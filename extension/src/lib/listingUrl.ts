/**
 * Détection des « pages de liste » (accueil, résultats de recherche, chaîne, playlist, flux) :
 * elles n'ont pas de vidéo propre, un probe serveur n'aurait qu'à énumérer des entrées pour
 * finir en échec. La popup n'en lance donc aucun et demande d'ouvrir une vidéo.
 *
 * Seul YouTube est reconnu : ses URL de liste sont stables et sans ambiguïté. Une URL
 * `watch?v=X&list=Y` reste une page de vidéo (le serveur ne prend que la vidéo).
 */

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);

/** Préfixes de chemin qui désignent une liste (le `/@handle` est traité à part). */
const LISTING_PATH_PREFIXES = ['/results', '/channel/', '/c/', '/user/', '/playlist', '/feed/'];

export function isListingUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!YOUTUBE_HOSTS.has(parsed.hostname)) return false;

  const path = parsed.pathname;
  if (path === '/' || path === '') return true;
  if (path.startsWith('/@')) return true;
  return LISTING_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}
