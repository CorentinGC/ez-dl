"""Tests de `app.core.queue` : progression numérique et pipeline complet d'un job."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlmodel import Session

from app.config import Settings
from app.core import ytdlp
from app.core.queue import JobQueue, _progress_fields
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


def _install_fake_ytdlp(monkeypatch, produced: dict[str, bytes], progress=None) -> list[Path]:
    """Simule yt-dlp : écrit `produced` (nom -> contenu) dans le dossier du template `-o`.

    Le vrai binaire choisit lui-même le nom de sortie (il impose l'extension du conteneur
    réellement produit) : le fake reçoit donc un template, pas un chemin final.
    Retourne la liste des dossiers de travail utilisés, pour vérifier leur nettoyage.
    """
    work_dirs: list[Path] = []

    async def fake_start_download(url: str, output_template: Path, **kwargs: object):
        work_dir = Path(output_template).parent
        work_dirs.append(work_dir)
        assert "%(ext)s" in Path(output_template).name, "le nom de sortie ne doit pas être deviné"
        work_dir.mkdir(parents=True, exist_ok=True)
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
    assert work_dirs and not work_dirs[0].exists()
