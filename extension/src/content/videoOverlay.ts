/**
 * Bouton de téléchargement ancré sur chaque vidéo de la page : un clic envoie **cette** vidéo au
 * serveur ez-dl avec les réglages par défaut, sans passer par la popup.
 *
 * Contraintes de contexte : un content script s'exécute dans une page hostile, sans accès aux
 * cookies ni au serveur. Tout ce fichier ne fait donc que du DOM et de la messagerie — le
 * background décide de la disponibilité et crée le job (`src/lib/quickDownload.ts`).
 *
 * L'UI vit dans un **Shadow DOM** : ni les styles de la page ne l'atteignent, ni les siens ne
 * fuient. Les boutons n'apparaissent que si le background a confirmé une source téléchargeable.
 */

import { findVideoTitle } from './videoTitleDom';
import type {
  OverlayCheckRequest,
  OverlayCheckResponse,
  QuickDownloadRequest,
  QuickDownloadResponse,
} from '@/src/lib/messaging';
import { computeBadgePosition, isEligibleVideoSize, isRectVisible } from '@/src/lib/overlayGeometry';
import { buildOverlayStyle, buildBadge, buildToast, setBadgeState, type BadgeState } from './overlayElements';

type Availability = 'unknown' | 'pending' | 'available' | 'unavailable';

interface Badge {
  button: HTMLButtonElement;
  state: BadgeState;
  resetTimer: number | null;
  /** Échéance du second clic « retélécharger quand même », `0` hors fenêtre de confirmation. */
  forceUntil: number;
}

interface OverlayState {
  host: HTMLElement;
  shadow: ShadowRoot;
  toast: HTMLElement;
  observer: MutationObserver;
  teardown: (() => void)[];
  badges: Map<HTMLVideoElement, Badge>;
  availability: Availability;
  /** URL de page au moment du dernier verdict : une navigation SPA le rend caduc. */
  checkedUrl: string;
  /** Une vidéo exposait-elle son média lors du dernier verdict ? Son apparition en relance un. */
  checkedDirectMedia: boolean;
  /** Suspendu pendant le mode picker, pour ne pas voler le clic de sélection. */
  suspended: boolean;
  frame: number | null;
  toastTimer: number | null;
}

/** Garde-fou : une page pathologique (mur de vidéos) ne doit pas coûter des centaines de boutons. */
const MAX_BADGES = 12;

/** Fenêtre pendant laquelle un second clic sur un bouton « déjà téléchargée » relance le job. */
const DUPLICATE_CONFIRM_MS = 8000;

let state: OverlayState | null = null;

// ---------------------------------------------------------------------------
// Cycle de vie
// ---------------------------------------------------------------------------

export function mountVideoOverlay(): void {
  if (state || !document.body) return;

  const host = document.createElement('div');
  // `position:fixed` + `pointer-events:none` : l'hôte couvre l'écran sans jamais intercepter un
  // clic destiné à la page ; seuls les boutons réactivent les événements.
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;';

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.appendChild(buildOverlayStyle());
  const toast = buildToast();
  shadow.appendChild(toast);
  document.body.appendChild(host);

  const observer = new MutationObserver(() => scheduleSync());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  state = {
    host,
    shadow,
    toast,
    observer,
    teardown: [],
    badges: new Map(),
    availability: 'unknown',
    checkedUrl: location.href,
    checkedDirectMedia: false,
    suspended: false,
    frame: null,
    toastTimer: null,
  };

  listen(window, 'scroll', scheduleSync, true);
  listen(window, 'resize', scheduleSync, false);
  listen(document, 'fullscreenchange', onFullscreenChange, false);

  scheduleSync();
}

export function unmountVideoOverlay(): void {
  if (!state) return;
  state.observer.disconnect();
  for (const off of state.teardown) off();
  for (const badge of state.badges.values()) if (badge.resetTimer !== null) clearTimeout(badge.resetTimer);
  if (state.frame !== null) cancelAnimationFrame(state.frame);
  if (state.toastTimer !== null) clearTimeout(state.toastTimer);
  state.host.remove();
  state = null;
}

/** Masque les boutons pendant le mode picker (le clic doit aller au sélecteur d'élément). */
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
// Suivi des vidéos et positionnement
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

  const videos = findEligibleVideos();
  const hasDirectMedia = videos.some((video) => mediaUrlOf(video) !== null);
  // Une vidéo qui expose son média est téléchargeable même si le probe avait échoué : on redemande.
  if (state.availability === 'unavailable' && hasDirectMedia && !state.checkedDirectMedia) {
    state.availability = 'unknown';
  }
  if (state.availability === 'unknown') void requestAvailability(hasDirectMedia);

  if (state.suspended || state.availability !== 'available') {
    clearBadges();
    return;
  }
  renderBadges(videos);
}

/** Vidéos assez grandes et visibles pour mériter un bouton, les plus grandes d'abord. */
function findEligibleVideos(): HTMLVideoElement[] {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const eligible: { video: HTMLVideoElement; area: number }[] = [];
  for (const video of document.querySelectorAll('video')) {
    const rect = video.getBoundingClientRect();
    const box = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    if (!isEligibleVideoSize(box) || !isRectVisible(box, viewport)) continue;
    eligible.push({ video, area: box.width * box.height });
  }
  return eligible
    .sort((a, b) => b.area - a.area)
    .slice(0, MAX_BADGES)
    .map((entry) => entry.video);
}

