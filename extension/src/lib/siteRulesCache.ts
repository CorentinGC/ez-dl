/**
 * Règles de site apprises, prêtes à appliquer à chaque requête sniffée.
 *
 * Trois niveaux, du plus rapide au plus lent :
 * 1. mémoire du worker (`memo`) : règles **déjà compilées**, zéro I/O par requête `webRequest` ;
 * 2. `storage.session` : survit au sommeil du worker, partagé avec le TTL de la mémoire ;
 * 3. `GET /api/rules` : un seul appel à la fois, même si plusieurs requêtes l'attendent.
 *
 * La mémoire n'est qu'un accélérateur : la perdre (sommeil du worker) coûte un `storage.session.get`.
 */

import { createApiClient, toApiConfig } from './api';
import { compileSiteRules, type CompiledSiteRule } from './detection';
import {
  RULES_CACHE_TTL_MS,
  getCachedRules,
  getSettings,
  invalidateRulesCache,
  isServerConfigured,
  setCachedRules,
  type RulesCacheEntry,
} from './storage';

/** Nouvel essai rapide quand le serveur est injoignable. */
const RULES_ERROR_RETRY_MS = 30_000;

interface RulesMemo {
  compiled: CompiledSiteRule[];
  expiresAt: number;
}

let memo: RulesMemo | null = null;
let fetchInFlight: Promise<RulesMemo> | null = null;
/** Incrémenté à chaque invalidation : un chargement démarré avant ne doit pas repeupler la mémoire. */
let epoch = 0;

/** Règles compilées valides ; ne touche ni au storage ni au réseau tant que la mémoire est fraîche. */
export async function getCompiledRules(): Promise<CompiledSiteRule[]> {
  if (memo && memo.expiresAt > Date.now()) return memo.compiled;

  fetchInFlight ??= loadRules().finally(() => {
    fetchInFlight = null;
  });
  return (await fetchInFlight).compiled;
}

/** Oublie les règles (changement de serveur, règle créée) : mémoire et `storage.session`. */
export async function invalidateRules(): Promise<void> {
  epoch += 1;
  memo = null;
  fetchInFlight = null;
  await invalidateRulesCache();
}

async function loadRules(): Promise<RulesMemo> {
  const startedAt = epoch;
  const cached = await getCachedRules();
  const entry = cached ?? (await fetchRules());
  const loaded = toMemo(entry);
  if (startedAt === epoch) memo = loaded;
  return loaded;
}

function toMemo(entry: RulesCacheEntry): RulesMemo {
  return { compiled: compileSiteRules(entry.rules), expiresAt: entry.expiresAt };
}

async function fetchRules(): Promise<RulesCacheEntry> {
  const settings = await getSettings();
  if (!isServerConfigured(settings)) return setCachedRules([], RULES_CACHE_TTL_MS);
  try {
    return await setCachedRules(await createApiClient(toApiConfig(settings)).listRules());
  } catch {
    // Serveur injoignable : le sniffer générique reste opérationnel, on retente vite.
    return setCachedRules([], RULES_ERROR_RETRY_MS);
  }
}
