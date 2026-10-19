"""Aides de test partagées pour la file de jobs : faux yt-dlp, jobs en base."""

from __future__ import annotations

import asyncio
import signal
from pathlib import Path
from types import SimpleNamespace

from sqlmodel import Session

from app.core import ytdlp
from app.core.queue import JobQueue
from app.models import Job, JobStatus


def create_job(engine, settings, filename: str = "video.mp4") -> str:
    """Insère un job `queued` visant la première racine de téléchargement."""
    with Session(engine) as session:
        job = Job(
            url="https://example.com/video",
            folder=str(settings.roots[0].path),
            filename=filename,
            status=JobStatus.QUEUED.value,
        )
        session.add(job)
        session.commit()
        session.refresh(job)
        return job.id


def finished_process() -> SimpleNamespace:
    """Process yt-dlp factice déjà terminé avec succès."""

    async def wait() -> int:
        return 0

    return SimpleNamespace(stdout=None, stderr=None, returncode=0, wait=wait, pid=-1)


def install_fake_ytdlp(
    monkeypatch,
    produced: dict[str, bytes],
    progress=None,
    seen_files: list[list[str]] | None = None,
) -> list[Path]:
    """Simule yt-dlp : écrit `produced` (nom -> contenu) dans le dossier du template `-o`.

    Le vrai binaire choisit lui-même le nom de sortie (il impose l'extension du conteneur
    réellement produit) : le fake reçoit donc un template, pas un chemin final.
    Retourne la liste des dossiers de travail utilisés, pour vérifier leur nettoyage.
    `seen_files` reçoit le contenu du dossier de travail *avant* écriture (état de reprise).
    """
    work_dirs: list[Path] = []

    async def fake_start_download(url: str, output_template: Path, **kwargs: object):
        work_dir = Path(output_template).parent
        work_dirs.append(work_dir)
        assert "%(ext)s" in Path(output_template).name, "le nom de sortie ne doit pas être deviné"
        work_dir.mkdir(parents=True, exist_ok=True)
        if seen_files is not None:
            seen_files.append(sorted(path.name for path in work_dir.iterdir()))
        for name, content in produced.items():
            (work_dir / name).write_bytes(content)
        return finished_process()

    async def fake_stream_progress(process: object, on_progress) -> None:
        if on_progress is None or progress is None:
            return
        await on_progress(progress)

    monkeypatch.setattr(ytdlp, "start_download", fake_start_download)
    monkeypatch.setattr(ytdlp, "stream_progress", fake_stream_progress)
    return work_dirs


class HangingProcess:
    """Process yt-dlp factice qui ne rend la main qu'une fois signalé (SIGTERM/SIGKILL)."""

    def __init__(self) -> None:
        self.returncode: int | None = None
        self.stdout = None
        self.stderr = None
        # Pid inexistant : `stop_process_group` doit alors retomber sur `send_signal` plutôt
        # que de viser un groupe de process — surtout pas celui qui exécute les tests.
        self.pid = -1
        self._stopped = asyncio.Event()

    def send_signal(self, sig: int) -> None:
        self.returncode = -int(sig)
        self._stopped.set()

    def terminate(self) -> None:
        self.send_signal(signal.SIGTERM)

    def kill(self) -> None:
        self.send_signal(signal.SIGKILL)

    async def wait(self) -> int:
        await self._stopped.wait()
        return self.returncode or 0


def install_hanging_ytdlp(monkeypatch, seen_files: list[list[str]]) -> None:
    """Simule un yt-dlp qui écrit un `.part` puis télécharge sans fin.

    `seen_files` reçoit, à chaque lancement, le contenu du dossier de travail *avant* le
    téléchargement : c'est ce qui prouve qu'une reprise retrouve bien le fichier partiel.
    `stream_progress` reste la vraie implémentation — c'est leur
    échec sur un process signalé qui doit être traduit en pause, pas en erreur.
    """

    async def fake_start_download(url: str, output_template: Path, **kwargs: object):
        work_dir = Path(output_template).parent
        work_dir.mkdir(parents=True, exist_ok=True)
        seen_files.append(sorted(path.name for path in work_dir.iterdir()))
        (work_dir / "download.mp4.part").write_bytes(b"p" * 4_096)
        return HangingProcess()

    monkeypatch.setattr(ytdlp, "start_download", fake_start_download)


async def wait_until_running(queue: JobQueue, job_id: str) -> None:
    """Attend que le process du job soit enregistré (donc interruptible), sans `sleep` fixe."""
    for _ in range(1_000):
        if job_id in queue._processes:
            return
        await asyncio.sleep(0)
    raise AssertionError("le process du job n'a jamais été enregistré")