function renderBadges(videos: HTMLVideoElement[]): void {
  if (!state) return;
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const visible = new Set(videos);

  for (const [video, badge] of state.badges) {
    if (visible.has(video)) continue;
    if (badge.resetTimer !== null) clearTimeout(badge.resetTimer);
    badge.button.remove();
    state.badges.delete(video);
  }

  for (const video of videos) {
    const badge = state.badges.get(video) ?? createBadge(video);
    const rect = video.getBoundingClientRect();
    const { left, top } = computeBadgePosition(
      { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      viewport,
    );
    badge.button.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    badge.button.style.display = 'flex';
  }
}

function createBadge(video: HTMLVideoElement): Badge {
  const button = buildBadge();
  // Capture + arrêt de propagation : sans cela le lecteur de la page se met en pause sous le clic.
  button.addEventListener(
    'click',
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      void submitQuickDownload(video);
    },
    true,
  );
  const badge: Badge = { button, state: 'idle', resetTimer: null, forceUntil: 0 };
  state?.shadow.appendChild(button);
  state?.badges.set(video, badge);
  return badge;
}

function clearBadges(): void {
  if (!state) return;
  for (const badge of state.badges.values()) {
    if (badge.resetTimer !== null) clearTimeout(badge.resetTimer);
    badge.button.remove();
  }
  state.badges.clear();
}

/** Plein écran : l'hôte doit vivre dans le sous-arbre plein écran, seul rendu par le navigateur. */
function onFullscreenChange(): void {
  if (!state) return;
  const parent = document.fullscreenElement ?? document.body;
  if (state.host.parentNode !== parent) parent.appendChild(state.host);
  scheduleSync();
}

/** URL média directe de l'élément, `null` pour un lecteur MSE (`blob:`) ou une source vide. */
function mediaUrlOf(video: HTMLVideoElement): string | null {
  const source = video.currentSrc || video.src || '';
  return source.startsWith('http://') || source.startsWith('https://') ? source : null;
}

// ---------------------------------------------------------------------------
// Messagerie
// ---------------------------------------------------------------------------

async function requestAvailability(hasDirectMedia: boolean): Promise<void> {
  if (!state || state.availability === 'pending') return;
  state.availability = 'pending';
  const url = location.href;
  try {
    const request: OverlayCheckRequest = { type: 'OVERLAY_CHECK', hasDirectMedia };
    const response = (await browser.runtime.sendMessage(request)) as OverlayCheckResponse | undefined;
    if (!state) return;
    state.availability = response?.available ? 'available' : 'unavailable';
    state.checkedUrl = url;
    state.checkedDirectMedia = hasDirectMedia;
  } catch {
    if (state) state.availability = 'unavailable'; // Background endormi/rechargé : pas de bouton.
  }
  scheduleSync();
}

async function submitQuickDownload(video: HTMLVideoElement): Promise<void> {
  const badge = state?.badges.get(video);
  if (!state || !badge || badge.state === 'sending') return;
  // Second clic dans la fenêtre de confirmation : l'utilisateur assume le doublon.
  const isForced = badge.state === 'duplicate' && Date.now() < badge.forceUntil;
  applyBadgeState(badge, 'sending');
  try {
    const request: QuickDownloadRequest = {
      type: 'QUICK_DOWNLOAD',
      clicked: {
        mediaUrl: mediaUrlOf(video),
        title: findVideoTitle(video),
        isOnlyVideo: document.querySelectorAll('video').length === 1,
      },
      force: isForced,
    };
    const response = (await browser.runtime.sendMessage(request)) as QuickDownloadResponse | undefined;
    if (!response || !response.ok) {
      const isDuplicate = response?.duplicate === true;
      applyBadgeState(badge, isDuplicate ? 'duplicate' : 'error');
      showToast(response?.error ?? 'Extension indisponible, rechargez la page.', isDuplicate ? 'duplicate' : 'error');
      return;
    }
    applyBadgeState(badge, 'success');
    showToast('Envoyé au serveur ez-dl.', 'success');
  } catch {
    applyBadgeState(badge, 'error');
    showToast('Extension indisponible, rechargez la page.', 'error');
  }
}

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------

function applyBadgeState(badge: Badge, next: BadgeState): void {
  badge.state = next;
  setBadgeState(badge.button, next);
  if (badge.resetTimer !== null) clearTimeout(badge.resetTimer);
  badge.forceUntil = next === 'duplicate' ? Date.now() + DUPLICATE_CONFIRM_MS : 0;
  if (next === 'success' || next === 'error') {
    badge.resetTimer = window.setTimeout(() => applyBadgeState(badge, 'idle'), 2500);
  }
  if (next === 'duplicate') {
    badge.resetTimer = window.setTimeout(() => applyBadgeState(badge, 'idle'), DUPLICATE_CONFIRM_MS);
  }
}

function showToast(message: string, tone: 'success' | 'error' | 'duplicate'): void {
  if (!state) return;
  // `textContent` et non `innerHTML` : le message vient du serveur, il n'est jamais du balisage.
  state.toast.textContent = message;
  state.toast.dataset.tone = tone;
  state.toast.style.display = 'block';
  if (state.toastTimer !== null) clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => {
    if (state) state.toast.style.display = 'none';
  }, 4000);
}
