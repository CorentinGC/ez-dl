import { describe, expect, it } from 'vitest';
import type { ClickedVideo } from './quickSource';
import {
  hasTweetContext,
  labelTweetCandidates,
  planTweetSource,
  sanitizeTweetVideos,
  sourceFromTweetProbe,
} from './tweetSource';
import type { MediaCandidate, ProbeResponse } from './types';

const ID_A = '1846000000000000001';
const ID_B = '1846000000000000002';
const ID_C = '1846000000000000003';

function candidate(url: string, overrides: Partial<MediaCandidate> = {}): MediaCandidate {
  return { url, kind: url.endsWith('.m3u8') ? 'hls' : 'mp4', source: 'sniffed', discoveredAt: 1, ...overrides };
}

const masterA = candidate(`https://video.twimg.com/amplify_video/${ID_A}/pl/a.m3u8`, { discoveredAt: 1 });
const masterB = candidate(`https://video.twimg.com/amplify_video/${ID_B}/pl/b.m3u8`, { discoveredAt: 2 });
const mp4B = candidate(`https://video.twimg.com/ext_tw_video/${ID_B}/pu/vid/avc1/720x1280/b.mp4`, { discoveredAt: 3 });

const clicked = (overrides: Partial<ClickedVideo> = {}): ClickedVideo => ({
  mediaUrl: null,
  title: '@jane - Mon tweet',
  isOnlyVideo: false,
  ...overrides,
});

describe('planTweetSource', () => {
  it('prend le flux du mediaId cliqué, pas le plus ancien de l’onglet', () => {
    const plan = planTweetSource(clicked({ mediaId: ID_B }), [masterA, mp4B, masterB], 'Page');
    expect(plan.kind).toBe('sniffed');
    if (plan.kind !== 'sniffed') return;
    expect(plan.source.url).toBe(masterB.url); // master HLS avant mp4
    expect(plan.source.title).toBe('@jane - Mon tweet');
  });

  it('sans master, retient le mp4 du bon média', () => {
    const plan = planTweetSource(clicked({ mediaId: ID_B }), [masterA, mp4B], 'Page');
    expect(plan.kind === 'sniffed' && plan.source.url).toBe(mp4B.url);
  });

  it('sans flux correspondant mais avec permalink : probe du permalink avec le rang', () => {
    const pageUrl = 'https://x.com/jane/status/1846000000000000009';
    const plan = planTweetSource(clicked({ mediaId: ID_C, pageUrl, playlistIndex: 2 }), [masterA, masterB], 'Page');
    expect(plan).toEqual({ kind: 'probe', pageUrl, playlistItems: 2 });
  });

  it('sans flux ni permalink : introuvable, jamais le 1er candidat', () => {
    expect(planTweetSource(clicked({ mediaId: ID_C }), [masterA, masterB], 'Page')).toEqual({ kind: 'missing' });
  });
});

describe('hasTweetContext', () => {
  it('vrai dès qu’un mediaId ou un permalink est présent', () => {
    expect(hasTweetContext(clicked({ mediaId: ID_A }))).toBe(true);
    expect(hasTweetContext(clicked({ pageUrl: 'https://x.com/a/status/1' }))).toBe(true);
    expect(hasTweetContext(clicked())).toBe(false);
    expect(hasTweetContext(null)).toBe(false);
  });
});

describe('sourceFromTweetProbe', () => {
  const probe = {
    title: 'Titre yt-dlp',
    best_format_id: 'hls-1',
    formats: [{ format_id: 'hls-1', ext: 'mp4' }],
  } as unknown as ProbeResponse;

  it('donne le permalink, le rang et le titre du tweet', () => {
    const permalink = 'https://x.com/jane/status/1846000000000000009';
    const source = sourceFromTweetProbe(probe, clicked({ playlistIndex: 2 }), permalink, 'Page');
    expect(source).toMatchObject({ url: permalink, formatId: 'hls-1', title: '@jane - Mon tweet', playlistItems: 2 });
    expect(source?.filename).toBe('@jane - Mon tweet.mp4');
  });

  it('retombe sur le titre yt-dlp sans titre de tweet', () => {
    const source = sourceFromTweetProbe(probe, clicked({ title: null }), 'https://x.com/a/status/1', 'Page');
    expect(source?.title).toBe('Titre yt-dlp');
  });

  it('rend null si le probe n’a aucun format', () => {
    expect(sourceFromTweetProbe({ ...probe, formats: [] }, clicked(), 'https://x.com/a/status/1', 'Page')).toBeNull();
  });
});

describe('labelTweetCandidates', () => {
  const videos = [
    { mediaId: ID_B, title: 'Tweet B' },
    { mediaId: ID_A, title: 'Tweet A' },
  ];

  it('libelle, ordonne selon le DOM et ne garde qu’un flux par média', () => {
    const other = candidate('https://cdn.example/x.mp4', { discoveredAt: 0 });
    const result = labelTweetCandidates([other, masterA, mp4B, masterB], videos);
    expect(result.map((e) => [e.candidate.url, e.title])).toEqual([
      [masterB.url, 'Tweet B'],
      [masterA.url, 'Tweet A'],
      [other.url, null],
    ]);
    expect(result.map((e) => e.isLabelled)).toEqual([true, true, false]);
  });

  it('ne change rien sans vidéo connue', () => {
    const result = labelTweetCandidates([masterA, masterB], []);
    expect(result.map((e) => e.candidate)).toEqual([masterA, masterB]);
    expect(result.some((e) => e.isLabelled)).toBe(false);
  });
});

describe('sanitizeTweetVideos', () => {
  it('filtre les entrées invalides et borne les titres', () => {
    const result = sanitizeTweetVideos({
      videos: [{ mediaId: ID_A, title: `  a\nb ${'x'.repeat(500)}` }, { mediaId: '../x' }, null, { mediaId: ID_B }],
    });
    expect(result).toHaveLength(2);
    expect(result[0]?.title).toHaveLength(200);
    expect(result[1]).toEqual({ mediaId: ID_B, title: null });
  });

  it('tolère une réponse absente', () => {
    expect(sanitizeTweetVideos(undefined)).toEqual([]);
    expect(sanitizeTweetVideos({ videos: 'non' })).toEqual([]);
  });
});
