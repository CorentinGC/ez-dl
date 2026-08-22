/**
 * Tests des profils de serveur : migration du format v1 (un seul serveur plat), CRUD,
 * vue aplatie sur le profil actif et détection de changement de serveur effectif.
 *
 * `storage.local` est remplacé par un stub en mémoire qui reproduit ce qui compte ici :
 * `get`/`set` asynchrones et l'événement `onChanged` émis à chaque écriture.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  MIGRATED_PROFILE_ID,
  createProfile,
  deleteProfile,
  duplicateProfile,
  getActiveProfile,
  getSettings,
  getSettingsRoot,
  hasActiveServerChanged,
  normalizeRoot,
  saveSettings,
  setActiveProfile,
  updateProfile,
  watchSettingsRoot,
} from './profiles';
import type { ExtensionSettings, SettingsRoot } from './types';

type StorageListener = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>) => void;

interface StorageStub {
  /** Nombre d'écritures effectives — sert à prouver qu'une migration n'a lieu qu'une fois. */
  writes: number;
  read: () => unknown;
  listenerCount: () => number;
}

function stubStorage(initial?: unknown): StorageStub {
  const data = new Map<string, unknown>();
  if (initial !== undefined) data.set('settings', initial);
  const listeners = new Set<StorageListener>();
  const stub: StorageStub = {
    writes: 0,
    read: () => data.get('settings'),
    listenerCount: () => listeners.size,
  };

  vi.stubGlobal('browser', {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: data.get(key) }),
        set: async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) {
            const oldValue = data.get(key);
            data.set(key, value);
            stub.writes += 1;
            for (const listener of [...listeners]) listener({ [key]: { oldValue, newValue: value } });
          }
        },
        onChanged: {
          addListener: (listener: StorageListener) => listeners.add(listener),
          removeListener: (listener: StorageListener) => listeners.delete(listener),
        },
      },
    },
  });

  return stub;
}

const V1_SETTINGS: ExtensionSettings = {
  serverUrl: 'https://ezdl.example.org',
  password: 'secret',
  favoriteFolders: [{ label: 'Films', path: '/data/movies' }],
  defaultFolderPath: '/data/movies',
  defaultPresetId: 'copy',
  sendCookies: true,
};

