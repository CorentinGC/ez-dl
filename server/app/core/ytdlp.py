"""Wrapper autour du binaire yt-dlp : analyse (probe), téléchargement avec suivi de
progression, auto-update. Toujours via `asyncio.create_subprocess_exec` (jamais
`shell=True`, arguments passés en liste)."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from app.core.paths import sanitize_filename

logger = logging.getLogger(__name__)

ProgressCallback = Callable[[dict[str, Any]], Awaitable[None]]

# Marqueur de ligne + template JSON pour parser la progression sans ambiguïté.
_PROGRESS_MARKER = "EZDL_PROGRESS "
PROGRESS_TEMPLATE = f"download:{_PROGRESS_MARKER}%(progress)j"


class YtDlpError(RuntimeError):
    """Erreur lors d'un appel yt-dlp (probe, téléchargement)."""


def _context_args(
    cookies_file: Path | None, headers: dict[str, str] | None, referer: str | None
) -> list[str]:
    """Construit les arguments communs (cookies, headers, referer) d'un appel yt-dlp."""
    args: list[str] = []
    if cookies_file is not None:
        args += ["--cookies", str(cookies_file)]
    if referer:
        args += ["--referer", referer]
    for key, value in (headers or {}).items():
        args += ["--add-header", f"{key}:{value}"]
    return args


def format_size(num_bytes: float) -> str:
    """Formate une taille en octets en chaîne lisible (Ko/Mo/Go)."""
    value = float(num_bytes)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024:
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} TB"


def _format_label(fmt: dict[str, Any]) -> str:
    """Construit un label lisible, ex : `1080p60 · mp4 · h264+aac · 245.0 MB`."""
    parts: list[str] = []
    height = fmt.get("height")
    fps = fmt.get("fps")
    has_video = fmt.get("vcodec") not in (None, "none")
    has_audio = fmt.get("acodec") not in (None, "none")
    if height:
        res = f"{height}p"
        if fps and fps > 30:
            res += str(int(fps))
        parts.append(res)
    elif has_audio and not has_video:
        parts.append("audio")
    if fmt.get("ext"):
        parts.append(fmt["ext"])
    codecs = [c.split(".")[0] for c in (fmt.get("vcodec"), fmt.get("acodec")) if c and c != "none"]
    if codecs:
        parts.append("+".join(codecs))
    size = fmt.get("filesize") or fmt.get("filesize_approx")
    if size:
        parts.append(format_size(size))
    return " · ".join(parts) if parts else str(fmt.get("format_id", "?"))


def _quality_rank(fmt: dict[str, Any]) -> tuple[bool, bool, int, float, float]:
    """Clé de tri décroissant : formats combinés d'abord, puis résolution/fps/bitrate."""
    has_video = fmt.get("vcodec") not in (None, "none")
    has_audio = fmt.get("acodec") not in (None, "none")
    return (
        has_video and has_audio,
        has_video,
        fmt.get("height") or 0,
        fmt.get("fps") or 0,
        fmt.get("tbr") or 0,
    )


def normalize_formats(info: dict[str, Any]) -> tuple[list[dict[str, Any]], str | None]:
    """Normalise `info["formats"]` (JSON `yt-dlp -J`) : labels lisibles, tri par qualité
    décroissante. Retourne `(formats normalisés, best_format_id)`."""
    normalized: list[dict[str, Any]] = []
    for fmt in info.get("formats") or []:
        format_id = fmt.get("format_id")
        if not format_id:
            continue
        normalized.append(
            {
                "format_id": format_id,
                "ext": fmt.get("ext") or "",
                "height": fmt.get("height"),
                "width": fmt.get("width"),
                "fps": fmt.get("fps"),
                "vcodec": fmt.get("vcodec"),
                "acodec": fmt.get("acodec"),
                "filesize": fmt.get("filesize") or fmt.get("filesize_approx"),
                "tbr": fmt.get("tbr"),
                "label": _format_label(fmt),
                "has_audio": fmt.get("acodec") not in (None, "none"),
                "has_video": fmt.get("vcodec") not in (None, "none"),
                "_rank": _quality_rank(fmt),
            }
        )
    normalized.sort(key=lambda f: f["_rank"], reverse=True)
    best_format_id = normalized[0]["format_id"] if normalized else None
    for fmt in normalized:
        del fmt["_rank"]
    return normalized, best_format_id


def suggested_filename(info: dict[str, Any]) -> str:
    """Construit un nom de fichier suggéré et sanitizé à partir du titre/id yt-dlp."""
    title = info.get("title") or info.get("id") or "download"
    ext = info.get("ext") or "mp4"
    return sanitize_filename(f"{title}.{ext}")


