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


def test_create_job_rejects_option_like_format_id(client_no_worker, download_root) -> None:
    """`format_id` finit en argument de `-f` : une valeur en `-` serait lue par yt-dlp comme
    une option et produirait une erreur opaque. Refus au schéma (ez-dl-b6e)."""
    response = client_no_worker.post(
        "/api/jobs",
        json={
            "url": "https://example.com/video",
            "folder": str(download_root),
            "filename": "video.mp4",
            "format_id": "--exec=touch /tmp/pwned",
        },
        headers=AUTH,
    )

    assert response.status_code == 422


def test_create_job_persists_the_requested_format_id(client_no_worker, download_root) -> None:
    """Le `format_id` choisi dans la popup doit survivre jusqu'au job : c'est lui qui
    alimente `build_format_selector` au téléchargement."""
    response = client_no_worker.post(
        "/api/jobs",
        json={
            "url": "https://example.com/video",
            "folder": str(download_root),
            "filename": "video.mp4",
            "format_id": "137",
        },
        headers=AUTH,
    )

    assert response.status_code == 201
    detail = client_no_worker.get(f"/api/jobs/{response.json()['job_id']}", headers=AUTH)
    assert detail.json()["format_id"] == "137"


def _create_done_job(client, download_root, filename: str = "video.mp4") -> str:
    """Crée un job puis le force en `done`, comme après un déplacement réussi.

    Le fichier de destination est écrit sur le disque : c'est lui que `delete_file` doit
    effacer (ou épargner par défaut).
    """
    from app.models import JobStatus

    job_id = _create_queued_job(client, download_root, filename=filename)
    client.app.state.job_queue.update(job_id, status=JobStatus.DONE, progress=100.0)
    (download_root / filename).write_bytes(b"contenu")
    return job_id


def test_delete_keeps_the_downloaded_file_by_default(client_no_worker, download_root) -> None:
    """Comportement par défaut : « Supprimer » retire la ligne d'historique, pas le fichier.

    C'est l'ambiguïté que la modale de la popup lève (ez-dl-f4z) — le défaut doit rester le
    geste non destructif."""
    job_id = _create_done_job(client_no_worker, download_root)

    assert client_no_worker.delete(f"/api/jobs/{job_id}", headers=AUTH).status_code == 204

    assert (download_root / "video.mp4").is_file()
    assert client_no_worker.get(f"/api/jobs/{job_id}", headers=AUTH).status_code == 404


def test_delete_with_delete_file_removes_the_downloaded_file(
    client_no_worker, download_root
) -> None:
    job_id = _create_done_job(client_no_worker, download_root)

    response = client_no_worker.delete(f"/api/jobs/{job_id}?delete_file=true", headers=AUTH)

    assert response.status_code == 204
    assert not (download_root / "video.mp4").exists()
    assert client_no_worker.get(f"/api/jobs/{job_id}", headers=AUTH).status_code == 404


def test_delete_with_delete_file_is_idempotent_when_the_file_is_gone(
    client_no_worker, download_root
) -> None:
    """Fichier déplacé ou effacé à la main entre-temps : la ligne part quand même."""
    job_id = _create_done_job(client_no_worker, download_root)
    (download_root / "video.mp4").unlink()

    response = client_no_worker.delete(f"/api/jobs/{job_id}?delete_file=true", headers=AUTH)

    assert response.status_code == 204
    assert client_no_worker.get(f"/api/jobs/{job_id}", headers=AUTH).status_code == 404


def test_delete_file_is_refused_on_a_job_that_never_finished(
    client_no_worker, download_root
) -> None:
    """Un job non terminé n'a pas écrit sa destination : `folder/filename` peut désigner le
    fichier d'un job homonyme qui, lui, a réussi. Refus (409) plutôt qu'effacement à côté."""
    survivor = _create_done_job(client_no_worker, download_root)
    failed = _create_queued_job(client_no_worker, download_root, filename="video.mp4")

    response = client_no_worker.delete(f"/api/jobs/{failed}?delete_file=true", headers=AUTH)

    assert response.status_code == 409
    assert (download_root / "video.mp4").is_file()
    # Le job visé est intact : rien n'a été supprimé de l'historique non plus.
    assert client_no_worker.get(f"/api/jobs/{failed}", headers=AUTH).status_code == 200
    assert client_no_worker.get(f"/api/jobs/{survivor}", headers=AUTH).status_code == 200


def test_delete_file_toward_an_unmounted_root_returns_400_and_keeps_the_job(
    client_no_worker, download_root
) -> None:
    """Racine démontée : refuser plutôt que perdre la seule référence au fichier restant."""
    job_id = _create_done_job(client_no_worker, download_root)
    (download_root / "video.mp4").unlink()
    download_root.rmdir()

    response = client_no_worker.delete(f"/api/jobs/{job_id}?delete_file=true", headers=AUTH)

    assert response.status_code == 400
    assert client_no_worker.get(f"/api/jobs/{job_id}", headers=AUTH).status_code == 200


