"""Cycle de vie de la file : entrées périmées, arrêt du serveur, arrêts demandés pendant le
lancement, redémarrage, drainage de stderr et cadence de progression."""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

from sqlmodel import Session

from app.core import ytdlp
from app.core.queue import INTERRUPTED_MESSAGE
from app.models import Job, JobStatus
from tests.queue_helpers import (
    HangingProcess,
    create_job,
    finished_process,
    install_fake_ytdlp,
    install_hanging_ytdlp,
    wait_until_running,
)


def _job(engine, job_id: str) -> Job:
    with Session(engine) as session:
        job = session.get(Job, job_id)
        assert job is not None
        return job


async def test_stale_queue_entry_does_not_strip_the_running_job(job_queue, monkeypatch) -> None:
    """Pause puis reprise d'un job `queued` laissent deux entrées pour un même id. Celle qui
    est ignorée ne doit pas effacer le process du run en cours : le job deviendrait
    inannulable (téléchargement fantôme)."""
    queue, engine, settings = job_queue
    job_id = create_job(engine, settings)
    install_hanging_ytdlp(monkeypatch, [])
    queue.enqueue(job_id)  # pose le contexte, comme `POST /api/jobs`

    running = asyncio.create_task(queue._run_job(job_id))
    await wait_until_running(queue, job_id)
    process = queue._processes[job_id]

    await queue._run_job(job_id)  # l'entrée périmée : le job est déjà pris

    assert queue._processes[job_id] is process
    assert job_id in queue._contexts
    queue.cancel(job_id)
    await running
    assert _job(engine, job_id).status == JobStatus.CANCELED.value
    assert process.returncode is not None  # le process a bien été tué


async def test_shutdown_kills_process_groups_and_suspends_jobs(job_queue, monkeypatch) -> None:
    """Annuler les seules tasks laisserait yt-dlp tourner : l'arrêt tue les groupes, et le
    job est suspendu (reprenable) avec son motif, pas classé en erreur."""
    queue, engine, settings = job_queue
    job_id = create_job(engine, settings)
    install_hanging_ytdlp(monkeypatch, [])

    await queue.start()  # ré-enfile le job `queued`
    await wait_until_running(queue, job_id)
    process = queue._processes[job_id]
    await queue.shutdown()

    assert process.returncode is not None
    job = _job(engine, job_id)
    assert job.status == JobStatus.PAUSED.value
    assert job.error == INTERRUPTED_MESSAGE
    assert queue._workers == []


async def test_cancelling_the_task_kills_the_process_group(job_queue, monkeypatch) -> None:
    """`CancelledError` en pleine phase de téléchargement ne doit pas orpheliner le process."""
    queue, engine, settings = job_queue
    job_id = create_job(engine, settings)
    install_hanging_ytdlp(monkeypatch, [])

    task = asyncio.create_task(queue._run_job(job_id))
    await wait_until_running(queue, job_id)
    process = queue._processes[job_id]
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)

    assert task.cancelled()
    assert process.returncode is not None


async def _stop_requested_while_spawning(job_queue, monkeypatch, request: str) -> Job:
    """Lance un job dont l'arrêt (`cancel`/`pause`) est demandé *avant* l'enregistrement du
    process : `cancel()` ne voit alors aucun process à signaler."""
    queue, engine, settings = job_queue
    job_id = create_job(engine, settings)

    async def fake_start_download(url: str, output_template: Path, **kwargs: object):
        getattr(queue, request)(job_id)
        return HangingProcess()

    monkeypatch.setattr(ytdlp, "start_download", fake_start_download)
    await queue._run_job(job_id)
    return _job(engine, job_id)


async def test_cancel_requested_while_spawning_is_honoured(job_queue, monkeypatch) -> None:
    job = await _stop_requested_while_spawning(job_queue, monkeypatch, "cancel")

    assert job.status == JobStatus.CANCELED.value


async def test_pause_requested_while_spawning_is_honoured(job_queue, monkeypatch) -> None:
    job = await _stop_requested_while_spawning(job_queue, monkeypatch, "pause")

    assert job.status == JobStatus.PAUSED.value


