/**
 * Sélecteur de dossier de destination : favoris (réglages) en premier, plus une option
 * "Parcourir…" qui ouvre un mini navigateur de dossiers alimenté par `GET`/`POST /api/folders`
 * (navigation, création de sous-dossier avec sélection automatique).
 */

import { FolderBrowserPanel } from '@/src/components/FolderBrowser';
import { useFolderBrowser } from '@/src/hooks/useFolderBrowser';
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
  const folderBrowser = useFolderBrowser(apiClient, {
    // Créer un dossier revient à le choisir immédiatement comme destination (sélection automatique).
    onFolderCreated: (path, label) => {
      onChange(path, label);
      folderBrowser.close();
    },
  });
  const { browsing, open, close } = folderBrowser;
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
        <FolderBrowserPanel
          state={folderBrowser}
          primaryActionLabel="Choisir ce dossier"
          onSelectCurrent={(path, label) => {
            onChange(path, label);
            close();
          }}
        />
      ) : null}
    </div>
  );
}
