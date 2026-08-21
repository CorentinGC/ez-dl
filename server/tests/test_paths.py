"""Tests de `app.core.paths` : `sanitize_filename`, `resolve_destination`, disponibilité
réelle des racines de téléchargement."""

from __future__ import annotations

import os

import pytest

from app.config import DownloadRoot
from app.core.paths import (
    PathSecurityError,
    RootUnavailableError,
    resolve_destination,
    root_issue,
    sanitize_filename,
    unavailable_roots,
)

# root ignore les bits de permission : le test de racine non inscriptible n'y a aucun sens.
skip_if_root = pytest.mark.skipif(os.getuid() == 0, reason="root ignore les permissions")


def test_sanitize_filename_removes_path_traversal() -> None:
    assert ".." not in sanitize_filename("../../etc/passwd")
    assert "/" not in sanitize_filename("../../etc/passwd")


def test_sanitize_filename_removes_control_chars() -> None:
    result = sanitize_filename("video\x00\x1f.mp4")
    assert "\x00" not in result
    assert "\x1f" not in result
    assert result.endswith(".mp4")


def test_sanitize_filename_limits_length_and_keeps_extension() -> None:
    long_name = ("a" * 300) + ".mp4"
    result = sanitize_filename(long_name)
    assert len(result) <= 180
    assert result.endswith(".mp4")


def test_sanitize_filename_empty_falls_back_to_default() -> None:
    assert sanitize_filename("") == "download"


def test_sanitize_filename_dots_only_stays_safe() -> None:
    result = sanitize_filename("...")
    assert result
    assert ".." not in result
    assert "/" not in result


def test_resolve_destination_valid_subfolder(tmp_path) -> None:
    root = tmp_path / "downloads"
    root.mkdir()
    subfolder = root / "movies"
    subfolder.mkdir()
    roots = [DownloadRoot(label="Downloads", path=root)]

    destination = resolve_destination(str(subfolder), "movie.mp4", roots)

    assert destination == (subfolder / "movie.mp4").resolve()


def test_resolve_destination_outside_root_raises(tmp_path) -> None:
    root = tmp_path / "downloads"
    root.mkdir()
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    roots = [DownloadRoot(label="Downloads", path=root)]

    with pytest.raises(PathSecurityError):
        resolve_destination(str(outside), "movie.mp4", roots)


def test_resolve_destination_traversal_outside_root_raises(tmp_path) -> None:
    root = tmp_path / "downloads"
    root.mkdir()
    roots = [DownloadRoot(label="Downloads", path=root)]

    with pytest.raises(PathSecurityError):
        resolve_destination(str(root / ".." / "escape"), "movie.mp4", roots)


def test_resolve_destination_rejects_missing_root(tmp_path) -> None:
    """Racine déclarée mais non montée : refus immédiat, pas après le téléchargement."""
    root = tmp_path / "not-mounted"
    roots = [DownloadRoot(label="Downloads", path=root)]

    with pytest.raises(RootUnavailableError) as excinfo:
        resolve_destination(str(root), "movie.mp4", roots)

    message = str(excinfo.value)
    assert "n'existe pas" in message
    assert str(root) in message  # message actionnable : le chemin fautif est nommé


@skip_if_root
def test_resolve_destination_rejects_readonly_root(tmp_path) -> None:
    """Racine montée en lecture seule (ou appartenant à un autre uid) : même refus."""
    root = tmp_path / "downloads"
    root.mkdir()
    root.chmod(0o500)
    roots = [DownloadRoot(label="Downloads", path=root)]
    try:
        with pytest.raises(RootUnavailableError) as excinfo:
            resolve_destination(str(root), "movie.mp4", roots)
    finally:
        root.chmod(0o700)

    assert "écriture" in str(excinfo.value)


def test_root_issue_none_when_root_is_usable(tmp_path) -> None:
    root = tmp_path / "downloads"
    root.mkdir()

    assert root_issue(DownloadRoot(label="Downloads", path=root)) is None


def test_unavailable_roots_lists_only_broken_roots(tmp_path) -> None:
    """L'avertissement de démarrage doit citer chaque racine cassée, et elles seules."""
    usable = tmp_path / "usable"
    usable.mkdir()
    missing = tmp_path / "missing"
    not_a_dir = tmp_path / "file.txt"
    not_a_dir.write_text("x")
    roots = [
        DownloadRoot(label="Usable", path=usable),
        DownloadRoot(label="Missing", path=missing),
        DownloadRoot(label="File", path=not_a_dir),
    ]

    reported = unavailable_roots(roots)

    assert [root.label for root, _ in reported] == ["Missing", "File"]
    assert "n'existe pas" in reported[0][1]
    assert "n'est pas un dossier" in reported[1][1]
