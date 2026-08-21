"""Détection des encodeurs ffmpeg disponibles et catalogue des presets de conversion."""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass

logger = logging.getLogger(__name__)

# Ligne d'encodeur ex: " V....D libx264              libx264 H.264 / AVC ... (codec h264)"
_ENCODER_LINE_RE = re.compile(r"^\s*[VAS][.\w]{5}\s+(?P<name>\S+)\s+(?P<desc>.+)$")

_HWACCEL_BY_SUFFIX = {
    "_nvenc": "nvidia",
    "_qsv": "quicksync",
    "_vaapi": "vaapi",
    "_videotoolbox": "videotoolbox",
    "_amf": "amf",
}

# Familles d'encodeurs exposées au client. `ffmpeg -encoders` en liste ~200 (images,
# sous-titres, PCM, formats historiques) : sans ce filtre, l'extension recevrait un
# inventaire inexploitable pour son sélecteur de conversion.
_RELEVANT_CODECS = frozenset({"h264", "hevc", "av1", "vp9", "aac", "mp3", "opus", "vorbis", "flac"})
_RELEVANT_PREFIXES = ("libx26", "libsvtav1", "libvpx", "libaom", "libmp3lame", "libopus", "libfdk")


@dataclass(frozen=True)
class Encoder:
    """Un encodeur ffmpeg disponible sur le serveur."""

    id: str
    name: str
    hwaccel: str | None
    codec: str


@dataclass(frozen=True)
class Preset:
    """Un preset de conversion, proposé au client si son encodeur est disponible."""

    id: str
    label: str
    description: str
    container: str
    video_codec: str | None
    encoder_name: str | None  # nom d'encodeur ffmpeg requis (None pour `copy`)
    audio_only: bool = False


def _guess_hwaccel(encoder_name: str) -> str | None:
    """Devine la techno d'accélération matérielle depuis le suffixe du nom d'encodeur."""
    for suffix, hwaccel in _HWACCEL_BY_SUFFIX.items():
        if encoder_name.endswith(suffix):
            return hwaccel
    return None


def _guess_codec(encoder_name: str) -> str:
    """Devine le codec depuis le nom d'encodeur ffmpeg."""
    lowered = encoder_name.lower()
    if "hevc" in lowered or "265" in lowered:
        return "hevc"
    if "264" in lowered:
        return "h264"
    if "mp3" in lowered:
        return "mp3"
    if "opus" in lowered:
        return "opus"
    if "av1" in lowered:
        return "av1"
    if "vp9" in lowered:
        return "vp9"
    if lowered.startswith("aac"):
        return "aac"
    return lowered


def parse_encoders(output: str) -> dict[str, Encoder]:
    """Parse la sortie de `ffmpeg -encoders` en `{nom_encodeur: Encoder}`.

    Ignore l'en-tête (légende des flags) et ne considère que les lignes après le
    séparateur `------`.
    """
    encoders: dict[str, Encoder] = {}
    started = False
    for line in output.splitlines():
        if line.strip().startswith("---"):
            started = True
            continue
        if not started:
            continue
        match = _ENCODER_LINE_RE.match(line)
        if not match:
            continue
        name = match.group("name")
        desc = match.group("desc").strip()
        encoders[name] = Encoder(
            id=name, name=desc, hwaccel=_guess_hwaccel(name), codec=_guess_codec(name)
        )
    return encoders


