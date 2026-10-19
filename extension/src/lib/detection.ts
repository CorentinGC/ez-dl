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

/**
 * Écrase les playlists « variantes » sous leur master : une playlist HLS/DASH dont le
 * répertoire est un descendant strict du répertoire d'une autre playlist du même onglet
 * est une déclinaison de qualité (ex : `…/pl/avc1/720x1280/x.m3u8` sous `…/pl/master.m3u8`).
 * Le master suffit : yt-dlp y retrouve toutes les qualités.
 */
export function collapseVariantPlaylists(candidates: MediaCandidate[]): MediaCandidate[] {
  const playlistDirs = candidates
    .filter((c) => c.kind === 'hls' || c.kind === 'dash')
    .map((c) => directoryOf(c.url));
  return candidates.filter((c) => {
    if (c.kind !== 'hls' && c.kind !== 'dash') return true;
    const dir = directoryOf(c.url);
    return !playlistDirs.some((other) => other !== dir && dir.startsWith(other));
  });
}

/** Une déclinaison de qualité d'un même flux progressif (mp4/webm). */
export interface QualityVariant {
  url: string;
  /** Libellé lisible, tiré du segment de qualité de l'URL (ex : `720x1280`, `1080p`). */
  label: string;
}

/** Candidat éventuellement porteur de ses déclinaisons de qualité regroupées. */
export type GroupedCandidate = MediaCandidate & { qualityVariants?: QualityVariant[] };

const RESOLUTION_SEGMENT = /^(\d{2,4})x(\d{2,4})$/;
const QUALITY_SEGMENT = /^(\d{3,4})p$/;

/** Hauteur en pixels déduite d'un segment de qualité, ou `null` si le segment n'en est pas un. */
function qualityHeightOf(segment: string): number | null {
  const resolution = RESOLUTION_SEGMENT.exec(segment);
  if (resolution) return Math.min(Number(resolution[1]), Number(resolution[2]));
  const quality = QUALITY_SEGMENT.exec(segment);
  return quality ? Number(quality[1]) : null;
}

/** Clé de groupe d'un flux progressif : chemin avec segments de qualité et nom de fichier
 * neutralisés. `null` si l'URL ne porte aucun segment de qualité (rien à regrouper). */
function variantGroupKey(url: string): { key: string; label: string; height: number } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const segments = parsed.pathname.split('/');
  const fileName = segments.pop() ?? '';
  const extension = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')) : '';
  let label: string | null = null;
  let height = 0;
  const neutralized = segments.map((segment) => {
    const segmentHeight = qualityHeightOf(segment);
    if (segmentHeight === null) return segment;
    label = segment;
    height = segmentHeight;
    return '*';
  });
  if (label === null) return null;
  return { key: `${parsed.origin}${neutralized.join('/')}/*${extension}`, label, height };
}

/**
 * Regroupe les déclinaisons de résolution/bitrate d'un même flux progressif (mp4/webm) en
 * un seul candidat (la meilleure qualité), porteur de la liste complète `qualityVariants`
 * pour laisser le choix dans l'UI. Les candidats sans segment de qualité restent tels quels.
 */