function v2Root(overrides: Partial<SettingsRoot> = {}): SettingsRoot {
  return {
    version: 2,
    profiles: [
      { ...DEFAULT_SETTINGS, id: 'a', name: 'Local', serverUrl: 'http://localhost:8000', password: 'pa' },
      { ...DEFAULT_SETTINGS, id: 'b', name: 'NAS', serverUrl: 'https://nas.example.org', password: 'pb' },
    ],
    activeProfileId: 'a',
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('normalizeRoot', () => {
  it('crée un profil par défaut quand rien n\'est stocké', () => {
    const root = normalizeRoot(undefined);
    expect(root.profiles).toHaveLength(1);
    expect(root.profiles[0]).toMatchObject({ id: MIGRATED_PROFILE_ID, ...DEFAULT_SETTINGS });
    expect(root.activeProfileId).toBe(MIGRATED_PROFILE_ID);
  });

  it('migre le format v1 plat sans perdre la configuration existante', () => {
    const root = normalizeRoot(V1_SETTINGS);
    expect(root.profiles).toHaveLength(1);
    expect(root.profiles[0]).toMatchObject({ ...V1_SETTINGS, id: MIGRATED_PROFILE_ID });
    expect(root.activeProfileId).toBe(MIGRATED_PROFILE_ID);
  });

  it('complète un v1 partiel par les valeurs par défaut', () => {
    const root = normalizeRoot({ serverUrl: 'http://nas.local:8000' });
    expect(root.profiles[0]).toMatchObject({ serverUrl: 'http://nas.local:8000', password: '', sendCookies: false });
  });

  it('produit un identifiant déterministe (migrations concurrentes identiques)', () => {
    expect(normalizeRoot(V1_SETTINGS)).toEqual(normalizeRoot({ ...V1_SETTINGS }));
  });

  it('retombe sur le premier profil quand activeProfileId est orphelin', () => {
    const root = normalizeRoot(v2Root({ activeProfileId: 'disparu' }));
    expect(root.activeProfileId).toBe('a');
  });

  it('recrée un profil par défaut si la liste stockée est vide', () => {
    const root = normalizeRoot({ version: 2, profiles: [], activeProfileId: 'x' });
    expect(root.profiles).toHaveLength(1);
    expect(root.activeProfileId).toBe(MIGRATED_PROFILE_ID);
  });
});

describe('getSettingsRoot', () => {
  it('persiste la migration v1 une seule fois', async () => {
    const storage = stubStorage(V1_SETTINGS);

    await getSettingsRoot();
    expect(storage.writes).toBe(1);
    expect((storage.read() as SettingsRoot).version).toBe(2);

    await getSettingsRoot();
    expect(storage.writes).toBe(1);
  });

  it('n\'écrit rien quand la racine est déjà en v2', async () => {
    const storage = stubStorage(v2Root());
    await getSettingsRoot();
    expect(storage.writes).toBe(0);
  });
});

describe('vue aplatie sur le profil actif', () => {
  beforeEach(() => stubStorage(v2Root({ activeProfileId: 'b' })));

  it('getSettings retourne le profil actif', async () => {
    expect((await getSettings()).serverUrl).toBe('https://nas.example.org');
  });

  it('saveSettings ne modifie que le profil actif', async () => {
    await saveSettings({ defaultPresetId: 'h264' });
    const root = await getSettingsRoot();
    expect(root.profiles.find((p) => p.id === 'b')?.defaultPresetId).toBe('h264');
    expect(root.profiles.find((p) => p.id === 'a')?.defaultPresetId).toBeNull();
  });
});

describe('CRUD des profils', () => {
  it('bascule le profil actif, et ignore un identifiant inconnu', async () => {
    const storage = stubStorage(v2Root());

    expect((await setActiveProfile('b')).activeProfileId).toBe('b');
    const writesAfterSwitch = storage.writes;

    expect((await setActiveProfile('inconnu')).activeProfileId).toBe('b');
    expect(storage.writes).toBe(writesAfterSwitch);
  });

  it('ajoute un profil vierge sans le rendre actif', async () => {
    stubStorage(v2Root());
    const { root, profile } = await createProfile('Nouveau');
    expect(root.profiles).toHaveLength(3);
    expect(profile).toMatchObject({ name: 'Nouveau', ...DEFAULT_SETTINGS });
    expect(root.activeProfileId).toBe('a');
  });

  it('duplique un profil en copie profonde, sans le rendre actif', async () => {
    stubStorage(
      v2Root({
        profiles: [{ ...DEFAULT_SETTINGS, id: 'a', name: 'Local', favoriteFolders: [{ label: 'Films', path: '/data/movies' }] }],
        activeProfileId: 'a',
      }),
    );

    const { root, profile } = await duplicateProfile('a');
    expect(profile?.name).toBe('Local (copie)');
    expect(profile?.id).not.toBe('a');
    expect(root.activeProfileId).toBe('a');

    // Modifier la copie ne doit pas atteindre les favoris de la source.
    profile?.favoriteFolders[0] && (profile.favoriteFolders[0].label = 'Autre');
    expect(root.profiles[0]?.favoriteFolders[0]?.label).toBe('Films');
  });

  it('renomme un profil et refuse un nom vide', async () => {
    stubStorage(v2Root());

    const renamed = await updateProfile('a', { name: 'Maison' });
    expect(renamed.profiles.find((p) => p.id === 'a')?.name).toBe('Maison');

    const untouched = await updateProfile('a', { name: '   ' });
    expect(untouched.profiles.find((p) => p.id === 'a')?.name).toBe('Maison');
  });

  it('supprime un profil et bascule l\'actif quand c\'est lui qui disparaît', async () => {
    stubStorage(v2Root({ activeProfileId: 'a' }));
    const root = await deleteProfile('a');
    expect(root.profiles.map((p) => p.id)).toEqual(['b']);
    expect(root.activeProfileId).toBe('b');
  });

  it('refuse de supprimer le dernier profil', async () => {
    const storage = stubStorage(v2Root({ profiles: [{ ...DEFAULT_SETTINGS, id: 'a', name: 'Local' }], activeProfileId: 'a' }));
    const root = await deleteProfile('a');
    expect(root.profiles).toHaveLength(1);
    expect(storage.writes).toBe(0);
  });
});

describe('hasActiveServerChanged', () => {
  it('est faux pour l\'écriture de migration v1 → v2 (même serveur)', () => {
    expect(hasActiveServerChanged(V1_SETTINGS, normalizeRoot(V1_SETTINGS))).toBe(false);
  });

  it('est vrai quand le profil actif change de serveur', () => {
    expect(hasActiveServerChanged(v2Root(), v2Root({ activeProfileId: 'b' }))).toBe(true);
  });

  it('est faux pour une modification qui ne touche pas le serveur actif', () => {
    const before = v2Root();
    const after = v2Root({
      profiles: [{ ...before.profiles[0]!, favoriteFolders: [{ label: 'Films', path: '/data/movies' }] }, before.profiles[1]!],
    });
    expect(hasActiveServerChanged(before, after)).toBe(false);
  });
});

describe('watchSettingsRoot', () => {
  it('notifie la racine normalisée puis se désinscrit', async () => {
    const storage = stubStorage(v2Root());
    const seen: SettingsRoot[] = [];
    const unsubscribe = watchSettingsRoot((root) => seen.push(root));

    await setActiveProfile('b');
    expect(seen.at(-1)?.activeProfileId).toBe('b');

    unsubscribe();
    expect(storage.listenerCount()).toBe(0);

    await setActiveProfile('a');
    expect(seen).toHaveLength(1);
  });

  it('renvoie le profil actif complété même si le stockage est écrasé par un v1', async () => {
    stubStorage(v2Root());
    const seen: SettingsRoot[] = [];
    watchSettingsRoot((root) => seen.push(root));

    await browser.storage.local.set({ settings: V1_SETTINGS });
    expect(seen.at(-1)?.profiles[0]).toMatchObject({ id: MIGRATED_PROFILE_ID, serverUrl: V1_SETTINGS.serverUrl });
  });
});

describe('getActiveProfile', () => {
  it('retourne le profil désigné par activeProfileId', async () => {
    stubStorage(v2Root({ activeProfileId: 'b' }));
    expect(await getActiveProfile()).toMatchObject({ id: 'b', name: 'NAS' });
  });
});
