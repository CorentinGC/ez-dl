/**
 * Accès typé à `chrome.storage` :
 * - `local` pour les réglages persistants (survit aux redémarrages du navigateur) ;
 * - `session` pour l'état par onglet et le cache des règles apprises (effacé à la fermeture
 *   du navigateur, jamais écrit sur disque — le service worker MV3 s'endort souvent, donc
 *   aucun état critique ne doit rester uniquement en mémoire du module).
 */

import { createTabStateGuard } from './tabStateGuard';
import type { SiteRule, TabState } from './types';

const TAB_STATE_PREFIX = 'tabState:';
const RULES_CACHE_KEY = 'rulesCache';

/** TTL par défaut du cache des règles apprises. */
export const RULES_CACHE_TTL_MS = 5 * 60 * 1000;

export const EMPTY_TAB_STATE: TabState = {
  candidates: [],
  pageInfo: null,
  pickedElement: null,
  quickProbe: null,
  pageUrl: null,
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

/** Garde partagé par tout le worker : sérialise les écritures d'un onglet et invalide les périmées. */
const tabStateGuard = createTabStateGuard();

/** Génération courante d'un onglet : à capturer au début d'une opération qui écrira plus tard. */
export function getTabGeneration(tabId: number): number {
  return tabStateGuard.generationOf(tabId);
}

/**
 * Lecture -> modification -> écriture atomique de l'état d'un onglet. `updater` renvoie le nouvel
 * état, ou `null` pour ne rien écrire. Retourne l'état écrit, `null` si rien n'a été écrit ou si
 * l'opération est périmée (`generation` ne correspond plus : onglet purgé entre-temps).
 */
export async function updateTabState(
  tabId: number,
  updater: (state: TabState) => TabState | null,
  generation: number = tabStateGuard.generationOf(tabId),
): Promise<TabState | null> {
  return tabStateGuard.run(tabId, async () => {
    if (tabStateGuard.generationOf(tabId) !== generation) return null;
    const next = updater(await getTabState(tabId));
    if (!next) return null;
    await browser.storage.session.set({ [tabStateKey(tabId)]: next });
    return next;
  });
}

/** Purge l'état d'un onglet : les écritures en file ou en vol de l'ancienne génération sont abandonnées. */
export async function clearTabState(tabId: number): Promise<void> {
  tabStateGuard.invalidate(tabId);
  await tabStateGuard.run(tabId, () => browser.storage.session.remove(tabStateKey(tabId)));
}

// ---------------------------------------------------------------------------
// Cache des règles de site apprises (rafraîchi via GET /api/rules)
// ---------------------------------------------------------------------------

export interface RulesCacheEntry {
  rules: SiteRule[];
  expiresAt: number;
}

/** Retourne l'entrée en cache si encore valide, `null` sinon (cache absent ou expiré). */
export async function getCachedRules(): Promise<RulesCacheEntry | null> {
  const stored = await browser.storage.session.get<Record<string, RulesCacheEntry>>(RULES_CACHE_KEY);
  const entry = stored[RULES_CACHE_KEY];
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry;
}

export async function setCachedRules(rules: SiteRule[], ttlMs = RULES_CACHE_TTL_MS): Promise<RulesCacheEntry> {
  const entry: RulesCacheEntry = { rules, expiresAt: Date.now() + ttlMs };
  await browser.storage.session.set({ [RULES_CACHE_KEY]: entry });
  return entry;
}

export async function invalidateRulesCache(): Promise<void> {
  await browser.storage.session.remove(RULES_CACHE_KEY);
}