async def test_cancel_after_the_download_stops_before_the_move(job_queue, monkeypatch) -> None:
    """Annulation arrivée alors que le process s'était déjà terminé proprement : rien ne
    fait échouer la phase, c'est la re-vérification avant déplacement qui doit l'arrêter."""
    queue, engine, settings = job_queue
    job_id = create_job(engine, settings)

    async def fake_start_download(url: str, output_template: Path, **kwargs: object):
        work_dir = Path(output_template).parent
        work_dir.mkdir(parents=True, exist_ok=True)
        (work_dir / "download.mp4").write_bytes(b"x")
        queue.cancel(job_id)  # aucun process enregistré : le signal ne part nulle part
        return finished_process()

    monkeypatch.setattr(ytdlp, "start_download", fake_start_download)
    await queue._run_job(job_id)

    assert _job(engine, job_id).status == JobStatus.CANCELED.value
    assert not (settings.roots[0].path / "video.mp4").exists()
    assert not queue.work_dir(job_id).exists()


async def test_start_requeues_jobs_left_queued_in_the_database(job_queue) -> None:
    """La file vit en mémoire : un job encore `queued` après un redémarrage n'a plus
    d'entrée et resterait en attente pour toujours."""
    queue, engine, settings = job_queue
    first = create_job(engine, settings, filename="a.mp4")
    second = create_job(engine, settings, filename="b.mp4")
    done = create_job(engine, settings, filename="c.mp4")
    queue.update(done, status=JobStatus.DONE)

    await queue.start()
    try:
        assert queue._queue.qsize() == 2
        queued = [queue._queue.get_nowait(), queue._queue.get_nowait()]
        assert sorted(queued) == sorted([first, second])
    finally:
        await queue.shutdown()


def _process_failing_with_stderr(lines: list[bytes]) -> SimpleNamespace:
    """Process factice qui sort en échec après avoir écrit `lines` sur stderr."""
    stderr = asyncio.StreamReader()
    for line in lines:
        stderr.feed_data(line)
    stderr.feed_eof()

    async def wait() -> int:
        return 1

    return SimpleNamespace(stdout=None, stderr=stderr, returncode=1, wait=wait, pid=-1)


async def test_error_message_comes_from_the_drained_stderr_tail(job_queue, monkeypatch) -> None:
    """stderr est drainé en continu (un pipe plein bloquerait yt-dlp) ; seules les dernières
    lignes sont gardées, et l'erreur utile s'y trouve."""
    queue, engine, settings = job_queue
    job_id = create_job(engine, settings)
    noise = [b"WARNING: bruit " + str(i).encode() * 50 + b"\n" for i in range(2_000)]
    process = _process_failing_with_stderr([*noise, b"ERROR: video indisponible\n"])

    async def fake_start_download(url: str, output_template: Path, **kwargs: object):
        return process

    monkeypatch.setattr(ytdlp, "start_download", fake_start_download)
    await queue._run_job(job_id)

    job = _job(engine, job_id)
    assert job.status == JobStatus.ERROR.value
    assert job.error is not None
    assert "code 1" in job.error and "video indisponible" in job.error


async def test_progress_writes_are_throttled(job_queue, monkeypatch) -> None:
    """Cent lignes de progression en rafale ne doivent pas faire cent commits + diffusions."""
    queue, engine, settings = job_queue
    job_id = create_job(engine, settings)
    subscriber = queue.broadcaster.subscribe()
    install_fake_ytdlp(monkeypatch, {"download.mp4": b"x"})

    async def burst(process: object, on_progress) -> None:
        for step in range(1, 101):
            await on_progress({"downloaded_bytes": step, "total_bytes": 100, "speed": 1.0})

    monkeypatch.setattr(ytdlp, "stream_progress", burst)
    await queue._run_job(job_id)

    snapshots = []
    while not subscriber.empty():
        snapshots.append(subscriber.get_nowait())
    progressing = [s for s in snapshots if s.status == JobStatus.DOWNLOADING and s.speed]
    assert len(progressing) == 1
    assert snapshots[-1].status == JobStatus.DONE  # les changements de statut ne sont pas retenus


async def test_download_receives_proxy_and_playlist_items(job_queue, monkeypatch) -> None:
    queue, engine, settings = job_queue
    job_id = create_job(engine, settings)
    queue.update(job_id, playlist_items=2)
    queue._settings = settings.model_copy(update={"proxy": "http://proxy.local:8888"})
    seen: dict[str, object] = {}

    async def fake_start_download(url: str, output_template: Path, **kwargs: object):
        seen.update(kwargs)
        return HangingProcess()

    monkeypatch.setattr(ytdlp, "start_download", fake_start_download)
    queue.pause(job_id)  # le process factice est stoppé dès son enregistrement
    await queue._run_job(job_id)

    assert seen["proxy"] == "http://proxy.local:8888"
    assert seen["playlist_items"] == 2
