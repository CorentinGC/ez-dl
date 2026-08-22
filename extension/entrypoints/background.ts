/**
 * Service worker MV3 : sniffe les requêtes réseau pour détecter des flux vidéo par onglet,
 * applique les règles de site apprises, maintient le badge, et relaie les messages entre
 * popup/options et content script.
 *
 * Le service worker MV3 peut s'endormir à tout instant : aucun état critique ne vit
 * uniquement en mémoire du module (hors caches best-effort explicitement documentés) —
 * tout état durable transite par `chrome.storage.session`/`local` (voir `src/lib/storage.ts`).
 */

import { toApiConfig, createApiClient, type ApiError } from '@/src/lib/api';
import {
  applySiteRules,
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
  OverlayCheckResponse,
  QuickDownloadResponse,
  SaveRuleResponse,
  TabStateUpdatedMessage,
} from '@/src/lib/messaging';
import { hasActiveServerChanged } from '@/src/lib/profiles';
import { resolveOverlayAvailability, runQuickDownload } from '@/src/lib/quickDownload';
import {
  EMPTY_TAB_STATE,
  RULES_CACHE_TTL_MS,
  clearTabState,
  getCachedRules,
  getSettings,
  getTabState,
  invalidateRulesCache,
  isServerConfigured,
  setCachedRules,
  setTabState,
} from '@/src/lib/storage';
import type { MediaCandidate, PageInfo, RawRequest, SiteRule } from '@/src/lib/types';

/** Ressources réseau observées : couvre <video>/<audio> direct et manifestes via XHR/fetch. */
const OBSERVED_RESOURCE_TYPES: `${Browser.webRequest.ResourceType}`[] = ['media', 'xmlhttprequest', 'object', 'other'];

const BADGE_COLOR = '#2563eb';

/** Fusionne plusieurs fetch concurrents des règles apprises en une seule requête serveur. */
let rulesFetchInFlight: Promise<SiteRule[]> | null = null;

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
    if (changeInfo.status !== 'loading' || !changeInfo.url) return;
    void clearTabState(tabId).then(() => refreshBadgeIfActive(tabId, 0));
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
    if (change && hasActiveServerChanged(change.oldValue, change.newValue)) void invalidateRulesCache();
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
    // Pas de match générique : on tente les règles de site apprises pour ce domaine.
    const rules = await getRulesForUrl(raw.url);
    candidate = applySiteRules([raw], rules)[0] ?? null;
  }

  if (!candidate) return;
  await mergeCandidate(raw.tabId, candidate);
}

async function mergeCandidate(tabId: number, candidate: MediaCandidate): Promise<void> {
  const state = await getTabState(tabId);
  const candidates = groupSegmentsByPlaylist(dedupeCandidates([...state.candidates, candidate]));
  if (candidates.length === state.candidates.length && candidates.every((c, i) => c.url === state.candidates[i]?.url)) {
    return; // Rien de nouveau : pas d'écriture ni de broadcast inutiles.
  }
  await setTabState(tabId, { ...state, candidates, updatedAt: Date.now() });
  await refreshBadgeIfActive(tabId, candidates.length);
  broadcastTabStateUpdated(tabId, candidates.length);
  notifyOverlayAvailable(tabId);
}

/** Règles apprises applicables au domaine d'une URL, avec cache TTL dans storage.session. */
async function getRulesForUrl(url: string): Promise<SiteRule[]> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return [];
  }
  const cached = await getCachedRules();
  if (cached) return filterRulesForHostname(cached, hostname);

  if (!rulesFetchInFlight) {
    rulesFetchInFlight = fetchAllRules().finally(() => {
      rulesFetchInFlight = null;
    });
  }
  return filterRulesForHostname(await rulesFetchInFlight, hostname);
}

function filterRulesForHostname(rules: SiteRule[], hostname: string): SiteRule[] {
  return rules.filter((rule) => hostname === rule.domain || hostname.endsWith(`.${rule.domain}`));
}

async function fetchAllRules(): Promise<SiteRule[]> {
  const settings = await getSettings();
  if (!isServerConfigured(settings)) {
    await setCachedRules([], RULES_CACHE_TTL_MS);
    return [];
  }
  try {
    const rules = await createApiClient(toApiConfig(settings)).listRules();
    await setCachedRules(rules);
    return rules;
  } catch {
    // Serveur injoignable : le sniffer générique reste opérationnel, on retente vite (30s).
    await setCachedRules([], 30_000);
    return [];
  }
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

async function handleMessage(message: BackgroundRequest, sender: Browser.runtime.MessageSender): Promise<unknown> {
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
    case 'OVERLAY_CHECK':
      return handleOverlayCheck(sender.tab);
    case 'QUICK_DOWNLOAD':
      return handleQuickDownload(sender.tab);
    default:
      return { ok: false, error: 'Message inconnu.' };
  }
}

async function handleGetTabState(requestedTabId?: number): Promise<GetTabStateResponse> {
  const tabId = requestedTabId ?? (await activeTabId());
  if (tabId === undefined) return { ...EMPTY_TAB_STATE, tabId: -1 };

  const state = await getTabState(tabId);
  const freshPageInfo = await requestFreshPageInfo(tabId);
  if (freshPageInfo) await setTabState(tabId, { ...state, pageInfo: freshPageInfo, updatedAt: Date.now() });

  return { ...state, pageInfo: freshPageInfo ?? state.pageInfo, tabId };
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
  const state = await getTabState(tabId);
  await setTabState(tabId, { ...state, pageInfo, updatedAt: Date.now() });
  return { ok: true };
}

async function handlePickedElement(
  tabId: number | undefined,
  message: Extract<BackgroundRequest, { type: 'PICKED_ELEMENT' }>,
): Promise<{ ok: boolean }> {
  if (tabId === undefined) return { ok: false };
  const state = await getTabState(tabId);
  const correlated = correlatePickedElement(message.element, state.candidates);
  const candidates = correlated ? dedupeCandidates([...state.candidates, correlated]) : state.candidates;
  await setTabState(tabId, { ...state, candidates, pickedElement: message.element, updatedAt: Date.now() });
  await refreshBadgeIfActive(tabId, candidates.length);
  broadcastTabStateUpdated(tabId, candidates.length);
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
    await invalidateRulesCache();
    return { ok: true, rule };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * Le content script ne fournit aucune donnée : l'onglet et son URL viennent de `sender`, jamais
 * de la page — sinon n'importe quel script de la page pourrait faire sonder une URL arbitraire.
 */
async function handleOverlayCheck(tab: Browser.tabs.Tab | undefined): Promise<OverlayCheckResponse> {
  if (tab?.id === undefined || !tab.url) return { available: false };
  return { available: await resolveOverlayAvailability(tab.id, tab.url) };
}

async function handleQuickDownload(tab: Browser.tabs.Tab | undefined): Promise<QuickDownloadResponse> {
  if (tab?.id === undefined || !tab.url) return { ok: false, error: 'Onglet introuvable.' };
  return runQuickDownload(tab.id, tab.url);
}

/** Signale au content script qu'une source vient d'apparaître (flux sniffé après chargement). */
function notifyOverlayAvailable(tabId: number): void {
  browser.tabs.sendMessage(tabId, { type: 'OVERLAY_AVAILABLE' } satisfies ContentRequest).catch(() => {
    // Pas de content script injecté sur cet onglet (page interne, extension rechargée) : normal.
  });
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String((error as ApiError).message);
  return 'Erreur inconnue.';
}
