/**
 * Construit la liste fusionnée de sources affichées dans la popup :
 * - le résultat `/api/probe` sur l'URL de l'onglet (sources yt-dlp, formats précis) ;
 * - les flux sniffés par le background pour cet onglet, seulement si le probe n'a pas trouvé
 *   d'extracteur exploitable (pas de doublon entre les deux origines dans le cas courant).
 */

import { useCallback, useEffect, useState } from 'react';
import { createApiClient, NetworkError, ServerError, UnauthorizedError, toApiConfig } from '@/src/lib/api';
import type { GetTabStateRequest, GetTabStateResponse } from '@/src/lib/messaging';
import type { ExtensionSettings, PickedElementInfo, ProbeResponse } from '@/src/lib/types';
import { readCookiesForUrl } from '../readCookies';
import type { ActiveTabInfo } from './useActiveTab';
import type { ProbeSource, Source } from '../types';

export type SourcesError =
  | { kind: 'unauthorized' }
  | { kind: 'network' }
  | { kind: 'server'; message: string };

export interface UseSourcesResult {
  sources: Source[];
  loading: boolean;
  error: SourcesError | null;
  pickedElement: PickedElementInfo | null;
  refresh: () => void;
}

export function useSources(settings: ExtensionSettings | null, tab: ActiveTabInfo | null): UseSourcesResult {
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<SourcesError | null>(null);
  const [pickedElement, setPickedElement] = useState<PickedElementInfo | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    if (!settings || !tab) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    void loadSources(settings, tab).then((result) => {
      if (cancelled) return;
      setSources(result.sources);
      setPickedElement(result.pickedElement);
      setError(result.sources.length === 0 ? result.error : null);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, tab, refreshToken]);

  const refresh = useCallback(() => setRefreshToken((t) => t + 1), []);

  return { sources, loading, error, pickedElement, refresh };
}

interface LoadResult {
  sources: Source[];
  pickedElement: PickedElementInfo | null;
  error: SourcesError | null;
}

async function loadSources(settings: ExtensionSettings, tab: ActiveTabInfo): Promise<LoadResult> {
  const [tabState, probeOutcome] = await Promise.all([requestTabState(tab.id), probeActiveTab(settings, tab.url)]);

  const sources: Source[] = [];
  let error: SourcesError | null = null;
  let probeCoversTab = false;

  if ('error' in probeOutcome) {
    error = probeOutcome.error;
  } else if (probeOutcome.formats.length > 0) {
    sources.push(toProbeSource(probeOutcome, tab.url));
    probeCoversTab = true;
  }

  // Flux réseau "non couverts" par le probe : on ne les ajoute que si aucun extracteur yt-dlp
  // n'a été trouvé (sinon, ce sont généralement des segments/représentations du même flux).
  if (!probeCoversTab) {
    const pageTitle = tabState.pageInfo?.pageTitle || tab.title;
    for (const candidate of tabState.candidates) {
      sources.push({ kind: 'sniffed', mediaUrl: candidate.url, mediaKind: candidate.kind, title: pageTitle });
    }
  }

  return { sources, pickedElement: tabState.pickedElement, error };
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

async function requestTabState(tabId: number): Promise<GetTabStateResponse> {
  const request: GetTabStateRequest = { type: 'GET_TAB_STATE', tabId };
  return (await browser.runtime.sendMessage(request)) as GetTabStateResponse;
}

async function probeActiveTab(
  settings: ExtensionSettings,
  url: string,
): Promise<ProbeResponse | { error: SourcesError }> {
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return { error: { kind: 'server', message: 'Page non téléchargeable (URL interne du navigateur).' } };
  }
  try {
    const client = createApiClient(toApiConfig(settings));
    if (settings.sendCookies) {
      const cookies = await readCookiesForUrl(url);
      return await client.probeWithContext(url, { cookies, referer: url });
    }
    return await client.probe(url);
  } catch (err) {
    return { error: classifyError(err) };
  }
}

function classifyError(err: unknown): SourcesError {
  if (err instanceof UnauthorizedError) return { kind: 'unauthorized' };
  if (err instanceof ServerError) return { kind: 'server', message: err.message };
  if (err instanceof NetworkError) return { kind: 'network' };
  return { kind: 'network' };
}
