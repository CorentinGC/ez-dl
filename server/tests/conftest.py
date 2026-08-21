"""Fixtures partagées : réglages de test isolés, aucun accès réseau ni binaire réel."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings

TEST_PASSWORD = "test-secret"


@pytest.fixture(autouse=True)
def _reset_settings_cache():
    """Vide le cache de `Settings` avant/après chaque test (isolation des variables d'env)."""
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def download_root(tmp_path):
    """Crée un dossier racine de téléchargement temporaire."""
    root = tmp_path / "downloads"
    root.mkdir()
    return root


@pytest.fixture
def base_env(monkeypatch, tmp_path, download_root):
    """Configure les variables d'environnement `EZDL_*` minimales pour un serveur de test."""
    monkeypatch.setenv("EZDL_PASSWORD", TEST_PASSWORD)
    monkeypatch.setenv("EZDL_DOWNLOAD_ROOTS", f"Downloads={download_root}")
    monkeypatch.setenv("EZDL_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("EZDL_TEMP_DIR", str(tmp_path / "temp"))
    monkeypatch.setenv("EZDL_YTDLP_UPDATE_INTERVAL_HOURS", "0")
    get_settings.cache_clear()
    return get_settings()


def _stub_external_binaries(monkeypatch) -> None:
    """Remplace les appels yt-dlp/ffmpeg du lifespan par des stubs (aucun binaire réel)."""
    import app.core.ffmpeg as ffmpeg_module
    import app.core.ytdlp as ytdlp_module

    async def _fake_detect_encoders(binary: str) -> dict:
        return {}

    async def _fake_is_available(binary: str) -> bool:
        return True

    async def _fake_version(binary: str) -> str:
        return "2024.01.01"

    async def _fake_update(binary: str, *, timeout: float = 120.0) -> str:
        return ""

    monkeypatch.setattr(ffmpeg_module, "detect_encoders", _fake_detect_encoders)
    monkeypatch.setattr(ffmpeg_module, "is_available", _fake_is_available)
    monkeypatch.setattr(ytdlp_module, "version", _fake_version)
    monkeypatch.setattr(ytdlp_module, "update", _fake_update)


@pytest.fixture
def client(base_env, monkeypatch):
    """`TestClient` avec lifespan actif ; workers de la file démarrés normalement."""
    _stub_external_binaries(monkeypatch)
    from app.main import create_app

    with TestClient(create_app()) as test_client:
        yield test_client


@pytest.fixture
def client_no_worker(base_env, monkeypatch):
    """`TestClient` dont la file de jobs ne démarre pas de worker : les jobs créés
    restent observables à l'état `queued` (worker mocké)."""
    _stub_external_binaries(monkeypatch)

    from app.core.queue import JobQueue

    async def _noop_start(self) -> None:
        return None

    monkeypatch.setattr(JobQueue, "start", _noop_start)

    from app.main import create_app

    with TestClient(create_app()) as test_client:
        yield test_client
