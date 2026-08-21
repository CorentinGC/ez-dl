/**
 * Rendu du navigateur de dossiers serveur (`GET`/`POST /api/folders`) : liste des racines
 * (avec disponibilité et espace disque) puis parent + sous-dossiers, formulaire de création, et
 * panneau complet prêt à intégrer (`FolderBrowserPanel`) — partagé entre la popup et les options.
 * L'état est géré par `src/hooks/useFolderBrowser.ts`.
 */

import { type FormEvent, useState } from 'react';
import { formatFreeSpace } from '@/src/lib/format';
import { hasParentNavigation, listSubfolders, parentNavigationTarget } from '@/src/lib/folders';
import type { FoldersResponse } from '@/src/lib/types';
import type { FolderBrowserState } from '@/src/hooks/useFolderBrowser';

interface FolderBrowseListProps {
  folders: FoldersResponse;
  onNavigate: (path?: string) => void;
}

/** Liste de navigation : racines (avec dispo + espace) à la racine, puis parent + sous-dossiers. */
export function FolderBrowseList({ folders, onNavigate }: FolderBrowseListProps) {
  if (!folders.current) {
    if (folders.roots.length === 0) {
      return <p className="folder-browser-status">Aucune racine de téléchargement configurée côté serveur.</p>;
    }
    return (
      <ul className="folder-browser-list">
        {folders.roots.map((root) => (
          <li key={root.path}>
            <button
              type="button"
              className="folder-browser-item"
              disabled={!root.is_available}
              title={root.is_available ? undefined : 'Racine non montée ou non accessible en écriture.'}
              onClick={() => onNavigate(root.path)}
            >
              <span className="folder-browser-item-label">
                {root.label}
                {!root.is_available ? ' (indisponible)' : ''}
              </span>
              {root.is_available ? (
                <span className="folder-browser-item-space">{formatFreeSpace(root.free_bytes, root.total_bytes)}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    );
  }

  const subfolders = listSubfolders(folders.entries);

  return (
    <ul className="folder-browser-list">
      <li>
        <button type="button" className="folder-browser-item folder-browser-item-breadcrumb" onClick={() => onNavigate(undefined)}>
          ‹ Toutes les racines
        </button>
      </li>
      {hasParentNavigation(folders) ? (
        <li>
          <button type="button" className="folder-browser-item" onClick={() => onNavigate(parentNavigationTarget(folders))}>
            .. (dossier parent)
          </button>
        </li>
      ) : null}
      {subfolders.length === 0 ? (
        <li className="folder-browser-empty">Aucun sous-dossier.</li>
      ) : (
        subfolders.map((entry) => (
          <li key={entry.path}>
            <button type="button" className="folder-browser-item" onClick={() => onNavigate(entry.path)}>
              {entry.name}
            </button>
          </li>
        ))
      )}
    </ul>
  );
}

interface NewFolderFormProps {
  creating: boolean;
  error: string | null;
  onCreate: (name: string) => void;
}

/** Formulaire replié par défaut ("+ Nouveau dossier") pour créer un sous-dossier dans le dossier courant. */
function NewFolderForm({ creating, error, onCreate }: NewFolderFormProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');

  if (!open) {
    return (
      <button type="button" className="btn btn-ghost btn-small folder-browser-new-toggle" onClick={() => setOpen(true)}>
        + Nouveau dossier
      </button>
    );
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    onCreate(trimmed);
  };

  return (
    <form className="folder-browser-new-form" onSubmit={submit}>
      <label className="field-label" htmlFor="folder-browser-new-name">
        Nom du nouveau dossier
      </label>
      <div className="folder-browser-new-row">
        <input
          id="folder-browser-new-name"
          className="field-input"
          type="text"
          autoFocus
          disabled={creating}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button type="submit" className="btn btn-secondary btn-small" disabled={creating || name.trim().length === 0}>
          {creating ? 'Création…' : 'Créer'}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-small"
          disabled={creating}
          onClick={() => {
            setOpen(false);
            setName('');
          }}
        >
          Annuler
        </button>
      </div>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

interface FolderBrowserPanelProps {
  state: FolderBrowserState;
  /** Libellé du bouton principal appliqué au dossier courant (ex. "Choisir ce dossier"). */
  primaryActionLabel: string;
  onSelectCurrent: (path: string, label: string) => void;
}

/** Panneau complet : chargement/erreur, espace disque du dossier courant, liste, création, actions. */
export function FolderBrowserPanel({ state, primaryActionLabel, onSelectCurrent }: FolderBrowserPanelProps) {
  const { folders, loading, error, creating, createError, open, close, createFolder } = state;
  const current = folders?.current ?? null;

  return (
    <div className="folder-browser" role="dialog" aria-label="Parcourir les dossiers du serveur">
      {loading ? (
        <p className="folder-browser-status" role="status">
          Chargement…
        </p>
      ) : null}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {folders && !loading ? (
        <>
          <p className="folder-browser-current">{current?.label ?? 'Racines disponibles'}</p>
          {current ? <p className="folder-browser-space">{formatFreeSpace(current.free_bytes, current.total_bytes)}</p> : null}
          <FolderBrowseList folders={folders} onNavigate={open} />
          {current ? <NewFolderForm creating={creating} error={createError} onCreate={createFolder} /> : null}
          <div className="folder-browser-actions">
            {current ? (
              <button type="button" className="btn btn-primary" onClick={() => onSelectCurrent(current.path, current.label)}>
                {primaryActionLabel}
              </button>
            ) : null}
            <button type="button" className="btn btn-secondary" onClick={close}>
              Annuler
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
