/**
 * Détection et classification des flux média observés par le sniffer réseau.
 * Fonctions pures et testées unitairement (voir detection.test.ts) : aucune dépendance
 * à `chrome`/`browser`, tout l'état est passé en paramètre.
 */

import type { CandidateSource, MediaCandidate, MediaKind, PickedElementInfo, RawRequest, SiteRule } from './types';

/** Extensions de fichier associées à un flux vidéo/manifeste "de premier niveau". */
const MEDIA_EXTENSIONS = new Map<string, MediaKind>([
  ['.m3u8', 'hls'],
  ['.mpd', 'dash'],
  ['.mp4', 'mp4'],
  ['.webm', 'webm'],
]);

/** Extensions de segments : jamais listées seules, toujours rattachées à leur playlist. */
const SEGMENT_EXTENSIONS = ['.ts', '.m4s'];

/** Content-Types exacts (sans paramètres) mappés directement sur une nature de flux. */
const MEDIA_CONTENT_TYPES_EXACT = new Map<string, MediaKind>([
  ['application/vnd.apple.mpegurl', 'hls'],
  ['application/x-mpegurl', 'hls'],
  ['application/dash+xml', 'dash'],
]);

/** Content-Types de segments, détectables même sans extension explicite dans l'URL. */
const SEGMENT_CONTENT_TYPES = new Set(['video/mp2t', 'video/iso.segment']);

/** Normalise un content-type (retire les paramètres `; codecs=...`, minuscules). */
function normalizeContentType(contentType?: string | null): string | null {
  if (!contentType) return null;
  const base = contentType.split(';')[0]?.trim().toLowerCase();
  return base || null;
}

/** Chemin d'URL en minuscules, sans query/hash ; tolère les URLs relatives/invalides. */
function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return url.split(/[?#]/)[0]?.toLowerCase() ?? '';
  }
}

/**
 * Classe une URL/content-type en nature de flux média, ou `null` si ce n'en est pas un.
 * Le content-type prime (plus fiable qu'une extension d'URL) ; à défaut on retombe sur
 * l'extension du chemin.
 */
export function classifyUrl(url: string, contentType?: string | null): MediaKind | null {
  const type = normalizeContentType(contentType);
  if (type) {
    const exact = MEDIA_CONTENT_TYPES_EXACT.get(type);
    if (exact) return exact;
    if (type.startsWith('video/') && !SEGMENT_CONTENT_TYPES.has(type)) return 'other-video';
  }
  const pathname = pathnameOf(url);
  for (const [ext, kind] of MEDIA_EXTENSIONS) {
    if (pathname.endsWith(ext)) return kind;
  }
  return null;
}

/** Vrai si l'URL/content-type correspond à un flux média détectable. */
export function isMediaUrl(url: string, contentType?: string | null): boolean {
  return classifyUrl(url, contentType) !== null;
}

/** Vrai si l'URL/content-type correspond à un segment HLS/DASH (jamais listé seul). */
export function isHlsSegment(url: string, contentType?: string | null): boolean {
  const type = normalizeContentType(contentType);
  if (type && SEGMENT_CONTENT_TYPES.has(type)) return true;
  const pathname = pathnameOf(url);
  return SEGMENT_EXTENSIONS.some((ext) => pathname.endsWith(ext));
}

/** Répertoire "parent" d'une URL (origine + chemin sans le dernier segment). */
function directoryOf(url: string): string {
  try {
    const parsed = new URL(url);
    const dir = parsed.pathname.replace(/\/[^/]*$/, '/');
    return `${parsed.origin}${dir}`;
  } catch {
    return url.replace(/[^/]*$/, '');
  }
}

/**
 * Regroupe les segments sous la playlist (.m3u8/.mpd) de leur répertoire : seules les
 * playlists/variants et les flux progressifs (mp4/webm) sont conservés en sortie.
 * Un segment sans playlist connue dans le même répertoire est conservé tel quel (dernier
 * recours : mieux vaut proposer le segment que ne rien proposer).
 */
export function groupSegmentsByPlaylist(candidates: MediaCandidate[]): MediaCandidate[] {
  const playlistDirs = new Set(
    candidates.filter((c) => c.kind === 'hls' || c.kind === 'dash').map((c) => directoryOf(c.url)),
  );
  return candidates.filter((c) => {
    if (c.kind === 'hls' || c.kind === 'dash') return true;
    if (!isHlsSegment(c.url, c.contentType)) return true;
    return !playlistDirs.has(directoryOf(c.url));
  });
}

