/**
 * Dossiers favoris : ajout via navigation serveur (`GET /api/folders`), suppression,
 * réordonnancement (haut/bas) et choix du favori par défaut.
 */

import { FolderBrowserPanel } from '@/src/components/FolderBrowser';
import { useFolderBrowser } from '@/src/hooks/useFolderBrowser';
import type { ApiClient } from '@/src/lib/api';
import type { ExtensionSettings, FavoriteFolder } from '@/src/lib/types';

interface FoldersSectionProps {
  settings: ExtensionSettings;
  apiClient: ApiClient | null;
  onUpdate: (patch: Partial<ExtensionSettings>) => Promise<ExtensionSettings>;
}

export function FoldersSection({ settings, apiClient, onUpdate }: FoldersSectionProps) {
  return (
    <section className="options-section">
      <h2>Dossiers favoris</h2>
      <p className="options-section-description">
        Raccourcis proposés en premier dans la popup. Le favori par défaut est utilisé pour le téléchargement en un
        clic.
      </p>

      {settings.favoriteFolders.length === 0 ? <p className="options-hint">Aucun favori pour l'instant.</p> : null}

      <ul className="folder-favorites-list">
        {settings.favoriteFolders.map((folder, index) => (
          <FavoriteRow
            key={folder.path}
            folder={folder}
            index={index}
            count={settings.favoriteFolders.length}
            isDefault={settings.defaultFolderPath === folder.path}
            onSetDefault={() => void onUpdate({ defaultFolderPath: folder.path })}
            onMove={(direction) => void moveFavorite(settings, onUpdate, index, direction)}
            onRemove={() => void removeFavorite(settings, onUpdate, folder.path)}
          />
        ))}
      </ul>

      {apiClient ? (
        <AddFavorite apiClient={apiClient} settings={settings} onUpdate={onUpdate} />
      ) : (
        <p className="options-hint">Configurez le serveur ci-dessus pour parcourir ses dossiers.</p>
      )}
    </section>
  );
}

interface FavoriteRowProps {
  folder: FavoriteFolder;
  index: number;
  count: number;
  isDefault: boolean;
  onSetDefault: () => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}

function FavoriteRow({ folder, index, count, isDefault, onSetDefault, onMove, onRemove }: FavoriteRowProps) {
  return (
    <li className="folder-favorite-row">
      <label className="field-checkbox">
        <input type="radio" name="default-folder" checked={isDefault} onChange={onSetDefault} />
        <span className="folder-favorite-label">{folder.label}</span>
      </label>
      <span className="folder-favorite-path">{folder.path}</span>
      <div className="folder-favorite-actions">
        <button type="button" className="btn btn-ghost btn-small" disabled={index === 0} onClick={() => onMove(-1)} aria-label={`Monter ${folder.label}`}>
          ↑
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-small"
          disabled={index === count - 1}
          onClick={() => onMove(1)}
          aria-label={`Descendre ${folder.label}`}
        >
          ↓
        </button>
        <button type="button" className="btn btn-ghost btn-small" onClick={onRemove} aria-label={`Retirer ${folder.label} des favoris`}>
          Retirer
        </button>
      </div>
    </li>
  );
}

async function moveFavorite(
  settings: ExtensionSettings,
  onUpdate: FoldersSectionProps['onUpdate'],
  index: number,
  direction: -1 | 1,
): Promise<void> {
  const target = index + direction;
  if (target < 0 || target >= settings.favoriteFolders.length) return;
  const next = [...settings.favoriteFolders];
  const a = next[index];
  const b = next[target];
  if (!a || !b) return;
  next[index] = b;
  next[target] = a;
  await onUpdate({ favoriteFolders: next });
}

async function removeFavorite(settings: ExtensionSettings, onUpdate: FoldersSectionProps['onUpdate'], path: string): Promise<void> {
  const favoriteFolders = settings.favoriteFolders.filter((f) => f.path !== path);
  const defaultFolderPath = settings.defaultFolderPath === path ? (favoriteFolders[0]?.path ?? null) : settings.defaultFolderPath;
  await onUpdate({ favoriteFolders, defaultFolderPath });
}

function AddFavorite({ apiClient, settings, onUpdate }: { apiClient: ApiClient; settings: ExtensionSettings; onUpdate: FoldersSectionProps['onUpdate'] }) {
  const addFavorite = (path: string, label: string) => {
    if (settings.favoriteFolders.some((f) => f.path === path)) return;
    const favoriteFolders = [...settings.favoriteFolders, { path, label }];
    const defaultFolderPath = settings.defaultFolderPath ?? path;
    void onUpdate({ favoriteFolders, defaultFolderPath });
  };

  const folderBrowser = useFolderBrowser(apiClient, {
    // Créer un dossier revient à l'ajouter immédiatement aux favoris (sélection automatique).
    onFolderCreated: (path, label) => {
      addFavorite(path, label);
      folderBrowser.close();
    },
  });
  const { browsing, open, close } = folderBrowser;

  return (
    <div className="folder-add">
      {!browsing ? (
        <button type="button" className="btn btn-secondary" onClick={() => open(undefined)}>
          Ajouter un dossier…
        </button>
      ) : (
        <FolderBrowserPanel
          state={folderBrowser}
          primaryActionLabel="Ajouter ce dossier"
          onSelectCurrent={(path, label) => {
            addFavorite(path, label);
            close();
          }}
        />
      )}
    </div>
  );
}
