/**
 * Génération et sanitisation du nom de fichier par défaut proposé dans la popup.
 * Fonctions pures, testées unitairement (voir filename.test.ts).
 */

const MAX_FILENAME_LENGTH = 150;
const FALLBACK_NAME = 'video';

/** Caractères interdits/dangereux dans un nom de fichier : séparateurs, caractères de contrôle. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\\/:*?"<>|\x00-\x1f]/g;

/**
 * Nettoie une chaîne pour en faire un nom de fichier sûr :
 * - neutralise les séquences de traversée de chemin (`..`) ;
 * - retire séparateurs (`/`, `\`) et caractères interdits/de contrôle ;
 * - réduit les espaces multiples, coupe espaces/points en bordure ;
 * - tronque à une longueur raisonnable ;
 * - retombe sur `"video"` si le résultat est vide.
 */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/\.\.+/g, '.')
    .replace(FORBIDDEN_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  const truncated = cleaned.slice(0, MAX_FILENAME_LENGTH).trim();
  return truncated || FALLBACK_NAME;
}

/** Ajoute l'extension demandée si le nom ne se termine pas déjà par elle (insensible à la casse). */
export function ensureExtension(filename: string, ext?: string | null): string {
  const normalizedExt = ext?.replace(/^\.+/, '').trim().toLowerCase();
  if (!normalizedExt) return filename;
  const suffix = `.${normalizedExt}`;
  return filename.toLowerCase().endsWith(suffix) ? filename : `${filename}${suffix}`;
}

export interface DefaultFilenameOptions {
  /** Titre de la vidéo (issu de /api/probe ou d'un élément `<video>`), prioritaire. */
  videoTitle?: string | null;
  /** Titre de la page, utilisé si aucun titre vidéo n'est disponible. */
  pageTitle?: string | null;
  /** Extension à garantir en suffixe (avec ou sans le point), ex. `"mp4"`. */
  ext?: string | null;
}

/** Construit le nom de fichier par défaut préfilli dans la popup : titre vidéo > titre page > fallback. */
export function buildDefaultFilename({ videoTitle, pageTitle, ext }: DefaultFilenameOptions): string {
  const source = videoTitle?.trim() || pageTitle?.trim() || FALLBACK_NAME;
  return ensureExtension(sanitizeFilename(source), ext);
}
