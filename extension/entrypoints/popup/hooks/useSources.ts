/**
 * Construit la liste fusionnée de sources affichées dans la popup :
 * - le résultat `/api/probe` sur l'URL de l'onglet (sources yt-dlp, formats précis) ;
 * - les flux sniffés par le background pour cet onglet, seulement si le probe n'a pas trouvé
 *   d'extracteur exploitable (pas de doublon entre les deux origines dans le cas courant).
 *
 * Le probe n'a lieu qu'**à l'ouverture** de la popup (ou sur « Réessayer ») : un probe déjà fait
 * par le bouton en overlay (`state.quickProbe`) est réutilisé, une page de liste n'en déclenche
 * aucun, et fermer la popup annule l'appel en cours. Les flux sniffés qui arrivent ensuite
 * rafraîchissent la liste sans nouveau probe.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createApiClient, NetworkError, ServerError, UnauthorizedError, toApiConfig } from '@/src/lib/api';
import { readCookiesForUrl } from '@/src/lib/cookies';
import { collapseVariantPlaylists, groupQualityVariants } from '@/src/lib/detection';
import { isListingUrl } from '@/src/lib/listingUrl';
import { hasMessageType, type GetTabStateRequest, type GetTabStateResponse } from '@/src/lib/messaging';
import { labelTweetCandidates } from '@/src/lib/tweetSource';
import { isTwitterUrl, normalizeStatusUrl, type TweetVideoInfo } from '@/src/lib/twitterMedia';
import { EMPTY_TAB_STATE } from '@/src/lib/storage';
import type { ExtensionSettings, PickedElementInfo, ProbeResponse } from '@/src/lib/types';
import type { ActiveTabInfo } from './useActiveTab';
import type { ProbeSource, Source } from '../types';
import { requestTweetVideos } from './tweetVideos';

export type SourcesError =
  | { kind: 'unauthorized' }
  | { kind: 'network' }
  | { kind: 'listing' }
  | { kind: 'server'; message: string };

export interface UseSourcesResult {
  sources: Source[];
  loading: boolean;
  error: SourcesError | null;
  pickedElement: PickedElementInfo | null;
  refresh: () => void;
}

/** Verdict du probe : une réponse exploitable, ou « rien » (avec la raison éventuelle). */
type ProbeOutcome = { probe: ProbeResponse | null; error: SourcesError | null };

const NO_PROBE: ProbeOutcome = { probe: null, error: null };

const NO_TAB_STATE: GetTabStateResponse = { ...EMPTY_TAB_STATE, tabId: -1 };

export function useSources(settings: ExtensionSettings | null, tab: ActiveTabInfo | null): UseSourcesResult {
  const [tabState, setTabState] = useState<GetTabStateResponse>(NO_TAB_STATE);
  const [tweetVideos, setTweetVideos] = useState<TweetVideoInfo[]>([]);
  const [outcome, setOutcome] = useState<ProbeOutcome | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshToken, setRefreshToken] = useState(0);
  const isProbingRef = useRef(false);

  // Primitives plutôt que l'objet `settings` : son identité change à chaque écriture du storage,
  // ce qui relancerait un probe (et un abonnement) à vide.
  const serverUrl = settings?.serverUrl;
  const password = settings?.password;
  const sendCookies = settings?.sendCookies ?? false;
  const tabId = tab?.id;
  const tabUrl = tab?.url;

  useEffect(() => {
    // Le probe est fait par le serveur : changer de serveur invalide les sources affichées.
    setOutcome(null);
    setTabState(NO_TAB_STATE);
    setTweetVideos([]);
    if (serverUrl === undefined || password === undefined || tabId === undefined || tabUrl === undefined) return;

    const controller = new AbortController();
    isProbingRef.current = true;
    setLoading(true);

    void (async () => {
      const state = await requestTabState(tabId);
      if (controller.signal.aborted) return;
      setTabState(state);
      const videos = await requestTweetVideos(tabId, tabUrl);
      if (controller.signal.aborted) return;
      setTweetVideos(videos);
      // Flux sniffé reconnu pour une vidéo du DOM : il suffit, inutile de solliciter le serveur.
      const result = hasLabelledCandidate(state, videos)
        ? NO_PROBE
        : await resolveProbe({ serverUrl, password, sendCookies }, tabUrl, state, controller.signal);
      if (controller.signal.aborted) return;
      setOutcome(result);
      isProbingRef.current = false;
      setLoading(false);
    })();

    return () => {
      controller.abort(); // démontage de la popup ou changement de serveur/onglet
      isProbingRef.current = false;
    };
  }, [serverUrl, password, sendCookies, tabId, tabUrl, refreshToken]);

  // Nouveaux flux sniffés pendant que la popup est ouverte : relecture de l'état, sans probe.
  useEffect(() => {
    if (tabId === undefined) return;
    let isActive = true;
    const listener = (message: unknown) => {
      if (!hasMessageType(message, 'TAB_STATE_UPDATED')) return;
      if ((message as { tabId?: number }).tabId !== tabId) return;
      void Promise.all([requestTabState(tabId), requestTweetVideos(tabId, tabUrl ?? '')]).then(([state, videos]) => {
        if (!isActive) return;
        setTabState(state);
        setTweetVideos(videos);
      });
    };
    browser.runtime.onMessage.addListener(listener);
    return () => {
      isActive = false;
      browser.runtime.onMessage.removeListener(listener);
    };
  }, [tabId, tabUrl]);

  const refresh = useCallback(() => {
    if (isProbingRef.current) return; // un probe est déjà en cours : ne pas en empiler un second
    setRefreshToken((token) => token + 1);
  }, []);

  const sources = useMemo(
    () => (tab && outcome ? buildSources(outcome, tabState, tab, tweetVideos) : []),
    [outcome, tabState, tab, tweetVideos],
  );
  const error = sources.length === 0 ? (outcome?.error ?? null) : null;

  return { sources, loading, error, pickedElement: tabState.pickedElement, refresh };
}

