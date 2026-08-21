import { describe, expect, it } from 'vitest';
import {
  applySiteRules,
  classifyUrl,
  collapseVariantPlaylists,
  correlatePickedElement,
  dedupeCandidates,
  generalizeUrlPattern,
  groupQualityVariants,
  groupSegmentsByPlaylist,
  isHlsSegment,
  isMediaUrl,
  patternToRegExp,
} from './detection';
import type { MediaCandidate, PickedElementInfo, RawRequest, SiteRule } from './types';

function candidate(overrides: Partial<MediaCandidate> = {}): MediaCandidate {
  return {
    url: 'https://cdn.example.com/video/master.m3u8',
    kind: 'hls',
    source: 'sniffed',
    contentType: null,
    size: null,
    discoveredAt: 1,
    ...overrides,
  };
}

describe('classifyUrl / isMediaUrl', () => {
  it('reconnaît une playlist HLS par extension', () => {
    expect(classifyUrl('https://cdn.example.com/stream/master.m3u8')).toBe('hls');
  });

  it('reconnaît un manifeste DASH par extension', () => {
    expect(classifyUrl('https://cdn.example.com/stream/manifest.mpd')).toBe('dash');
  });

  it('reconnaît un mp4 progressif', () => {
    expect(classifyUrl('https://cdn.example.com/video/file.mp4?token=abc')).toBe('mp4');
  });

  it('reconnaît un webm progressif', () => {
    expect(classifyUrl('https://cdn.example.com/video/file.webm')).toBe('webm');
  });

  it('reconnaît via le content-type application/vnd.apple.mpegurl même sans extension', () => {
    expect(classifyUrl('https://cdn.example.com/api/stream?id=1', 'application/vnd.apple.mpegurl')).toBe('hls');
  });

  it('reconnaît via le content-type application/dash+xml', () => {
    expect(classifyUrl('https://cdn.example.com/api/stream?id=1', 'application/dash+xml; charset=utf-8')).toBe(
      'dash',
    );
  });

  it('reconnaît un content-type video/* générique', () => {
    expect(classifyUrl('https://cdn.example.com/api/stream?id=1', 'video/mp4')).toBe('other-video');
  });

  it("retourne null pour une ressource qui n'est pas un média", () => {
    expect(classifyUrl('https://example.com/index.html', 'text/html')).toBeNull();
    expect(isMediaUrl('https://example.com/index.html', 'text/html')).toBe(false);
  });

  it('isMediaUrl est vrai pour une URL média reconnue', () => {
    expect(isMediaUrl('https://cdn.example.com/video/file.mp4')).toBe(true);
  });
});

describe('isHlsSegment', () => {
  it('reconnaît un segment .ts', () => {
    expect(isHlsSegment('https://cdn.example.com/stream/seg-001.ts')).toBe(true);
  });

  it('reconnaît un segment .m4s', () => {
    expect(isHlsSegment('https://cdn.example.com/stream/init.m4s')).toBe(true);
  });

  it('reconnaît un segment via content-type video/mp2t', () => {
    expect(isHlsSegment('https://cdn.example.com/api/chunk?n=1', 'video/mp2t')).toBe(true);
  });

  it("n'est pas un segment pour une playlist m3u8", () => {
    expect(isHlsSegment('https://cdn.example.com/stream/master.m3u8')).toBe(false);
  });

  it("n'est pas un segment pour un mp4 progressif", () => {
    expect(isHlsSegment('https://cdn.example.com/video/file.mp4')).toBe(false);
  });
});

describe('groupSegmentsByPlaylist', () => {
  it('élimine les segments rattachés à une playlist du même répertoire', () => {
    const candidates = [
      candidate({ url: 'https://cdn.example.com/hls/master.m3u8', kind: 'hls' }),
      candidate({ url: 'https://cdn.example.com/hls/seg-001.ts', kind: 'other-video' }),
      candidate({ url: 'https://cdn.example.com/hls/seg-002.ts', kind: 'other-video' }),
    ];
    const result = groupSegmentsByPlaylist(candidates);
    expect(result).toHaveLength(1);
    expect(result[0]?.url).toBe('https://cdn.example.com/hls/master.m3u8');
  });

  it('conserve les flux progressifs (mp4/webm) tels quels', () => {
    const candidates = [candidate({ url: 'https://cdn.example.com/video/file.mp4', kind: 'mp4' })];
    expect(groupSegmentsByPlaylist(candidates)).toEqual(candidates);
  });

  it("conserve un segment orphelin (pas de playlist connue dans son répertoire)", () => {
    const candidates = [candidate({ url: 'https://cdn.example.com/hls/seg-001.ts', kind: 'other-video' })];
    expect(groupSegmentsByPlaylist(candidates)).toEqual(candidates);
  });

  it('gère plusieurs playlists dans des répertoires différents indépendamment', () => {
    const candidates = [
      candidate({ url: 'https://cdn.example.com/a/master.m3u8', kind: 'hls' }),
      candidate({ url: 'https://cdn.example.com/a/seg.ts', kind: 'other-video' }),
      candidate({ url: 'https://cdn.example.com/b/master.m3u8', kind: 'hls' }),
      candidate({ url: 'https://cdn.example.com/b/seg.ts', kind: 'other-video' }),
    ];
    const result = groupSegmentsByPlaylist(candidates);
    expect(result.map((c) => c.url)).toEqual([
      'https://cdn.example.com/a/master.m3u8',
      'https://cdn.example.com/b/master.m3u8',
    ]);
  });
});

