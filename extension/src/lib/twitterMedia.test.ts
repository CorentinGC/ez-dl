import { describe, expect, it } from 'vitest';
import {
  buildTweetTitle,
  isTwitterUrl,
  mediaIdFromMediaUrl,
  mediaIdFromPoster,
  normalizeStatusUrl,
  parseUserName,
} from './twitterMedia';

describe('mediaIdFromPoster', () => {
  it.each([
    ['https://pbs.twimg.com/amplify_video_thumb/1846000000000000001/img/abc.jpg', '1846000000000000001'],
    ['https://pbs.twimg.com/ext_tw_video_thumb/1846000000000000002/pu/img/abc.jpg', '1846000000000000002'],
    ['https://pbs.twimg.com/tweet_video_thumb/Gabc_12-x.jpg', 'Gabc_12-x'],
  ])('%s -> %s', (url, expected) => {
    expect(mediaIdFromPoster(url)).toBe(expected);
  });

  it('refuse un hôte étranger, une URL invalide ou vide', () => {
    expect(mediaIdFromPoster('https://evil.example/amplify_video_thumb/123/img/a.jpg')).toBeNull();
    expect(mediaIdFromPoster('pas une url')).toBeNull();
    expect(mediaIdFromPoster('')).toBeNull();
    expect(mediaIdFromPoster(null)).toBeNull();
  });
});

describe('mediaIdFromMediaUrl', () => {
  it.each([
    ['https://video.twimg.com/amplify_video/1846000000000000001/pl/xyz.m3u8', '1846000000000000001'],
    ['https://video.twimg.com/ext_tw_video/1846000000000000002/pu/vid/avc1/720x1280/xyz.mp4', '1846000000000000002'],
    ['https://video.twimg.com/tweet_video/Gabc_12-x.mp4', 'Gabc_12-x'],
  ])('%s -> %s', (url, expected) => {
    expect(mediaIdFromMediaUrl(url)).toBe(expected);
  });

  it('ignore les flux non X', () => {
    expect(mediaIdFromMediaUrl('https://cdn.example/amplify_video/123/pl/a.m3u8')).toBeNull();
    expect(mediaIdFromMediaUrl('https://video.twimg.com/other/123/a.mp4')).toBeNull();
  });

  it('poster et flux d’un même média donnent le même identifiant', () => {
    const id = '1846000000000000001';
    expect(mediaIdFromPoster(`https://pbs.twimg.com/amplify_video_thumb/${id}/img/a.jpg`)).toBe(
      mediaIdFromMediaUrl(`https://video.twimg.com/amplify_video/${id}/pl/b.m3u8`),
    );
  });
});

describe('normalizeStatusUrl', () => {
  const expected = 'https://x.com/some_user/status/1846000000000000001';

  it.each([
    '/some_user/status/1846000000000000001',
    '/some_user/status/1846000000000000001/video/2',
    '/some_user/status/1846000000000000001/photo/1',
    '/some_user/status/1846000000000000001/analytics',
    'https://twitter.com/some_user/status/1846000000000000001?s=20#x',
    'https://x.com/some_user/status/1846000000000000001/',
  ])('%s -> permalink canonique', (href) => {
    expect(normalizeStatusUrl(href)).toBe(expected);
  });

  it('rejette ce qui n’est pas un tweet', () => {
    expect(normalizeStatusUrl('https://x.com/home')).toBeNull();
    expect(normalizeStatusUrl('https://x.com/search?q=chat')).toBeNull();
    expect(normalizeStatusUrl('https://x.com/some_user')).toBeNull();
    expect(normalizeStatusUrl('https://evil.example/some_user/status/123')).toBeNull();
  });
});

describe('isTwitterUrl', () => {
  it('reconnaît x.com, twitter.com et mobile.*', () => {
    expect(isTwitterUrl('https://x.com/home')).toBe(true);
    expect(isTwitterUrl('https://mobile.twitter.com/a')).toBe(true);
    expect(isTwitterUrl('https://example.com/')).toBe(false);
  });
});

describe('parseUserName / buildTweetTitle', () => {
  it('extrait nom et handle du bloc User-Name', () => {
    expect(parseUserName('Jane Doe\n@jane_doe\n·\n3 h')).toEqual({ name: 'Jane Doe', handle: '@jane_doe' });
    expect(parseUserName(null)).toEqual({ name: null, handle: null });
  });

  it('formate « @handle - texte » et normalise les espaces', () => {
    expect(buildTweetTitle('Jane', '@jane_doe', '  Bonjour \n  le   monde ')).toBe('@jane_doe - Bonjour le monde');
  });

  it('retombe sur le nom sans handle, sur le handle sans texte', () => {
    expect(buildTweetTitle('Jane', null, 'Salut')).toBe('Jane - Salut');
    expect(buildTweetTitle('Jane', 'jane_doe', '')).toBe('@jane_doe');
    expect(buildTweetTitle(null, null, null)).toBeNull();
  });

  it('tronque à 120 caractères avec une ellipse', () => {
    const title = buildTweetTitle('Jane', '@jane', 'a'.repeat(500));
    expect(title).toHaveLength(120);
    expect(title?.endsWith('…')).toBe(true);
  });
});
