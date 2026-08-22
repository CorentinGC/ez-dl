/**
 * Accès typé à `chrome.storage` :
 * - `local` pour les réglages persistants (survit aux redémarrages du navigateur) ;
 * - `session` pour l'état par onglet et le cache des règles apprises (effacé à la fermeture
 *   du navigateur, jamais écrit sur disque — le service worker MV3 s'endort souvent, donc
 *   aucun état critique ne doit rester uniquement en mémoire du module).
 */

import type { SiteRule, TabState } from './types';

const TAB_STATE_PREFIX = 'tabState:';
const RULES_CACHE_KEY = 'rulesCache';

/** TTL par défaut du cache des règles apprises. */
export const RULES_CACHE_TTL_MS = 5 * 60 * 1000;

export const EMPTY_TAB_STATE: TabState = {
  candidates: [],
  pageInfo: null,
  pickedElement: null,
  updatedAt: 0,
};

// ---------------------------------------------------------------------------
// Réglages (storage.local) — délégués à `profiles.ts` depuis les profils multi-serveurs.
// Ces ré-exports gardent `storage.ts` comme point d'entrée unique côté appelants : la vue
// aplatie (`getSettings`/`saveSettings`) porte toujours sur le profil actif.
// ---------------------------------------------------------------------------

export { DEFAULT_SETTINGS, getSettings, isServerConfigured, saveSettings } from './profiles';

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
