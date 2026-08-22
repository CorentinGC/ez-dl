/**
 * Comparaison de versions d'extension (`browser.runtime.getManifest().version` face à la version
 * publiée par le serveur). Format Chrome : 1 à 4 entiers séparés par des points, pas de
 * pré-release ni de métadonnée — inutile d'embarquer un comparateur semver complet.
 */

/**
 * Segments numériques d'une version, ou `null` si la chaîne n'est pas une version exploitable.
 * Chaque segment doit être entièrement numérique : `parseInt` seul accepterait `1.0.0-beta`
 * (il lit `0` dans `0-beta`) et ferait passer une pré-release pour une version publiée.
 */
const NUMERIC_SEGMENT = /^\d+$/;

function parseVersion(version: string): number[] | null {
  const segments = version.trim().split('.');
  if (segments.length === 0 || !segments.every((segment) => NUMERIC_SEGMENT.test(segment))) return null;
  return segments.map((segment) => Number.parseInt(segment, 10));
}

/**
 * Vrai si `candidate` est strictement plus récente que `installed`.
 *
 * Toute version illisible d'un côté ou de l'autre répond `false` : mieux vaut ne rien proposer
 * qu'annoncer une mise à jour inexistante sur une réponse serveur inattendue.
 */
export function isNewerVersion(candidate: string, installed: string): boolean {
  const left = parseVersion(candidate);
  const right = parseVersion(installed);
  if (!left || !right) return false;

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    // Les segments absents valent 0 : « 1.2 » et « 1.2.0 » désignent la même version.
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}
