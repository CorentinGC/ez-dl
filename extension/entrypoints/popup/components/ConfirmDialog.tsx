/**
 * Modale de confirmation de la popup : un titre, un message, N actions.
 *
 * Volontairement pas un `<dialog>` natif : `showModal()` positionne l'élément dans la
 * top-layer du document, dont la taille est celle de la fenêtre de popup (400 px) — le
 * centrage y est correct, mais le rendu diffère entre Chrome et les navigateurs dérivés, et
 * l'élément échappe au conteneur `.popup-root` qui porte le thème. Un overlay classique reste
 * prévisible ici, à condition de reproduire à la main ce que `showModal()` offre : `aria-modal`,
 * focus initial, fermeture à `Escape`, piège à focus — c'est le rôle de `useModalFocus`, partagé
 * avec le navigateur de dossiers en plein écran.
 */

import { useId } from 'react';
import { useModalFocus } from '../hooks/useModalFocus';

export interface ConfirmAction {
  label: string;
  /** `danger` pour une action destructive (efface un fichier), `default` sinon. */
  tone?: 'default' | 'danger';
  onSelect: () => void;
}

interface ConfirmDialogProps {
  title: string;
  message: string;
  actions: ConfirmAction[];
  /** Fermeture sans choisir : `Escape`, clic hors du panneau, bouton « Annuler ». */
  onDismiss: () => void;
  dismissLabel?: string;
}

export function ConfirmDialog({ title, message, actions, onDismiss, dismissLabel = 'Annuler' }: ConfirmDialogProps) {
  const { panelRef, onKeyDown } = useModalFocus<HTMLDivElement>(onDismiss);
  const titleId = useId();
  const messageId = useId();

  return (
    <div className="dialog-backdrop" onMouseDown={onDismiss} onKeyDown={onKeyDown}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        ref={panelRef}
        // Un clic *dans* le panneau ne doit pas remonter à l'overlay et refermer la modale.
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="dialog-title" id={titleId}>
          {title}
        </h2>
        <p className="dialog-message" id={messageId}>
          {message}
        </p>
        <div className="dialog-actions">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className={`btn ${action.tone === 'danger' ? 'btn-danger' : 'btn-secondary'}`}
              onClick={action.onSelect}
            >
              {action.label}
            </button>
          ))}
          <button type="button" className="btn btn-ghost" onClick={onDismiss}>
            {dismissLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
