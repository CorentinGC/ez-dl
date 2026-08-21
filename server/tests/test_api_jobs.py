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


def test_create_job_unmounted_root_returns_400_before_downloading(
    client_no_worker, download_root
) -> None:
    """Racine déclarée mais absente du disque (volume non monté) : le job doit être refusé
    à la création — sinon l'échec n'arrive qu'au déplacement, mégaoctets téléchargés."""
    download_root.rmdir()

    response = client_no_worker.post(
        "/api/jobs",
        json={
            "url": "https://example.com/video",
            "folder": str(download_root),
            "filename": "video.mp4",
        },
        headers=AUTH,
    )

    assert response.status_code == 400
    detail = response.json()["detail"]
    assert "Downloads" in detail and "n'est pas montée" in detail
    assert "uid" not in detail  # le détail d'infrastructure reste dans les logs serveur
    # Aucun job n'a été créé : rien à nettoyer côté historique.
    assert client_no_worker.get("/api/jobs", headers=AUTH).json() == []


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


def test_create_job_rejects_option_like_url(client_no_worker, download_root) -> None:
    """Une URL commençant par `-` serait parsée par yt-dlp comme une option (`--exec`...) :
    elle doit être refusée par le schéma avant d'atteindre le subprocess."""
    response = client_no_worker.post(
        "/api/jobs",
        json={
            "url": "--exec=touch /tmp/pwned",
            "folder": str(download_root),
            "filename": "video.mp4",
        },
        headers=AUTH,
    )

    assert response.status_code == 422


def test_create_job_rejects_non_http_scheme(client_no_worker, download_root) -> None:
    """`file://` permettrait de faire lire un fichier local du conteneur à yt-dlp."""
    response = client_no_worker.post(
        "/api/jobs",
        json={"url": "file:///etc/passwd", "folder": str(download_root), "filename": "v.mp4"},
        headers=AUTH,
    )

    assert response.status_code == 422


def test_probe_rejects_option_like_url(client_no_worker) -> None:
    """Même protection sur les deux variantes de `/api/probe`."""
    get_response = client_no_worker.get("/api/probe?url=--version", headers=AUTH)
    post_response = client_no_worker.post("/api/probe", json={"url": "--version"}, headers=AUTH)

    assert get_response.status_code == 422
    assert post_response.status_code == 422
