"""Zip d'extension « à clé » : identifiant Chrome fixe pour la voie non empaquetée."""

from __future__ import annotations

import base64
import json
import zipfile
from pathlib import Path

from app.core import crx
from app.core.keyed_zip import build_keyed_zip


def _archive(path: Path, *, with_manifest: bool = True) -> Path:
    with zipfile.ZipFile(path, "w") as archive:
        if with_manifest:
            archive.writestr("manifest.json", json.dumps({"name": "ez-dl", "version": "1.2.3"}))
        archive.writestr("background.js", "console.log('ok')")
    return path


def test_manifest_gets_the_server_public_key(tmp_path) -> None:
    source = _archive(tmp_path / "ext.zip")

    keyed = build_keyed_zip(source, tmp_path / "cache", tmp_path)

    public_key = crx.public_key_der(crx.load_or_create_key(tmp_path))
    with zipfile.ZipFile(keyed) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        assert archive.read("background.js") == b"console.log('ok')"
    assert manifest["version"] == "1.2.3"
    assert base64.b64decode(manifest["key"]) == public_key
    # Même identifiant que le `.crx` signé : c'est tout l'intérêt de la clé.
    assert crx.extension_id(base64.b64decode(manifest["key"])) == crx.signing_identity(tmp_path)


def test_result_is_cached_and_stale_copies_are_purged(tmp_path) -> None:
    source = _archive(tmp_path / "ext.zip")
    cache = tmp_path / "cache"

    first = build_keyed_zip(source, cache, tmp_path)
    assert build_keyed_zip(source, cache, tmp_path) == first

    with zipfile.ZipFile(source, "a") as archive:
        archive.writestr("new.js", "x")
    second = build_keyed_zip(source, cache, tmp_path)

    assert second != first
    assert sorted(p.name for p in cache.glob("*.zip")) == [second.name]


def test_archive_without_root_manifest_is_served_as_is(tmp_path) -> None:
    source = _archive(tmp_path / "ext.zip", with_manifest=False)

    assert build_keyed_zip(source, tmp_path / "cache", tmp_path) == source
    assert list((tmp_path / "cache").glob("*.zip")) == []


def test_unreadable_archive_is_served_as_is(tmp_path) -> None:
    source = tmp_path / "ext.zip"
    source.write_bytes(b"pas un zip")

    assert build_keyed_zip(source, tmp_path / "cache", tmp_path) == source
