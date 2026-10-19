"""Cycle de vie des sous-process externes (yt-dlp, ffmpeg) : lancement en groupe dédié,
arrêt du groupe entier, récolte systématique.

Le binaire yt-dlp standalone est un exécutable PyInstaller : un bootloader parent qui
ré-exécute le vrai interpréteur dans un process enfant. Tuer le seul bootloader laisse
l'enfant tourner — il continue d'extraire, garde sa mémoire, puis bloque en écriture sur
un pipe que plus personne ne lit (ez-dl-1xu, puis les process fantômes de ez-dl-nta).
Toute la logique d'arrêt passe donc par le **groupe** de process.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal
from typing import Any

#: Délai laissé à un groupe après SIGTERM avant l'escalade en SIGKILL.
TERM_GRACE_SECONDS = 5.0


async def spawn(*args: str, **kwargs: Any) -> asyncio.subprocess.Process:
    """Lance `args` (liste, jamais de shell) dans sa propre session, stdin fermé.

    `start_new_session=True` rend le process chef de son groupe (pgid == pid) : c'est ce
    qui permet à `stop_process_group` de signaler aussi les enfants du bootloader.
    """
    kwargs.setdefault("stdin", asyncio.subprocess.DEVNULL)
    return await asyncio.create_subprocess_exec(*args, start_new_session=True, **kwargs)


def stop_process_group(process: asyncio.subprocess.Process | None, sig: int) -> None:
    """Envoie `sig` au **groupe** de process, pas au seul process lancé.

    Le garde-fou vérifie que le process est bien chef de son groupe avant `killpg` : sinon
    un process lancé sans `start_new_session` ferait signaler le groupe du serveur lui-même.
    """
    if process is None or process.returncode is not None:
        return
    try:
        is_group_leader = os.getpgid(process.pid) == process.pid
    except (ProcessLookupError, PermissionError, OSError):
        is_group_leader = False
    try:
        if is_group_leader:
            os.killpg(process.pid, sig)
        else:
            process.send_signal(sig)
    except (ProcessLookupError, PermissionError):
        # Course normale : le process s'est terminé entre le test et l'envoi du signal.
        return


async def kill_and_reap(process: asyncio.subprocess.Process | None) -> None:
    """SIGKILL sur tout le groupe puis attente de la fin du process (pas de zombie).

    `shield` : appelée depuis un `except CancelledError`, la récolte doit aller au bout
    même si la tâche appelante est de nouveau annulée.
    """
    if process is None:
        return
    stop_process_group(process, signal.SIGKILL)
    with contextlib.suppress(Exception):
        await asyncio.shield(process.wait())


async def terminate_and_reap(
    process: asyncio.subprocess.Process | None, grace: float = TERM_GRACE_SECONDS
) -> None:
    """SIGTERM sur le groupe, puis SIGKILL si rien n'a bougé après `grace` secondes."""
    if process is None or process.returncode is not None:
        return
    stop_process_group(process, signal.SIGTERM)
    try:
        await asyncio.wait_for(asyncio.shield(process.wait()), timeout=grace)
    except TimeoutError:
        await kill_and_reap(process)


async def run_bounded(*args: str, timeout: float, **kwargs: Any) -> tuple[int, bytes, bytes]:
    """Lance `args`, attend sa sortie au plus `timeout` secondes, tue le groupe sinon.

    Couvre aussi l'annulation (`CancelledError` : client parti, arrêt du serveur) : le
    groupe est tué et récolté avant de propager. Lève `TimeoutError` au dépassement.
    """
    process = await spawn(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, **kwargs
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except BaseException:
        await kill_and_reap(process)
        raise
    return process.returncode or 0, stdout, stderr
