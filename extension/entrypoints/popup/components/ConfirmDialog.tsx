/**
 * Modale de confirmation de la popup : un titre, un message, N actions.
 *
 * Volontairement pas un `<dialog>` natif : `showModal()` positionne l'élément dans la
 * top-layer du document, dont la taille est celle de la fenêtre de popup (400 px) — le
 * centrage y est correct, mais le rendu diffère entre Chrome et les navigateurs dérivés, et
 * l'élément échappe au conteneur `.popup-root` qui porte le thème. Un overlay classique reste
 * prévisible ici, à condition de reproduire à la main ce que `showModal()` offre : `aria-modal`,
 * focus initial, fermeture à `Escape`, piège à focus.
 */

import { type KeyboardEvent, useCallback, useEffect, useId, useRef } from 'react';

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

/** Éléments focusables de la modale, dans l'ordre du DOM (uniquement des boutons ici). */
function focusableButtons(root: HTMLElement | null): HTMLButtonElement[] {
  return root ? Array.from(root.querySelectorAll('button')) : [];
}

export function ConfirmDialog({ title, message, actions, onDismiss, dismissLabel = 'Annuler' }: ConfirmDialogProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const messageId = useId();

  // Le focus part sur la première action : sans ça il reste sur le bouton « Supprimer » de la
  // ligne, derrière l'overlay, et la modale est invisible au clavier comme au lecteur d'écran.
  useEffect(() => {
    focusableButtons(panelRef.current)[0]?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onDismiss();
        return;
      }
      if (event.key !== 'Tab') return;
      // Piège à focus : sans lui, Tab sort de la modale et laisse activer les boutons du
      // fond, dont celui qui vient d'ouvrir cette confirmation.
      const buttons = focusableButtons(panelRef.current);
      const first = buttons.at(0);
      const last = buttons.at(-1);
      if (!first || !last) return;
      const target = document.activeElement;
      if (event.shiftKey && target === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && target === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onDismiss],
  );

  return (
    <div className="dialog-backdrop" onMouseDown={onDismiss} onKeyDown={handleKeyDown}>
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
