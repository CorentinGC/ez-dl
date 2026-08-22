import { describe, expect, it } from 'vitest';
import {
  defaultFilenameForMedia,
  defaultFilenameForProbe,
  extensionForMediaKind,
  pickBestCandidate,
  pickQuickSource,
  resolveDefaultFolder,
  sortFormatsBestFirst,
} from './quickSource';
import type { ExtensionSettings, MediaCandidate, ProbeFormat, ProbeResponse } from './types';

function format(overrides: Partial<ProbeFormat>): ProbeFormat {
  return {
    format_id: '0',
    ext: 'mp4',
    height: null,
    width: null,
    fps: null,
    vcodec: 'avc1',
    acodec: 'mp4a',
    filesize: null,
    tbr: null,
    label: '',
    has_audio: true,
    has_video: true,
    ...overrides,
  };
}

function probe(overrides: Partial<ProbeResponse> = {}): ProbeResponse {
  return {
    url: 'https://site.example/watch?v=1',
    title: 'Ma vidéo',
    uploader: null,
    duration: null,
    thumbnail: null,
    extractor: 'generic',
    formats: [format({ format_id: '137', height: 1080 }), format({ format_id: '18', height: 360 })],
    best_format_id: null,
    suggested_filename: null,
    ...overrides,
  };
}

function candidate(overrides: Partial<MediaCandidate>): MediaCandidate {
  return { url: 'https://cdn.example/a.mp4', kind: 'mp4', source: 'sniffed', discoveredAt: 1, ...overrides };
}

const PAGE_URL = 'https://site.example/watch?v=1';

describe('pickQuickSource', () => {
  it('privilégie le probe et son meilleur format déclaré', () => {
    const source = pickQuickSource({
      probe: probe({ best_format_id: '137' }),
      candidates: [candidate({})],
      pageUrl: PAGE_URL,
      pageTitle: 'Titre de page',
    });
    expect(source).toEqual({ url: PAGE_URL, formatId: '137', filename: 'Ma vidéo.mp4', title: 'Ma vidéo' });
  });

  it('retombe sur le format de meilleure qualité quand le serveur n’en désigne aucun', () => {
    const source = pickQuickSource({ probe: probe(), candidates: [], pageUrl: PAGE_URL, pageTitle: 'Titre' });
    expect(source?.formatId).toBe('137');
  });

  it('utilise le flux sniffé quand le probe est absent', () => {
    const source = pickQuickSource({
      probe: null,
      candidates: [candidate({ url: 'https://cdn.example/stream.m3u8', kind: 'hls' })],
      pageUrl: PAGE_URL,
      pageTitle: 'Titre de page',
    });
    expect(source).toEqual({
      url: 'https://cdn.example/stream.m3u8',
      formatId: null,
      filename: 'Titre de page.mp4',
      title: 'Titre de page',
    });
  });

  it('ignore un probe sans aucun format exploitable', () => {
    const source = pickQuickSource({
      probe: probe({ formats: [] }),
      candidates: [candidate({ url: 'https://cdn.example/v.mp4' })],
      pageUrl: PAGE_URL,
      pageTitle: 'Titre',
    });
    expect(source?.url).toBe('https://cdn.example/v.mp4');
  });

  it('rend null quand la page n’offre aucune source', () => {
    expect(pickQuickSource({ probe: null, candidates: [], pageUrl: PAGE_URL, pageTitle: 'Titre' })).toBeNull();
  });
});

describe('pickBestCandidate', () => {
  it('préfère un manifeste HLS à un fichier progressif', () => {
    const best = pickBestCandidate([
      candidate({ url: 'https://cdn.example/v.mp4', kind: 'mp4', discoveredAt: 1 }),
      candidate({ url: 'https://cdn.example/master.m3u8', kind: 'hls', discoveredAt: 5 }),
    ]);
    expect(best?.url).toBe('https://cdn.example/master.m3u8');
  });

  it('regroupe les déclinaisons de résolution et garde la meilleure', () => {
    const best = pickBestCandidate([
      candidate({ url: 'https://cdn.example/vid/320x180/v.mp4', discoveredAt: 1 }),
      candidate({ url: 'https://cdn.example/vid/1280x720/v.mp4', discoveredAt: 2 }),
    ]);
    expect(best?.url).toBe('https://cdn.example/vid/1280x720/v.mp4');
  });

  it('départage deux flux de même nature par ordre de découverte', () => {
    const best = pickBestCandidate([
      candidate({ url: 'https://cdn.example/b.mp4', discoveredAt: 9 }),
      candidate({ url: 'https://cdn.example/a.mp4', discoveredAt: 2 }),
    ]);
    expect(best?.url).toBe('https://cdn.example/a.mp4');
  });

  it('rend null sur une liste vide', () => {
    expect(pickBestCandidate([])).toBeNull();
  });
});

describe('noms de fichiers par défaut', () => {
  it('respecte la suggestion du serveur, assainie', () => {
    expect(defaultFilenameForProbe({ title: 'T', suggested_filename: '../etc/passwd.mp4', formats: [] }, 'Page', null))
      .toBe('etc passwd.mp4');
  });

  it('compose titre + extension du format choisi', () => {
    expect(
      defaultFilenameForProbe(
        { title: 'Ma vidéo', suggested_filename: null, formats: [format({ format_id: '137', ext: 'webm' })] },
        'Page',
        '137',
      ),
    ).toBe('Ma vidéo.webm');
  });

  it('retombe sur le titre de page quand la source n’a pas de titre', () => {
    expect(defaultFilenameForMedia('hls', null, 'Titre de page')).toBe('Titre de page.mp4');
  });

  it('mappe les conteneurs de sortie', () => {
    expect(extensionForMediaKind('mp4')).toBe('mp4');
    expect(extensionForMediaKind('webm')).toBe('webm');
    expect(extensionForMediaKind('dash')).toBe('mp4');
    expect(extensionForMediaKind('other-video')).toBeNull();
  });
});

describe('sortFormatsBestFirst', () => {
  it('trie par hauteur puis par débit, sans muter l’entrée', () => {
    const formats = [
      format({ format_id: 'a', height: 720, tbr: 1000 }),
      format({ format_id: 'b', height: 1080, tbr: 2000 }),
      format({ format_id: 'c', height: 1080, tbr: 5000 }),
    ];
    expect(sortFormatsBestFirst(formats).map((f) => f.format_id)).toEqual(['c', 'b', 'a']);
    expect(formats[0]?.format_id).toBe('a');
  });
});

describe('resolveDefaultFolder', () => {
  const base: ExtensionSettings = {
    serverUrl: 'http://localhost:8000',
    password: 'x',
    favoriteFolders: [
      { label: 'Films', path: '/mnt/media/movies' },
      { label: 'Séries', path: '/mnt/media/series' },
    ],
    defaultFolderPath: '/mnt/media/series',
    defaultPresetId: null,
    sendCookies: false,
  };

  it('rend le favori marqué par défaut', () => {
    expect(resolveDefaultFolder(base)).toEqual({ label: 'Séries', path: '/mnt/media/series' });
  });

  it('retombe sur le premier favori si le défaut ne correspond à aucun', () => {
    expect(resolveDefaultFolder({ ...base, defaultFolderPath: '/disparu' })).toEqual({
      label: 'Films',
      path: '/mnt/media/movies',
    });
  });

  it('rend null sans aucun favori', () => {
    expect(resolveDefaultFolder({ ...base, favoriteFolders: [], defaultFolderPath: null })).toBeNull();
  });
});
