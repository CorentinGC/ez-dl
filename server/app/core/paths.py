"""Résolution et validation des chemins de destination contre les racines autorisées."""

from __future__ import annotations

import os
import re
from pathlib import Path

from app.config import DownloadRoot

_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")
_MAX_FILENAME_LENGTH = 180


class PathSecurityError(ValueError):
    """Levée quand un chemin résolu sort des racines de téléchargement autorisées."""


class RootUnavailableError(PathSecurityError):
    """Levée quand la racine visée est déclarée mais inutilisable (absente, non inscriptible).

    Sous-classe de `PathSecurityError` pour hériter du même traitement `400` côté API : le
    but est de refuser le job **avant** le téléchargement plutôt qu'à l'écriture finale.
    """


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


def root_issue(root: DownloadRoot) -> str | None:
    """Décrit pourquoi une racine est inutilisable, ou `None` si elle est prête à l'emploi.

    La validation de chemin est lexicale : elle ne dit rien de l'état réel du disque. Une
    racine déclarée mais non montée (ou montée en lecture seule / avec un autre uid) doit
    être détectée ici, sinon l'échec n'arrive qu'au déplacement final, téléchargement fait.
    """
    path = root.path
    if not path.exists():
        return (
            f"la racine « {root.label} » ({path}) n'existe pas côté serveur — monter ce chemin "
            "dans le conteneur (docker-compose.override.yml) ou corriger EZDL_DOWNLOAD_ROOTS"
        )
    if not path.is_dir():
        return f"la racine « {root.label} » ({path}) n'est pas un dossier"
    if not os.access(path, os.W_OK | os.X_OK):
        return (
            f"la racine « {root.label} » ({path}) n'est pas accessible en écriture pour "
            f"l'utilisateur du serveur (uid {os.getuid()}) — ajuster les permissions du volume"
        )
    return None


def unavailable_roots(roots: list[DownloadRoot]) -> list[tuple[DownloadRoot, str]]:
    """Liste les racines inutilisables avec leur cause (pour l'avertissement de démarrage)."""
    issues = ((root, root_issue(root)) for root in roots)
    return [(root, issue) for root, issue in issues if issue is not None]


def resolve_folder(folder: str, roots: list[DownloadRoot]) -> Path:
    """Résout un chemin de dossier et vérifie qu'il est sous une racine autorisée ET utilisable."""
    candidate = Path(folder).expanduser()
    if not candidate.is_absolute():
        raise PathSecurityError(f"Chemin de dossier invalide (doit être absolu) : {folder!r}")
    resolved = candidate.resolve()
    root = next((root for root in roots if _under_root(resolved, root)), None)
    if root is None:
        raise PathSecurityError(f"Le dossier {folder!r} n'est sous aucune racine autorisée")
    issue = root_issue(root)
    if issue is not None:
        raise RootUnavailableError(f"Destination indisponible : {issue}")
    return resolved


def resolve_destination(folder: str, filename: str, roots: list[DownloadRoot]) -> Path:
    """Résout `folder/filename` (nom sanitizé) et vérifie qu'il reste sous une racine
    autorisée. Lève `PathSecurityError` sinon (à convertir en 400 côté API)."""
    safe_name = sanitize_filename(filename)
    folder_path = resolve_folder(folder, roots)
    destination = (folder_path / safe_name).resolve()
    if any(_under_root(destination, root) for root in roots):
        return destination
    raise PathSecurityError(f"Destination hors des racines autorisées : {destination}")
