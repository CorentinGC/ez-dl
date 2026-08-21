"""Route `GET /api/folders` — navigation dans les racines de téléchargement autorisées."""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter, Depends, Query, Request

from app.config import DownloadRoot
from app.core.paths import resolve_folder
from app.schemas import CurrentFolderOut, FolderEntryOut, FoldersResponse, RootOut
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


@router.get("/folders", response_model=FoldersResponse)
async def list_folders(request: Request, path: str | None = Query(default=None)) -> FoldersResponse:
    """Liste les racines autorisées, ou le contenu d'un sous-dossier si `path` est fourni."""
    settings = request.app.state.settings
    roots = settings.roots
    root_entries = [RootOut(label=r.label, path=str(r.path)) for r in roots]

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

    parent = resolved.parent
    parent_str = str(parent) if parent != resolved and _under_any_root(parent, roots) else None
    return FoldersResponse(
        roots=root_entries,
        current=CurrentFolderOut(path=str(resolved), label=_label_for(resolved, roots)),
        entries=entries,
        parent=parent_str,
    )
