/**
 * Bouton de téléchargement ancré sur les vidéos de la page : un clic envoie la vidéo au serveur
 * ez-dl avec les réglages par défaut, sans passer par la popup.
 *
 * Contraintes de contexte : un content script s'exécute dans une page hostile, sans accès aux
 * cookies ni au serveur. Tout ce fichier ne fait donc que du DOM et de la messagerie — le
 * background décide de la disponibilité et crée le job (`src/lib/quickDownload.ts`).
 *
 * L'UI vit dans un **Shadow DOM** : ni les styles de la page ne l'atteignent, ni les siens ne
 * fuient. Le bouton n'apparaît que si le background a confirmé une source téléchargeable.
 */

import type { OverlayCheckRequest, OverlayCheckResponse, QuickDownloadRequest, QuickDownloadResponse } from '@/src/lib/messaging';
import { BADGE_SIZE, computeBadgePosition, isEligibleVideoSize, isRectVisible } from '@/src/lib/overlayGeometry';

type Availability = 'unknown' | 'pending' | 'available' | 'unavailable';
type ButtonState = 'idle' | 'sending' | 'success' | 'error';

interface OverlayState {
  host: HTMLElement;
  shadow: ShadowRoot;
  button: HTMLButtonElement;
  toast: HTMLElement;
  observer: MutationObserver;
  teardown: (() => void)[];
  availability: Availability;
  buttonState: ButtonState;
  /** URL de page au moment du dernier verdict : une navigation SPA le rend caduc. */
  checkedUrl: string;
  /** Suspendu pendant le mode picker, pour ne pas voler le clic de sélection. */
  suspended: boolean;
  frame: number | null;
  toastTimer: number | null;
  resetTimer: number | null;
}

let state: OverlayState | null = null;

// ---------------------------------------------------------------------------
// Cycle de vie
// ---------------------------------------------------------------------------

export function mountVideoOverlay(): void {
  if (state || !document.body) return;

  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'false');
  // `position:fixed` + `pointer-events:none` : l'hôte couvre l'écran sans jamais intercepter un
  // clic destiné à la page ; seul le bouton réactive les événements.
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;';

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.appendChild(buildStyle());
  const button = buildButton();
  const toast = buildToast();
  shadow.append(button, toast);
  document.body.appendChild(host);

  const observer = new MutationObserver(() => scheduleSync());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  state = {
    host,
    shadow,
    button,
    toast,
    observer,
    teardown: [],
    availability: 'unknown',
    buttonState: 'idle',
    checkedUrl: location.href,
    suspended: false,
    frame: null,
    toastTimer: null,
    resetTimer: null,
  };

  button.addEventListener('click', onButtonClick, true);
  listen(window, 'scroll', scheduleSync, true);
  listen(window, 'resize', scheduleSync, false);
  listen(document, 'fullscreenchange', onFullscreenChange, false);

  scheduleSync();
}

export function unmountVideoOverlay(): void {
  if (!state) return;
  state.observer.disconnect();
  for (const off of state.teardown) off();
  if (state.frame !== null) cancelAnimationFrame(state.frame);
  if (state.toastTimer !== null) clearTimeout(state.toastTimer);
  if (state.resetTimer !== null) clearTimeout(state.resetTimer);
  state.host.remove();
  state = null;
}

/** Masque le bouton pendant le mode picker (le clic doit aller au sélecteur d'élément). */
export function setOverlaySuspended(suspended: boolean): void {
  if (!state) return;
  state.suspended = suspended;
  scheduleSync();
}

/** Le background signale qu'une source vient d'être détectée sur cet onglet. */
export function markOverlayAvailable(): void {
  if (!state) return;
  state.availability = 'available';
  state.checkedUrl = location.href;
  scheduleSync();
}

function listen(target: EventTarget, type: string, handler: EventListener, capture: boolean): void {
  target.addEventListener(type, handler, capture);
  state?.teardown.push(() => target.removeEventListener(type, handler, capture));
}

// ---------------------------------------------------------------------------
// Positionnement
// ---------------------------------------------------------------------------

function scheduleSync(): void {
  if (!state || state.frame !== null) return;
  state.frame = requestAnimationFrame(() => {
    if (state) state.frame = null;
    sync();
  });
}

function sync(): void {
  if (!state) return;

  // Navigation SPA : le verdict du background portait sur l'ancienne URL.
  if (state.checkedUrl !== location.href) {
    state.availability = 'unknown';
    state.checkedUrl = location.href;
  }

  const video = findTargetVideo();
  if (!video || state.suspended) {
    hideButton();
    return;
  }

  if (state.availability === 'unknown') void requestAvailability();
  if (state.availability !== 'available') {
    hideButton();
    return;
  }

  const rect = video.getBoundingClientRect();
  const { left, top } = computeBadgePosition(rect, { width: window.innerWidth, height: window.innerHeight });
  state.button.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  state.button.style.display = 'flex';
}

