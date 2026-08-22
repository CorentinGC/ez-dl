/**
 * Fabrique des éléments du bouton en overlay et de son toast, styles compris.
 *
 * Séparé de `videoOverlay.ts` (qui gère le suivi des vidéos et la messagerie) : un fichier, une
 * responsabilité — ici, uniquement du balisage et du CSS destinés au Shadow DOM.
 */

import { BADGE_SIZE } from '@/src/lib/overlayGeometry';

export type BadgeState = 'idle' | 'sending' | 'success' | 'error';

const BADGE_LABELS: Record<BadgeState, string> = {
  idle: 'Télécharger cette vidéo avec ez-dl',
  sending: 'Envoi au serveur ez-dl…',
  success: 'Envoyé au serveur ez-dl',
  error: 'Échec de l’envoi',
};

/** Les quatre icônes coexistent dans le bouton ; le CSS n'en montre qu'une selon `data-state`. */
const BADGE_ICONS = `
<svg class="icon icon-idle" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M4 19h16"/></svg>
<svg class="icon icon-sending" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" opacity=".25"/><path d="M21 12a9 9 0 0 0-9-9"/></svg>
<svg class="icon icon-success" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 13 5 5L19 7"/></svg>
<svg class="icon icon-error" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>`;

export function buildBadge(): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ezdl-badge';
  button.style.display = 'none';
  // Balisage constant, écrit ici même : aucune donnée de la page ni du serveur n'y entre.
  button.innerHTML = BADGE_ICONS;
  setBadgeState(button, 'idle');
  return button;
}

export function setBadgeState(button: HTMLButtonElement, state: BadgeState): void {
  button.dataset.state = state;
  button.disabled = state === 'sending';
  button.setAttribute('aria-label', BADGE_LABELS[state]);
  button.title = BADGE_LABELS[state];
}

export function buildToast(): HTMLElement {
  const toast = document.createElement('div');
  toast.className = 'ezdl-toast';
  toast.setAttribute('role', 'status');
  toast.style.display = 'none';
  return toast;
}

export function buildOverlayStyle(): HTMLStyleElement {
  const style = document.createElement('style');
  style.textContent = `
:host { all: initial; }
.ezdl-badge {
  position: fixed; top: 0; left: 0; width: ${BADGE_SIZE}px; height: ${BADGE_SIZE}px;
  display: none; align-items: center; justify-content: center;
  padding: 0; border: 0; border-radius: 50%; cursor: pointer; pointer-events: auto;
  background: rgba(17, 24, 39, .82); color: #f9fafb;
  box-shadow: 0 2px 10px rgba(0, 0, 0, .45); backdrop-filter: blur(2px);
  transition: background .15s ease, transform .15s ease, opacity .15s ease;
  opacity: .75;
}
.ezdl-badge:hover, .ezdl-badge:focus-visible { opacity: 1; background: #2563eb; }
.ezdl-badge:focus-visible { outline: 2px solid #f9fafb; outline-offset: 2px; }
.ezdl-badge[data-state="success"] { background: #16a34a; opacity: 1; }
.ezdl-badge[data-state="error"] { background: #dc2626; opacity: 1; }
.ezdl-badge[disabled] { cursor: progress; opacity: 1; }
.icon { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; display: none; }
.ezdl-badge[data-state="idle"] .icon-idle,
.ezdl-badge[data-state="sending"] .icon-sending,
.ezdl-badge[data-state="success"] .icon-success,
.ezdl-badge[data-state="error"] .icon-error { display: block; }
.ezdl-badge[data-state="sending"] .icon-sending { animation: ezdl-spin 900ms linear infinite; }
@keyframes ezdl-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .ezdl-badge { transition: none; }
  .ezdl-badge[data-state="sending"] .icon-sending { animation: none; }
}
.ezdl-toast {
  position: fixed; right: 16px; bottom: 16px; max-width: 320px; pointer-events: none;
  padding: 10px 14px; border-radius: 8px; color: #f9fafb; background: #111827;
  font: 13px/1.4 -apple-system, system-ui, sans-serif; box-shadow: 0 4px 12px rgba(0, 0, 0, .35);
}
.ezdl-toast[data-tone="error"] { background: #7f1d1d; }
`;
  return style;
}
