/**
 * Service worker MV3 : sniffe les requêtes réseau pour détecter des flux vidéo par onglet,
 * applique les règles de site apprises, maintient le badge, et relaie les messages entre
 * popup/options et content script.
 *
 * Le service worker MV3 peut s'endormir à tout instant : aucun état critique ne vit
 * uniquement en mémoire du module (hors caches best-effort explicitement documentés) —
 * tout état durable transite par `chrome.storage.session`/`local` (voir `src/lib/storage.ts`).
 */

import { createApiClient, toApiConfig, type ApiError } from '@/src/lib/api';
import {
  applyCompiledSiteRules,
  classifyUrl,
  correlatePickedElement,
  dedupeCandidates,
  groupSegmentsByPlaylist,
  isMediaUrl,
} from '@/src/lib/detection';
import type {
  BackgroundRequest,
  ContentRequest,
  GetTabStateResponse,
  QuickDownloadResponse,
  SaveRuleResponse,
  TabStateUpdatedMessage,
} from '@/src/lib/messaging';
import { hasPageChanged } from '@/src/lib/pageNavigation';
import { hasActiveServerChanged } from '@/src/lib/profiles';
import { runQuickDownload } from '@/src/lib/quickDownload';
import { isExtensionSender } from '@/src/lib/senderGuard';
import { getCompiledRules, invalidateRules } from '@/src/lib/siteRulesCache';
import {
  EMPTY_TAB_STATE,
  clearTabState,
  getSettings,
  getTabGeneration,
  getTabState,
  isServerConfigured,
  updateTabState,
} from '@/src/lib/storage';
import type { MediaCandidate, PageInfo, RawRequest } from '@/src/lib/types';

/** Ressources réseau observées : couvre <video>/<audio> direct et manifestes via XHR/fetch. */
const OBSERVED_RESOURCE_TYPES: `${Browser.webRequest.ResourceType}`[] = ['media', 'xmlhttprequest', 'object', 'other'];

const BADGE_COLOR = '#2563eb';

export default defineBackground(() => {
  void browser.action.setBadgeBackgroundColor({ color: BADGE_COLOR });

  browser.webRequest.onBeforeRequest.addListener(
    handleBeforeRequest,
    { urls: ['<all_urls>'], types: OBSERVED_RESOURCE_TYPES },
  );

  browser.webRequest.onHeadersReceived.addListener(
    handleHeadersReceived,
    { urls: ['<all_urls>'], types: OBSERVED_RESOURCE_TYPES },
    ['responseHeaders'],
  );

  // Navigation vers une nouvelle page : les candidats de l'ancienne page n'ont plus de sens.
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url) void handleUrlChange(tabId, changeInfo.url, changeInfo.status === 'loading');
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    void clearTabState(tabId);
  });

  browser.tabs.onActivated.addListener(({ tabId }) => {
    void getTabState(tabId).then((state) => refreshBadge(tabId, state.candidates.length));
  });

  // Changement de serveur actif : les règles en cache viennent de l'ancien serveur et seraient
  // appliquées jusqu'à 5 min de plus. Le test porte sur l'URL/mot de passe effectifs, pour ne pas
  // vider le cache à chaque renommage de profil ou ajout de favori.
  browser.storage.local.onChanged.addListener((changes) => {
    const change = changes.settings;
    if (change && hasActiveServerChanged(change.oldValue, change.newValue)) void invalidateRules();
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message as BackgroundRequest, sender)
      .then(sendResponse)
      .catch((error: unknown) => sendResponse({ ok: false, error: errorMessage(error) }));
    return true; // réponse asynchrone : garder le canal ouvert jusqu'à sendResponse.
  });
});

// ---------------------------------------------------------------------------
// Sniffing réseau
// ---------------------------------------------------------------------------

// Écouteurs déclarés en tant que fonctions nommées (et non en tant qu'annotées `: undefined`)
// car TypeScript infère `void` pour un `return;` nu dans une fléchée inline, ce qui n'est pas
// assignable au type attendu `BlockingResponse | undefined` — on observe seulement, sans bloquer.
function handleBeforeRequest(details: Browser.webRequest.OnBeforeRequestDetails): undefined {
  if (details.tabId < 0) return undefined;
  void recordRawRequest({ url: details.url, tabId: details.tabId, timeStamp: details.timeStamp });
  return undefined;
}