/** Clé de déduplication : origine + chemin, sans les paramètres de requête (cache-busting…). */
function dedupeKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/** Score d'information d'un candidat, pour choisir lequel garder en cas de doublon. */
function infoScore(candidate: MediaCandidate): number {
  const sourceRank: Record<CandidateSource, number> = { sniffed: 0, learned: 1, picked: 2 };
  let score = sourceRank[candidate.source];
  if (candidate.contentType) score += 1;
  if (candidate.size) score += 1;
  return score;
}

/**
 * Déduplique une liste de candidats par URL (origine + chemin). En cas de doublon, garde
 * celui qui porte le plus d'information (content-type/taille connus, source la plus fiable).
 */
export function dedupeCandidates(candidates: MediaCandidate[]): MediaCandidate[] {
  const bestByKey = new Map<string, MediaCandidate>();
  for (const candidate of candidates) {
    const key = dedupeKey(candidate.url);
    const existing = bestByKey.get(key);
    if (!existing || infoScore(candidate) > infoScore(existing)) {
      bestByKey.set(key, candidate);
    }
  }
  return Array.from(bestByKey.values());
}

/**
 * Convertit un `url_pattern` de règle apprise (glob simple ou regex) en `RegExp`.
 * Heuristique : la présence de métacaractères regex typiques (hors `*`) fait traiter le
 * pattern comme une regex brute ; sinon c'est un glob simple où seul `*` est un joker
 * (zéro ou plusieurs caractères), le reste étant échappé littéralement.
 */
export function patternToRegExp(pattern: string): RegExp {
  const looksLikeRegex = /[\\^$+?(){}|[\]]/.test(pattern);
  if (looksLikeRegex) {
    try {
      return new RegExp(pattern);
    } catch {
      // Regex invalide fournie par l'utilisateur : on retombe sur l'interprétation glob.
    }
  }
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/** Vrai si `hostname` correspond au `domain` d'une règle (égalité ou sous-domaine). */
function hostnameMatchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/**
 * Applique les règles de site apprises à des requêtes réseau brutes pour reconnaître des
 * flux qui ne matchent pas les patterns génériques (extension/content-type). Une requête
 * ne peut produire qu'un seul candidat "learned" (la première règle qui matche gagne).
 */
export function applySiteRules(requests: RawRequest[], rules: SiteRule[]): MediaCandidate[] {
  if (rules.length === 0) return [];
  const candidates: MediaCandidate[] = [];
  for (const request of requests) {
    let hostname: string;
    try {
      hostname = new URL(request.url).hostname;
    } catch {
      continue;
    }
    const matchedRule = rules.find(
      (rule) => hostnameMatchesDomain(hostname, rule.domain) && patternToRegExp(rule.url_pattern).test(request.url),
    );
    if (!matchedRule) continue;
    candidates.push({
      url: request.url,
      kind: classifyUrl(request.url, request.contentType) ?? 'other-video',
      source: 'learned',
      contentType: request.contentType ?? null,
      size: request.contentLength ?? null,
      discoveredAt: request.timeStamp ?? Date.now(),
    });
  }
  return candidates;
}

/**
 * Corrèle un élément choisi via le picker DOM avec les requêtes réseau récentes de l'onglet,
 * pour proposer une URL candidate exploitable pour une règle de site.
 * - Si l'élément porte lui-même une URL média exploitable (src/currentSrc), on la retient.
 * - Sinon, on retombe sur le candidat le plus récemment détecté par le sniffer (meilleure
 *   approximation disponible : l'utilisateur vient de cliquer sur le lecteur).
 */
export function correlatePickedElement(
  picked: PickedElementInfo,
  recentCandidates: MediaCandidate[],
): MediaCandidate | null {
  const elementUrl = picked.currentSrc || picked.src;
  if (elementUrl && isMediaUrl(elementUrl)) {
    return {
      url: elementUrl,
      kind: classifyUrl(elementUrl) ?? 'other-video',
      source: 'picked',
      contentType: null,
      size: null,
      discoveredAt: Date.now(),
    };
  }
  if (recentCandidates.length === 0) return null;
  return recentCandidates.reduce((latest, candidate) =>
    candidate.discoveredAt > latest.discoveredAt ? candidate : latest,
  );
}
