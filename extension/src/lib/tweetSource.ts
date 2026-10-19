/**
 * Sélection de la vidéo à télécharger quand le clic (ou la popup) porte un contexte de tweet.
 *
 * Module **pur**. Règle d'or : avec un contexte tweet, on ne retombe **jamais** sur « le plus
 * ancien flux de l'onglet » (sur une timeline, c'est presque toujours une autre vidéo) — soit le
 * flux sniffé du bon média, soit le permalink du tweet, soit une erreur explicite.
 */

import {
  compareCandidates,
  defaultFilenameForMedia,
  pickBestCandidate,
  sortFormatsBestFirst,
  type ClickedVideo,
  type QuickJobSource,
} from './quickSource';
import { buildDefaultFilename } from './filename';
import { isValidMediaId, mediaIdFromMediaUrl, type TweetVideoInfo } from './twitterMedia';
import type { MediaCandidate, ProbeResponse } from './types';

export const TWEET_VIDEO_NOT_FOUND = 'Vidéo introuvable : ouvrez le tweet puis réessayez.';

/** Ce qu'il faut faire pour télécharger la vidéo d'un tweet. */
export type TweetPlan =
  | { kind: 'sniffed'; source: QuickJobSource }
  | { kind: 'probe'; pageUrl: string; playlistItems: number | undefined }
  | { kind: 'missing' };

export function hasTweetContext(clicked: ClickedVideo | null | undefined): clicked is ClickedVideo {
  return Boolean(clicked?.mediaId || clicked?.pageUrl);
}

/**
 * Choisit la source d'une vidéo de tweet : (a) meilleur flux sniffé du même média, (b) sinon
 * probe du permalink avec le rang de la vidéo, (c) sinon `missing`.
 */
export function planTweetSource(clicked: ClickedVideo, candidates: MediaCandidate[], pageTitle: string): TweetPlan {
  const matching = clicked.mediaId ? candidates.filter((c) => mediaIdFromMediaUrl(c.url) === clicked.mediaId) : [];
  const best = pickBestCandidate(matching);
  if (best) {
    const title = clicked.title ?? pageTitle;
    return {
      kind: 'sniffed',
      source: { url: best.url, formatId: null, filename: defaultFilenameForMedia(best.kind, title, pageTitle), title },
    };
  }
  if (clicked.pageUrl) return { kind: 'probe', pageUrl: clicked.pageUrl, playlistItems: clicked.playlistIndex };
  return { kind: 'missing' };
}

/** Source issue du probe du permalink ; le titre du tweet prime sur celui de yt-dlp. */
export function sourceFromTweetProbe(
  probe: ProbeResponse,
  clicked: ClickedVideo,
  permalink: string,
  pageTitle: string,
): QuickJobSource | null {
  if (probe.formats.length === 0) return null;
  const formatId = probe.best_format_id ?? sortFormatsBestFirst(probe.formats)[0]?.format_id ?? null;
  const title = clicked.title ?? probe.title ?? pageTitle;
  const ext = probe.formats.find((f) => f.format_id === formatId)?.ext ?? null;
  return {
    url: permalink,
    formatId,
    filename: buildDefaultFilename({ videoTitle: title, pageTitle, ext }),
    title,
    playlistItems: clicked.playlistIndex,
  };
}

export interface LabelledCandidate<T extends MediaCandidate> {
  candidate: T;
  /** Titre du tweet si le média est présent dans le DOM, sinon `null`. */
  title: string | null;
  isLabelled: boolean;
}

/**
 * Libelle les flux sniffés dont le média est dans le DOM (un seul flux par média, le meilleur) et
 * les ordonne comme les vidéos de la page ; les autres suivent dans leur ordre d'origine.
 */
export function labelTweetCandidates<T extends MediaCandidate>(
  candidates: T[],
  videos: TweetVideoInfo[],
): LabelledCandidate<T>[] {
  const domRank = new Map(videos.map((video, index) => [video.mediaId, index]));
  const bestByMedia = new Map<string, T>();
  const labelled: { candidate: T; rank: number }[] = [];
  const others: LabelledCandidate<T>[] = [];

  for (const candidate of candidates) {
    const mediaId = mediaIdFromMediaUrl(candidate.url);
    const rank = mediaId ? domRank.get(mediaId) : undefined;
    if (!mediaId || rank === undefined) {
      others.push({ candidate, title: null, isLabelled: false });
      continue;
    }
    const current = bestByMedia.get(mediaId);
    if (current && compareCandidates(current, candidate) <= 0) continue;
    bestByMedia.set(mediaId, candidate);
  }
  for (const [mediaId, candidate] of bestByMedia) labelled.push({ candidate, rank: domRank.get(mediaId) ?? 0 });

  labelled.sort((a, b) => a.rank - b.rank);
  const titles = new Map(videos.map((video) => [video.mediaId, video.title]));
  return [
    ...labelled.map(({ candidate }) => ({
      candidate,
      title: titles.get(mediaIdFromMediaUrl(candidate.url) ?? '') ?? null,
      isLabelled: true,
    })),
    ...others,
  ];
}

/** Valide la réponse du content script (données de page non fiables) avant usage dans la popup. */
export function sanitizeTweetVideos(raw: unknown): TweetVideoInfo[] {
  const list = (raw as { videos?: unknown } | null | undefined)?.videos;
  if (!Array.isArray(list)) return [];
  const videos: TweetVideoInfo[] = [];
  for (const item of list) {
    const { mediaId, title } = (item ?? {}) as Record<string, unknown>;
    if (!isValidMediaId(mediaId)) continue;
    const cleanTitle = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    videos.push({ mediaId, title: cleanTitle || null });
  }
  return videos;
}
