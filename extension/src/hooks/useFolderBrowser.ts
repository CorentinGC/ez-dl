/**
 * État + navigation du parcours de dossiers serveur (`GET`/`POST /api/folders`), partagé entre la
 * popup (sélection de destination d'un job) et les options (gestion des dossiers favoris). Le
 * rendu est délégué à `src/components/FolderBrowser.tsx`.
 */

import { useCallback, useRef, useState } from 'react';
import type { ApiClient } from '@/src/lib/api';
import { creationParentPath } from '@/src/lib/folders';
import type { FoldersResponse } from '@/src/lib/types';

export interface UseFolderBrowserOptions {
  /** Appelé juste après la création réussie d'un dossier — permet une sélection automatique
   * (destination de job, favori…) sans round-trip réseau supplémentaire. */
  onFolderCreated?: (path: string, label: string) => void;
}

export interface FolderBrowserState {
  browsing: boolean;
  folders: FoldersResponse | null;
  loading: boolean;
  error: string | null;
  creating: boolean;
  createError: string | null;
  open: (path?: string) => void;
  close: () => void;
  createFolder: (name: string) => void;
}

export function useFolderBrowser(apiClient: ApiClient, options: UseFolderBrowserOptions = {}): FolderBrowserState {
  const { onFolderCreated } = options;
  const [browsing, setBrowsing] = useState(false);
  const [folders, setFolders] = useState<FoldersResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Deux navigations rapprochées peuvent revenir dans le désordre : seule la dernière demandée
  // a le droit d'écrire l'état, sinon l'affichage retombe sur le dossier précédent.
  const requestIdRef = useRef(0);

  const open = useCallback(
    (path?: string) => {
      const requestId = (requestIdRef.current += 1);
      setBrowsing(true);
      setLoading(true);
      setError(null);
      setCreateError(null); // Navigation : on quitte le contexte de l'éventuelle erreur de création précédente.
      apiClient
        .listFolders(path)
        .then((result) => {
          if (requestIdRef.current === requestId) setFolders(result);
        })
        .catch((err: unknown) => {
          if (requestIdRef.current === requestId) setError(err instanceof Error ? err.message : 'Erreur de chargement.');
        })
        .finally(() => {
          if (requestIdRef.current === requestId) setLoading(false);
        });
    },
    [apiClient],
  );

  const close = useCallback(() => {
    setBrowsing(false);
    setCreateError(null);
  }, []);

  const createFolder = useCallback(
    (name: string) => {
      const parent = creationParentPath(folders);
      if (!parent) return; // Pas de dossier ouvert (liste des racines) : création impossible.
      setCreating(true);
      setCreateError(null);
      apiClient
        .createFolder({ parent, name })
        .then((entry) => onFolderCreated?.(entry.path, entry.name))
        .catch((err: unknown) => setCreateError(err instanceof Error ? err.message : 'Erreur inconnue.'))
        .finally(() => setCreating(false));
    },
    [apiClient, folders, onFolderCreated],
  );

  return { browsing, folders, loading, error, creating, createError, open, close, createFolder };
}