interface ProbeSettings {
  serverUrl: string;
  password: string;
  sendCookies: boolean;
}

/** Probe de l'onglet, ou verdict sans appel serveur (URL interne, page de liste, probe déjà en cache). */
async function resolveProbe(
  settings: ProbeSettings,
  url: string,
  tabState: GetTabStateResponse,
  signal: AbortSignal,
): Promise<ProbeOutcome> {
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return { probe: null, error: { kind: 'server', message: 'Page non téléchargeable (URL interne du navigateur).' } };
  }
  if (isListingUrl(url)) return { probe: null, error: { kind: 'listing' } };

  // Probe déjà fait pour cette URL (clic sur le bouton en overlay) : inutile de le refaire.
  const cached = tabState.quickProbe;
  if (cached && cached.url === url) return { probe: cached.probe, error: null };

  // Page d'un tweet : on sonde le permalink canonique et seule sa 1re vidéo (un tweet
  // multi-vidéos est une « playlist », refusée par le serveur sans `playlist_items`).
  const permalink = isTwitterUrl(url) ? normalizeStatusUrl(url) : null;
  const target = permalink ?? url;
  const playlistItems = permalink ? 1 : undefined;

  try {
    const client = createApiClient(toApiConfig(settings));
    const probe = settings.sendCookies
      ? await client.probeWithContext(
          target,
          { cookies: await readCookiesForUrl(target), referer: url, playlist_items: playlistItems },
          { signal },
        )
      : await client.probe(target, { signal, playlistItems });
    return { probe: probe.formats.length > 0 ? probe : null, error: null };
  } catch (err) {
    return { probe: null, error: classifyError(err) };
  }
}

/** Un flux sniffé correspond-il à une vidéo du DOM (X/Twitter) ? Alors il est libellé et suffit. */
function hasLabelledCandidate(tabState: GetTabStateResponse, videos: TweetVideoInfo[]): boolean {
  return videos.length > 0 && labelTweetCandidates(tabState.candidates, videos).some((entry) => entry.isLabelled);
}

function buildSources(
  outcome: ProbeOutcome,
  tabState: GetTabStateResponse,
  tab: ActiveTabInfo,
  tweetVideos: TweetVideoInfo[],
): Source[] {
  const sources: Source[] = [];
  // Présentation : playlists variantes écrasées sous leur master, et déclinaisons de
  // résolution d'un même flux progressif regroupées en une entrée avec choix de qualité.
  const candidates = groupQualityVariants(collapseVariantPlaylists(tabState.candidates));
  const labelled = labelTweetCandidates(candidates, tweetVideos);
  // Sur X, un flux reconnu désigne une vidéo précise de la page : le probe (1re vidéo du tweet)
  // ne ferait que doubler l'une d'elles, on ne garde que les flux libellés.
  const hasTweetLabels = labelled.some((entry) => entry.isLabelled);

  if (outcome.probe && !hasTweetLabels) sources.push(toProbeSource(outcome.probe, tab.url));

  // Flux réseau "non couverts" par le probe : on ne les ajoute que si aucun extracteur yt-dlp
  // n'a été trouvé (sinon, ce sont généralement des segments/représentations du même flux).
  if (!outcome.probe || hasTweetLabels) {
    const pageTitle = tabState.pageInfo?.pageTitle || tab.title;
    for (const { candidate, title } of labelled) {
      sources.push({
        kind: 'sniffed',
        mediaUrl: candidate.url,
        mediaKind: candidate.kind,
        title: title ?? pageTitle,
        qualityVariants: candidate.qualityVariants,
      });
    }
  }
  return sources;
}

function toProbeSource(probe: ProbeResponse, pageUrl: string): ProbeSource {
  return {
    kind: 'probe',
    pageUrl,
    title: probe.title ?? pageUrl,
    thumbnail: probe.thumbnail,
    formats: probe.formats,
    bestFormatId: probe.best_format_id,
    suggestedFilename: probe.suggested_filename,
  };
}

/** Lecture de l'état d'onglet ; un background injoignable ne doit pas bloquer la popup en chargement. */
async function requestTabState(tabId: number): Promise<GetTabStateResponse> {
  try {
    const request: GetTabStateRequest = { type: 'GET_TAB_STATE', tabId };
    const response = (await browser.runtime.sendMessage(request)) as GetTabStateResponse | undefined;
    return response && Array.isArray(response.candidates) ? response : { ...EMPTY_TAB_STATE, tabId };
  } catch {
    return { ...EMPTY_TAB_STATE, tabId };
  }
}

function classifyError(err: unknown): SourcesError {
  if (err instanceof UnauthorizedError) return { kind: 'unauthorized' };
  if (err instanceof ServerError) return { kind: 'server', message: err.message };
  if (err instanceof NetworkError) return { kind: 'network' };
  return { kind: 'network' };
}
