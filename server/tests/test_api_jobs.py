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


def _create_queued_job(client, download_root, filename: str = "video.mp4") -> str:
    """Crée un job et retourne son identifiant (worker mocké : il reste `queued`)."""
    response = client.post(
        "/api/jobs",
        json={
            "url": "https://example.com/video",
            "folder": str(download_root),
            "filename": filename,
        },
        headers=AUTH,
    )
    assert response.status_code == 201
    return response.json()["job_id"]


def test_pause_then_resume_a_queued_job(client_no_worker, download_root) -> None:
    """Un job encore en attente se suspend sans process à interrompre, et se reprend."""
    job_id = _create_queued_job(client_no_worker, download_root)

    paused = client_no_worker.post(f"/api/jobs/{job_id}/pause", headers=AUTH)
    assert paused.status_code == 200
    assert paused.json()["status"] == "paused"

    resumed = client_no_worker.post(f"/api/jobs/{job_id}/resume", headers=AUTH)
    assert resumed.status_code == 200
    assert resumed.json()["status"] == "queued"
    assert resumed.json()["error"] is None


def test_resume_accepts_a_re_supplied_cookie_context(client_no_worker, download_root) -> None:
    """Le serveur ne persiste pas les cookies : la reprise d'une page authentifiée doit
    pouvoir les re-fournir."""
    job_id = _create_queued_job(client_no_worker, download_root)
    client_no_worker.post(f"/api/jobs/{job_id}/pause", headers=AUTH)

    resumed = client_no_worker.post(
        f"/api/jobs/{job_id}/resume",
        json={
            "cookies": [{"name": "sid", "value": "abc", "domain": ".example.com"}],
            "referer": "https://example.com/watch",
        },
        headers=AUTH,
    )

    assert resumed.status_code == 200
    assert resumed.json()["status"] == "queued"


def test_resume_rejects_a_job_that_is_not_stopped(client_no_worker, download_root) -> None:
    """Reprendre un job déjà en attente n'a pas de sens : 409, pas un doublon dans la file."""
    job_id = _create_queued_job(client_no_worker, download_root)

    response = client_no_worker.post(f"/api/jobs/{job_id}/resume", headers=AUTH)

    assert response.status_code == 409
    assert "queued" in response.json()["detail"]


def test_resume_toward_an_unmounted_root_returns_400(client_no_worker, download_root) -> None:
    """Racine démontée entre-temps : la reprise échoue tout de suite, pas après coup."""
    job_id = _create_queued_job(client_no_worker, download_root)
    client_no_worker.post(f"/api/jobs/{job_id}/pause", headers=AUTH)
    download_root.rmdir()

    response = client_no_worker.post(f"/api/jobs/{job_id}/resume", headers=AUTH)

    assert response.status_code == 400
    assert "n'est pas montée" in response.json()["detail"]


def test_pause_unknown_job_returns_404(client_no_worker) -> None:
    assert client_no_worker.post("/api/jobs/does-not-exist/pause", headers=AUTH).status_code == 404


def test_pause_and_resume_require_auth(client_no_worker, download_root) -> None:
    job_id = _create_queued_job(client_no_worker, download_root)

    assert client_no_worker.post(f"/api/jobs/{job_id}/pause").status_code == 401
    assert client_no_worker.post(f"/api/jobs/{job_id}/resume").status_code == 401


def test_delete_purges_the_work_directory_of_a_paused_job(
    client_no_worker, download_root, base_env
) -> None:
    """Supprimer un job suspendu doit emporter son fichier partiel : sans cela, un job
    effacé de l'historique laisserait ses mégaoctets dans EZDL_TEMP_DIR pour toujours."""
    job_id = _create_queued_job(client_no_worker, download_root)
    client_no_worker.post(f"/api/jobs/{job_id}/pause", headers=AUTH)
    work_dir = base_env.temp_dir / job_id
    work_dir.mkdir(parents=True)
    (work_dir / "download.mp4.part").write_bytes(b"partiel")

    assert client_no_worker.delete(f"/api/jobs/{job_id}", headers=AUTH).status_code == 204

    assert not work_dir.exists()
    assert client_no_worker.get(f"/api/jobs/{job_id}", headers=AUTH).status_code == 404
