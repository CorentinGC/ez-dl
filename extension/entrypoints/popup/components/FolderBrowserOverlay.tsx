/**
 * Navigateur de dossiers en plein écran de popup : la carte source ne laissait qu'une bande
 * étroite au panneau, alors que choisir une destination demande de voir beaucoup d'entrées.
 * L'overlay occupe toute la fenêtre de la popup ; le panneau lui-même reste le composant partagé
 * avec la page d'options (`src/components/FolderBrowser.tsx`).
 */

import { FolderBrowserPanel } from '@/src/components/FolderBrowser';
import type { FolderBrowserState } from '@/src/hooks/useFolderBrowser';
import { useModalFocus } from '../hooks/useModalFocus';

interface FolderBrowserOverlayProps {
  state: FolderBrowserState;
  primaryActionLabel: string;
  onSelectCurrent: (path: string, label: string) => void;
  onDismiss: () => void;
}

export function FolderBrowserOverlay({ state, primaryActionLabel, onSelectCurrent, onDismiss }: FolderBrowserOverlayProps) {
  const { panelRef, onKeyDown } = useModalFocus<HTMLDivElement>(onDismiss);

  return (
    <div className="folder-overlay-backdrop" onMouseDown={onDismiss} onKeyDown={onKeyDown}>
      <div
        className="folder-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="Choisir un dossier du serveur"
        ref={panelRef}
        // Un clic *dans* le panneau ne doit pas remonter à l'overlay et tout refermer.
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="folder-overlay-header">
          <h2 className="folder-overlay-title">Choisir un dossier</h2>
          <button type="button" className="popup-icon-button" aria-label="Fermer le navigateur de dossiers" onClick={onDismiss}>
            ×
          </button>
        </header>
        <FolderBrowserPanel state={state} primaryActionLabel={primaryActionLabel} onSelectCurrent={onSelectCurrent} />
      </div>
    </div>
  );
}
