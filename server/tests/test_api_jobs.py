"""Tests de `POST /api/jobs` : validation de destination, persistance en `queued`."""

from __future__ import annotations

from tests.conftest import TEST_PASSWORD

AUTH = {"Authorization": f"Bearer {TEST_PASSWORD}"}


def test_create_job_outside_root_returns_400(client_no_worker, tmp_path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()

    response = client_no_worker.post(
        "/api/jobs",
        json={"url": "https://example.com/video", "folder": str(outside), "filename": "video.mp4"},
        headers=AUTH,
    )

    assert response.status_code == 400


def test_create_job_valid_persists_as_queued(client_no_worker, download_root) -> None:
    response = client_no_worker.post(
        "/api/jobs",
        json={
            "url": "https://example.com/video",
            "folder": str(download_root),
            "filename": "video.mp4",
        },
        headers=AUTH,
    )

    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "queued"
    assert body["job_id"]

    detail = client_no_worker.get(f"/api/jobs/{body['job_id']}", headers=AUTH)
    assert detail.status_code == 200
    detail_body = detail.json()
    assert detail_body["status"] == "queued"
    assert detail_body["filename"] == "video.mp4"
    assert detail_body["folder"] == str(download_root)


def test_create_job_requires_auth(client_no_worker, download_root) -> None:
    response = client_no_worker.post(
        "/api/jobs",
        json={"url": "https://example.com/video", "folder": str(download_root)},
    )
    assert response.status_code == 401