function handleHeadersReceived(details: Browser.webRequest.OnHeadersReceivedDetails): undefined {
  if (details.tabId < 0) return undefined;
  const headers = details.responseHeaders ?? [];
  const contentType = findHeader(headers, 'content-type');
  const contentLength = parseContentLength(findHeader(headers, 'content-length'));
  void recordRawRequest({
    url: details.url,
    tabId: details.tabId,
    timeStamp: details.timeStamp,
    contentType,
    contentLength,
  });
  return undefined;
}

function findHeader(headers: Browser.webRequest.HttpHeader[], name: string): string | null {
  return headers.find((h) => h.name.toLowerCase() === name)?.value ?? null;
}

function parseContentLength(raw: string | null): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

async function recordRawRequest(raw: RawRequest): Promise<void> {
  // Génération capturée avant tout `await` : une purge survenue pendant le traitement l'invalide.
  const generation = getTabGeneration(raw.tabId);
  let candidate: MediaCandidate | null = null;

  if (isMediaUrl(raw.url, raw.contentType)) {
    candidate = {
      url: raw.url,
      kind: classifyUrl(raw.url, raw.contentType) ?? 'other-video',
      source: 'sniffed',
      contentType: raw.contentType ?? null,
      size: raw.contentLength ?? null,
      discoveredAt: raw.timeStamp ?? Date.now(),
    };
  } else {
    // Pas de match générique : on tente les règles de site apprises (compilées, en mémoire).
    candidate = applyCompiledSiteRules([raw], await getCompiledRules())[0] ?? null;
  }

  if (!candidate) return;
  await mergeCandidate(raw.tabId, candidate, generation);
}

async function mergeCandidate(tabId: number, candidate: MediaCandidate, generation: number): Promise<void> {
  const written = await updateTabState(
    tabId,
    (state) => {
      const candidates = groupSegmentsByPlaylist(dedupeCandidates([...state.candidates, candidate]));
      const isUnchanged =
        candidates.length === state.candidates.length && candidates.every((c, i) => c.url === state.candidates[i]?.url);
      // Rien de nouveau : pas d'écriture ni de broadcast inutiles.
      return isUnchanged ? null : { ...state, candidates, updatedAt: Date.now() };
    },
    generation,
  );
  if (!written) return;
  await refreshBadgeIfActive(tabId, written.candidates.length);
  broadcastTabStateUpdated(tabId, written.candidates.length);
}

/**
 * Changement d'URL d'un onglet. `status: 'loading'` couvre les vraies navigations ; les SPA
 * (YouTube, X) changent d'URL sans l'émettre, d'où la comparaison avec l'URL mémorisée.
 */
