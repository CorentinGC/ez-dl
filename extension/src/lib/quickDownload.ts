/**
 * Téléchargement en un clic déclenché par le bouton en overlay de la page.
 *
 * Vit côté **service worker** : lui seul peut lire les cookies et joindre le serveur avec le mot
 * de passe. Le content script n'obtient jamais qu'un résultat de job — ni URL de serveur, ni mot
 * de passe, ni cookies ne traversent la frontière de la page.
 *
 * Le serveur n'est sollicité (probe, cookies éventuels) qu'**au clic** : aucune requête
 * n'est émise en arrière-plan pour une page simplement visitée.
 *
 * Extrait de `background.ts` pour garder le service worker sous le seuil de 400 LOC.
 */

import { createApiClient, NetworkError, toApiConfig } from './api';
import { readCookiesForUrl } from './cookies';
import { isListingUrl } from './listingUrl';
import type { QuickDownloadResponse } from './messaging';
import { pickQuickSource, resolveDefaultFolder, sanitizeClickedVideo, type ClickedVideo } from './quickSource';
import { createSingleFlight, probeFlightKey } from './singleFlight';
import { getSettings, getTabGeneration, getTabState, isServerConfigured, updateTabState } from './storage';
import type { ExtensionSettings, ProbeResponse, QuickProbeCache, TabState } from './types';

/**
 * Probes en vol, par onglet **et** URL : les iframes d'une même page interrogent toutes le
 * background, mais après une navigation SPA le probe de la vidéo A ne doit pas servir la vidéo B.
 */
const probeFlight = createSingleFlight<QuickProbeCache>();

/** Crée le job correspondant au clic sur le bouton : meilleure qualité et réglages par défaut. */
export async function runQuickDownload(
  tabId: number,
  tab: { url: string; title?: string },
  rawClicked: unknown,
  isForced = false,
): Promise<QuickDownloadResponse> {
  const tabUrl = tab.url;
  const clicked = sanitizeClickedVideo(rawClicked);
  const settings = await getSettings();
  if (!isServerConfigured(settings)) return { ok: false, error: 'Serveur ez-dl non configuré.' };
  if (!isProbeableUrl(tabUrl)) return { ok: false, error: 'Page non téléchargeable.' };

  const folder = resolveDefaultFolder(settings);
  if (!folder) return { ok: false, error: 'Aucun dossier favori : configurez-en un dans les options.' };

  const state = await getTabState(tabId);
  const probe = await resolveProbe(tabId, tabUrl, state, clicked, settings);
  const source = pickQuickSource({
    probe,
    candidates: state.candidates,
    pageUrl: tabUrl,
    // `sender.tab.title` est toujours frais, contrairement à l'instantané de page mémorisé, qui
    // peut dater de la page précédente sur une navigation SPA.
    pageTitle: tab.title?.trim() || state.pageInfo?.pageTitle || tabUrl,
    clicked,
  });
  if (!source) return { ok: false, error: 'Aucune vidéo téléchargeable détectée sur cette page.' };

  try {
    const client = createApiClient(toApiConfig(settings));
    // Avertissement sans blocage : le second clic sur le bouton passe `isForced` et refait le job.
    if (!isForced) {
      const duplicate = await findDuplicate(client, source.url, folder.path, source.filename);
      if (duplicate) return { ok: false, error: duplicate, duplicate: true };
    }
    const cookies = settings.sendCookies ? await readCookiesForUrl(tabUrl) : undefined;
    const response = await client.createJob({
      url: source.url,
      format_id: source.formatId ?? undefined,
      folder: folder.path,
      filename: source.filename,
      preset_id: settings.defaultPresetId ?? undefined,
      cookies,
      referer: tabUrl,
      title: source.title,
    });
    return { ok: true, jobId: response.job_id };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Erreur inconnue.' };
  }
}

// ---------------------------------------------------------------------------
// Cache de probe (état d'onglet, vidé à la navigation par `clearTabState`)
// ---------------------------------------------------------------------------

