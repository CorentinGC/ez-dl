"""Tests des routes publiques de marque (`/favicon.ico`, `/favicon.svg`,
`/apple-touch-icon.png`).

L'enjeu tenu ici est l'absence d'authentification : un navigateur ne joint aucun en-tête
`Authorization` à une requête de favicon, donc une régression qui protégerait ces routes
casserait l'icône d'onglet sans qu'aucun autre test ne le voie.
"""

from __future__ import annotations

import pytest

from app.api.brand import router as brand_router

# (chemin, type MIME attendu, préfixe d'octets qui identifie le format)
BRAND_ROUTES = [
    ("/favicon.ico", "image/x-icon", b"\x00\x00\x01\x00"),
    ("/favicon.svg", "image/svg+xml", b"<svg"),
    ("/apple-touch-icon.png", "image/png", b"\x89PNG"),
]


@pytest.mark.parametrize(("path", "media_type", "magic"), BRAND_ROUTES)
def test_asset_served_without_authentication(client, path, media_type, magic):
    """Servi en 200 sans en-tête `Authorization`, avec le bon type et un contenu non vide."""
    response = client.get(path)

    assert response.status_code == 200
    assert response.headers["content-type"].startswith(media_type)
    assert response.content.startswith(magic)


@pytest.mark.parametrize(("path", "media_type", "magic"), BRAND_ROUTES)
def test_asset_is_cacheable(client, path, media_type, magic):
    """Un `Cache-Control` public est posé : ces fichiers ne changent qu'à un rebuild d'image."""
    response = client.get(path)

    assert "public" in response.headers["cache-control"]


def test_assets_stay_out_of_the_openapi_schema(client):
    """Routes de marque absentes du schéma : ce ne sont pas des points d'entrée d'API."""
    paths = client.get("/openapi.json").json()["paths"]

    for path, _media_type, _magic in BRAND_ROUTES:
        assert path not in paths


def test_favicon_ico_declares_several_resolutions():
    """Le `.ico` est assemblé à la main par `assets/render.mjs` : on vérifie que le fichier
    livré contient bien plusieurs images, sinon l'empaquetage a régressé en silence."""
    from app.api.brand import _STATIC_DIR

    header = (_STATIC_DIR / "favicon.ico").read_bytes()[:6]
    image_count = int.from_bytes(header[4:6], "little")

    assert image_count >= 2


def test_router_exposes_exactly_the_expected_paths():
    """Aucune route de marque ajoutée sans test : la liste ci-dessus fait foi."""
    declared = {route.path for route in brand_router.routes}

    assert declared == {path for path, _media_type, _magic in BRAND_ROUTES}
