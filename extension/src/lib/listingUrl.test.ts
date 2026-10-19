import { describe, expect, it } from 'vitest';
import { isListingUrl } from './listingUrl';

describe('isListingUrl', () => {
  it.each([
    'https://www.youtube.com/',
    'https://www.youtube.com',
    'https://www.youtube.com/results?search_query=chats',
    'https://www.youtube.com/@someone',
    'https://www.youtube.com/@someone/videos',
    'https://www.youtube.com/channel/UC123',
    'https://www.youtube.com/c/SomeName',
    'https://www.youtube.com/user/someone',
    'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/feed/subscriptions',
    'https://m.youtube.com/',
    'https://x.com/home',
    'https://x.com/search?q=chat',
    'https://x.com/some_user',
  ])('%s est une page de liste', (url) => {
    expect(isListingUrl(url)).toBe(true);
  });

  it.each([
    'https://www.youtube.com/watch?v=abc',
    // Une vidéo dans une playlist reste une page de vidéo : le serveur ne prend que la vidéo.
    'https://www.youtube.com/watch?v=abc&list=PL123',
    'https://www.youtube.com/shorts/abc',
    'https://www.youtube.com/live/abc',
    'https://youtu.be/abc',
    'https://x.com/some_user/status/1846000000000000001',
    'https://x.com/some_user/status/1846000000000000001/video/2',
    'https://example.com/',
    'https://example.com/results',
    'chrome://extensions',
    'pas une url',
  ])('%s n\'est pas une page de liste', (url) => {
    expect(isListingUrl(url)).toBe(false);
  });
});
