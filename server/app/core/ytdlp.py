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


def _quality_rank(fmt: dict[str, Any]) -> tuple[bool, int, float, float]:
    """Clé de tri décroissant : formats vidéo d'abord, puis résolution/fps/bitrate.

    Les formats video-only ne sont plus pénalisés : `build_format_selector` leur adjoint
    automatiquement la meilleure piste audio. Privilégier un muxé ferait au contraire
    élire un 360p combiné devant un 1080p sans audio (cas YouTube classique).
    """
    has_video = fmt.get("vcodec") not in (None, "none")
    return (
        has_video,
        fmt.get("height") or 0,
        fmt.get("fps") or 0,
        fmt.get("tbr") or 0,
    )


def _is_downloadable(fmt: dict[str, Any]) -> bool:
    """Écarte les formats qui n'ont rien à faire dans un choix de qualité utilisateur.

    - Storyboards (`mhtml`) : planches de vignettes, ni audio ni vidéo.
    - Formats « Premium » : variantes haut débit dont YouTube réserve l'accès aux comptes
      Premium de façon inconstante (parfois servies à tous, parfois refusées avec
      « Requested format is not available »). Le gain de débit ne vaut pas ce risque sur le
      format proposé par défaut : on ne les expose pas (ez-dl-b6e).
    """
    if fmt.get("protocol") == "mhtml":
        return False
    if "Premium" in (fmt.get("format_note") or ""):
        return False
    return fmt.get("vcodec") not in (None, "none") or fmt.get("acodec") not in (None, "none")


def normalize_formats(info: dict[str, Any]) -> tuple[list[dict[str, Any]], str | None]:
    """Normalise `info["formats"]` (JSON `yt-dlp -J`) : labels lisibles, tri par qualité
    décroissante. Retourne `(formats normalisés, best_format_id)`."""
    normalized: list[dict[str, Any]] = []
    for fmt in info.get("formats") or []:
        format_id = fmt.get("format_id")
        if not format_id or not _is_downloadable(fmt):
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
    # `--ignore-no-formats-error` : sans lui, une extraction dégradée (YouTube sans runtime
    # JS, page géobloquée...) fait sortir `-J` en erreur sur le sélecteur par défaut plutôt
    # que de rendre le JSON d'info. On préfère récupérer l'info et diagnostiquer nous-mêmes.
    args = [
        binary,
        "-J",
        "--no-warnings",
        "--ignore-no-formats-error",
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
    if not formats:
        raise YtDlpError(
            "Aucun format téléchargeable pour cette URL (contenu protégé, géobloqué, "
            "ou extraction incomplète côté yt-dlp)."
        )
    info["formats"] = formats
    info["best_format_id"] = best_format_id
    info["suggested_filename"] = suggested_filename(info)
    return info


def build_format_selector(format_id: str) -> str:
    """Construit le sélecteur `-f` à partir du `format_id` choisi par l'utilisateur.

    Un identifiant nu ne convient pas : sur YouTube tout format au-delà de 360p est
    **video-only**, et `-f 137` produirait un fichier muet. La chaîne de repli `/` de
    yt-dlp couvre les trois cas dans un seul appel, dans l'ordre :

    1. `<id>+bestaudio` — le format demandé fusionné avec la meilleure piste audio ;
    2. `<id>` — le format demandé est déjà muxé (la fusion précédente n'a pas de sens) ;
    3. `bv*+ba/b` — l'identifiant a disparu entre le probe et le téléchargement (les ids
       YouTube varient d'une extraction à l'autre selon le client interrogé) : on retombe
       sur le meilleur format disponible plutôt que d'échouer.
    """
    return f"{format_id}+bestaudio/{format_id}/bv*+ba/b"


async def start_download(
    url: str,
    output_template: Path,
    *,
    binary: str = "yt-dlp",
    format_id: str | None = None,
    cookies_file: Path | None = None,
    headers: dict[str, str] | None = None,
    referer: str | None = None,
) -> asyncio.subprocess.Process:
    """Démarre le téléchargement en subprocess et retourne le process (suivi/annulation).

    `output_template` est un **template** `-o` yt-dlp, pas un chemin final : yt-dlp y
    substitue les champs `%(...)s` et impose l'extension du conteneur réellement produit
    (un merge/remux peut changer le conteneur en cours de route). L'appelant doit donc
    retrouver le fichier produit après coup plutôt que de présumer son nom.

    `--continue` reprend le `.part` déjà présent dans le dossier de sortie au lieu de tout
    retélécharger : c'est ce qui rend la reprise d'un job en pause (ou coupé par un
    redémarrage du serveur) possible. C'est le défaut de yt-dlp, explicité ici parce que le
    pipeline en dépend.
    """
    args = [
        binary,
        "--newline",
        "--no-warnings",
        "--continue",
        "--progress-template",
        PROGRESS_TEMPLATE,
        "-o",
        str(output_template),
    ]
    # Sans `format_id` (sources sniffées : la qualité est dans l'URL), pas de `-f` du tout :
    # yt-dlp applique son propre défaut.
    if format_id:
        args += ["-f", build_format_selector(format_id)]
    args += _context_args(cookies_file, headers, referer)
    # Voir `probe` : `--` empêche qu'une URL en `-...` soit interprétée comme une option.
    args += ["--", url]
    # `start_new_session=True` : yt-dlp standalone est un binaire PyInstaller (bootloader +
    # process enfant). Sans groupe de process dédié, un SIGKILL sur le bootloader laisse
    # l'enfant télécharger dans le vide. Voir `_stop_process_group` côté queue.
    return await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=True,
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
    """Retourne la ligne la plus informative d'une sortie process (pour message d'erreur),
    expurgée des lignes susceptibles de contenir des cookies et tronquée.

    yt-dlp fait souvent suivre son `ERROR:` d'une ligne de conseil (« Use --list-formats… »,
    « Install… ») : c'est la ligne `ERROR:` qui porte la cause, on la privilégie.
    """
    lines = [
        line
        for line in raw.decode("utf-8", errors="replace").strip().splitlines()
        if line and _COOKIE_LEAK_MARKER not in line
    ]
    if not lines:
        return "erreur inconnue"
    errors = [line for line in lines if line.lstrip().startswith("ERROR:")]
    return (errors or lines)[-1][:_MAX_ERROR_LENGTH]


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
