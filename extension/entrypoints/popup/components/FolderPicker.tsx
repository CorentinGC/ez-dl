/**
 * Sélecteur de dossier de destination : favoris (réglages) en premier, plus une option
 * "Parcourir…" qui ouvre un mini navigateur de dossiers alimenté par `GET /api/folders`.
 */

import { FolderBrowseList, useFolderBrowser } from '@/src/components/FolderBrowser';
import type { ApiClient } from '@/src/lib/api';
import type { FavoriteFolder } from '@/src/lib/types';

const BROWSE_OPTION = '__browse__';

interface FolderPickerProps {
  apiClient: ApiClient;
  favorites: FavoriteFolder[];
  value: string | null;
  onChange: (path: string, label: string) => void;
  fieldId: string;
}

export function FolderPicker({ apiClient, favorites, value, onChange, fieldId }: FolderPickerProps) {
  const { browsing, folders, loading, error, open, close } = useFolderBrowser(apiClient);
  const isKnownFavorite = favorites.some((f) => f.path === value);

  return (
    <div className="folder-picker">
      <label htmlFor={fieldId} className="field-label">
        Dossier
      </label>
      <select
        id={fieldId}
        className="field-select"
        value={isKnownFavorite ? (value ?? '') : BROWSE_OPTION}
        onChange={(event) => {
          if (event.target.value === BROWSE_OPTION) open(undefined);
          else {
            const favorite = favorites.find((f) => f.path === event.target.value);
            if (favorite) onChange(favorite.path, favorite.label);
          }
        }}
      >
        {favorites.length === 0 ? <option value="">Aucun favori configuré</option> : null}
        {favorites.map((favorite) => (
          <option key={favorite.path} value={favorite.path}>
            {favorite.label}
          </option>
        ))}
        <option value={BROWSE_OPTION}>Parcourir…</option>
      </select>
      {value && !isKnownFavorite ? <p className="field-hint">Dossier choisi : {value}</p> : null}

      {browsing ? (
        <div className="folder-browser" role="dialog" aria-label="Parcourir les dossiers du serveur">
          {loading ? <p className="folder-browser-status">Chargement…</p> : null}
          {error ? (
            <p className="field-error" role="alert">
              {error}
            </p>
          ) : null}
          {folders && !loading ? (
            <>
              <p className="folder-browser-current">{folders.current?.label ?? folders.current?.path ?? 'Racines disponibles'}</p>
              <FolderBrowseList folders={folders} onNavigate={open} />
              <div className="folder-browser-actions">
                {folders.current ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      const current = folders.current;
                      if (!current) return;
                      onChange(current.path, current.label);
                      close();
                    }}
                  >
                    Choisir ce dossier
                  </button>
                ) : null}
                <button type="button" className="btn btn-secondary" onClick={close}>
                  Annuler
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
