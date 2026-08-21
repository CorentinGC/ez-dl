"""Résolution et validation des chemins de destination contre les racines autorisées."""

from __future__ import annotations

import re
from pathlib import Path

from app.config import DownloadRoot

_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")
_MAX_FILENAME_LENGTH = 180


class PathSecurityError(ValueError):
    """Levée quand un chemin résolu sort des racines de téléchargement autorisées."""


def sanitize_filename(name: str) -> str:
    """Nettoie un nom de fichier : retire séparateurs, `..`, caractères de contrôle,
    limite la longueur (~180 caractères) en préservant l'extension."""
    cleaned = _CONTROL_CHARS_RE.sub("", name)
    cleaned = cleaned.replace("/", "_").replace("\\", "_").replace("..", "_")
    cleaned = cleaned.strip().strip(".")
    if not cleaned:
        return "download"
    if len(cleaned) <= _MAX_FILENAME_LENGTH:
        return cleaned
    stem, dot, ext = cleaned.rpartition(".")
    if dot and stem and 0 < len(ext) <= 10:
        max_stem = _MAX_FILENAME_LENGTH - len(ext) - 1
        return f"{stem[:max_stem]}.{ext}"
    return cleaned[:_MAX_FILENAME_LENGTH]


def _under_root(candidate: Path, root: DownloadRoot) -> bool:
    """Vrai si `candidate` est la racine elle-même ou un de ses descendants."""
    root_resolved = root.path.resolve()
    return candidate == root_resolved or candidate.is_relative_to(root_resolved)


def resolve_folder(folder: str, roots: list[DownloadRoot]) -> Path:
    """Résout un chemin de dossier et vérifie qu'il est sous une des racines autorisées."""
    candidate = Path(folder).expanduser()
    if not candidate.is_absolute():
        raise PathSecurityError(f"Chemin de dossier invalide (doit être absolu) : {folder!r}")
    resolved = candidate.resolve()
    if any(_under_root(resolved, root) for root in roots):
        return resolved
    raise PathSecurityError(f"Le dossier {folder!r} n'est sous aucune racine autorisée")


def resolve_destination(folder: str, filename: str, roots: list[DownloadRoot]) -> Path:
    """Résout `folder/filename` (nom sanitizé) et vérifie qu'il reste sous une racine
    autorisée. Lève `PathSecurityError` sinon (à convertir en 400 côté API)."""
    safe_name = sanitize_filename(filename)
    folder_path = resolve_folder(folder, roots)
    destination = (folder_path / safe_name).resolve()
    if any(_under_root(destination, root) for root in roots):
        return destination
    raise PathSecurityError(f"Destination hors des racines autorisées : {destination}")
