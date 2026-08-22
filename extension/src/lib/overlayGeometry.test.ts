import { describe, expect, it } from 'vitest';
import {
  BADGE_MARGIN,
  BADGE_SIZE,
  computeBadgePosition,
  isEligibleVideoSize,
  isRectVisible,
} from './overlayGeometry';

const VIEWPORT = { width: 1280, height: 720 };

describe('isEligibleVideoSize', () => {
  it('accepte un lecteur de taille normale', () => {
    expect(isEligibleVideoSize({ width: 640, height: 360 })).toBe(true);
  });

  it('accepte exactement le seuil', () => {
    expect(isEligibleVideoSize({ width: 200, height: 150 })).toBe(true);
  });

  it('rejette une vignette publicitaire ou un pixel de tracking', () => {
    expect(isEligibleVideoSize({ width: 199, height: 400 })).toBe(false);
    expect(isEligibleVideoSize({ width: 400, height: 149 })).toBe(false);
    expect(isEligibleVideoSize({ width: 0, height: 0 })).toBe(false);
  });
});

describe('isRectVisible', () => {
  it('voit une vidéo dans le viewport', () => {
    expect(isRectVisible({ left: 10, top: 10, width: 640, height: 360 }, VIEWPORT)).toBe(true);
  });

  it('ignore une vidéo masquée (display:none donne un rectangle nul)', () => {
    expect(isRectVisible({ left: 0, top: 0, width: 0, height: 0 }, VIEWPORT)).toBe(false);
  });

  it('ignore une vidéo entièrement au-dessus ou en dessous du viewport', () => {
    expect(isRectVisible({ left: 0, top: -400, width: 640, height: 360 }, VIEWPORT)).toBe(false);
    expect(isRectVisible({ left: 0, top: 900, width: 640, height: 360 }, VIEWPORT)).toBe(false);
  });

  it('garde une vidéo partiellement visible en bord d’écran', () => {
    expect(isRectVisible({ left: 0, top: -100, width: 640, height: 360 }, VIEWPORT)).toBe(true);
  });
});

describe('computeBadgePosition', () => {
  it('se place en haut à droite de la vidéo', () => {
    const position = computeBadgePosition({ left: 100, top: 50, width: 640, height: 360 }, VIEWPORT);
    expect(position).toEqual({ left: 100 + 640 - BADGE_SIZE - BADGE_MARGIN, top: 50 + BADGE_MARGIN });
  });

  it('ramène le bouton dans le viewport quand le lecteur déborde à droite', () => {
    const position = computeBadgePosition({ left: 0, top: 20, width: 2000, height: 900 }, VIEWPORT);
    expect(position.left).toBe(VIEWPORT.width - BADGE_SIZE - BADGE_MARGIN);
  });

  it('ramène le bouton dans le viewport quand la vidéo commence au-dessus de l’écran', () => {
    const position = computeBadgePosition({ left: 10, top: -500, width: 640, height: 900 }, VIEWPORT);
    expect(position.top).toBe(BADGE_MARGIN);
  });
});
