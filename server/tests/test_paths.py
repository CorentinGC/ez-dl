"""Tests de `app.core.paths` : `sanitize_filename` et `resolve_destination`."""

from __future__ import annotations

import pytest

from app.config import DownloadRoot
from app.core.paths import PathSecurityError, resolve_destination, sanitize_filename


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
