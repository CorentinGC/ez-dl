/**
 * Détection des « pages de liste » (accueil, résultats de recherche, chaîne, playlist, flux) :
 * elles n'ont pas de vidéo propre, un probe serveur n'aurait qu'à énumérer des entrées pour
 * finir en échec. La popup n'en lance donc aucun et demande d'ouvrir une vidéo.
 *
 * YouTube (URL de liste stables et sans ambiguïté ; `watch?v=X&list=Y` reste une page de vidéo,
 * le serveur ne prend que la vidéo) et X/Twitter (tout ce qui n'est pas `/<user>/status/<id>`).
 */

import { isTwitterHostname, normalizeStatusUrl } from './twitterMedia';

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);

/** Préfixes de chemin qui désignent une liste (le `/@handle` est traité à part). */
const LISTING_PATH_PREFIXES = ['/results', '/channel/', '/c/', '/user/', '/playlist', '/feed/'];

/** Sur X/Twitter, seule la page d'un tweet (`/<user>/status/<id>`) porte une vidéo propre. */
function isTwitterListing(url: string): boolean {
  return normalizeStatusUrl(url) === null;
}

export function isListingUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (isTwitterHostname(parsed.hostname)) return isTwitterListing(url);
  if (!YOUTUBE_HOSTS.has(parsed.hostname)) return false;

  const path = parsed.pathname;
  if (path === '/' || path === '') return true;
  if (path.startsWith('/@')) return true;
  return LISTING_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}
