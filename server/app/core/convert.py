"""Conversion ffmpeg d'un fichier téléchargé, en sous-process borné."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from pathlib import Path

from app.core import ffmpeg
from app.core.process import kill_and_reap, redact_credentials, spawn

# Options globales avant les arguments du preset : stdin jamais lu (un ffmpeg qui attendrait
# une réponse bloquerait le job), pas de bannière, seules les erreurs sur stderr.
_QUIET_ARGS = ["-nostdin", "-hide_banner", "-loglevel", "error"]
_STDERR_TAIL_CHARS = 300


async def run_conversion(
    binary: str,
    preset: ffmpeg.Preset,
    source: Path,
    output: Path,
    on_started: Callable[[asyncio.subprocess.Process], None],
) -> None:
    """Convertit `source` vers `output`. Lève `RuntimeError` si ffmpeg échoue.

    `on_started` reçoit le process dès son lancement (suivi pour pause/annulation). Une
    annulation de la tâche tue le groupe de process avant de se propager.
    """
    args = ffmpeg.build_conversion_args(preset, str(source), str(output))
    process = None
    try:
        process = await spawn(
            binary,
            *_QUIET_ARGS,
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        on_started(process)
        _, stderr = await process.communicate()
    except asyncio.CancelledError:
        await kill_and_reap(process)
        raise
    if process.returncode != 0:
        tail = redact_credentials(stderr.decode("utf-8", errors="replace"))[-_STDERR_TAIL_CHARS:]
        raise RuntimeError(f"ffmpeg a échoué : {tail}")