function hideButton(): void {
  if (state) state.button.style.display = 'none';
}

/** Plus grande vidéo éligible visible à l'écran : sur une page à plusieurs lecteurs, celui qu'on
 * regarde. `null` si aucune ne mérite un bouton. */
function findTargetVideo(): HTMLVideoElement | null {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  let best: { video: HTMLVideoElement; area: number } | null = null;
  for (const video of document.querySelectorAll('video')) {
    const rect = video.getBoundingClientRect();
    const box = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    if (!isEligibleVideoSize(box) || !isRectVisible(box, viewport)) continue;
    const area = box.width * box.height;
    if (!best || area > best.area) best = { video, area };
  }
  return best?.video ?? null;
}

/** Plein écran : l'hôte doit vivre dans le sous-arbre plein écran, seul rendu par le navigateur. */
function onFullscreenChange(): void {
  if (!state) return;
  const parent = document.fullscreenElement ?? document.body;
  if (state.host.parentNode !== parent) parent.appendChild(state.host);
  scheduleSync();
}

// ---------------------------------------------------------------------------
// Messagerie
// ---------------------------------------------------------------------------

async function requestAvailability(): Promise<void> {
  if (!state || state.availability === 'pending') return;
  state.availability = 'pending';
  const url = location.href;
  try {
    const request: OverlayCheckRequest = { type: 'OVERLAY_CHECK' };
    const response = (await browser.runtime.sendMessage(request)) as OverlayCheckResponse | undefined;
    if (!state) return;
    state.availability = response?.available ? 'available' : 'unavailable';
    state.checkedUrl = url;
  } catch {
    if (state) state.availability = 'unavailable'; // Background endormi/rechargé : pas de bouton.
  }
  scheduleSync();
}

function onButtonClick(event: MouseEvent): void {
  // Capture + arrêt de propagation : sans cela le lecteur de la page se met en pause sous le clic.
  event.preventDefault();
  event.stopPropagation();
  void submitQuickDownload();
}

async function submitQuickDownload(): Promise<void> {
  if (!state || state.buttonState === 'sending') return;
  setButtonState('sending');
  try {
    const request: QuickDownloadRequest = { type: 'QUICK_DOWNLOAD' };
    const response = (await browser.runtime.sendMessage(request)) as QuickDownloadResponse | undefined;
    if (!response || !response.ok) {
      setButtonState('error');
      showToast(response?.error ?? 'Extension indisponible, rechargez la page.', true);
      return;
    }
    setButtonState('success');
    showToast('Envoyé au serveur ez-dl.', false);
  } catch {
    setButtonState('error');
    showToast('Extension indisponible, rechargez la page.', true);
  }
}

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------

function setButtonState(next: ButtonState): void {
  if (!state) return;
  state.buttonState = next;
  state.button.dataset.state = next;
  state.button.disabled = next === 'sending';
  state.button.setAttribute('aria-label', BUTTON_LABELS[next]);
  state.button.title = BUTTON_LABELS[next];
  if (state.resetTimer !== null) clearTimeout(state.resetTimer);
  if (next === 'success' || next === 'error') {
    state.resetTimer = window.setTimeout(() => setButtonState('idle'), 2500);
  }
}

const BUTTON_LABELS: Record<ButtonState, string> = {
  idle: 'Télécharger avec ez-dl',
  sending: 'Envoi au serveur ez-dl…',
  success: 'Envoyé au serveur ez-dl',
  error: 'Échec de l’envoi',
};

function showToast(message: string, isError: boolean): void {
  if (!state) return;
  // `textContent` et non `innerHTML` : le message vient du serveur, il n'est jamais du balisage.
  state.toast.textContent = message;
  state.toast.dataset.tone = isError ? 'error' : 'success';
  state.toast.style.display = 'block';
  if (state.toastTimer !== null) clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => {
    if (state) state.toast.style.display = 'none';
  }, 4000);
}

function buildButton(): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ezdl-badge';
  button.dataset.state = 'idle';
  button.setAttribute('aria-label', BUTTON_LABELS.idle);
  button.title = BUTTON_LABELS.idle;
  button.style.display = 'none';
  button.innerHTML = BADGE_ICONS;
  return button;
}

function buildToast(): HTMLElement {
  const toast = document.createElement('div');
  toast.className = 'ezdl-toast';
  toast.setAttribute('role', 'status');
  toast.style.display = 'none';
  return toast;
}

/** Les trois icônes coexistent dans le bouton ; le CSS n'en montre qu'une selon `data-state`. */
const BADGE_ICONS = `
<svg class="icon icon-idle" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M4 19h16"/></svg>
<svg class="icon icon-sending" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" opacity=".25"/><path d="M21 12a9 9 0 0 0-9-9"/></svg>
<svg class="icon icon-success" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 13 5 5L19 7"/></svg>
<svg class="icon icon-error" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>`;

function buildStyle(): HTMLStyleElement {
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
