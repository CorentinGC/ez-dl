"""Tests de `app.security.require_auth` : 401 sans/avec mauvais mot de passe, 200 si
valide ; `/api/health` reste accessible sans authentification."""

from __future__ import annotations

from tests.conftest import TEST_PASSWORD


def test_health_accessible_without_auth(client) -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


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
