"""Tests de `app.core.cookies` : le cookie-jar temporaire reste dans `EZDL_TEMP_DIR`,
en permissions 0600, et disparaît quoi qu'il arrive."""

from __future__ import annotations

import stat
from pathlib import Path

import pytest

from app.core.cookies import cookie_jar_file
from app.schemas import CookieItem

COOKIE = CookieItem(name="auth_token", value="s3cr3t", domain=".example.com", path="/")


def test_jar_is_created_in_temp_dir_with_0600(tmp_path: Path) -> None:
    """Le fichier doit vivre dans `EZDL_TEMP_DIR` (monté en tmpfs par le compose), pas dans
    le `/tmp` du système, et n'être lisible que par son propriétaire."""
    temp_dir = tmp_path / "ez-dl"

    with cookie_jar_file([COOKIE], temp_dir) as path:
        assert path is not None
        assert path.parent == temp_dir
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert "s3cr3t" in path.read_text(encoding="utf-8")


def test_jar_is_deleted_after_context(tmp_path: Path) -> None:
    with cookie_jar_file([COOKIE], tmp_path) as path:
        assert path is not None
        created = path
    assert not created.exists()


def test_jar_is_deleted_even_on_exception(tmp_path: Path) -> None:
    """Une exception pendant l'appel yt-dlp ne doit jamais laisser de cookies sur disque."""
    created: Path | None = None

    with pytest.raises(RuntimeError):
        with cookie_jar_file([COOKIE], tmp_path) as path:
            created = path
            raise RuntimeError("échec yt-dlp simulé")

    assert created is not None
    assert not created.exists()


def test_no_file_created_without_cookies(tmp_path: Path) -> None:
    """Sans cookie, aucun fichier n'est écrit du tout."""
    with cookie_jar_file(None, tmp_path) as path:
        assert path is None
    assert list(tmp_path.iterdir()) == []


def test_cookie_item_rejects_control_characters() -> None:
    """Un caractère de contrôle casserait le format TSV du cookie-jar : yt-dlp recopierait
    alors la ligne fautive (donc le cookie) sur stderr."""
    with pytest.raises(ValueError):
        CookieItem(name="a\tb", value="v", domain=".example.com")
    with pytest.raises(ValueError):
        CookieItem(name="a", value="v\nDOMAIN\tTRUE\t/", domain=".example.com")
