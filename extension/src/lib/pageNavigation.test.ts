import { describe, expect, it } from 'vitest';
import { hasPageChanged } from './pageNavigation';

describe('hasPageChanged', () => {
  it('détecte une navigation SPA (autre chemin ou autre requête)', () => {
    expect(hasPageChanged('https://www.youtube.com/watch?v=a', 'https://www.youtube.com/watch?v=b')).toBe(true);
    expect(hasPageChanged('https://x.com/home', 'https://x.com/u/status/1')).toBe(true);
  });

  it('ignore un changement de fragment seul', () => {
    expect(hasPageChanged('https://a.test/p#top', 'https://a.test/p#bottom')).toBe(false);
    expect(hasPageChanged('https://a.test/p', 'https://a.test/p#x')).toBe(false);
  });

  it('ne conclut rien sans URL mémorisée', () => {
    expect(hasPageChanged(null, 'https://a.test/')).toBe(false);
    expect(hasPageChanged(undefined, 'https://a.test/')).toBe(false);
  });
});
