/**
 * Contexte « tweet » d'une vidéo, lu dans le DOM de X/Twitter (actif uniquement sur ces hôtes).
 *
 * `<video>.src` est un `blob:` : pour savoir **quelle** vidéo est cliquée, on relève l'identifiant
 * de média (poster), le permalink du tweet, le rang de la vidéo dans le tweet et un titre
 * `@handle - texte`. Les sélecteurs `data-testid` ont été vérifiés en live ; ils peuvent évoluer
 * côté X, d'où des replis systématiques (un champ manquant n'empêche pas les autres).
 */

import {
  buildTweetTitle,
  isTwitterHostname,
  mediaIdFromPoster,
  normalizeStatusUrl,
  parseUserName,
  type TweetVideoContext,
  type TweetVideoInfo,
} from '@/src/lib/twitterMedia';

const USER_NAME = '[data-testid="User-Name"]';
const TWEET_TEXT = '[data-testid="tweetText"]';
/** Nombre maximal de vidéos d'un tweet (rang accepté par la validation du background). */
const MAX_PLAYLIST_INDEX = 4;

/** Contexte de la vidéo, `null` hors X/Twitter ou si rien d'exploitable n'a été trouvé. */
export function readTweetContext(video: HTMLVideoElement): TweetVideoContext | null {
  if (!isTwitterHostname(location.hostname)) return null;
  const mediaId = mediaIdFromPoster(video.poster) ?? undefined;
  const article = video.closest('article');
  if (!article) return mediaId ? { mediaId, title: null } : null;

  const quoted = quotedBlockOf(video, article);
  const title = readTitle(article, quoted);
  // Tweet cité : pas de permalink propre, le lien du bloc est celui du tweet porteur.
  if (quoted) return mediaId ? { mediaId, title } : null;

  const pageUrl = readPermalink(article) ?? undefined;
  const playlistIndex = rankInArticle(video, article);
  if (!mediaId && !pageUrl) return null;
  return { mediaId, pageUrl, playlistIndex, title };
}

/** Vidéos du DOM dont le média est identifié, dans l'ordre d'apparition (sans doublon de média). */
export function collectTweetVideos(): TweetVideoInfo[] {
  const videos: TweetVideoInfo[] = [];
  const seen = new Set<string>();
  for (const video of document.querySelectorAll('video')) {
    const context = readTweetContext(video);
    if (!context?.mediaId || seen.has(context.mediaId)) continue;
    seen.add(context.mediaId);
    videos.push({ ...context, mediaId: context.mediaId });
  }
  return videos;
}

/** Bloc de tweet cité contenant l'élément, `null` s'il appartient au tweet principal. */
function quotedBlockOf(element: Element, article: Element): Element | null {
  const block = element.closest('div[role="link"]');
  if (!block || block === article || !article.contains(block)) return null;
  return block.querySelector(USER_NAME) ? block : null;
}

/** Premier élément du tweet principal (hors blocs cités), ou celui du bloc cité s'il est donné. */
function findOwn(article: Element, selector: string, quoted: Element | null): Element | null {
  if (quoted) return quoted.querySelector(selector);
  return Array.from(article.querySelectorAll(selector)).find((el) => !quotedBlockOf(el, article)) ?? null;
}

function readTitle(article: Element, quoted: Element | null): string | null {
  const userName = findOwn(article, USER_NAME, quoted);
  // `innerText` (et non `textContent`) : seul il sépare nom, handle et date par des retours à la ligne.
  const { name, handle } = parseUserName(userName instanceof HTMLElement ? userName.innerText : null);
  return buildTweetTitle(name, handle, findOwn(article, TWEET_TEXT, quoted)?.textContent);
}

function readPermalink(article: Element): string | null {
  for (const time of article.querySelectorAll('a[href*="/status/"] time')) {
    if (quotedBlockOf(time, article)) continue;
    const href = time.closest('a')?.getAttribute('href');
    const permalink = href ? normalizeStatusUrl(href) : null;
    if (permalink) return permalink;
  }
  return null;
}

/** Rang 1-based de la vidéo parmi celles du tweet principal, `undefined` au-delà de 4. */
function rankInArticle(video: HTMLVideoElement, article: Element): number | undefined {
  const own = Array.from(article.querySelectorAll('video')).filter((v) => !quotedBlockOf(v, article));
  const rank = own.indexOf(video) + 1;
  return rank >= 1 && rank <= MAX_PLAYLIST_INDEX ? rank : undefined;
}