def test_create_job_targeting_system_folder_returns_400(client_no_worker, download_root) -> None:
    """Un favori/défaut client resté sur `@eaDir` doit produire une erreur claire à la
    création du job, pas un téléchargement dans un dossier invisible."""
    (download_root / "@eaDir").mkdir()

    response = client_no_worker.post(
        "/api/jobs",
        json={
            "url": "https://example.com/video",
            "folder": str(download_root / "@eaDir"),
            "filename": "video.mp4",
        },
        headers=AUTH,
    )

    assert response.status_code == 400


# ---------------------------------------------------------------------------
# GET /api/jobs/lookup — déjà téléchargé ? (ez-dl-av7)
# ---------------------------------------------------------------------------


def _lookup(client, url: str, download_root=None, filename: str | None = None):
    params = {"url": url}
    if download_root is not None:
        params["folder"] = str(download_root)
    if filename is not None:
        params["filename"] = filename
    return client.get("/api/jobs/lookup", params=params, headers=AUTH)


def test_lookup_reports_nothing_on_a_fresh_server(client_no_worker, download_root) -> None:
    response = _lookup(client_no_worker, "https://example.com/video", download_root, "video.mp4")

    assert response.status_code == 200
    assert response.json() == {"found": False, "reason": None, "job": None, "file_exists": False}


def test_lookup_matches_a_previous_job_by_url(client_no_worker, download_root) -> None:
    job_id = _create_done_job(client_no_worker, download_root)

    body = _lookup(client_no_worker, "https://example.com/video").json()

    assert body["found"] is True
    assert body["reason"] == "url"
    assert body["job"]["id"] == job_id


def test_lookup_ignores_the_query_string_of_signed_cdn_urls(
    client_no_worker, download_root
) -> None:
    """Deux liens signés d'une même vidéo ne partagent que schéma, hôte et chemin."""
    _create_done_job(client_no_worker, download_root)

    body = _lookup(client_no_worker, "https://example.com/video?token=abc&expires=1").json()

    assert body["found"] is True
    assert body["reason"] == "url"


def test_lookup_does_not_match_another_video_on_the_same_host(
    client_no_worker, download_root
) -> None:
    _create_done_job(client_no_worker, download_root)

    assert _lookup(client_no_worker, "https://example.com/autre").json()["found"] is False


def test_lookup_ignores_canceled_and_failed_jobs(client_no_worker, download_root) -> None:
    """Un job annulé ou en erreur n'a rien livré : proposer de le refaire est le bon défaut."""
    from app.models import JobStatus

    job_id = _create_queued_job(client_no_worker, download_root)
    client_no_worker.app.state.job_queue.update(job_id, status=JobStatus.CANCELED)

    assert _lookup(client_no_worker, "https://example.com/video").json()["found"] is False


def test_lookup_prefers_the_finished_job_over_a_newer_pending_one(
    client_no_worker, download_root
) -> None:
    done_id = _create_done_job(client_no_worker, download_root)
    _create_queued_job(client_no_worker, download_root)

    assert _lookup(client_no_worker, "https://example.com/video").json()["job"]["id"] == done_id


def test_lookup_detects_an_existing_file_without_any_job(client_no_worker, download_root) -> None:
    """Historique purgé, ou même vidéo atteinte par une autre URL : le fichier fait foi."""
    (download_root / "video.mp4").write_bytes(b"deja la")

    body = _lookup(client_no_worker, "https://autre.example/v", download_root, "video.mp4").json()

    assert body == {"found": True, "reason": "file", "job": None, "file_exists": True}


def test_lookup_sanitizes_the_candidate_filename(client_no_worker, download_root) -> None:
    (download_root / "video.mp4").write_bytes(b"deja la")

    body = _lookup(
        client_no_worker, "https://autre.example/v", download_root, "  video.mp4 "
    ).json()

    assert body["file_exists"] is True


def test_lookup_answers_no_on_a_destination_outside_the_roots(
    client_no_worker, download_root, tmp_path
) -> None:
    """Une destination invalide n'est pas une erreur ici : la création du job la refusera."""
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "video.mp4").write_bytes(b"hors racine")

    body = _lookup(client_no_worker, "https://autre.example/v", outside, "video.mp4").json()

    assert body == {"found": False, "reason": None, "job": None, "file_exists": False}


def test_lookup_requires_authentication(client_no_worker) -> None:
    assert (
        client_no_worker.get("/api/jobs/lookup", params={"url": "https://x/y"}).status_code == 401
    )