async def probe(
    url: str,
    *,
    binary: str = "yt-dlp",
    cookies_file: Path | None = None,
    headers: dict[str, str] | None = None,
    referer: str | None = None,
    timeout: float = 60.0,
) -> dict[str, Any]:
    """Interroge yt-dlp (`-J`) pour une URL et retourne le JSON d'info normalisé
    (`formats`, `best_format_id`, `suggested_filename` inclus)."""
    # `--` sépare les options des arguments positionnels : sans lui, une URL commençant par
    # `-` serait parsée par yt-dlp comme une option (`--exec`, `--paths`...).
    args = [
        binary,
        "-J",
        "--no-warnings",
        *_context_args(cookies_file, headers, referer),
        "--",
        url,
    ]
    try:
        proc = await asyncio.create_subprocess_exec(
            *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except FileNotFoundError as exc:
        raise YtDlpError(f"Binaire yt-dlp introuvable : {binary}") from exc
    except TimeoutError as exc:
        proc.kill()
        raise YtDlpError("Timeout lors de l'analyse de l'URL") from exc
    if proc.returncode != 0:
        raise YtDlpError(f"yt-dlp a échoué : {_last_line(stderr)}")
    info: dict[str, Any] = json.loads(stdout.decode("utf-8", errors="replace"))
    formats, best_format_id = normalize_formats(info)
    info["formats"] = formats
    info["best_format_id"] = best_format_id
    info["suggested_filename"] = suggested_filename(info)
    return info


async def start_download(
    url: str,
    destination: Path,
    *,
    binary: str = "yt-dlp",
    format_id: str | None = None,
    cookies_file: Path | None = None,
    headers: dict[str, str] | None = None,
    referer: str | None = None,
) -> asyncio.subprocess.Process:
    """Démarre le téléchargement en subprocess et retourne le process (suivi/annulation)."""
    args = [
        binary,
        "--newline",
        "--no-warnings",
        "--progress-template",
        PROGRESS_TEMPLATE,
        "-o",
        str(destination),
    ]
    if format_id:
        args += ["-f", format_id]
    args += _context_args(cookies_file, headers, referer)
    # Voir `probe` : `--` empêche qu'une URL en `-...` soit interprétée comme une option.
    args += ["--", url]
    return await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )


async def stream_progress(
    process: asyncio.subprocess.Process, on_progress: ProgressCallback | None
) -> None:
    """Lit stdout ligne par ligne, parse les évènements de progression, appelle le callback."""
    if process.stdout is None:
        return
    async for raw_line in process.stdout:
        line = raw_line.decode("utf-8", errors="replace").strip()
        if not line.startswith(_PROGRESS_MARKER) or on_progress is None:
            continue
        try:
            data = json.loads(line[len(_PROGRESS_MARKER) :])
        except json.JSONDecodeError:
            logger.debug("Ligne de progression yt-dlp non parsable")
            continue
        await on_progress(data)


async def wait_download(process: asyncio.subprocess.Process) -> None:
    """Attend la fin du process et lève `YtDlpError` si le code de retour est non nul."""
    returncode = await process.wait()
    if returncode == 0:
        return
    stderr = await process.stderr.read() if process.stderr is not None else b""
    raise YtDlpError(f"yt-dlp a échoué (code {returncode}) : {_last_line(stderr)}")


# yt-dlp recopie la ligne fautive du cookie-jar dans cet avertissement (non supprimé par
# `--no-warnings`) : elle contient des cookies en clair et ne doit ni être loggée ni persistée.
_COOKIE_LEAK_MARKER = "skipping cookie file entry"

# Un message d'erreur est destiné à l'UI : au-delà, c'est du bruit en base et dans les logs.
_MAX_ERROR_LENGTH = 500


def _last_line(raw: bytes) -> str:
    """Retourne la dernière ligne non vide d'une sortie process (pour message d'erreur),
    expurgée des lignes susceptibles de contenir des cookies et tronquée."""
    lines = [
        line
        for line in raw.decode("utf-8", errors="replace").strip().splitlines()
        if line and _COOKIE_LEAK_MARKER not in line
    ]
    if not lines:
        return "erreur inconnue"
    return lines[-1][:_MAX_ERROR_LENGTH]


async def update(binary: str = "yt-dlp", *, timeout: float = 120.0) -> str:
    """Lance `yt-dlp -U`. Ne lève jamais : un échec est loggé en warning (non fatal)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            binary, "-U", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except (FileNotFoundError, TimeoutError) as exc:
        logger.warning("Auto-update yt-dlp impossible : %s", exc)
        return ""
    if proc.returncode != 0:
        logger.warning("yt-dlp -U a échoué : %s", _last_line(stderr))
    return stdout.decode("utf-8", errors="replace").strip()


async def version(binary: str = "yt-dlp") -> str | None:
    """Retourne la version de yt-dlp (`--version`), `None` si le binaire est introuvable."""
    try:
        proc = await asyncio.create_subprocess_exec(
            binary, "--version", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        stdout, _ = await proc.communicate()
    except FileNotFoundError:
        return None
    if proc.returncode != 0:
        return None
    return stdout.decode("utf-8", errors="replace").strip()
