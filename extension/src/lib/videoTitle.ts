/**
 * Choix du titre le plus probable d'une vidéo à partir du texte trouvé autour d'elle dans la page.
 *
 * Module **pur** : le content script collecte des candidats dans le DOM (attributs, titres,
 * légendes, en remontant les ancêtres de l'élément `<video>`), ce module tranche. Séparation
 * indispensable pour tester l'heuristique dans l'environnement `node` de Vitest.
 */

/** Un texte trouvé autour de la vidéo, avec sa distance et la fiabilité de sa provenance. */
export interface TitleCandidate {
  text: string;
  /** Nombre d'ancêtres traversés depuis l'élément `<video>` (0 = attribut de la vidéo elle-même). */
  depth: number;
  /** Fiabilité de la provenance à distance égale : 0 = libellé explicite, puis titre, légende… */
  rank: number;
}

const MIN_TITLE_LENGTH = 3;
const MAX_TITLE_LENGTH = 200;

/** Texte trop générique pour être un titre : libellés de contrôles de lecteur, FR et EN. */
const UI_NOISE = new Set([
  'video',
  'vidéo',
  'player',
  'lecteur',
  'play',
  'pause',
  'lecture',
  'replay',
  'revoir',
  'mute',
  'unmute',
  'son',
  'sound',
  'volume',
  'fullscreen',
  'plein écran',
  'settings',
  'paramètres',
  'options',
  'menu',
  'more',
  'plus',
  'share',
  'partager',
  'download',
  'télécharger',
  'next',
  'suivant',
  'previous',
  'précédent',
  'subtitles',
  'sous-titres',
  'live',
  'direct',
  'en direct',
  'ad',
  'publicité',
  'advertisement',
]);

/** Durée ou horodatage (`0:42`, `1:02:03`, `12.5`) : jamais un titre. */
const TIMESTAMP = /^\d+([:.]\d+)*$/;

/** Réduit les espaces (retours ligne des textes DOM compris) et tronque à une longueur lisible. */
export function normalizeTitle(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH).trim();
}

export function isPlausibleTitle(text: string): boolean {
  const normalized = normalizeTitle(text);
  if (normalized.length < MIN_TITLE_LENGTH) return false;
  if (TIMESTAMP.test(normalized)) return false;
  return !UI_NOISE.has(normalized.toLowerCase());
}

/**
 * Titre retenu : le candidat plausible le plus proche de la vidéo, la provenance la plus fiable
 * départageant les ex æquo. `fallback` (titre de page) sert quand la page n'offre rien d'utile.
 */
export function chooseVideoTitle(candidates: TitleCandidate[], fallback: string): string {
  const best = [...candidates]
    .filter((candidate) => isPlausibleTitle(candidate.text))
    .sort((a, b) => a.depth - b.depth || a.rank - b.rank)[0];
  return best ? normalizeTitle(best.text) : normalizeTitle(fallback);
}