describe('dedupeCandidates', () => {
  it('déduplique deux entrées de la même URL en ignorant les paramètres de requête', () => {
    const result = dedupeCandidates([
      candidate({ url: 'https://cdn.example.com/v.mp4?t=1', kind: 'mp4' }),
      candidate({ url: 'https://cdn.example.com/v.mp4?t=2', kind: 'mp4' }),
    ]);
    expect(result).toHaveLength(1);
  });

  it('garde le doublon le plus riche en information (content-type + taille connus)', () => {
    const poor = candidate({ url: 'https://cdn.example.com/v.mp4', contentType: null, size: null });
    const rich = candidate({ url: 'https://cdn.example.com/v.mp4', contentType: 'video/mp4', size: 12345 });
    expect(dedupeCandidates([poor, rich])).toEqual([rich]);
    expect(dedupeCandidates([rich, poor])).toEqual([rich]);
  });

  it('préfère une source "learned"/"picked" à une source "sniffed" à information égale', () => {
    const sniffed = candidate({ url: 'https://cdn.example.com/v.mp4', source: 'sniffed' });
    const learned = candidate({ url: 'https://cdn.example.com/v.mp4', source: 'learned' });
    expect(dedupeCandidates([sniffed, learned])).toEqual([learned]);
  });

  it("laisse intactes des URLs distinctes", () => {
    const a = candidate({ url: 'https://cdn.example.com/a.mp4' });
    const b = candidate({ url: 'https://cdn.example.com/b.mp4' });
    expect(dedupeCandidates([a, b])).toHaveLength(2);
  });
});

describe('patternToRegExp', () => {
  it('interprète un pattern simple comme un glob (seul * est un joker)', () => {
    const re = patternToRegExp('https://cdn.example.com/*/master.m3u8');
    expect(re.test('https://cdn.example.com/abc/master.m3u8')).toBe(true);
    expect(re.test('https://cdn.example.com/master.m3u8')).toBe(false);
  });

  it('échappe les caractères spéciaux regex dans un glob (le point est littéral)', () => {
    const re = patternToRegExp('https://cdn.example.com/video.mp4');
    expect(re.test('https://cdn.example.com/videoXmp4')).toBe(false);
    expect(re.test('https://cdn.example.com/video.mp4')).toBe(true);
  });

  it('traite un pattern contenant des métacaractères comme une regex', () => {
    const re = patternToRegExp('^https://cdn\\.example\\.com/(a|b)/stream\\.m3u8$');
    expect(re.test('https://cdn.example.com/a/stream.m3u8')).toBe(true);
    expect(re.test('https://cdn.example.com/c/stream.m3u8')).toBe(false);
  });

  it("traite `?` comme le séparateur littéral de query string, pas comme un quantificateur regex", () => {
    const re = patternToRegExp('https://cdn.example.com/video?id=*');
    expect(re.test('https://cdn.example.com/video?id=12345')).toBe(true);
    expect(re.test('https://cdn.example.com/video?id=')).toBe(true);
    expect(re.test('https://cdn.example.com/videoid=12345')).toBe(false);
  });
});