# Catalogue statique des presets connus (cf. CONTRACT.md), filtré ensuite par les
# encodeurs réellement détectés sur le serveur.
_PRESET_CATALOG: list[Preset] = [
    Preset("copy", "Copie (remux)", "Aucun réencodage, le plus rapide", "mkv", None, None),
    Preset(
        "h264_nvenc", "H.264 (NVIDIA)", "Encodage matériel GPU NVIDIA", "mp4", "h264", "h264_nvenc"
    ),
    Preset(
        "hevc_nvenc",
        "HEVC (NVIDIA)",
        "Encodage matériel GPU NVIDIA, meilleure compression",
        "mp4",
        "hevc",
        "hevc_nvenc",
    ),
    Preset(
        "h264_qsv", "H.264 (Intel QuickSync)", "Encodage matériel Intel", "mp4", "h264", "h264_qsv"
    ),
    Preset(
        "hevc_qsv",
        "HEVC (Intel QuickSync)",
        "Encodage matériel Intel, meilleure compression",
        "mp4",
        "hevc",
        "hevc_qsv",
    ),
    Preset(
        "h264_vaapi", "H.264 (VAAPI)", "Encodage matériel via VAAPI", "mp4", "h264", "h264_vaapi"
    ),
    Preset(
        "hevc_vaapi",
        "HEVC (VAAPI)",
        "Encodage matériel via VAAPI, meilleure compression",
        "mp4",
        "hevc",
        "hevc_vaapi",
    ),
    Preset(
        "h264_videotoolbox",
        "H.264 (Apple VideoToolbox)",
        "Encodage matériel macOS",
        "mp4",
        "h264",
        "h264_videotoolbox",
    ),
    Preset(
        "hevc_videotoolbox",
        "HEVC (Apple VideoToolbox)",
        "Encodage matériel macOS, meilleure compression",
        "mp4",
        "hevc",
        "hevc_videotoolbox",
    ),
    Preset(
        "libx264", "H.264 (CPU)", "Encodage logiciel, large compatibilité", "mp4", "h264", "libx264"
    ),
    Preset(
        "libx265",
        "HEVC (CPU)",
        "Encodage logiciel, meilleure compression",
        "mp4",
        "hevc",
        "libx265",
    ),
    Preset(
        "audio_mp3",
        "Audio MP3",
        "Extraction audio en MP3",
        "mp3",
        None,
        "libmp3lame",
        audio_only=True,
    ),
    Preset(
        "audio_opus",
        "Audio Opus",
        "Extraction audio en Opus",
        "opus",
        None,
        "libopus",
        audio_only=True,
    ),
]


def available_presets(encoders: dict[str, Encoder]) -> list[Preset]:
    """Filtre le catalogue de presets selon les encodeurs réellement disponibles."""
    return [p for p in _PRESET_CATALOG if p.encoder_name is None or p.encoder_name in encoders]


def relevant_encoders(encoders: dict[str, Encoder]) -> list[Encoder]:
    """Restreint les encodeurs exposés au client à ceux utiles pour la conversion.

    Conserve les encodeurs référencés par un preset, ceux des familles vidéo/audio
    courantes, et tous les encodeurs matériels détectés.
    """
    used_by_presets = {p.encoder_name for p in _PRESET_CATALOG if p.encoder_name}
    kept = [
        encoder
        for encoder in encoders.values()
        if encoder.id in used_by_presets
        or encoder.hwaccel is not None
        or encoder.codec in _RELEVANT_CODECS
        or encoder.id.startswith(_RELEVANT_PREFIXES)
    ]
    return sorted(kept, key=lambda e: e.id)


def build_conversion_args(preset: Preset, input_path: str, output_path: str) -> list[str]:
    """Construit les arguments ffmpeg (hors nom du binaire) pour appliquer un preset."""
    if preset.id == "copy":
        return ["-y", "-i", input_path, "-c", "copy", output_path]
    if preset.audio_only:
        return ["-y", "-i", input_path, "-vn", "-c:a", preset.encoder_name, output_path]
    return ["-y", "-i", input_path, "-c:v", preset.encoder_name, "-c:a", "aac", output_path]


async def detect_encoders(ffmpeg_binary: str) -> dict[str, Encoder]:
    """Lance `ffmpeg -encoders` et retourne les encodeurs disponibles."""
    try:
        proc = await asyncio.create_subprocess_exec(
            ffmpeg_binary,
            "-hide_banner",
            "-encoders",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
    except FileNotFoundError:
        logger.warning("Binaire ffmpeg introuvable (%s), aucun encodeur détecté", ffmpeg_binary)
        return {}
    return parse_encoders(stdout.decode("utf-8", errors="replace"))


async def is_available(ffmpeg_binary: str) -> bool:
    """Vérifie que le binaire ffmpeg est exécutable."""
    try:
        proc = await asyncio.create_subprocess_exec(
            ffmpeg_binary,
            "-version",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await proc.communicate()
    except FileNotFoundError:
        return False
    return proc.returncode == 0
