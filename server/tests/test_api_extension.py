"""Tests des routes publiques `/extension` : page d'installation, `.crx` signé, zip et version
publiée, avec et sans artefact embarqué dans l'image."""

from __future__ import annotations

import hashlib
from xml.etree import ElementTree

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
    assert "/extension/zip" in response.text


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


def test_install_page_leads_with_the_zip_not_the_crx(app_client, published):
    """Chrome refuse tout `.crx` auto-signé déposé sur `chrome://extensions`
    (`CRX_REQUIRED_PROOF_MISSING`) : la page ne doit pas proposer ce geste comme voie
    d'installation."""
    page = app_client.get("/extension").text

    assert '<a class="download" href="/extension/zip"' in page, "le zip est la voie principale"
    assert "Charger l'extension non empaquetée" in page
    assert "CRX_REQUIRED_PROOF_MISSING" in page, "l'échec du glisser-déposer doit être annoncé"
    assert "Glisser le fichier" not in page


def test_install_page_shows_the_zip_digest_and_the_signed_package_identity(app_client, published):
    identity = app_client.get("/extension/version").json()["extension_id"]

    page = app_client.get("/extension").text

    assert hashlib.sha256(ARCHIVE).hexdigest() in page, "empreinte de l'artefact réellement servi"
    assert identity in page, "identifiant du paquet signé, pour l'installation par politique"


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
    assert "ez-dl-extension.zip" in page.text, "repli sur le nom générique"


def test_update_manifest_matches_the_published_identity_and_version(app_client, published):
    """Chrome compare la version annoncée à celle du `.crx` installé, et n'installe que si
    `appid` correspond à la clé qui a signé le paquet."""
    response = app_client.get("/extension/update.xml")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/xml")
    assert response.headers["cache-control"] == "no-store"

    root = ElementTree.fromstring(response.text)
    assert root.tag == "{http://www.google.com/update2/response}gupdate"
    assert root.get("protocol") == "2.0"
    app = root[0]
    assert app.get("appid") == app_client.get("/extension/version").json()["extension_id"]
    check = app[0]
    assert check.get("version") == VERSION
    assert check.get("codebase", "").endswith("/extension/download")


def test_update_manifest_uses_the_configured_public_url(app_client, published, monkeypatch):
    """Derrière un reverse proxy, l'hôte vu par uvicorn n'est pas celui du navigateur : une
    `codebase` déduite de la requête pointerait une adresse inatteignable."""
    monkeypatch.setenv("EZDL_PUBLIC_URL", "https://ez-dl.example.com/")
    get_settings.cache_clear()

    codebase = ElementTree.fromstring(app_client.get("/extension/update.xml").text)[0][0].get(
        "codebase"
    )

    assert codebase == "https://ez-dl.example.com/extension/download"


def test_update_manifest_refuses_to_announce_an_unknown_version(app_client, dist_dir):
    """Un manifeste sans version exploitable ferait boucler Chrome sur le téléchargement."""
    (dist_dir / ZIP_FILENAME).write_bytes(ARCHIVE)

    response = app_client.get("/extension/update.xml")

    assert response.status_code == 503
    assert "version" in response.json()["detail"]


def test_update_manifest_returns_404_without_artifact(app_client, dist_dir):
    assert app_client.get("/extension/update.xml").status_code == 404


def test_install_page_shows_the_forcelist_value(app_client, published):
    """La politique système prend `<identifiant>;<url du manifeste>` — jamais l'URL du
    `.crx` — et c'est cette valeur exacte que la page doit donner à copier."""
    identity = app_client.get("/extension/version").json()["extension_id"]

    page = app_client.get("/extension").text

    assert f"{identity};http://testserver/extension/update.xml" in page
    assert "ExtensionInstallForcelist" in page


def test_zip_route_refuses_a_symlinked_artifact(app_client, dist_dir, tmp_path):
    """Un lien déposé dans le dossier d'artefacts ferait servir — et signer — un fichier
    arbitraire sur une route publique."""
    secret = tmp_path / "secret.txt"
    secret.write_text("contenu hors du dossier d'artefacts")
    (dist_dir / ZIP_FILENAME).symlink_to(secret)

    assert app_client.get("/extension/zip").status_code == 404
    assert app_client.get("/extension/download").status_code == 404
    assert app_client.get("/extension/version").json()["available"] is False
