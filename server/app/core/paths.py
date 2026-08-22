"""Résolution et validation des chemins de destination contre les racines autorisées."""

from __future__ import annotations

import os
import re
from pathlib import Path

from app.config import DownloadRoot

_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")
_MAX_FILENAME_LENGTH = 180

# Entrées de métadonnées créées par les NAS/OS sur les volumes partagés (comparaison en
# minuscules) : jamais des destinations légitimes, et du bruit dans le navigateur de dossiers.
# Cas vécu : une racine Synology dont le seul sous-dossier est `@eaDir` — l'utilisateur n'a
# que lui à choisir, et le téléchargement part dans un dossier masqué par DSM/SMB.
_SYSTEM_ENTRY_NAMES = frozenset(
    {
        "@eadir",  # Synology DSM — vignettes et index
        "#recycle",  # Synology — corbeille
        "#snapshot",  # Synology — snapshots
        "@recycle",  # QNAP — corbeille
        "$recycle.bin",  # Windows — corbeille
        "system volume information",  # Windows
        "lost+found",  # ext4
        "thumbs.db",  # Windows — cache de vignettes
    }
)


def is_system_entry(name: str) -> bool:
    """Vrai pour une entrée cachée (préfixe `.`) ou système (métadonnées NAS/OS) :
    à masquer du navigateur de dossiers."""
    return name.startswith(".") or name.lower() in _SYSTEM_ENTRY_NAMES


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
    """Cause d'indisponibilité d'une racine **à destination de l'opérateur** (logs), ou `None`.

    La validation de chemin est lexicale : elle ne dit rien de l'état réel du disque. Une
    racine déclarée mais non montée (ou montée en lecture seule / avec un autre uid) doit
    être détectée ici, sinon l'échec n'arrive qu'au déplacement final, téléchargement fait.

    Ce message cite l'uid du process et le fichier de montage à corriger : il va dans les
    logs serveur, jamais dans une réponse HTTP (voir `_client_issue`).
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


def _client_issue(root: DownloadRoot) -> str:
    """Message d'indisponibilité destiné au client : ce qu'il doit savoir, rien de plus.

    L'uid d'exécution et la topologie de montage n'ont aucune utilité côté client et
    renseignent gratuitement sur l'infrastructure — ils restent dans les logs serveur.
    """
    return (
        f"Destination indisponible : la racine « {root.label} » n'est pas montée ou n'est pas "
        "accessible en écriture côté serveur. Voir les logs du serveur pour le détail."
    )


def unavailable_roots(roots: list[DownloadRoot]) -> list[tuple[DownloadRoot, str]]:
    """Liste les racines inutilisables avec leur cause (pour l'avertissement de démarrage)."""
    issues = ((root, root_issue(root)) for root in roots)
    return [(root, issue) for root, issue in issues if issue is not None]


def _available_root(resolved: Path, roots: list[DownloadRoot]) -> DownloadRoot:
    """Retourne la racine autorisée ET utilisable qui contient `resolved`, ou lève."""
    root = next((root for root in roots if _under_root(resolved, root)), None)
    if root is None:
        raise PathSecurityError(f"Le dossier {str(resolved)!r} n'est sous aucune racine autorisée")
    if root_issue(root) is not None:
        raise RootUnavailableError(_client_issue(root))
    return root


def _reject_system_components(resolved: Path, root: DownloadRoot) -> None:
    """Refuse un chemin dont un composant **sous la racine** est un dossier système.

    Seuls les noms système exacts sont refusés, pas les dot-dossiers : ceux-ci sont masqués
    du navigateur mais restent utilisables comme destination explicite (ex. `.incoming`).
    """
    relative = resolved.relative_to(root.path.resolve())
    for part in relative.parts:
        if part.lower() in _SYSTEM_ENTRY_NAMES:
            raise PathSecurityError(
                f"Destination refusée : « {part} » est un dossier système (métadonnées NAS/OS)."
            )


def resolve_folder(folder: str, roots: list[DownloadRoot]) -> Path:
    """Résout un chemin de dossier et vérifie qu'il est sous une racine autorisée ET utilisable."""
    # Pas de `expanduser()` : le contrat exige un chemin absolu, `~` ne peut désigner qu'un
    # home du process (jamais une racine légitime), et il lève `RuntimeError` — donc un 500 —
    # sur un `~utilisateur` inconnu, cas courant sous un uid Docker sans entrée /etc/passwd.
    candidate = Path(folder)
    if not candidate.is_absolute():
        raise PathSecurityError(f"Chemin de dossier invalide (doit être absolu) : {folder!r}")
    resolved = candidate.resolve()
    root = _available_root(resolved, roots)
    _reject_system_components(resolved, root)
    return resolved


def resolve_destination(folder: str, filename: str, roots: list[DownloadRoot]) -> Path:
    """Résout `folder/filename` (nom sanitizé) et vérifie qu'il reste sous une racine
    autorisée ET utilisable. Lève `PathSecurityError` sinon (à convertir en 400 côté API)."""
    safe_name = sanitize_filename(filename)
    folder_path = resolve_folder(folder, roots)
    destination = (folder_path / safe_name).resolve()
    # Même contrôle que sur le dossier : un lien symbolique pourrait faire sortir la
    # destination de la racine validée, ou la faire retomber sur une racine indisponible.
    root = _available_root(destination, roots)
    _reject_system_components(destination, root)
    return destination


def remove_destination_file(folder: str, filename: str, roots: list[DownloadRoot]) -> bool:
    """Supprime le fichier final d'un job terminé, après re-validation complète du chemin.

    Le chemin n'est jamais reconstruit naïvement : il repasse par `resolve_destination`, donc
    un dossier devenu hors racine (ou une racine démontée) lève au lieu d'effacer quoi que ce
    soit. `is_file()` écarte les dossiers : cette fonction ne supprime jamais d'arborescence.

    Retourne `False` si le fichier a déjà disparu — la suppression reste idempotente,
    l'utilisateur a pu déplacer ou effacer le fichier lui-même entre-temps.
    """
    destination = resolve_destination(folder, filename, roots)
    if not destination.is_file():
        return False
    destination.unlink(missing_ok=True)
    return True