async function handleUrlChange(tabId: number, url: string, isLoading: boolean): Promise<void> {
  // Purge immédiate sur `loading` : lire l'état d'abord laisserait filtrer les requêtes de la nouvelle page.
  if (isLoading || hasPageChanged((await getTabState(tabId)).pageUrl, url)) {
    await clearTabState(tabId);
    await refreshBadgeIfActive(tabId, 0);
  }
  await updateTabState(tabId, (state) => (state.pageUrl === url ? null : { ...state, pageUrl: url }));
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

async function refreshBadgeIfActive(tabId: number, count: number): Promise<void> {
  const [activeTab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (activeTab?.id === tabId) await refreshBadge(tabId, count);
}

async function refreshBadge(tabId: number, count: number): Promise<void> {
  await browser.action.setBadgeText({ tabId, text: count > 0 ? String(count) : '' });
}

function broadcastTabStateUpdated(tabId: number, candidateCount: number): void {
  const message: TabStateUpdatedMessage = { type: 'TAB_STATE_UPDATED', tabId, candidateCount };
  browser.runtime.sendMessage(message).catch(() => {
    // Aucune page d'extension ouverte pour recevoir le message : pas une erreur.
  });
}

// ---------------------------------------------------------------------------
// Messagerie (popup/options/content -> background)
// ---------------------------------------------------------------------------

/** Types de messages réservés aux pages de l'extension (popup/options) : jamais à un content script. */
const PRIVILEGED_MESSAGE_TYPES: ReadonlySet<BackgroundRequest['type']> = new Set([
  'SAVE_RULE',
  'GET_TAB_STATE',
  'CLEAR_TAB',
  'START_PICKER',
]);

async function handleMessage(message: BackgroundRequest, sender: Browser.runtime.MessageSender): Promise<unknown> {
  if (PRIVILEGED_MESSAGE_TYPES.has(message.type) && !isExtensionSender(sender.url, browser.runtime.getURL(''))) {
    return { ok: false, error: 'Expéditeur non autorisé.' };
  }
  switch (message.type) {
    case 'GET_TAB_STATE':
      return handleGetTabState(message.tabId);
    case 'CLEAR_TAB':
      await clearTabState(message.tabId);
      await refreshBadgeIfActive(message.tabId, 0);
      return { ok: true };
    case 'START_PICKER':
      await browser.tabs.sendMessage(message.tabId, { type: 'ACTIVATE_PICKER' } satisfies ContentRequest);
      return { ok: true };
    case 'SAVE_RULE':
      return handleSaveRule(message);
    case 'PAGE_INFO':
      return handlePageInfo(sender.tab?.id, message.pageInfo);
    case 'PICKED_ELEMENT':
      return handlePickedElement(sender.tab?.id, message);
    case 'PICKER_CANCELLED':
      return { ok: true };
    case 'QUICK_DOWNLOAD':
      return handleQuickDownload(sender.tab, message.clicked, message.force === true);
    default:
      return { ok: false, error: 'Message inconnu.' };
  }
}

async function handleGetTabState(requestedTabId?: number): Promise<GetTabStateResponse> {
  const tabId = requestedTabId ?? (await activeTabId());
  if (tabId === undefined) return { ...EMPTY_TAB_STATE, tabId: -1 };

  const generation = getTabGeneration(tabId);
  const freshPageInfo = await requestFreshPageInfo(tabId);
  const written = freshPageInfo
    ? await updateTabState(tabId, (state) => ({ ...state, pageInfo: freshPageInfo, updatedAt: Date.now() }), generation)
    : null;
  return { ...(written ?? (await getTabState(tabId))), tabId };
}

async function activeTabId(): Promise<number | undefined> {
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id;
}

/** Interroge le content script pour un instantané frais des infos de page (best-effort). */
async function requestFreshPageInfo(tabId: number): Promise<PageInfo | null> {
  try {
    const response = await browser.tabs.sendMessage(tabId, { type: 'GET_PAGE_INFO' } satisfies ContentRequest);
    return (response as { pageInfo: PageInfo } | undefined)?.pageInfo ?? null;
  } catch {
    return null; // Pas de content script injecté (page interne, onglet pas encore chargé…).
  }
}

async function handlePageInfo(tabId: number | undefined, pageInfo: PageInfo): Promise<{ ok: boolean }> {
  if (tabId === undefined) return { ok: false };
  await updateTabState(tabId, (state) => ({ ...state, pageInfo, updatedAt: Date.now() }));
  return { ok: true };
}

async function handlePickedElement(
  tabId: number | undefined,
  message: Extract<BackgroundRequest, { type: 'PICKED_ELEMENT' }>,
): Promise<{ ok: boolean }> {
  if (tabId === undefined) return { ok: false };
  const written = await updateTabState(tabId, (state) => {
    const correlated = correlatePickedElement(message.element, state.candidates);
    const candidates = correlated ? dedupeCandidates([...state.candidates, correlated]) : state.candidates;
    return { ...state, candidates, pickedElement: message.element, updatedAt: Date.now() };
  });
  if (!written) return { ok: true };
  await refreshBadgeIfActive(tabId, written.candidates.length);
  broadcastTabStateUpdated(tabId, written.candidates.length);
  return { ok: true };
}

async function handleSaveRule(
  message: Extract<BackgroundRequest, { type: 'SAVE_RULE' }>,
): Promise<SaveRuleResponse> {
  const settings = await getSettings();
  if (!isServerConfigured(settings)) return { ok: false, error: 'Serveur non configuré.' };
  try {
    const rule = await createApiClient(toApiConfig(settings)).createRule({
      domain: message.domain,
      url_pattern: message.urlPattern,
      label: message.label,
      notes: message.notes,
      source: message.source,
    });
    await invalidateRules();
    return { ok: true, rule };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * L'onglet et son URL viennent de `sender`, jamais de la page — sinon n'importe quel script de
 * la page pourrait faire sonder une URL arbitraire. Le contenu de `clicked` est assaini en aval.
 */
async function handleQuickDownload(
  tab: Browser.tabs.Tab | undefined,
  clicked: unknown,
  isForced: boolean,
): Promise<QuickDownloadResponse> {
  if (tab?.id === undefined || !tab.url) return { ok: false, error: 'Onglet introuvable.' };
  return runQuickDownload(tab.id, { url: tab.url, title: tab.title }, clicked, isForced);
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String((error as ApiError).message);
  return 'Erreur inconnue.';
}
