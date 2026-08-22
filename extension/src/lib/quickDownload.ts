/**
 * Téléchargement en un clic déclenché par le bouton en overlay de la page.
 *
 * Vit côté **service worker** : lui seul peut lire les cookies et joindre le serveur avec le mot
 * de passe. Le content script n'obtient jamais qu'un booléen de disponibilité puis un résultat de
 * job — ni URL de serveur, ni mot de passe, ni cookies ne traversent la frontière de la page.
 *
 * Extrait de `background.ts` pour garder le service worker sous le seuil de 400 LOC.
 */

import { createApiClient, toApiConfig } from './api';
import { readCookiesForUrl } from './cookies';
import type { QuickDownloadResponse } from './messaging';
import { pickQuickSource, resolveDefaultFolder, sanitizeClickedVideo, type ClickedVideo } from './quickSource';
import { getSettings, getTabState, isServerConfigured, setTabState } from './storage';
import type { ExtensionSettings, ProbeResponse, QuickProbeCache, TabState } from './types';
import { getUiPrefs } from './uiPrefs';

/** Probes en vol par onglet : les iframes d'une même page interrogent toutes le background. */
const probesInFlight = new Map<number, Promise<QuickProbeCache>>();

/**
 * Une source est-elle téléchargeable sur cet onglet ? Le probe serveur n'est tenté qu'en dernier
 * recours (aucun flux sniffé), une seule fois par URL d'onglet grâce au cache d'état d'onglet.
 */
export async function resolveOverlayAvailability(
  tabId: number,
  tabUrl: string,
  hasDirectMedia: boolean,
): Promise<boolean> {
  const prefs = await getUiPrefs();
  if (!prefs.showPageOverlay) return false;

  const settings = await getSettings();
  if (!isServerConfigured(settings) || !isProbeableUrl(tabUrl)) return false;

  // Une vidéo qui expose son URL média est téléchargeable telle quelle : ni probe, ni sniffer.
  if (hasDirectMedia) return true;

  const state = await getTabState(tabId);
  if (state.candidates.length > 0) return true;

  const cache = await getOrRefreshProbe(tabId, tabUrl, state, settings);
  return cache.probe !== null;
}

/** Crée le job correspondant au clic sur le bouton : meilleure qualité et réglages par défaut. */
export async function runQuickDownload(
  tabId: number,
  tab: { url: string; title?: string },
  rawClicked: unknown,
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
    const cookies = settings.sendCookies ? await readCookiesForUrl(tabUrl) : undefined;
    const response = await createApiClient(toApiConfig(settings)).createJob({
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
  return (await getOrRefreshProbe(tabId, tabUrl, state, settings)).probe;
}

async function getOrRefreshProbe(
  tabId: number,
  tabUrl: string,
  state: TabState,
  settings: ExtensionSettings,
): Promise<QuickProbeCache> {
  if (isCacheFresh(state.quickProbe, tabUrl)) return state.quickProbe as QuickProbeCache;

  const inFlight = probesInFlight.get(tabId);
  if (inFlight) return inFlight;

  const pending = probeAndCache(tabId, tabUrl, settings).finally(() => probesInFlight.delete(tabId));
  probesInFlight.set(tabId, pending);
  return pending;
}

function isCacheFresh(cache: QuickProbeCache | null | undefined, tabUrl: string): boolean {
  return Boolean(cache && cache.url === tabUrl);
}

async function probeAndCache(tabId: number, tabUrl: string, settings: ExtensionSettings): Promise<QuickProbeCache> {
  const cache: QuickProbeCache = { url: tabUrl, probe: await probeTab(tabUrl, settings), checkedAt: Date.now() };
  // Relecture de l'état : le sniffer a pu ajouter des candidats pendant l'appel serveur.
  const fresh = await getTabState(tabId);
  await setTabState(tabId, { ...fresh, quickProbe: cache });
  return cache;
}

async function probeTab(tabUrl: string, settings: ExtensionSettings): Promise<ProbeResponse | null> {
  try {
    const client = createApiClient(toApiConfig(settings));
    const probe = settings.sendCookies
      ? await client.probeWithContext(tabUrl, { cookies: await readCookiesForUrl(tabUrl), referer: tabUrl })
      : await client.probe(tabUrl);
    return probe.formats.length > 0 ? probe : null;
  } catch {
    // Page sans extracteur, serveur injoignable, 401… : pas de bouton, et pas de bruit console.
    return null;
  }
}

function isProbeableUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}