describe('applySiteRules', () => {
  const rules: SiteRule[] = [
    {
      id: 'rule-1',
      domain: 'video.example.com',
      url_pattern: 'https://video.example.com/stream/*.bin',
      label: 'Flux propriétaire',
      notes: null,
      source: 'learned',
      created_at: '2026-01-01T00:00:00Z',
    },
  ];

  it('reconnaît une requête qui ne matche aucun pattern générique mais matche une règle apprise', () => {
    const requests: RawRequest[] = [
      { url: 'https://video.example.com/stream/abc.bin', contentType: 'application/octet-stream', tabId: 1 },
    ];
    const result = applySiteRules(requests, rules);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ url: 'https://video.example.com/stream/abc.bin', source: 'learned' });
  });

  it("ignore les requêtes d'un autre domaine", () => {
    const requests: RawRequest[] = [{ url: 'https://other.com/stream/abc.bin', tabId: 1 }];
    expect(applySiteRules(requests, rules)).toHaveLength(0);
  });

  it('ignore les requêtes du bon domaine qui ne matchent pas le pattern', () => {
    const requests: RawRequest[] = [{ url: 'https://video.example.com/other/abc.txt', tabId: 1 }];
    expect(applySiteRules(requests, rules)).toHaveLength(0);
  });

  it('reconnaît un sous-domaine du domaine de la règle', () => {
    const requests: RawRequest[] = [{ url: 'https://cdn.video.example.com/stream/abc.bin', tabId: 1 }];
    const subdomainRule: SiteRule[] = [{ ...rules[0]!, domain: 'example.com', url_pattern: 'https://*.example.com/stream/*.bin' }];
    expect(applySiteRules(requests, subdomainRule)).toHaveLength(1);
  });

  it('retourne un tableau vide sans règles', () => {
    expect(applySiteRules([{ url: 'https://video.example.com/stream/abc.bin', tabId: 1 }], [])).toEqual([]);
  });
});

describe('correlatePickedElement', () => {
  const basePicked: PickedElementInfo = {
    tagName: 'VIDEO',
    src: null,
    currentSrc: null,
    poster: null,
    selector: 'video#player',
    rect: { x: 0, y: 0, width: 640, height: 360 },
  };

  it("retient l'URL portée par l'élément si c'est un média reconnu", () => {
    const picked: PickedElementInfo = { ...basePicked, currentSrc: 'https://cdn.example.com/v.mp4' };
    const result = correlatePickedElement(picked, []);
    expect(result?.url).toBe('https://cdn.example.com/v.mp4');
    expect(result?.source).toBe('picked');
  });

  it("retombe sur le candidat sniffé le plus récent si l'élément ne porte pas d'URL exploitable", () => {
    const older = candidate({ url: 'https://cdn.example.com/old.mp4', discoveredAt: 1 });
    const newer = candidate({ url: 'https://cdn.example.com/new.mp4', discoveredAt: 2 });
    const result = correlatePickedElement(basePicked, [older, newer]);
    expect(result?.url).toBe('https://cdn.example.com/new.mp4');
  });

  it("retourne null si rien n'est exploitable", () => {
    expect(correlatePickedElement(basePicked, [])).toBeNull();
  });
});

describe('generalizeUrlPattern', () => {
  /** Vérifie systématiquement que le pattern généralisé matche bien l'URL dont il est dérivé. */
  function expectPatternMatchesSource(url: string): string {
    const pattern = generalizeUrlPattern(url);
    expect(patternToRegExp(pattern).test(url)).toBe(true);
    return pattern;
  }

  it('généralise un id purement numérique (≥ 2 chiffres) dans le chemin', () => {
    const url = 'https://cdn.example.com/videos/12345/master.m3u8';
    expect(expectPatternMatchesSource(url)).toBe('https://cdn.example.com/videos/*/master.m3u8');
  });

  it('conserve un identifiant numérique trop court (1 chiffre) tel quel', () => {
    const url = 'https://cdn.example.com/videos/v2/master.m3u8';
    expect(expectPatternMatchesSource(url)).toBe('https://cdn.example.com/videos/v2/master.m3u8');
  });

  it('généralise un hash hexadécimal (≥ 8 caractères) dans le chemin', () => {
    const url = 'https://cdn.example.com/files/a3f5c9d2e1b8/video.mp4';
    expect(expectPatternMatchesSource(url)).toBe('https://cdn.example.com/files/*/video.mp4');
  });

  it('généralise un UUID dans le chemin', () => {
    const url = 'https://cdn.example.com/stream/550e8400-e29b-41d4-a716-446655440000/index.m3u8';
    expect(expectPatternMatchesSource(url)).toBe('https://cdn.example.com/stream/*/index.m3u8');
  });

  it('généralise un token aléatoire (≥ 16 caractères, non hexadécimal) dans le chemin', () => {
    const url = 'https://cdn.example.com/get/aZ9bQ7xM2kLp5vRt8nWc/video.mp4';
    expect(expectPatternMatchesSource(url)).toBe('https://cdn.example.com/get/*/video.mp4');
  });

  it('généralise un segment mixte en conservant préfixe/suffixe/extension stables', () => {
    const url = 'https://cdn.example.com/videos/video-12345.mp4';
    expect(expectPatternMatchesSource(url)).toBe('https://cdn.example.com/videos/video-*.mp4');
  });

  it('conserve les clés de la query string et remplace toutes les valeurs par *', () => {
    const url = 'https://cdn.example.com/api/stream?id=12345&token=abcDEF123456&format=hls';
    expect(expectPatternMatchesSource(url)).toBe('https://cdn.example.com/api/stream?id=*&token=*&format=*');
  });

  it('supprime le fragment (jamais envoyé au serveur)', () => {
    const pattern = generalizeUrlPattern('https://cdn.example.com/videos/12345/master.m3u8#t=30');
    expect(pattern).toBe('https://cdn.example.com/videos/*/master.m3u8');
  });

  it("retourne l'URL telle quelle si elle est invalide", () => {
    expect(generalizeUrlPattern('not a url')).toBe('not a url');
  });

  it('laisse un chemin purement littéral (aucun identifiant variable) inchangé', () => {
    const url = 'https://cdn.example.com/hls/master.m3u8';
    expect(expectPatternMatchesSource(url)).toBe('https://cdn.example.com/hls/master.m3u8');
  });
});

