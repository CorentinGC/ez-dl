import { describe, expect, it } from 'vitest';
import { BACKUP_FORMAT, MAX_BACKUP_BYTES, buildBackup, parseBackup } from './settingsBackup';
import { DEFAULT_SETTINGS, normalizeRoot } from './profiles';

const root = normalizeRoot({
  version: 2,
  profiles: [{ ...DEFAULT_SETTINGS, id: 'a', name: 'Maison', serverUrl: 'https://ez-dl.example.com', password: 'pw' }],
  activeProfileId: 'a',
});

describe('settingsBackup', () => {
  it('relit à l’identique ce qu’il exporte', () => {
    const text = JSON.stringify(buildBackup(root, { showPageOverlay: false }, new Date(0)));
    const parsed = parseBackup(text);
    expect(parsed.settings).toEqual(root);
    expect(parsed.uiPrefs).toEqual({ showPageOverlay: false });
  });

  it('normalise un contenu partiel', () => {
    const parsed = parseBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 1, settings: { serverUrl: 'http://nas.local:8000' } }));
    expect(parsed.settings.profiles[0]?.serverUrl).toBe('http://nas.local:8000');
    expect(parsed.uiPrefs.showPageOverlay).toBe(true);
  });

  it.each([
    ['pas du JSON', 'nope'],
    ['format inconnu', JSON.stringify({ format: 'autre', version: 1 })],
    ['version future', JSON.stringify({ format: BACKUP_FORMAT, version: 99 })],
    ['tableau', '[]'],
    ['trop gros', 'x'.repeat(MAX_BACKUP_BYTES + 1)],
  ])('refuse : %s', (_label, text) => {
    expect(() => parseBackup(text)).toThrow(Error);
  });
});
