/**
 * Content script : extrait le titre de page / balises OpenGraph / éléments `<video>`, monte le
 * bouton de téléchargement en overlay sur les vidéos, et fournit le mode picker DOM du mode
 * apprentissage (surlignage au survol, clic pour choisir l'élément vidéo/conteneur, Échap pour
 * annuler).
 */

import { mountVideoOverlay, setOverlaySuspended, unmountVideoOverlay } from '@/src/content/videoOverlay';
import type { ContentRequest, PageInfoMessage, PickedElementMessage, PickerCancelledMessage } from '@/src/lib/messaging';
import type { PageInfo, PickedElementInfo } from '@/src/lib/types';
import { getUiPrefs, watchUiPrefs } from '@/src/lib/uiPrefs';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    void sendPageInfo();
    void applyOverlayPref();
    // La page options peut basculer le réglage pendant que la page est ouverte : on suit à chaud.
    watchUiPrefs((prefs) => (prefs.showPageOverlay ? mountVideoOverlay() : unmountVideoOverlay()));
    // Certains lecteurs injectent leur <video> après le chargement initial (SPA) : on renvoie
    // un instantané une deuxième fois pour rattraper ce cas courant sans complexité excessive.
    window.addEventListener('load', () => void sendPageInfo());

    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      handleMessage(message as ContentRequest, sendResponse);
      // Toutes les réponses sont envoyées de façon synchrone : ne pas garder le canal ouvert
      // (sinon un message sans réponse laisse l'expéditeur en attente jusqu'à la fermeture).
      return false;
    });
  },
});

function handleMessage(message: ContentRequest, sendResponse: (response?: unknown) => void): void {
  switch (message.type) {
    case 'ACTIVATE_PICKER':
      activatePicker();
      sendResponse({ ok: true });
      return;
    case 'DEACTIVATE_PICKER':
      deactivatePicker();
      sendResponse({ ok: true });
      return;
    case 'GET_PAGE_INFO':
      sendResponse({ pageInfo: extractPageInfo() });
      return;
    default:
      return; // message inconnu : pas de réponse
  }
}

async function applyOverlayPref(): Promise<void> {
  if ((await getUiPrefs()).showPageOverlay) mountVideoOverlay();
}

// ---------------------------------------------------------------------------
// Infos de page
// ---------------------------------------------------------------------------

function extractPageInfo(): PageInfo {
  const videos = Array.from(document.querySelectorAll('video')).map((video) => ({
    src: video.getAttribute('src'),
    currentSrc: video.currentSrc || null,
    poster: video.poster || null,
    duration: Number.isFinite(video.duration) ? video.duration : null,
  }));
  return {
    pageTitle: document.title,
    videos,
    ogTitle: getMetaContent('og:title'),
    ogVideoUrl: getMetaContent('og:video') ?? getMetaContent('og:video:url'),
  };
}

function getMetaContent(property: string): string | null {
  return document.querySelector(`meta[property="${property}"]`)?.getAttribute('content') ?? null;
}

async function sendPageInfo(): Promise<void> {
  const message: PageInfoMessage = { type: 'PAGE_INFO', pageInfo: extractPageInfo() };
  try {
    await browser.runtime.sendMessage(message);
  } catch {
    // Background pas encore prêt (rechargement d'extension) : sans conséquence, la popup
    // redemandera un instantané frais via GET_PAGE_INFO si besoin.
  }
}

// ---------------------------------------------------------------------------
// Mode picker (apprentissage)
// ---------------------------------------------------------------------------

interface PickerState {
  hint: HTMLElement;
  highlight: HTMLElement;
  onMouseMove: (event: MouseEvent) => void;
  onClick: (event: MouseEvent) => void;
  onKeyDown: (event: KeyboardEvent) => void;
}

let pickerState: PickerState | null = null;

function activatePicker(): void {
  if (pickerState) return; // déjà actif, rien à faire.

  const highlight = document.createElement('div');
  highlight.setAttribute('aria-hidden', 'true');
  highlight.style.cssText =
    'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #2563eb;' +
    'background:rgba(37,99,235,.15);display:none;box-sizing:border-box;';
  document.body.appendChild(highlight);

  const hint = document.createElement('div');
  hint.setAttribute('aria-hidden', 'true');
  hint.textContent = 'ez-dl : cliquez sur la vidéo à détecter (Échap pour annuler)';
  hint.style.cssText =
    'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
    'background:#111827;color:#f9fafb;padding:8px 16px;border-radius:8px;' +
    'font:14px/1.4 -apple-system,system-ui,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.3);' +
    'pointer-events:none;';
  document.body.appendChild(hint);

  document.documentElement.style.cursor = 'crosshair';
  setOverlaySuspended(true);

  const onMouseMove = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element) || target === highlight || target === hint) return;
    const rect = target.getBoundingClientRect();
    highlight.style.display = 'block';
    highlight.style.left = `${rect.left}px`;
    highlight.style.top = `${rect.top}px`;
    highlight.style.width = `${rect.width}px`;
    highlight.style.height = `${rect.height}px`;
  };

  const onClick = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    const target = event.target;
    if (target instanceof Element) {
      const message: PickedElementMessage = { type: 'PICKED_ELEMENT', element: describeElement(target) };
      void browser.runtime.sendMessage(message);
    }
    deactivatePicker();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    const message: PickerCancelledMessage = { type: 'PICKER_CANCELLED' };
    void browser.runtime.sendMessage(message);
    deactivatePicker();
  };

  // Capture (3e argument `true`) : on intercepte avant les handlers de la page (lecteur vidéo,
  // liens…) pour éviter tout effet de bord (lecture/pause, navigation) pendant la sélection.
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);

  pickerState = { hint, highlight, onMouseMove, onClick, onKeyDown };
}

function deactivatePicker(): void {
  if (!pickerState) return;
  const { hint, highlight, onMouseMove, onClick, onKeyDown } = pickerState;
  document.removeEventListener('mousemove', onMouseMove, true);
  document.removeEventListener('click', onClick, true);
  document.removeEventListener('keydown', onKeyDown, true);
  hint.remove();
  highlight.remove();
  document.documentElement.style.cursor = '';
  setOverlaySuspended(false);
  pickerState = null;
}

function describeElement(element: Element): PickedElementInfo {
  const rect = element.getBoundingClientRect();
  const video = element instanceof HTMLVideoElement ? element : element.querySelector('video');
  return {
    tagName: element.tagName.toLowerCase(),
    src: video?.getAttribute('src') ?? element.getAttribute('src'),
    currentSrc: video?.currentSrc || null,
    poster: video?.poster || null,
    selector: buildSelector(element),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  };
}

/** Construit un sélecteur CSS lisible pour l'élément (limité à 5 niveaux de profondeur). */
function buildSelector(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.body && parts.length < 5) {
    let part = current.tagName.toLowerCase();
    if (current.id) {
      parts.unshift(`${part}#${current.id}`);
      break;
    }
    const parent: Element | null = current.parentElement;
    if (parent) {
      const sameTagSiblings = Array.from(parent.children).filter((c) => c.tagName === current?.tagName);
      if (sameTagSiblings.length > 1) part += `:nth-of-type(${sameTagSiblings.indexOf(current) + 1})`;
    }
    parts.unshift(part);
    current = parent;
  }
  return parts.join(' > ');
}
