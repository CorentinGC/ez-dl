/**
 * Comportement clavier commun aux modales de la popup (confirmation, navigateur de dossiers).
 *
 * Reproduit à la main ce qu'offrirait `<dialog>.showModal()` — écarté ici, voir l'en-tête de
 * `components/ConfirmDialog.tsx` : focus initial dans le panneau, fermeture à `Escape`, piège à
 * focus sur `Tab`, et restitution du focus à l'élément qui a ouvert la modale.
 */

import { type KeyboardEvent, type RefObject, useCallback, useEffect, useRef } from 'react';

/** Éléments focusables du panneau, dans l'ordre du DOM. */
const FOCUSABLE_SELECTOR = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), [href]';

function focusables(root: HTMLElement | null): HTMLElement[] {
  return root ? Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) : [];
}

export interface UseModalFocusResult<T extends HTMLElement> {
  panelRef: RefObject<T | null>;
  /** À poser sur le conteneur de la modale (overlay compris) pour capter `Escape` et `Tab`. */
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

export function useModalFocus<T extends HTMLElement>(onDismiss: () => void): UseModalFocusResult<T> {
  const panelRef = useRef<T | null>(null);

  useEffect(() => {
    // Sans focus initial, il reste sur le bouton qui a ouvert la modale — derrière l'overlay —
    // et la modale est invisible au clavier comme au lecteur d'écran.
    const opener = document.activeElement as HTMLElement | null;
    focusables(panelRef.current)[0]?.focus();
    return () => opener?.focus?.();
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onDismiss();
        return;
      }
      if (event.key !== 'Tab') return;
      // Piège à focus : sans lui, Tab sort de la modale et laisse activer les boutons du fond,
      // dont celui qui vient de l'ouvrir.
      const elements = focusables(panelRef.current);
      const first = elements.at(0);
      const last = elements.at(-1);
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

  return { panelRef, onKeyDown };
}
