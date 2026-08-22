/**
 * Géométrie du bouton en overlay : fonctions pures, sans DOM, pour rester testables dans
 * l'environnement `node` de Vitest. Le content script se contente de leur passer des rectangles.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Size {
  left: number;
  top: number;
}

export interface Point {
  left: number;
  top: number;
}

/** Dimensions minimales d'une vidéo pour mériter un bouton : filtre pubs, GIF autoplay, pixels. */
export const MIN_VIDEO_WIDTH = 200;
export const MIN_VIDEO_HEIGHT = 150;

/** Taille du bouton (carré) et marge par rapport au bord de la vidéo, en pixels CSS. */
export const BADGE_SIZE = 36;
export const BADGE_MARGIN = 12;

export function isEligibleVideoSize({ width, height }: Size): boolean {
  return width >= MIN_VIDEO_WIDTH && height >= MIN_VIDEO_HEIGHT;
}

/** Vrai si le rectangle a une surface visible dans le viewport (élément masqué ou hors écran). */
export function isRectVisible(rect: Rect, viewport: Size): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false;
  const isOffScreen =
    rect.top >= viewport.height || rect.left >= viewport.width || rect.top + rect.height <= 0 || rect.left + rect.width <= 0;
  return !isOffScreen;
}

/**
 * Position du bouton : coin haut-droit de la vidéo, ramené dans le viewport quand la vidéo
 * déborde (lecteur plus large que la fenêtre, défilement horizontal).
 */
export function computeBadgePosition(rect: Rect, viewport: Size): Point {
  const left = rect.left + rect.width - BADGE_SIZE - BADGE_MARGIN;
  const top = rect.top + BADGE_MARGIN;
  return {
    left: clamp(left, BADGE_MARGIN, Math.max(BADGE_MARGIN, viewport.width - BADGE_SIZE - BADGE_MARGIN)),
    top: clamp(top, BADGE_MARGIN, Math.max(BADGE_MARGIN, viewport.height - BADGE_SIZE - BADGE_MARGIN)),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
