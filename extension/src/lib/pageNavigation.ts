/**
 * Une nouvelle URL d'onglet est-elle une vraie navigation ? Les SPA (YouTube, X) changent l'URL
 * via `pushState` sans passer par `status: 'loading'` ; seul le fragment (`#…`) ne compte pas,
 * il ne désigne pas une autre page.
 */

function withoutFragment(url: string): string {
  const index = url.indexOf('#');
  return index === -1 ? url : url.slice(0, index);
}

/** `false` si aucune URL n'est mémorisée : on ne peut pas affirmer qu'elle a changé. */
export function hasPageChanged(storedUrl: string | null | undefined, nextUrl: string): boolean {
  if (!storedUrl) return false;
  return withoutFragment(storedUrl) !== withoutFragment(nextUrl);
}
