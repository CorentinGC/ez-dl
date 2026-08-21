"""Routes `/api/folders` — navigation dans les racines de téléchargement autorisées et
création de sous-dossiers."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.config import DownloadRoot
from app.core.paths import resolve_destination, resolve_folder, root_issue, sanitize_filename
from app.schemas import (
    CurrentFolderOut,
    FolderCreate,
    FolderEntryOut,
    FoldersResponse,
    RootOut,
)
from app.security import require_auth

router = APIRouter(tags=["folders"], dependencies=[Depends(require_auth)])


def _under_any_root(candidate: Path, roots: list[DownloadRoot]) -> bool:
    """Vrai si `candidate` est une racine ou un sous-dossier d'une racine autorisée."""
    return any(
        candidate == r.path.resolve() or candidate.is_relative_to(r.path.resolve()) for r in roots
    )


def _label_for(resolved: Path, roots: list[DownloadRoot]) -> str:
    """Label affiché pour le dossier courant : celui de sa racine, sinon son nom."""
    return next((r.label for r in roots if _under_any_root(resolved, [r])), resolved.name)


def _disk_usage(path: Path) -> tuple[int | None, int | None]:
    """Espace `(libre, total)` du volume portant `path`, `(None, None)` s'il est illisible
    (racine non montée, volume déconnecté) : l'affichage ne doit jamais faire échouer la route."""
    try:
        usage = shutil.disk_usage(path)
    except OSError:
        return None, None
    return usage.free, usage.total


def _root_entry(root: DownloadRoot) -> RootOut:
    """Décrit une racine pour le client, disponibilité et espace disque inclus."""
    if root_issue(root) is not None:
        return RootOut(label=root.label, path=str(root.path), is_available=False)
    free, total = _disk_usage(root.path)
    return RootOut(
        label=root.label,
        path=str(root.path),
        is_available=True,
        free_bytes=free,
        total_bytes=total,
    )


@router.get("/folders", response_model=FoldersResponse)
def list_folders(request: Request, path: str | None = Query(default=None)) -> FoldersResponse:
    """Liste les racines autorisées, ou le contenu d'un sous-dossier si `path` est fourni.

    Volontairement **non `async`** : `stat`/`statvfs`/`scandir` sur un montage réseau mort
    partent en sommeil ininterruptible. Dans la boucle asyncio, cela figerait tout le serveur
    (health, SSE, jobs en cours) ; en fonction synchrone, Starlette l'exécute en threadpool.
    """
    settings = request.app.state.settings
    roots = settings.roots
    root_entries = [_root_entry(r) for r in roots]

    if path is None:
        return FoldersResponse(roots=root_entries, current=None, entries=[], parent=None)

    resolved = resolve_folder(path, roots)  # PathSecurityError -> 400 (gestionnaire global)

    entries: list[FolderEntryOut] = []
    if resolved.is_dir():
        with os.scandir(resolved) as scan:
            for entry in sorted(scan, key=lambda e: (not e.is_dir(), e.name.lower())):
                entries.append(
                    FolderEntryOut(
                        name=entry.name, path=str(resolved / entry.name), is_dir=entry.is_dir()
                    )
                )

    free, total = _disk_usage(resolved)
    parent = resolved.parent
    parent_str = str(parent) if parent != resolved and _under_any_root(parent, roots) else None
    return FoldersResponse(
        roots=root_entries,
        current=CurrentFolderOut(
            path=str(resolved),
            label=_label_for(resolved, roots),
            free_bytes=free,
            total_bytes=total,
        ),
        entries=entries,
        parent=parent_str,
    )


def _validated_folder_name(name: str) -> str:
    """Valide un nom de dossier saisi par l'utilisateur.

    Un nom que la sanitization modifierait est **refusé**, jamais réécrit : créer un dossier
    au nom différent de celui demandé (ou un `download` surgi de nulle part) est plus
    déroutant qu'une erreur explicite.
    """
    raw = name.strip()
    if raw and raw not in {".", ".."} and sanitize_filename(raw) == raw:
        return raw
    raise HTTPException(
        status_code=400,
        detail=(
            "Nom de dossier invalide : ni vide, ni « .. », ni séparateur de chemin, "
            "ni caractère de contrôle."
        ),
    )


@router.post("/folders", response_model=FolderEntryOut, status_code=201)
def create_folder(request: Request, body: FolderCreate) -> FolderEntryOut:
    """Crée un sous-dossier sous une racine autorisée et retourne son entrée.

    Non `async` pour la même raison que `list_folders` : `mkdir` est bloquant.
    """
    roots = request.app.state.settings.roots
    safe_name = _validated_folder_name(body.name)
    # Revalide le chemin complet contre les racines (défense en profondeur après sanitize).
    destination = resolve_destination(body.parent, safe_name, roots)

    try:
        if not destination.parent.is_dir():
            raise HTTPException(status_code=400, detail="Le dossier parent n'existe pas.")
        if destination.exists():
            raise HTTPException(status_code=409, detail=f"Le dossier « {safe_name} » existe déjà.")
        # `parents=False` : cette route crée UN dossier, pas une arborescence — sinon un seul
        # appel peut matérialiser des dizaines de niveaux sous la racine.
        destination.mkdir()
    except OSError as exc:
        raise HTTPException(
            status_code=400, detail=f"Création impossible : {exc.strerror or exc}"
        ) from exc
    return FolderEntryOut(name=destination.name, path=str(destination), is_dir=True)
