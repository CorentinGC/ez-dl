"""Zip de l'extension avec la clé publique du serveur dans `manifest.json` (champ `key`).

Sans `key`, Chrome dérive l'identifiant d'une extension non empaquetée du chemin de son
dossier : la supprimer ou la recharger depuis un autre dossier change l'identifiant, et
`storage.local` (serveurs, mot de passe, dossiers favoris) repart vide (ez-dl-vjr). Avec la
clé publique de signature du serveur, l'identifiant est fixe, le même que celui du `.crx`
signé, quel que soit le dossier.

Le zip est réécrit une fois puis mis en cache sous un nom dérivé de son contenu source et de
l'identifiant de clé : un rebuild de l'image ou une rotation de clé produit un nouveau zip.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import uuid
import zipfile
from pathlib import Path

from app.core import crx

logger = logging.getLogger(__name__)

_MANIFEST_NAME = "manifest.json"
_CACHE_PREFIX = "ez-dl-extension-keyed"
_CACHE_DIGEST_CHARS = 16


def add_key_to_archive(archive: Path, target: Path, public_key: bytes) -> bool:
    """Copie `archive` vers `target` en posant `key` dans le manifeste racine.

    Retourne `False` (rien n'est écrit) si l'archive est illisible ou n'a pas de
    `manifest.json` racine exploitable.
    Les entrées sont recopiées avec leurs métadonnées d'origine : seul le manifeste change.
    """
    try:
        source = zipfile.ZipFile(archive)
    except zipfile.BadZipFile:
        return False
    with source:
        try:
            manifest = json.loads(source.read(_MANIFEST_NAME))
        except (KeyError, ValueError):
            return False
        if not isinstance(manifest, dict):
            return False
        manifest["key"] = base64.b64encode(public_key).decode("ascii")
        staging = target.with_name(f".{target.name}.{uuid.uuid4().hex}.part")
        try:
            with zipfile.ZipFile(staging, "w", zipfile.ZIP_DEFLATED) as output:
                for info in source.infolist():
                    if info.filename == _MANIFEST_NAME:
                        payload = json.dumps(manifest, indent=2, ensure_ascii=False).encode()
                    else:
                        payload = source.read(info)
                    output.writestr(info, payload, compress_type=zipfile.ZIP_DEFLATED)
            # Écriture atomique : une requête concurrente ne lit jamais un zip partiel.
            os.replace(staging, target)
        finally:
            staging.unlink(missing_ok=True)
    return True


def build_keyed_zip(archive: Path, cache_dir: Path, key_dir: Path) -> Path:
    """Retourne le zip « à clé » correspondant à `archive` (reconstruit seulement s'il a changé).

    Repli sur `archive` tel quel si son manifeste est introuvable : l'extension reste
    installable, seulement avec un identifiant dépendant du dossier. Lève `OSError` si le
    cache ou la clé ne peuvent être écrits.
    """
    public_key = crx.public_key_der(crx.load_or_create_key(key_dir))
    source_digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    key_id = crx.extension_id(public_key)
    digest = hashlib.sha256(f"{source_digest}:{key_id}".encode()).hexdigest()
    target = cache_dir / f"{_CACHE_PREFIX}-{digest[:_CACHE_DIGEST_CHARS]}.zip"
    if target.exists():
        return target

    cache_dir.mkdir(parents=True, exist_ok=True)
    if not add_key_to_archive(archive, target, public_key):
        logger.warning("Zip d'extension illisible ou sans manifest.json racine : servi sans clé.")
        return archive

    for stale in cache_dir.glob(f"{_CACHE_PREFIX}-*.zip"):
        if stale.name != target.name:
            stale.unlink(missing_ok=True)
    return target