describe('collapseVariantPlaylists', () => {
  it('écrase les playlists variantes sous leur master (cas x.com)', () => {
    const master = candidate({ url: 'https://video.twimg.com/amplify_video/123/pl/abc.m3u8' });
    const candidates = [
      master,
      candidate({ url: 'https://video.twimg.com/amplify_video/123/pl/avc1/320x568/d.m3u8' }),
      candidate({ url: 'https://video.twimg.com/amplify_video/123/pl/avc1/720x1280/e.m3u8' }),
    ];
    expect(collapseVariantPlaylists(candidates)).toEqual([master]);
  });

  it('conserve deux masters de répertoires distincts et les flux non-playlist', () => {
    const candidates = [
      candidate({ url: 'https://cdn.example.com/videos/1/master.m3u8' }),
      candidate({ url: 'https://cdn.example.com/videos/2/master.m3u8' }),
      candidate({ url: 'https://cdn.example.com/videos/1/direct.mp4', kind: 'mp4' }),
    ];
    expect(collapseVariantPlaylists(candidates)).toEqual(candidates);
  });
});

describe('groupQualityVariants', () => {
  it('regroupe les déclinaisons de résolution mp4 en une entrée, meilleure qualité en tête', () => {
    const low = candidate({ url: 'https://video.twimg.com/ext_tw_video/9/pu/vid/avc1/320x568/aa.mp4', kind: 'mp4' });
    const high = candidate({ url: 'https://video.twimg.com/ext_tw_video/9/pu/vid/avc1/720x1280/bb.mp4', kind: 'mp4' });
    const mid = candidate({ url: 'https://video.twimg.com/ext_tw_video/9/pu/vid/avc1/480x852/cc.mp4', kind: 'mp4' });

    const grouped = groupQualityVariants([low, high, mid]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.url).toBe(high.url);
    expect(grouped[0]?.qualityVariants).toEqual([
      { url: high.url, label: '720x1280' },
      { url: mid.url, label: '480x852' },
      { url: low.url, label: '320x568' },
    ]);
  });

  it('reconnaît les segments de qualité en NNNp', () => {
    const grouped = groupQualityVariants([
      candidate({ url: 'https://cdn.example.com/v/1080p/video.mp4', kind: 'mp4' }),
      candidate({ url: 'https://cdn.example.com/v/480p/video.mp4', kind: 'mp4' }),
    ]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.qualityVariants?.map((v) => v.label)).toEqual(['1080p', '480p']);
  });

  it('ne regroupe pas des vidéos différentes ni les URLs sans segment de qualité', () => {
    const candidates = [
      candidate({ url: 'https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/720x1280/aa.mp4', kind: 'mp4' }),
      candidate({ url: 'https://video.twimg.com/ext_tw_video/2/pu/vid/avc1/720x1280/bb.mp4', kind: 'mp4' }),
      candidate({ url: 'https://cdn.example.com/videos/plain.mp4', kind: 'mp4' }),
      candidate({ url: 'https://cdn.example.com/videos/other.webm', kind: 'webm' }),
    ];
    const grouped = groupQualityVariants(candidates);
    expect(grouped).toHaveLength(4);
    expect(grouped.every((c) => !c.qualityVariants)).toBe(true);
  });

  it('laisse les playlists HLS hors du regroupement progressif', () => {
    const hls = candidate({ url: 'https://cdn.example.com/v/720x1280/media.m3u8' });
    expect(groupQualityVariants([hls])).toEqual([hls]);
  });

  it('une seule déclinaison connue -> pas de dropdown (pas de qualityVariants)', () => {
    const single = candidate({ url: 'https://cdn.example.com/v/720x1280/only.mp4', kind: 'mp4' });
    const grouped = groupQualityVariants([single]);
    expect(grouped).toEqual([single]);
    expect(grouped[0]?.qualityVariants).toBeUndefined();
  });
});
