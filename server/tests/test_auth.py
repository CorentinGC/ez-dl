"""Tests de `app.security.require_auth` : 401 sans/avec mauvais mot de passe, 200 si
valide ; `/api/health` et les routes `/extension` restent accessibles sans authentification."""

from __future__ import annotations

import pytest

from tests.conftest import TEST_PASSWORD

# Routes délibérément ouvertes : sonde de santé et distribution de l'extension (ADR 0004).
# Toute nouvelle entrée ici est une décision de sécurité, pas un détail d'implémentation.
PUBLIC_ROUTES = [
    "/api/health",
    "/extension",
    "/extension/download",
    "/extension/zip",
    "/extension/version",
]


def test_health_accessible_without_auth(client) -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


@pytest.mark.parametrize("path", PUBLIC_ROUTES)
def test_public_routes_never_answer_401(client, path: str) -> None:
    """Les routes publiques répondent sans en-tête `Authorization` (404 possible quand
    l'artefact d'extension n'est pas embarqué, mais jamais 401)."""
    assert client.get(path).status_code != 401


def test_protected_route_without_header_returns_401(client) -> None:
    response = client.get("/api/jobs")
    assert response.status_code == 401


def test_protected_route_with_wrong_password_returns_401(client) -> None:
    response = client.get("/api/jobs", headers={"Authorization": "Bearer wrong-password"})
    assert response.status_code == 401


def test_protected_route_with_correct_password_returns_200(client) -> None:
    response = client.get("/api/jobs", headers={"Authorization": f"Bearer {TEST_PASSWORD}"})
    assert response.status_code == 200
    assert response.json() == []


async def test_non_ascii_token_raises_401_not_type_error(base_env) -> None:
    """`secrets.compare_digest` lève `TypeError` sur des `str` non-ASCII, ce qui donnerait un
    500 au lieu d'un 401. Testé sous la couche HTTP : httpx refuse d'émettre un tel en-tête,
    mais Starlette décode les octets bruts d'un client quelconque en latin-1."""
    from fastapi import HTTPException
    from fastapi.security import HTTPAuthorizationCredentials

    from app.security import require_auth

    credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials="mot-de-passé")

    with pytest.raises(HTTPException) as exc_info:
        await require_auth(credentials=credentials, settings=base_env)

    assert exc_info.value.status_code == 401


async def test_non_ascii_password_still_authenticates(base_env, monkeypatch) -> None:
    """Un `EZDL_PASSWORD` accentué doit rester utilisable (et non casser toutes les routes)."""
    from fastapi.security import HTTPAuthorizationCredentials

    from app.security import require_auth

    monkeypatch.setattr(base_env, "password", "mot-de-passé-accentué")
    credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials="mot-de-passé-accentué")

    assert await require_auth(credentials=credentials, settings=base_env) is None
