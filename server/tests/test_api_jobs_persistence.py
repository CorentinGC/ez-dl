"""`POST /api/jobs` (playlist_items), `lookup` filtré en SQL et abonnement SSE."""

from __future__ import annotations

from types import SimpleNamespace

from sqlmodel import Session

from app.api.jobs import job_events
from app.core.broadcaster import JobBroadcaster
from app.models import Job, JobStatus
from tests.conftest import TEST_PASSWORD

AUTH = {"Authorization": f"Bearer {TEST_PASSWORD}"}


def test_create_job_persists_playlist_items(client_no_worker, download_root) -> None:
    response = client_no_worker.post(
        "/api/jobs",
        json={
            "url": "https://x.com/user/status/1",
            "folder": str(download_root),
            "filename": "tweet.mp4",
            "playlist_items": 3,
        },
        headers=AUTH,
    )

    assert response.status_code == 201
    with Session(client_no_worker.app.state.engine) as session:
        job = session.get(Job, response.json()["job_id"])
        assert job is not None
        assert job.playlist_items == 3


def _insert_job(client, url: str, status: JobStatus = JobStatus.DONE) -> str:
    with Session(client.app.state.engine) as session:
        job = Job(url=url, folder="/mnt/media/movies", status=status.value)
        session.add(job)
        session.commit()
        return job.id


def _lookup(client, url: str) -> dict:
    return client.get("/api/jobs/lookup", params={"url": url}, headers=AUTH).json()


def test_lookup_matches_regardless_of_scheme_and_host_case(client_no_worker) -> None:
    job_id = _insert_job(client_no_worker, "HTTPS://Example.COM/video?token=abc")

    body = _lookup(client_no_worker, "https://example.com/video")

    assert body["found"] is True and body["job"]["id"] == job_id


def test_lookup_does_not_match_a_longer_path_sharing_the_prefix(client_no_worker) -> None:
    _insert_job(client_no_worker, "https://example.com/video2")

    assert _lookup(client_no_worker, "https://example.com/video")["found"] is False


def test_lookup_treats_like_wildcards_literally(client_no_worker) -> None:
    _insert_job(client_no_worker, "https://example.com/a1b")

    assert _lookup(client_no_worker, "https://example.com/a_b")["found"] is False
    assert _lookup(client_no_worker, "https://example.com/a%b")["found"] is False


async def test_job_events_subscribes_only_once_the_stream_is_iterated() -> None:
    """Abonner dans la route (hors générateur) fuirait une file par flux jamais itéré."""
    broadcaster = JobBroadcaster()
    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(job_queue=SimpleNamespace(broadcaster=broadcaster))
        )
    )

    await job_events(request)

    assert broadcaster._subscribers == set()
