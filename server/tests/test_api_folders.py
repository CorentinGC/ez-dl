"""Tests de `/api/folders` : navigation, espace disque, création de sous-dossiers."""

from __future__ import annotations

from tests.conftest import TEST_PASSWORD

AUTH = {"Authorization": f"Bearer {TEST_PASSWORD}"}


def test_list_roots_reports_availability_and_disk_space(client_no_worker, download_root) -> None:
    """Une racine montée annonce l'espace disque du volume qui la porte."""
    response = client_no_worker.get("/api/folders", headers=AUTH)

    assert response.status_code == 200
    roots = response.json()["roots"]
    assert len(roots) == 1
    assert roots[0]["path"] == str(download_root)
    assert roots[0]["is_available"] is True
    assert roots[0]["free_bytes"] > 0
    assert roots[0]["total_bytes"] >= roots[0]["free_bytes"]


def test_list_roots_flags_unmounted_root_as_unavailable(client_no_worker, download_root) -> None:
    """Racine déclarée mais non montée : signalée indisponible, sans espace disque, plutôt
    que masquée — le client doit pouvoir expliquer pourquoi elle n'est pas sélectionnable."""
    download_root.rmdir()

    roots = client_no_worker.get("/api/folders", headers=AUTH).json()["roots"]

    assert roots[0]["is_available"] is False
    assert roots[0]["free_bytes"] is None
    assert roots[0]["total_bytes"] is None


def test_browse_folder_lists_subfolders_and_disk_space(client_no_worker, download_root) -> None:
    (download_root / "movies").mkdir()
    (download_root / "note.txt").write_text("x")

    body = client_no_worker.get(
        "/api/folders", params={"path": str(download_root)}, headers=AUTH
    ).json()

    assert body["current"]["path"] == str(download_root)
    assert body["current"]["free_bytes"] > 0
    names = {(e["name"], e["is_dir"]) for e in body["entries"]}
    assert ("movies", True) in names
    assert ("note.txt", False) in names


def test_create_folder_creates_directory_under_root(client_no_worker, download_root) -> None:
    response = client_no_worker.post(
        "/api/folders",
        json={"parent": str(download_root), "name": "Films 2026"},
        headers=AUTH,
    )

    assert response.status_code == 201
    body = response.json()
    assert body == {
        "name": "Films 2026",
        "path": str(download_root / "Films 2026"),
        "is_dir": True,
    }
    assert (download_root / "Films 2026").is_dir()


def test_create_folder_existing_returns_409(client_no_worker, download_root) -> None:
    (download_root / "movies").mkdir()

    response = client_no_worker.post(
        "/api/folders", json={"parent": str(download_root), "name": "movies"}, headers=AUTH
    )

    assert response.status_code == 409


def test_create_folder_rejects_traversal_name(client_no_worker, download_root, tmp_path) -> None:
    """Un nom porteur de `..` est refusé, jamais réécrit silencieusement."""
    response = client_no_worker.post(
        "/api/folders",
        json={"parent": str(download_root), "name": "../../escaped"},
        headers=AUTH,
    )

    assert response.status_code == 400
    assert not (tmp_path / "escaped").exists()
    assert not (download_root.parent / "escaped").exists()


def test_create_folder_rejects_empty_name(client_no_worker, download_root) -> None:
    response = client_no_worker.post(
        "/api/folders", json={"parent": str(download_root), "name": "   "}, headers=AUTH
    )

    assert response.status_code == 400


def test_create_folder_outside_root_returns_400(client_no_worker, tmp_path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()

    response = client_no_worker.post(
        "/api/folders", json={"parent": str(outside), "name": "loot"}, headers=AUTH
    )

    assert response.status_code == 400
    assert not (outside / "loot").exists()


def test_create_folder_rejects_name_that_sanitizing_would_rewrite(
    client_no_worker, download_root
) -> None:
    """Un nom que la sanitization modifierait est refusé : jamais de dossier créé sous un
    nom différent de celui demandé (ni de `download` surgi d'un nom de contrôle pur)."""
    response = client_no_worker.post(
        "/api/folders", json={"parent": str(download_root), "name": "\x01\x02"}, headers=AUTH
    )

    assert response.status_code == 400
    assert not (download_root / "download").exists()
    assert list(download_root.iterdir()) == []


def test_create_folder_does_not_build_deep_tree(client_no_worker, download_root) -> None:
    """La route crée UN dossier : un parent inexistant est refusé, pas matérialisé."""
    missing_parent = download_root / "a" / "b" / "c"

    response = client_no_worker.post(
        "/api/folders", json={"parent": str(missing_parent), "name": "d"}, headers=AUTH
    )

    assert response.status_code == 400
    assert not (download_root / "a").exists()


def test_create_folder_rejects_oversized_input(client_no_worker, download_root) -> None:
    """Les longueurs sont bornées par le schéma : pas d'`ENAMETOOLONG` remonté en 500."""
    response = client_no_worker.post(
        "/api/folders", json={"parent": str(download_root), "name": "z" * 500}, headers=AUTH
    )

    assert response.status_code == 422


def test_create_folder_requires_auth(client_no_worker, download_root) -> None:
    response = client_no_worker.post(
        "/api/folders", json={"parent": str(download_root), "name": "movies"}
    )

    assert response.status_code == 401
    assert not (download_root / "movies").exists()


def test_browse_folder_hides_system_and_hidden_entries(client_no_worker, download_root) -> None:
    """`@eaDir` & co ne sont jamais proposés : les lister envoie l'utilisateur télécharger
    dans un dossier invisible (cas vécu : racine Synology dont c'est le seul sous-dossier)."""
    (download_root / "@eaDir").mkdir()
    (download_root / "#recycle").mkdir()
    (download_root / ".DS_Store").write_text("x")
    (download_root / "Films").mkdir()

    body = client_no_worker.get(
        "/api/folders", params={"path": str(download_root)}, headers=AUTH
    ).json()

    assert {e["name"] for e in body["entries"]} == {"Films"}


def test_browse_system_folder_returns_400(client_no_worker, download_root) -> None:
    (download_root / "@eaDir").mkdir()

    response = client_no_worker.get(
        "/api/folders", params={"path": str(download_root / "@eaDir")}, headers=AUTH
    )

    assert response.status_code == 400


def test_create_folder_rejects_system_name(client_no_worker, download_root) -> None:
    response = client_no_worker.post(
        "/api/folders", json={"parent": str(download_root), "name": "@eaDir"}, headers=AUTH
    )

    assert response.status_code == 400
    assert not (download_root / "@eaDir").exists()
