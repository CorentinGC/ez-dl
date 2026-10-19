"""Drainage concurrent du stderr d'un process : un pipe non lu se remplit (~64 Ko), le
process bloque alors en écriture et ne se termine jamais."""

from __future__ import annotations

import asyncio
import contextlib
from collections import deque

from app.core import ytdlp

#: Nombre de lignes de stderr conservées pour construire le message d'erreur.
TAIL_LINES = 50
_JOIN_TIMEOUT_SECONDS = 2.0


class StderrTail:
    """Lit un flux en tâche de fond et ne garde que ses dernières lignes."""

    def __init__(self, stream: asyncio.StreamReader | None) -> None:
        self._lines: deque[bytes] = deque(maxlen=TAIL_LINES)
        self._task = asyncio.create_task(self._drain(stream)) if stream is not None else None

    async def _drain(self, stream: asyncio.StreamReader) -> None:
        async for line in stream:
            self._lines.append(line)

    async def stop(self) -> None:
        """Interrompt le drainage (appelé quoi qu'il arrive à la fin du téléchargement)."""
        if self._task is None or self._task.done():
            return
        self._task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._task

    async def raise_unless_success(self, process: asyncio.subprocess.Process) -> None:
        """Attend la fin du process ; code non nul -> `YtDlpError` construite depuis le tail.

        Remplace l'ancienne `ytdlp.wait_download`, qui lisait `stderr` d'un bloc après la fin du
        process — en conflit avec le drainage concurrent. Le message passe
        par le même filtre que `ytdlp.last_line` (retrait des lignes portant des cookies).
        """
        returncode = await process.wait()
        if returncode == 0:
            return
        if self._task is not None:
            # Le flux se ferme avec le process ; le délai borne le cas d'un petit-fils qui
            # garderait le pipe ouvert.
            await asyncio.wait({self._task}, timeout=_JOIN_TIMEOUT_SECONDS)
        raw = b"".join(self._lines)
        raise ytdlp.YtDlpError(f"yt-dlp a échoué (code {returncode}) : {ytdlp.last_line(raw)}")
