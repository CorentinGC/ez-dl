/**
 * Utilitaires **purs** pour relier une vidéo affichée sur X/Twitter à un tweet : identifiant de
 * média (poster ou URL sniffée), permalink normalisé, titre lisible.
 *
 * Sur X, `<video>.src` est un `blob:` (lecteur MSE) : la seule passerelle entre l'élément du DOM
 * et les flux sniffés est l'identifiant de média, présent à la fois dans l'URL du poster
 * (`pbs.twimg.com/…_thumb/<id>/…`) et dans celle des flux (`video.twimg.com/…/<id>/…`).
 */

const TWITTER_HOSTS = new Set(['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);

const MEDIA_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const STATUS_PATH_PATTERN = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})(?:\/|$)/;

/** Longueur maximale d'un titre de tweet (ellipse comprise). */
const MAX_TITLE_LENGTH = 120;

/** Contexte « tweet » d'une vidéo du DOM, rapporté par le content script. */
export interface TweetVideoContext {
  /** Identifiant de média tiré du poster ; absent si le poster n'est pas reconnu. */
  mediaId?: string;
  /** Permalink du tweet ; absent pour une vidéo de tweet cité (pas de lien propre). */
  pageUrl?: string;
  /** Rang (1-based) de la vidéo parmi celles du tweet. */
  playlistIndex?: number;
  /** Titre lisible `@handle - texte`, `null` si rien n'a été trouvé. */
  title: string | null;
}

/** Vidéo présente dans le DOM dont le média est identifié (utilisé pour libeller la popup). */
export type TweetVideoInfo = TweetVideoContext & { mediaId: string };

export function isTwitterHostname(hostname: string): boolean {
  return TWITTER_HOSTS.has(hostname.toLowerCase());
}

/** Vrai si l'URL (`http(s)`) pointe vers X/Twitter. */
export function isTwitterUrl(url: string): boolean {
  const parsed = parseUrl(url);
  return parsed !== null && isTwitterHostname(parsed.hostname);
}

export function isValidMediaId(value: unknown): value is string {
  return typeof value === 'string' && MEDIA_ID_PATTERN.test(value);
}

/** Identifiant de média depuis l'URL du poster (`amplify_video_thumb`, `ext_tw_video_thumb`, `tweet_video_thumb`). */
export function mediaIdFromPoster(url: string | null | undefined): string | null {
  const parsed = url ? parseUrl(url) : null;
  if (!parsed || !parsed.hostname.endsWith('twimg.com')) return null;
  const numeric = /^\/(?:amplify_video_thumb|ext_tw_video_thumb)\/(\d+)\//.exec(parsed.pathname);
  if (numeric?.[1]) return numeric[1];
  const gif = /^\/tweet_video_thumb\/([A-Za-z0-9_-]+)\.[A-Za-z0-9]+$/.exec(parsed.pathname);
  return gif?.[1] ?? null;
}

/** Identifiant de média depuis l'URL d'un flux sniffé (`amplify_video`, `ext_tw_video`, `tweet_video`). */
export function mediaIdFromMediaUrl(url: string | null | undefined): string | null {
  const parsed = url ? parseUrl(url) : null;
  if (!parsed || !parsed.hostname.endsWith('twimg.com')) return null;
  const numeric = /^\/(?:amplify_video|ext_tw_video)\/(\d+)\//.exec(parsed.pathname);
  if (numeric?.[1]) return numeric[1];
  const gif = /^\/tweet_video\/([A-Za-z0-9_-]+)\.mp4$/.exec(parsed.pathname);
  return gif?.[1] ?? null;
}

/**
 * Permalink canonique `https://x.com/<user>/status/<id>` d'un lien de tweet (relatif ou absolu).
 * Les suffixes `/video/N`, `/photo/N`, `/analytics`, la query et le fragment sont retirés.
 */
export function normalizeStatusUrl(href: string): string | null {
  const parsed = parseUrl(href, 'https://x.com');
  if (!parsed || !isTwitterHostname(parsed.hostname)) return null;
  const match = STATUS_PATH_PATTERN.exec(parsed.pathname);
  return match ? `https://x.com/${match[1]}/status/${match[2]}` : null;
}

/** Sépare le texte de `[data-testid="User-Name"]` (`Nom\n@handle\n·\ndate`) en nom + handle. */
export function parseUserName(text: string | null | undefined): { name: string | null; handle: string | null } {
  const lines = (text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const handle = lines.find((line) => /^@[A-Za-z0-9_]{1,15}$/.test(line)) ?? null;
  const first = lines[0];
  return { name: first && first !== handle ? first : null, handle };
}

/** Titre `@handle - texte` (nom à défaut de handle), espaces normalisés, tronqué à ~120 caractères. */
export function buildTweetTitle(
  name: string | null | undefined,
  handle: string | null | undefined,
  text: string | null | undefined,
): string | null {
  const cleanHandle = handle?.trim();
  const author = cleanHandle ? (cleanHandle.startsWith('@') ? cleanHandle : `@${cleanHandle}`) : normalizeSpaces(name);
  const body = normalizeSpaces(text);
  const full = author && body ? `${author} - ${body}` : author || body;
  if (!full) return null;
  return full.length > MAX_TITLE_LENGTH ? `${full.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…` : full;
}

function normalizeSpaces(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function parseUrl(value: string, base?: string): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}
