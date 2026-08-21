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


async def test_run_job_persists_numeric_progress_and_real_final_size(
    job_queue, monkeypatch
) -> None:
    """Pipeline complet d'un job (download -> move) : `speed`/`eta` restent numériques et
    `size` final reflète la taille réelle du fichier déplacé, pas la dernière estimation."""
    queue, engine, settings = job_queue

    with Session(engine) as session:
        job = Job(
            url="https://example.com/video",
            folder=str(settings.roots[0].path),
            filename="video.mp4",
            status=JobStatus.QUEUED.value,
        )
        session.add(job)
        session.commit()
        session.refresh(job)
        job_id = job.id

    downloaded_bytes = b"x" * 4_200_000

    async def fake_start_download(url: str, destination: Path, **kwargs: object) -> SimpleNamespace:
        # Simule yt-dlp qui écrit le fichier temporaire final directement (pas de flux réel ici).
        Path(destination).write_bytes(downloaded_bytes)
        return SimpleNamespace(stdout=None, stderr=None, returncode=0, kill=lambda: None)

    async def fake_stream_progress(process: object, on_progress) -> None:
        if on_progress is None:
            return
        # Frame de progression brute telle qu'émise par `--progress-template` (valeurs numériques).
        await on_progress(
            {
                "downloaded_bytes": len(downloaded_bytes),
                "total_bytes": len(downloaded_bytes),
                "speed": 39_200_000.5,
                "eta": 0,
            }
        )

    async def fake_wait_download(process: object) -> None:
        return None

    monkeypatch.setattr(ytdlp, "start_download", fake_start_download)
    monkeypatch.setattr(ytdlp, "stream_progress", fake_stream_progress)
    monkeypatch.setattr(ytdlp, "wait_download", fake_wait_download)

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