/** Probe utilisable pour cet onglet : cache valide, sinon appel serveur (jamais deux en //). */
async function resolveProbe(
  tabId: number,
  tabUrl: string,
  state: TabState,
  clicked: ClickedVideo | null,
  settings: ExtensionSettings,
): Promise<ProbeResponse | null> {
  if (isCacheFresh(state.quickProbe, tabUrl)) return state.quickProbe?.probe ?? null;
  // Page à plusieurs vidéos : le probe décrit la principale, pas celle qui a été cliquée — il ne
  // servira à rien. Des flux sniffés suffisent aussi. Sur une vidéo unique en revanche le probe
  // reste le meilleur chemin (qualités séparées, piste audio à réassembler).
  if (clicked?.mediaUrl && !clicked.isOnlyVideo) return null;
  if (state.candidates.length > 0) return null;
  // Page de liste : rien à sonder (le serveur répondrait « ouvrez une vidéo »).
  if (isListingUrl(tabUrl)) return null;
  return (await getOrRefreshProbe(tabId, tabUrl, state, settings)).probe;
}

async function getOrRefreshProbe(
  tabId: number,
  tabUrl: string,
  state: TabState,
  settings: ExtensionSettings,
): Promise<QuickProbeCache> {
  if (isCacheFresh(state.quickProbe, tabUrl)) return state.quickProbe as QuickProbeCache;

  return probeFlight.run(probeFlightKey(tabId, tabUrl), () => probeAndCache(tabId, tabUrl, settings));
}

function isCacheFresh(cache: QuickProbeCache | null | undefined, tabUrl: string): boolean {
  return Boolean(cache && cache.url === tabUrl);
}

async function probeAndCache(tabId: number, tabUrl: string, settings: ExtensionSettings): Promise<QuickProbeCache> {
  // Génération capturée avant l'appel serveur : si l'onglet est purgé entre-temps (navigation,
  // fermeture), l'écriture du résultat est abandonnée au lieu de ressusciter l'état.
  const generation = getTabGeneration(tabId);
  const outcome = await probeTab(tabUrl, settings);
  const cache: QuickProbeCache = { url: tabUrl, probe: outcome.probe, checkedAt: Date.now() };
  // Un timeout ou un réseau coupé n'est pas un verdict : ne jamais mémoriser « indisponible ».
  if (outcome.isDefinitive) await updateTabState(tabId, (state) => ({ ...state, quickProbe: cache }), generation);
  return cache;
}

interface ProbeOutcome {
  probe: ProbeResponse | null;
  /** `false` si l'échec est transitoire (timeout, abort, serveur injoignable) : à ne pas mettre en cache. */
  isDefinitive: boolean;
}

async function probeTab(tabUrl: string, settings: ExtensionSettings): Promise<ProbeOutcome> {
  try {
    const client = createApiClient(toApiConfig(settings));
    const probe = settings.sendCookies
      ? await client.probeWithContext(tabUrl, { cookies: await readCookiesForUrl(tabUrl), referer: tabUrl })
      : await client.probe(tabUrl);
    return { probe: probe.formats.length > 0 ? probe : null, isDefinitive: true };
  } catch (error) {
    // Page sans extracteur, 401… : verdict définitif, pas de bruit console. Réseau/timeout : à retenter.
    return { probe: null, isDefinitive: !(error instanceof NetworkError) };
  }
}

function isProbeableUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

/** Message d'avertissement si la vidéo a déjà été téléchargée, `null` sinon. */
async function findDuplicate(
  client: ReturnType<typeof createApiClient>,
  url: string,
  folder: string,
  filename: string,
): Promise<string | null> {
  try {
    const existing = await client.lookupExistingJob({ url, folder, filename });
    if (!existing.found) return null;
    const name = existing.job?.filename ?? filename;
    return `Déjà téléchargé (${name}). Cliquez à nouveau pour retélécharger.`;
  } catch {
    // Serveur d'une version antérieure (404) ou injoignable : ne pas empêcher le téléchargement.
    return null;
  }
}
