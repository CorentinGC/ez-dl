"""Tests de `app.core.queue` : progression numérique, pipeline complet d'un job,
pause/reprise et récupération après un redémarrage du serveur."""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlmodel import Session

from app.config import Settings
from app.core import ytdlp
from app.core.cookies import cookie_jar_dir
from app.core.queue import INTERRUPTED_MESSAGE, JobQueue, _progress_fields
from app.db import get_engine, init_db
from app.models import Job, JobStatus


def test_progress_fields_returns_numeric_speed_eta_size() -> None:
    """Le parsing de la progression yt-dlp ne doit produire aucune chaîne humaine
    (contrat d'API : `speed: float|null`, `eta: int|null`, `size: int|null`)."""
    data = {
        "downloaded_bytes": 2_100_000,
        "total_bytes": 4_200_000,
        "speed": 39_200_000.5,
        "eta": 0,
    }

    fields = _progress_fields(data)

    assert fields["progress"] == 50.0
    assert fields["size"] == 4_200_000
    assert isinstance(fields["size"], int)
    assert fields["speed"] == pytest.approx(39_200_000.5)
    assert isinstance(fields["speed"], float)
    assert fields["eta"] == 0
    assert isinstance(fields["eta"], int)


def test_progress_fields_uses_total_bytes_estimate_when_total_unknown() -> None:
    """`total_bytes_estimate` sert de repli quand `total_bytes` n'est pas encore connu."""
    fields = _progress_fields(
        {"downloaded_bytes": 1_000, "total_bytes_estimate": 10_000, "speed": None, "eta": None}
    )

    assert fields["progress"] == 10.0
    assert fields["size"] == 10_000
    assert "speed" not in fields
    assert "eta" not in fields


def test_progress_fields_skips_progress_and_size_without_total() -> None:
    """Sans taille totale connue, ni `progress` ni `size` ne doivent être renvoyés."""
    fields = _progress_fields({"downloaded_bytes": 500})

    assert "progress" not in fields
    assert "size" not in fields


@pytest.fixture
def job_queue(tmp_path):
    """Une `JobQueue` reliée à une base SQLite de test, sans worker démarré."""
    download_root = tmp_path / "downloads"
    download_root.mkdir()
    settings = Settings(
        password="test-secret",
        download_roots=f"Downloads={download_root}",
        data_dir=tmp_path / "data",
        temp_dir=tmp_path / "temp",
    )
    engine = get_engine(settings)
    init_db(settings)
    queue = JobQueue(settings, engine, encoders={})
    return queue, engine, settings


def _create_job(engine, settings, filename: str = "video.mp4") -> str:
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


