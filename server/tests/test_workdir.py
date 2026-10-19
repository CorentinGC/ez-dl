"""Tests de `app.core.workdir` : déplacement, copie inter-volumes, réservation de nom."""

from __future__ import annotations

import errno
import shutil
from pathlib import Path

import pytest

from app.core import workdir
from app.core.workdir import atomic_move, final_name, move_to_reserved, reserve_destination


def _force_cross_device(monkeypatch) -> None:
    """Fait échouer `Path.replace` en EXDEV, comme entre un volume temporaire et un NAS."""
    original = Path.replace

    def replace(self: Path, target):
        if self.parent.name == "src":
            raise OSError(errno.EXDEV, "Invalid cross-device link")
        return original(self, target)

    monkeypatch.setattr(Path, "replace", replace)


def _source(tmp_path: Path, name: str = "download.mkv", content: bytes = b"data") -> Path:
    (tmp_path / "src").mkdir(exist_ok=True)
    source = tmp_path / "src" / name
    source.write_bytes(content)
    return source


def test_cross_device_move_copies_through_a_hidden_temp_then_replaces(
    tmp_path, monkeypatch
) -> None:
    _force_cross_device(monkeypatch)
    source = _source(tmp_path)
    destination = tmp_path / "dst" / "video.mkv"
    destination.parent.mkdir()
    seen: list[list[str]] = []
    real_replace = workdir.os.replace

    def spy(src, dst):
        seen.append(sorted(p.name for p in destination.parent.iterdir()))
        real_replace(src, dst)

    monkeypatch.setattr(workdir.os, "replace", spy)

    atomic_move(source, destination)

    # Jamais de fichier tronqué sous le nom final : un seul fichier, temporaire et caché.
    assert len(seen) == 1 and len(seen[0]) == 1
    assert seen[0][0].startswith(".ezdl-") and seen[0][0].endswith(".tmp")
    assert destination.read_bytes() == b"data"
    assert not source.exists()
    assert [p.name for p in destination.parent.iterdir()] == ["video.mkv"]


def test_failed_copy_leaves_no_temp_file_and_keeps_the_source(tmp_path, monkeypatch) -> None:
    _force_cross_device(monkeypatch)
    source = _source(tmp_path)
    destination = tmp_path / "dst" / "video.mkv"
    destination.parent.mkdir()

    def broken_copy(origin, target):
        target.write(b"tron")
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(shutil, "copyfileobj", broken_copy)

    with pytest.raises(OSError):
        atomic_move(source, destination)

    assert list(destination.parent.iterdir()) == []
    assert source.exists()


def test_other_oserror_is_not_masked_by_a_copy(tmp_path, monkeypatch) -> None:
    source = _source(tmp_path)

    def denied(self: Path, target):
        raise PermissionError(errno.EACCES, "denied")

    monkeypatch.setattr(Path, "replace", denied)

    with pytest.raises(PermissionError):
        atomic_move(source, tmp_path / "video.mkv")


def test_reserve_destination_never_hands_out_the_same_name_twice(tmp_path) -> None:
    destination = tmp_path / "film.mkv"

    first = reserve_destination(destination)
    second = reserve_destination(destination)

    assert first == destination
    assert second == tmp_path / "film (2).mkv"
    assert first.exists() and second.exists()


def test_move_to_reserved_releases_the_name_on_failure(tmp_path) -> None:
    missing = tmp_path / "nope.mkv"

    with pytest.raises(OSError):
        move_to_reserved(missing, tmp_path / "out" / "film.mkv")

    assert list((tmp_path / "out").iterdir()) == []


def test_move_to_reserved_never_overwrites(tmp_path) -> None:
    (tmp_path / "out").mkdir()
    (tmp_path / "out" / "film.mkv").write_bytes(b"ORIGINAL")
    source = _source(tmp_path, content=b"nouveau")

    final = move_to_reserved(source, tmp_path / "out" / "film.mkv")

    assert final.name == "film (2).mkv"
    assert (tmp_path / "out" / "film.mkv").read_bytes() == b"ORIGINAL"
    assert final.read_bytes() == b"nouveau"


@pytest.mark.parametrize(
    ("requested", "produced", "expected"),
    [
        ("video.mp4", "download.mkv", "video.mkv"),
        ("video.mp4", "download.mp4", "video.mp4"),
        ("Season.1", "download.mkv", "Season.1.mkv"),  # `.1` fait partie du titre
        ("video", "download.webm", "video.webm"),
        ("video.mp4", "download", "video.mp4"),
    ],
)
def test_final_name_takes_the_real_container_suffix(
    tmp_path, requested: str, produced: str, expected: str
) -> None:
    assert final_name(tmp_path / requested, tmp_path / produced) == tmp_path / expected


def test_cross_device_copy_never_follows_a_planted_symlink(tmp_path, monkeypatch) -> None:
    """Un lien posé à l'avance sous l'ancien nom temporaire prévisible n'est jamais suivi."""
    _force_cross_device(monkeypatch)
    source = _source(tmp_path)
    victim = tmp_path / "victim.db"
    victim.write_bytes(b"precious")
    destination = tmp_path / "dst" / "video.mkv"
    destination.parent.mkdir()
    (destination.parent / ".video.mkv.ezdl-tmp").symlink_to(victim)

    atomic_move(source, destination)

    assert victim.read_bytes() == b"precious"
    assert destination.read_bytes() == b"data"
