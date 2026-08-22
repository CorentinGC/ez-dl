"""Tests des routes publiques `/extension` : page d'installation, `.crx` signé, zip et version
publiée, avec et sans artefact embarqué dans l'image."""

from __future__ import annotations

import hashlib

import pytest
from fastapi.testclient import TestClient

from app.api.extension import VERSION_FILENAME, ZIP_FILENAME
from app.config import get_settings

ARCHIVE = b"PK\x03\x04" + b"contenu-zip-factice" * 8
VERSION = "1.2.3"


@pytest.fixture
def dist_dir(monkeypatch, tmp_path):
    """Dossier d'artefacts vide, déclaré via `EZDL_EXTENSION_DIST_DIR`.

    Toujours pointé explicitement : un test ne doit pas dépendre de l'absence de `/app` sur
    la machine qui l'exécute.
    """
    path = tmp_path / "extension-dist"
    path.mkdir()
    monkeypatch.setenv("EZDL_EXTENSION_DIST_DIR", str(path))
    get_settings.cache_clear()
    return path


@pytest.fixture
def published(dist_dir):
    """Artefacts complets : zip publié et version issue du build."""
    (dist_dir / ZIP_FILENAME).write_bytes(ARCHIVE)
    (dist_dir / VERSION_FILENAME).write_text(f"{VERSION}\n")
    return dist_dir


@pytest.fixture
def app_client(base_env, monkeypatch):
    """Client de test sans worker de téléchargement (aucun job n'est créé ici)."""
    from tests.conftest import _stub_external_binaries

    _stub_external_binaries(monkeypatch)
    from app.core.queue import JobQueue

    async def _noop_start(self) -> None:
        return None

    monkeypatch.setattr(JobQueue, "start", _noop_start)
    from app.main import create_app

    with TestClient(create_app()) as client:
        yield client


def test_install_page_is_public_and_shows_the_published_version(app_client, published):
    response = app_client.get("/extension")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert VERSION in response.text
    assert "/extension/download" in response.text


def test_install_page_explains_when_no_extension_is_published(app_client, dist_dir):
    response = app_client.get("/extension")

    assert response.status_code == 200
    assert "Aucune extension" in response.text
    assert "/extension/download" not in response.text


def test_download_serves_a_signed_crx_wrapping_the_published_zip(app_client, published):
    response = app_client.get("/extension/download")

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/x-chrome-extension"
    assert f"ez-dl-extension-{VERSION}.crx" in response.headers["content-disposition"]

    blob = response.content
    assert blob[:4] == b"Cr24"
    header_size = int.from_bytes(blob[8:12], "little")
    assert blob[12 + header_size :] == ARCHIVE


def test_download_returns_an_actionable_404_without_artifact(app_client, dist_dir):
    response = app_client.get("/extension/download")

    assert response.status_code == 404
    assert "docker compose" in response.json()["detail"]


def test_download_keeps_a_generic_name_when_the_version_is_unknown(app_client, dist_dir):
    (dist_dir / ZIP_FILENAME).write_bytes(ARCHIVE)

    response = app_client.get("/extension/download")

    assert response.status_code == 200
    assert "ez-dl-extension.crx" in response.headers["content-disposition"]


def test_zip_route_serves_the_untouched_archive(app_client, published):
    response = app_client.get("/extension/zip")

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    assert f"ez-dl-extension-{VERSION}.zip" in response.headers["content-disposition"]
    assert response.content == ARCHIVE


def test_zip_route_returns_404_without_artifact(app_client, dist_dir):
    assert app_client.get("/extension/zip").status_code == 404


def test_version_route_describes_the_published_artifact(app_client, published):
    payload = app_client.get("/extension/version").json()

    assert payload["available"] is True
    assert payload["version"] == VERSION
    assert payload["filename"] == f"ez-dl-extension-{VERSION}.crx"
    assert payload["size"] > len(ARCHIVE)


def test_version_route_stays_silent_friendly_without_artifact(app_client, dist_dir):
    response = app_client.get("/extension/version")

    assert response.status_code == 200, (
        "un serveur sans artefact ne doit pas ressembler à une panne"
    )
    assert response.json() == {
        "available": False,
        "version": None,
        "filename": None,
        "size": None,
        "extension_id": None,
        "sha256": None,
    }


def test_version_route_reports_an_unknown_version(app_client, dist_dir):
    (dist_dir / ZIP_FILENAME).write_bytes(ARCHIVE)

    payload = app_client.get("/extension/version").json()

    assert payload["available"] is True
    assert payload["version"] is None


def test_crx_identity_is_stable_across_downloads(app_client, published):
    first = app_client.get("/extension/download").content
    second = app_client.get("/extension/download").content

    assert first == second, "la clé de signature doit être réutilisée, pas régénérée"


def test_version_route_publishes_the_crx_fingerprints(app_client, published):
    payload = app_client.get("/extension/version").json()

    assert len(payload["extension_id"]) == 32
    assert all("a" <= char <= "p" for char in payload["extension_id"])
    assert (
        payload["sha256"]
        == hashlib.sha256(app_client.get("/extension/download").content).hexdigest()
    )


def test_install_page_shows_the_expected_identity_and_digest(app_client, published):
    identity = app_client.get("/extension/version").json()["extension_id"]

    page = app_client.get("/extension").text

    assert identity in page, "sans identifiant attendu, une substitution du .crx est indétectable"
    assert hashlib.sha256(app_client.get("/extension/download").content).hexdigest() in page


@pytest.mark.parametrize(
    "hostile",
    ['1.0"><script>alert(1)</script>', "../../../../etc/passwd", "0.1.0-<img src=x>"],
)
def test_install_page_ignores_a_version_outside_the_numeric_format(app_client, published, hostile):
    """`extension-version.txt` vient d'un contexte de build, pas du code : une version hors
    format ne doit ni atteindre le HTML ni servir de composant de chemin."""
    (published / VERSION_FILENAME).write_text(hostile)

    page = app_client.get("/extension")

    assert page.status_code == 200
    assert "<script>" not in page.text
    assert "etc/passwd" not in page.text
    assert "ez-dl-extension.crx" in page.text, "repli sur le nom générique"


def test_zip_route_refuses_a_symlinked_artifact(app_client, dist_dir, tmp_path):
    """Un lien déposé dans le dossier d'artefacts ferait servir — et signer — un fichier
    arbitraire sur une route publique."""
    secret = tmp_path / "secret.txt"
    secret.write_text("contenu hors du dossier d'artefacts")
    (dist_dir / ZIP_FILENAME).symlink_to(secret)

    assert app_client.get("/extension/zip").status_code == 404
    assert app_client.get("/extension/download").status_code == 404
    assert app_client.get("/extension/version").json()["available"] is False
