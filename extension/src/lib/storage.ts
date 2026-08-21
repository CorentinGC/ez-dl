/**
 * Accès typé à `chrome.storage` :
 * - `local` pour les réglages persistants (survit aux redémarrages du navigateur) ;
 * - `session` pour l'état par onglet et le cache des règles apprises (effacé à la fermeture
 *   du navigateur, jamais écrit sur disque — le service worker MV3 s'endort souvent, donc
 *   aucun état critique ne doit rester uniquement en mémoire du module).
 */

import type { ExtensionSettings, FavoriteFolder, SiteRule, TabState } from './types';

const SETTINGS_KEY = 'settings';
const TAB_STATE_PREFIX = 'tabState:';
const RULES_CACHE_KEY = 'rulesCache';

/** TTL par défaut du cache des règles apprises. */
export const RULES_CACHE_TTL_MS = 5 * 60 * 1000;

export const DEFAULT_SETTINGS: ExtensionSettings = {
  // Port par défaut du serveur ez-dl (voir docker-compose.yml) : un serveur local tourne sans
  // configuration préalable de l'URL, seul le mot de passe reste à saisir (auth obligatoire).
  serverUrl: 'http://localhost:8000',
  password: '',
  favoriteFolders: [],
  defaultFolderPath: null,
  defaultPresetId: null,
  sendCookies: false,
};

export const EMPTY_TAB_STATE: TabState = {
  candidates: [],
  pageInfo: null,
  pickedElement: null,
  updatedAt: 0,
};

// ---------------------------------------------------------------------------
// Réglages (storage.local)
// ---------------------------------------------------------------------------

/** Lit les réglages depuis `storage.local`, complétés par les valeurs par défaut. */
export async function getSettings(): Promise<ExtensionSettings> {
  const stored = await browser.storage.local.get<Record<string, ExtensionSettings>>(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] ?? {}) };
}

/** Fusionne un patch partiel dans les réglages et le persiste. */
export async function saveSettings(patch: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const current = await getSettings();
  const next: ExtensionSettings = { ...current, ...patch };
  await browser.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/** Vrai si un serveur (URL + mot de passe) est configuré. */
export function isServerConfigured(settings: ExtensionSettings): boolean {
  return settings.serverUrl.trim().length > 0 && settings.password.trim().length > 0;
}

export async function addFavoriteFolder(folder: FavoriteFolder): Promise<ExtensionSettings> {
  const current = await getSettings();
  if (current.favoriteFolders.some((f) => f.path === folder.path)) return current;
  const favoriteFolders = [...current.favoriteFolders, folder];
  const defaultFolderPath = current.defaultFolderPath ?? folder.path;
  return saveSettings({ favoriteFolders, defaultFolderPath });
}

export async function removeFavoriteFolder(path: string): Promise<ExtensionSettings> {
  const current = await getSettings();
  const favoriteFolders = current.favoriteFolders.filter((f) => f.path !== path);
  const defaultFolderPath = current.defaultFolderPath === path ? (favoriteFolders[0]?.path ?? null) : current.defaultFolderPath;
  return saveSettings({ favoriteFolders, defaultFolderPath });
}

/** Réordonne les favoris selon la liste de chemins fournie (ordre = ordre d'affichage). */
export async function reorderFavoriteFolders(orderedPaths: string[]): Promise<ExtensionSettings> {
  const current = await getSettings();
  const byPath = new Map(current.favoriteFolders.map((f) => [f.path, f] as const));
  const favoriteFolders = orderedPaths
    .map((path) => byPath.get(path))
    .filter((f): f is FavoriteFolder => f !== undefined);
  return saveSettings({ favoriteFolders });
}

// ---------------------------------------------------------------------------
// État par onglet (storage.session)
// ---------------------------------------------------------------------------

function tabStateKey(tabId: number): string {
  return `${TAB_STATE_PREFIX}${tabId}`;
}

export async function getTabState(tabId: number): Promise<TabState> {
  const key = tabStateKey(tabId);
  const stored = await browser.storage.session.get<Record<string, TabState>>(key);
  return stored[key] ?? EMPTY_TAB_STATE;
}

export async function setTabState(tabId: number, state: TabState): Promise<void> {
  await browser.storage.session.set({ [tabStateKey(tabId)]: state });
}

export async function clearTabState(tabId: number): Promise<void> {
  await browser.storage.session.remove(tabStateKey(tabId));
}

// ---------------------------------------------------------------------------
// Cache des règles de site apprises (rafraîchi via GET /api/rules)
// ---------------------------------------------------------------------------

interface RulesCacheEntry {
  rules: SiteRule[];
  expiresAt: number;
}

/** Retourne les règles en cache si encore valides, `null` sinon (cache absent ou expiré). */
export async function getCachedRules(): Promise<SiteRule[] | null> {
  const stored = await browser.storage.session.get<Record<string, RulesCacheEntry>>(RULES_CACHE_KEY);
  const entry = stored[RULES_CACHE_KEY];
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.rules;
}

export async function setCachedRules(rules: SiteRule[], ttlMs = RULES_CACHE_TTL_MS): Promise<void> {
  const entry: RulesCacheEntry = { rules, expiresAt: Date.now() + ttlMs };
  await browser.storage.session.set({ [RULES_CACHE_KEY]: entry });
}

export async function invalidateRulesCache(): Promise<void> {
  await browser.storage.session.remove(RULES_CACHE_KEY);
}