def _install_fake_ytdlp(
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
        return SimpleNamespace(stdout=None, stderr=None, returncode=0, kill=lambda: None)

    async def fake_stream_progress(process: object, on_progress) -> None:
        if on_progress is None or progress is None:
            return
        await on_progress(progress)

    async def fake_wait_download(process: object) -> None:
        return None

    monkeypatch.setattr(ytdlp, "start_download", fake_start_download)
    monkeypatch.setattr(ytdlp, "stream_progress", fake_stream_progress)
    monkeypatch.setattr(ytdlp, "wait_download", fake_wait_download)
    return work_dirs


async def test_run_job_persists_numeric_progress_and_real_final_size(
    job_queue, monkeypatch
) -> None:
    """Pipeline complet d'un job (download -> move) : `speed`/`eta` restent numériques et
    `size` final reflète la taille réelle du fichier déplacé, pas la dernière estimation."""
    queue, engine, settings = job_queue
    job_id = _create_job(engine, settings)
    downloaded_bytes = b"x" * 4_200_000

    _install_fake_ytdlp(
        monkeypatch,
        {"download.mp4": downloaded_bytes},
        # Frame de progression brute telle qu'émise par `--progress-template` (valeurs numériques).
        progress={
            "downloaded_bytes": len(downloaded_bytes),
            "total_bytes": len(downloaded_bytes),
            "speed": 39_200_000.5,
            "eta": 0,
        },
    )

    await queue._run_job(job_id)

    with Session(engine) as session:
        persisted = session.get(Job, job_id)
        assert persisted is not None
        assert persisted.status == JobStatus.DONE.value
        assert persisted.speed == pytest.approx(39_200_000.5)
        assert isinstance(persisted.speed, float)
        assert persisted.eta == 0
        assert isinstance(persisted.eta, int)
        assert persisted.size == len(downloaded_bytes)
        assert isinstance(persisted.size, int)


async def test_run_job_moves_output_whatever_container_ytdlp_chose(job_queue, monkeypatch) -> None:
    """Le conteneur produit (ici `.mkv`, après un merge) n'est pas celui du nom demandé :
    le pipeline doit récupérer le fichier réellement écrit, pas un nom présumé."""
    queue, engine, settings = job_queue
    job_id = _create_job(engine, settings)
    work_dirs = _install_fake_ytdlp(monkeypatch, {"download.mkv": b"y" * 2_048})

    await queue._run_job(job_id)

    with Session(engine) as session:
        persisted = session.get(Job, job_id)
        assert persisted is not None
        assert persisted.error is None
        assert persisted.status == JobStatus.DONE.value
        assert persisted.size == 2_048

    destination = settings.roots[0].path / "video.mp4"
    assert destination.read_bytes() == b"y" * 2_048
    # Dossier de travail supprimé : pas de résidu par job dans EZDL_TEMP_DIR.
    assert work_dirs and not work_dirs[0].exists()


async def test_run_job_ignores_partial_leftovers(job_queue, monkeypatch) -> None:
    """Les résidus yt-dlp (`.part`, `.ytdl`) ne doivent jamais être pris pour le résultat,
    même quand ils sont plus gros que le fichier final."""
    queue, engine, settings = job_queue
    job_id = _create_job(engine, settings)
    _install_fake_ytdlp(
        monkeypatch,
        {
            "download.mp4": b"final",
            "download.mp4.part": b"z" * 9_000,
            "download.mp4.part-Frag0": b"z" * 9_000,
            "download.mp4.ytdl": b"z" * 9_000,
        },
    )

    await queue._run_job(job_id)

    assert (settings.roots[0].path / "video.mp4").read_bytes() == b"final"


async def test_run_job_never_overwrites_an_existing_file(job_queue, monkeypatch) -> None:
    """`os.rename` écrase sans erreur : un job dont le nom coïncide avec un fichier existant
    doit dériver un nom libre, jamais détruire l'original."""
    queue, engine, settings = job_queue
    existing = settings.roots[0].path / "video.mp4"
    existing.write_bytes(b"ORIGINAL A NE PAS PERDRE")
    job_id = _create_job(engine, settings)
    _install_fake_ytdlp(monkeypatch, {"download.mp4": b"nouveau"})

    await queue._run_job(job_id)

    assert existing.read_bytes() == b"ORIGINAL A NE PAS PERDRE"
    assert (settings.roots[0].path / "video (2).mp4").read_bytes() == b"nouveau"
    with Session(engine) as session:
        persisted = session.get(Job, job_id)
        assert persisted is not None
        assert persisted.status == JobStatus.DONE.value
        # L'UI doit annoncer le nom réellement écrit, pas celui demandé.
        assert persisted.filename == "video (2).mp4"
        assert persisted.size == len(b"nouveau")


async def test_run_job_errors_when_root_vanishes_during_download(job_queue, monkeypatch) -> None:
    """Volume démonté pendant le téléchargement : le job échoue au lieu de recréer
    l'arborescence sur la couche locale et d'annoncer un `done` trompeur."""
    queue, engine, settings = job_queue
    job_id = _create_job(engine, settings)
    root = settings.roots[0].path

    async def fake_start_download(url: str, output_template: Path, **kwargs: object):
        work_dir = Path(output_template).parent
        work_dir.mkdir(parents=True, exist_ok=True)
        (work_dir / "download.mp4").write_bytes(b"contenu")
        root.rmdir()  # la racine disparaît après la création du job
        return SimpleNamespace(stdout=None, stderr=None, returncode=0, kill=lambda: None)

    async def noop(*args: object, **kwargs: object) -> None:
        return None

    monkeypatch.setattr(ytdlp, "start_download", fake_start_download)
    monkeypatch.setattr(ytdlp, "stream_progress", noop)
    monkeypatch.setattr(ytdlp, "wait_download", noop)

    await queue._run_job(job_id)

    with Session(engine) as session:
        persisted = session.get(Job, job_id)
        assert persisted is not None
        assert persisted.status == JobStatus.ERROR.value
        assert persisted.error is not None and "Downloads" in persisted.error
    assert not root.exists()  # rien n'a été recréé sous la racine démontée


async def test_run_job_reports_error_when_ytdlp_produced_nothing(job_queue, monkeypatch) -> None:
    """Sortie vide malgré un code retour 0 : le job passe en erreur explicite, pas en `done`."""
    queue, engine, settings = job_queue
    job_id = _create_job(engine, settings)
    work_dirs = _install_fake_ytdlp(monkeypatch, {})

    await queue._run_job(job_id)

    with Session(engine) as session:
        persisted = session.get(Job, job_id)
        assert persisted is not None
        assert persisted.status == JobStatus.ERROR.value
        assert persisted.error is not None and "aucun fichier" in persisted.error

    assert not (settings.roots[0].path / "video.mp4").exists()
    # Job en erreur : le dossier de travail survit pour qu'un retry reprenne le partiel.
    assert work_dirs and work_dirs[0].exists()


class _HangingProcess:
    """Process yt-dlp factice qui ne rend la main qu'une fois signalé (SIGTERM/SIGKILL)."""

    def __init__(self) -> None:
        self.returncode: int | None = None
        self.stdout = None
        self.stderr = None
        self._stopped = asyncio.Event()

    def terminate(self) -> None:
        self.returncode = -15
        self._stopped.set()

    def kill(self) -> None:
        self.returncode = -9
        self._stopped.set()

    async def wait(self) -> int:
        await self._stopped.wait()
        return self.returncode or 0


def _install_hanging_ytdlp(monkeypatch, seen_files: list[list[str]]) -> None:
    """Simule un yt-dlp qui écrit un `.part` puis télécharge sans fin.

    `seen_files` reçoit, à chaque lancement, le contenu du dossier de travail *avant* le
    téléchargement : c'est ce qui prouve qu'une reprise retrouve bien le fichier partiel.
    `stream_progress` et `wait_download` restent les vraies implémentations — c'est leur
    échec sur un process signalé qui doit être traduit en pause, pas en erreur.
    """

    async def fake_start_download(url: str, output_template: Path, **kwargs: object):
        work_dir = Path(output_template).parent
        work_dir.mkdir(parents=True, exist_ok=True)
        seen_files.append(sorted(path.name for path in work_dir.iterdir()))
        (work_dir / "download.mp4.part").write_bytes(b"p" * 4_096)
        return _HangingProcess()

    monkeypatch.setattr(ytdlp, "start_download", fake_start_download)


async def _wait_until_running(queue: JobQueue, job_id: str) -> None:
    """Attend que le process du job soit enregistré (donc interruptible), sans `sleep` fixe."""
    for _ in range(1_000):
        if job_id in queue._processes:
            return
        await asyncio.sleep(0)
    raise AssertionError("le process du job n'a jamais été enregistré")


async def test_pause_suspends_job_and_keeps_the_partial_file(job_queue, monkeypatch) -> None:
    """Pause d'un téléchargement en cours : statut `paused`, pas `error`, et le `.part` reste
    sur place — sans lui la reprise repartirait de zéro."""
    queue, engine, settings = job_queue
    job_id = _create_job(engine, settings)
    _install_hanging_ytdlp(monkeypatch, [])

    task = asyncio.create_task(queue._run_job(job_id))
    await _wait_until_running(queue, job_id)
    queue.pause(job_id)
    await task

    with Session(engine) as session:
        persisted = session.get(Job, job_id)
        assert persisted is not None
        assert persisted.status == JobStatus.PAUSED.value
        assert persisted.error is None  # une pause n'est pas un échec
        assert persisted.speed is None and persisted.eta is None

    partial = queue.work_dir(job_id) / "download.mp4.part"
    assert partial.exists()
    assert partial.stat().st_size == 4_096


async def test_resume_restarts_from_the_partial_file(job_queue, monkeypatch) -> None:
    """Reprise après pause : yt-dlp est relancé dans le dossier de travail conservé, avec le
    `.part` déjà présent."""
    queue, engine, settings = job_queue
    job_id = _create_job(engine, settings)
    seen_files: list[list[str]] = []
    _install_hanging_ytdlp(monkeypatch, seen_files)

    task = asyncio.create_task(queue._run_job(job_id))
    await _wait_until_running(queue, job_id)
    queue.pause(job_id)
    await task

    # Reprise : ce que fait `POST /api/jobs/{id}/resume`.
    queue.enqueue(job_id)
    queue.update(job_id, status=JobStatus.QUEUED, error=None)
    seen_on_resume: list[list[str]] = []
    _install_fake_ytdlp(monkeypatch, {"download.mp4": b"complet"}, seen_files=seen_on_resume)
    await queue._run_job(job_id)

    # Le premier lancement démarre à vide, la reprise retrouve le fichier partiel.
    assert seen_files == [[]]
    assert seen_on_resume == [["download.mp4.part"]]
    with Session(engine) as session:
        persisted = session.get(Job, job_id)
        assert persisted is not None
        assert persisted.status == JobStatus.DONE.value
    assert (settings.roots[0].path / "video.mp4").read_bytes() == b"complet"
    # Job terminé : le dossier de travail est purgé, plus rien n'est reprenable.
    assert not queue.work_dir(job_id).exists()


async def test_cancel_discards_the_partial_file(job_queue, monkeypatch) -> None:
    """Annulation (et non pause) : le dossier de travail part, un `retry` repartira de zéro."""
    queue, engine, settings = job_queue
    job_id = _create_job(engine, settings)
    _install_hanging_ytdlp(monkeypatch, [])

    task = asyncio.create_task(queue._run_job(job_id))
    await _wait_until_running(queue, job_id)
    queue.cancel(job_id)
    await task

    with Session(engine) as session:
        persisted = session.get(Job, job_id)
        assert persisted is not None
        assert persisted.status == JobStatus.CANCELED.value
    assert not queue.work_dir(job_id).exists()


async def test_run_job_ignores_an_entry_whose_job_is_no_longer_queued(
    job_queue, monkeypatch
) -> None:
    """Une reprise ré-enfile l'id sans pouvoir retirer l'entrée obsolète : le second passage
    ne doit pas relancer un téléchargement déjà pris en charge."""
    queue, engine, settings = job_queue
    job_id = _create_job(engine, settings)
    queue.update(job_id, status=JobStatus.PAUSED)
    work_dirs = _install_fake_ytdlp(monkeypatch, {"download.mp4": b"x"})

    await queue._run_job(job_id)

    assert work_dirs == []  # yt-dlp n'a jamais été lancé
    with Session(engine) as session:
        persisted = session.get(Job, job_id)
        assert persisted is not None
        assert persisted.status == JobStatus.PAUSED.value


def test_recover_interrupted_jobs_suspends_instead_of_erroring(job_queue) -> None:
    """Redémarrage du serveur : un job en cours devient `paused` (donc reprenable) et porte
    le motif de l'interruption, au lieu d'être classé en erreur définitive."""
    queue, engine, settings = job_queue
    job_id = _create_job(engine, settings)
    queue.update(job_id, status=JobStatus.DOWNLOADING, speed=1_000.0, eta=42)

    queue._recover_interrupted_jobs()

    with Session(engine) as session:
        persisted = session.get(Job, job_id)
        assert persisted is not None
        assert persisted.status == JobStatus.PAUSED.value
        assert persisted.error == INTERRUPTED_MESSAGE
        # Vitesse et ETA d'un job arrêté seraient trompeurs dans l'UI.
        assert persisted.speed is None and persisted.eta is None


async def test_start_purges_stale_temp_residue_but_keeps_resumable_jobs(job_queue) -> None:
    """Le dossier temporaire persiste désormais : au démarrage, il faut jeter ce qui n'est
    plus reprenable (et les cookie-jars laissés par un SIGKILL) sans toucher au reste."""
    queue, engine, settings = job_queue

    orphan = settings.temp_dir / "11111111-1111-4111-8111-111111111111"
    orphan.mkdir(parents=True)
    (orphan / "download.mp4.part").write_bytes(b"o" * 128)

    done_id = _create_job(engine, settings, filename="fini.mp4")
    queue.update(done_id, status=JobStatus.DONE)
    done_dir = queue.work_dir(done_id)
    done_dir.mkdir(parents=True)

    paused_id = _create_job(engine, settings, filename="suspendu.mp4")
    queue.update(paused_id, status=JobStatus.PAUSED)
    kept = queue.work_dir(paused_id)
    kept.mkdir(parents=True)
    (kept / "download.mp4.part").write_bytes(b"k" * 128)

    jar_dir = cookie_jar_dir(settings.temp_dir)
    jar_dir.mkdir(parents=True)
    stale_jar = jar_dir / "ez-dl-cookies-abcdef.txt"
    stale_jar.write_text("secret")
    legacy_jar = settings.temp_dir / "ez-dl-cookies-legacy.txt"
    legacy_jar.write_text("secret")

    # `EZDL_TEMP_DIR` peut être partagé : ce qui n'est pas à ez-dl reste intact.
    stranger = settings.temp_dir / "not-ours.txt"
    stranger.write_text("keep")
    stranger_dir = settings.temp_dir / "autre-appli"
    stranger_dir.mkdir()

    await queue.start()
    await queue.shutdown()

    assert not orphan.exists()
    assert not done_dir.exists()
    assert kept.exists()
    assert (kept / "download.mp4.part").read_bytes() == b"k" * 128
    assert not stale_jar.exists()
    assert not legacy_jar.exists()
    assert jar_dir.is_dir()  # point de montage tmpfs : on purge son contenu, pas lui
    assert stranger.exists()
    assert stranger_dir.exists()
