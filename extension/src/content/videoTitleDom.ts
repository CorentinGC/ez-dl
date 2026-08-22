/**
 * Collecte, dans le DOM autour d'un élément `<video>`, les textes susceptibles d'être son titre.
 *
 * Le tri et le filtrage vivent dans `src/lib/videoTitle.ts` (module pur, testé) : ici, uniquement
 * la lecture du DOM. Le principe est la proximité — on remonte les ancêtres et on s'arrête vite,
 * pour attraper le titre de *cette* vidéo et non celui de la page sur une liste de lecteurs.
 */

import { chooseVideoTitle, type TitleCandidate } from '@/src/lib/videoTitle';

/** Au-delà, on est remonté au conteneur de la page : le titre trouvé ne décrit plus la vidéo. */
const MAX_ANCESTOR_DEPTH = 8;

/** Sélecteurs interrogés dans chaque ancêtre, du plus fiable au moins fiable (= `rank`). */
const TEXT_SOURCES = ['h1', 'h2', 'h3', 'h4', '[role="heading"]', 'figcaption'];

/** Titre le plus probable de la vidéo, avec repli sur le titre de page. */
export function findVideoTitle(video: HTMLVideoElement): string {
  return chooseVideoTitle(collectTitleCandidates(video), document.title);
}

function collectTitleCandidates(video: HTMLVideoElement): TitleCandidate[] {
  const candidates: TitleCandidate[] = [];
  pushAttributes(candidates, video, 0);

  let element: Element | null = video.parentElement;
  for (let depth = 1; element && depth <= MAX_ANCESTOR_DEPTH; depth += 1) {
    if (element === document.body || element === document.documentElement) break;
    pushAttributes(candidates, element, depth);
    pushTexts(candidates, element, depth);
    element = element.parentElement;
  }

  // Derniers recours, volontairement très « loin » : ils ne gagnent que si rien d'autre ne sort.
  const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
  if (ogTitle) candidates.push({ text: ogTitle, depth: MAX_ANCESTOR_DEPTH + 1, rank: 0 });
  return candidates;
}

/** Libellés explicites portés par l'élément : la source la plus fiable à distance donnée. */
function pushAttributes(candidates: TitleCandidate[], element: Element, depth: number): void {
  const attributes = ['aria-label', 'title', 'data-title'];
  attributes.forEach((attribute, index) => {
    const value = element.getAttribute(attribute);
    if (value) candidates.push({ text: value, depth, rank: index });
  });
}

/** Titres, en-têtes et légendes contenus dans l'ancêtre. */
function pushTexts(candidates: TitleCandidate[], element: Element, depth: number): void {
  TEXT_SOURCES.forEach((selector, index) => {
    const text = element.querySelector(selector)?.textContent;
    if (text) candidates.push({ text, depth, rank: 3 + index });
  });
}