export function groupQualityVariants(candidates: MediaCandidate[]): GroupedCandidate[] {
  const groups = new Map<string, Array<{ candidate: MediaCandidate; label: string; height: number }>>();
  const passthrough: GroupedCandidate[] = [];

  for (const candidate of candidates) {
    const isProgressive = candidate.kind === 'mp4' || candidate.kind === 'webm';
    const group = isProgressive ? variantGroupKey(candidate.url) : null;
    if (!group) {
      passthrough.push(candidate);
      continue;
    }
    const entries = groups.get(group.key) ?? [];
    entries.push({ candidate, label: group.label, height: group.height });
    groups.set(group.key, entries);
  }

  const grouped: GroupedCandidate[] = [];
  for (const entries of groups.values()) {
    const sorted = [...entries].sort((a, b) => b.height - a.height);
    const best = sorted[0];
    if (!best) continue;
    if (sorted.length === 1) {
      grouped.push(best.candidate);
      continue;
    }
    grouped.push({
      ...best.candidate,
      qualityVariants: sorted.map((e) => ({ url: e.candidate.url, label: e.label })),
    });
  }

  return [...passthrough, ...grouped];
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
 *
 * `?` est volontairement exclu du déclencheur "regex brute" : dans un `url_pattern` (généré
 * notamment par `generalizeUrlPattern`), `?` n'est quasiment jamais un quantificateur regex
 * voulu, mais le séparateur littéral de la query string d'une URL — il est donc toujours
 * échappé dans la branche glob plutôt que de faire basculer tout le pattern en regex brute.
 */
export function patternToRegExp(pattern: string): RegExp {
  const looksLikeRegex = /[\\^$+(){}|[\]]/.test(pattern);
  if (looksLikeRegex) {
    try {
      return new RegExp(pattern);
    } catch {
      // Regex invalide fournie par l'utilisateur : on retombe sur l'interprétation glob.
    }
  }
  const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

// ---------------------------------------------------------------------------
// Généralisation de pattern (mode apprentissage)
// ---------------------------------------------------------------------------

/**
 * Segments d'identifiant variable à généraliser en `*`, du plus spécifique au plus générique
 * (l'alternance regex essaie chaque variante à une position donnée dans cet ordre) :
 * UUID, run hexadécimal (≥ 8 caractères), token alphanumérique/`-`/`_` (≥ 16 caractères, couvre
 * les tokens base64url et les hex longs), run purement numérique (≥ 2 chiffres).
 */
const VARIABLE_RUN_RE =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{8,}|[A-Za-z0-9_-]{16,}|\d{2,}/g;

/** Extension de fichier "courte" reconnue en fin de segment (`.mp4`, `.m3u8`, `.ts`…). */
const EXTENSION_RE = /^(.*)(\.[A-Za-z0-9]{1,8})$/;

/** Sépare un segment de chemin en `{ base, extension }` ; extension vide si non reconnue. */
function splitExtension(segment: string): { base: string; extension: string } {
  const match = segment.match(EXTENSION_RE);
  if (!match) return { base: segment, extension: '' };
  return { base: match[1] ?? '', extension: match[2] ?? '' };
}

/**
 * Généralise un segment de chemin : remplace les identifiants variables (numériques, hex,
 * UUID, tokens aléatoires) par `*`, en conservant le préfixe/suffixe littéral stable et
 * l'extension de fichier (ex. `video-12345.mp4` → `video-*.mp4`). Un segment purement
 * littéral (mot, nom fixe) reste inchangé ; les segments vides (`//`, début de chemin) aussi.
 */
function generalizeSegment(segment: string): string {
  if (segment === '') return segment;
  const { base, extension } = splitExtension(segment);
  const generalizedBase = base.replace(VARIABLE_RUN_RE, '*').replace(/\*{2,}/g, '*');
  return `${generalizedBase}${extension}`;
}

/**
 * Remplace toutes les valeurs de la query string par `*`, en conservant les clés (ordre et
 * répétitions incluses). Une query string vide reste vide.
 */
function generalizeQuery(search: string): string {
  if (!search) return '';
  const params = new URLSearchParams(search);
  const generalized = new URLSearchParams();
  for (const [key] of params) {
    generalized.append(key, '*');
  }
  return generalized.toString();
}

/**
 * Généralise l'URL d'un flux sniffé en `url_pattern` réutilisable pour une `SiteRule` : conserve
 * le schéma, l'hôte et la structure du chemin, mais remplace par `*` les identifiants variables
 * (id numériques, hash hex, UUID, tokens) dans le chemin ainsi que toutes les valeurs de la query
 * string. Le fragment (`#...`) est supprimé — il n'est jamais envoyé au serveur par le navigateur
 * et n'a donc pas de sens dans un pattern de matching réseau.
 *
 * Le pattern produit ne contient que des segments littéraux (échappés par `patternToRegExp`) et
 * des jokers `*` : il matche donc toujours l'URL d'origine (hors fragment) via `patternToRegExp`.
 * Une URL invalide est retournée telle quelle, sans tenter de généralisation.
 */
export function generalizeUrlPattern(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const pathname = parsed.pathname.split('/').map(generalizeSegment).join('/');
  const query = generalizeQuery(parsed.search);
  return `${parsed.origin}${pathname}${query ? `?${query}` : ''}`;
}

/** Vrai si `hostname` correspond au `domain` d'une règle (égalité ou sous-domaine). */
function hostnameMatchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/** Règle de site dont le pattern est déjà compilé : à construire une fois, pas à chaque requête. */
export interface CompiledSiteRule {
  domain: string;
  pattern: RegExp;
}

/** Compile les patterns des règles ; une règle dont le pattern ne compile pas est ignorée. */
export function compileSiteRules(rules: SiteRule[]): CompiledSiteRule[] {
  const compiled: CompiledSiteRule[] = [];
  for (const rule of rules) {
    try {
      compiled.push({ domain: rule.domain, pattern: patternToRegExp(rule.url_pattern) });
    } catch {
      // Pattern invalide : la règle est ignorée plutôt que de casser tout le sniffing.
    }
  }
  return compiled;
}

/**
 * Applique les règles de site apprises à des requêtes réseau brutes pour reconnaître des
 * flux qui ne matchent pas les patterns génériques (extension/content-type). Une requête
 * ne peut produire qu'un seul candidat "learned" (la première règle qui matche gagne).
 */
export function applySiteRules(requests: RawRequest[], rules: SiteRule[]): MediaCandidate[] {
  return applyCompiledSiteRules(requests, compileSiteRules(rules));
}

export function applyCompiledSiteRules(requests: RawRequest[], rules: CompiledSiteRule[]): MediaCandidate[] {
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
      (rule) => hostnameMatchesDomain(hostname, rule.domain) && rule.pattern.test(request.url),
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
