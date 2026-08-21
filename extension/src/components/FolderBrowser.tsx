/**
 * Navigateur de dossiers serveur, partagé entre la popup (sélection par source) et les options
 * (gestion des favoris) : état de navigation + liste de résultats, alimentés par
 * `GET /api/folders`.
 */

import { useCallback, useState } from 'react';
import type { ApiClient } from '@/src/lib/api';
import type { FoldersResponse } from '@/src/lib/types';

export interface FolderBrowserState {
  browsing: boolean;
  folders: FoldersResponse | null;
  loading: boolean;
  error: string | null;
  open: (path?: string) => void;
  close: () => void;
}

/** État + navigation du parcours de dossiers ; le rendu est laissé à `FolderBrowseList`. */
export function useFolderBrowser(apiClient: ApiClient): FolderBrowserState {
  const [browsing, setBrowsing] = useState(false);
  const [folders, setFolders] = useState<FoldersResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = useCallback(
    (path?: string) => {
      setBrowsing(true);
      setLoading(true);
      setError(null);
      apiClient
        .listFolders(path)
        .then((result) => setFolders(result))
        .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Erreur de chargement.'))
        .finally(() => setLoading(false));
    },
    [apiClient],
  );

  const close = useCallback(() => setBrowsing(false), []);

  return { browsing, folders, loading, error, open, close };
}

interface FolderBrowseListProps {
  folders: FoldersResponse;
  onNavigate: (path?: string) => void;
}

/** Liste de navigation : racines autorisées à la racine, puis parent + sous-dossiers ensuite. */
export function FolderBrowseList({ folders, onNavigate }: FolderBrowseListProps) {
  const parentPath = folders.parent;
  if (!folders.current) {
    return (
      <ul className="folder-browser-list">
        {folders.roots.map((root) => (
          <li key={root.path}>
            <button type="button" className="folder-browser-item" onClick={() => onNavigate(root.path)}>
              {root.label}
            </button>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul className="folder-browser-list">
      {parentPath !== null ? (
        <li>
          <button type="button" className="folder-browser-item" onClick={() => onNavigate(parentPath)}>
            .. (dossier parent)
          </button>
        </li>
      ) : null}
      {folders.entries
        .filter((entry) => entry.is_dir)
        .map((entry) => (
          <li key={entry.path}>
            <button type="button" className="folder-browser-item" onClick={() => onNavigate(entry.path)}>
              {entry.name}
            </button>
          </li>
        ))}
    </ul>
  );
}
