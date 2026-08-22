/**
 * Profils de serveur : plusieurs configurations ez-dl nommées, une seule active à la fois.
 *
 * Tout tient dans l'unique clé `settings` de `storage.local` (écriture atomique, un seul point
 * d'écoute `onChanged`). Le format v1 — un objet `ExtensionSettings` plat — est migré
 * paresseusement à la première lecture : la migration est déterministe (identifiant fixe
 * `default`), donc deux contextes qui migrent en même temps (popup, options, service worker)
 * produisent exactement le même octet et le dernier écrivain ne casse rien.
 */

import type { ExtensionSettings, ServerProfile, SettingsRoot } from './types';

const SETTINGS_KEY = 'settings';

/** Identifiant du profil issu de la migration v1 : fixe, jamais aléatoire (cf. en-tête). */
export const MIGRATED_PROFILE_ID = 'default';

export const DEFAULT_SETTINGS: ExtensionSettings = {
  // Port par défaut du serveur ez-dl (voir docker-compose.yml) : un serveur local tourne sans
  // configuration préalable de l'URL, seul le mot de passe reste à saisir (auth obligatoire).
  serverUrl: 'http://localhost:8000',
  password: '',
  favoriteFolders: [],
  defaultFolderPath: null,
  defaultPresetId: null,
  sendCookies: false,
};

const DEFAULT_PROFILE_NAME = 'Serveur';

// ---------------------------------------------------------------------------
// Normalisation / migration (pure, testable sans storage)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Complète un profil partiel par les valeurs par défaut, en garantissant id et nom. */
function toProfile(raw: Record<string, unknown>, fallbackId: string, fallbackName: string): ServerProfile {
  const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : fallbackId;
  const name = typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name : fallbackName;
  return { ...DEFAULT_SETTINGS, ...(raw as Partial<ExtensionSettings>), id, name };
}

function defaultRoot(): SettingsRoot {
  return {
    version: 2,
    profiles: [{ ...DEFAULT_SETTINGS, id: MIGRATED_PROFILE_ID, name: DEFAULT_PROFILE_NAME }],
    activeProfileId: MIGRATED_PROFILE_ID,
  };
}

/**
 * Ramène n'importe quel contenu stocké (absent, v1 plat, v2 partiel) à un `SettingsRoot`
 * valide : au moins un profil, un `activeProfileId` qui existe vraiment.
 */
export function normalizeRoot(stored: unknown): SettingsRoot {
  if (!isRecord(stored)) return defaultRoot();

  // v1 : objet plat sans `version` ni `profiles` — un seul serveur, identifiant fixe.
  if (stored.version !== 2 || !Array.isArray(stored.profiles)) {
    return {
      version: 2,
      profiles: [toProfile(stored, MIGRATED_PROFILE_ID, DEFAULT_PROFILE_NAME)],
      activeProfileId: MIGRATED_PROFILE_ID,
    };
  }

  const profiles = stored.profiles
    .filter(isRecord)
    .map((raw, index) => toProfile(raw, `${MIGRATED_PROFILE_ID}-${index}`, `${DEFAULT_PROFILE_NAME} ${index + 1}`));
  if (profiles.length === 0) return defaultRoot();

  const first = profiles[0] as ServerProfile;
  const activeProfileId =
    typeof stored.activeProfileId === 'string' && profiles.some((p) => p.id === stored.activeProfileId)
      ? stored.activeProfileId
      : first.id;
  return { version: 2, profiles, activeProfileId };
}

/** Vrai si `stored` est déjà un `SettingsRoot` v2 exploitable (pas de réécriture nécessaire). */
function isMigrated(stored: unknown): boolean {
  return isRecord(stored) && stored.version === 2 && Array.isArray(stored.profiles) && stored.profiles.length > 0;
}

// ---------------------------------------------------------------------------
// Lecture / écriture
// ---------------------------------------------------------------------------

async function readStored(): Promise<unknown> {
  const stored = await browser.storage.local.get<Record<string, unknown>>(SETTINGS_KEY);
  return stored[SETTINGS_KEY];
}

async function writeRoot(root: SettingsRoot): Promise<SettingsRoot> {
  await browser.storage.local.set({ [SETTINGS_KEY]: root });
  return root;
}

/**
 * Lit la racine des réglages, en migrant et persistant le format v1 au passage (une seule fois :
 * une racine déjà en v2 n'est jamais réécrite, sinon chaque lecture réveillerait les watchers).
 */
export async function getSettingsRoot(): Promise<SettingsRoot> {
  const stored = await readStored();
  const root = normalizeRoot(stored);
  if (!isMigrated(stored)) await writeRoot(root);
  return root;
}

/** Profil actif — celui utilisé par la popup, le background et les téléchargements. */
export async function getActiveProfile(): Promise<ServerProfile> {
  const root = await getSettingsRoot();
  return findActive(root);
}

function findActive(root: SettingsRoot): ServerProfile {
  const active = root.profiles.find((p) => p.id === root.activeProfileId);
  // `normalizeRoot` garantit au moins un profil et un actif valide ; le repli est défensif.
  return active ?? (root.profiles[0] as ServerProfile);
}

// ---------------------------------------------------------------------------
// Vue aplatie : compatibilité avec tout le code qui ne connaît qu'un serveur
// ---------------------------------------------------------------------------

/** Réglages du profil actif (contrat historique : un seul serveur visible à la fois). */
export async function getSettings(): Promise<ExtensionSettings> {
  return getActiveProfile();
}

/** Fusionne un patch partiel dans le profil **actif** et le persiste. */
export async function saveSettings(patch: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const root = await getSettingsRoot();
  const next = await updateProfileIn(root, root.activeProfileId, patch);
  return findActive(next);
}

/** Vrai si un serveur (URL + mot de passe) est configuré. */
export function isServerConfigured(settings: ExtensionSettings): boolean {
  return settings.serverUrl.trim().length > 0 && settings.password.trim().length > 0;
}

// ---------------------------------------------------------------------------
// CRUD des profils
// ---------------------------------------------------------------------------

/** Bascule le profil actif. Un identifiant inconnu est ignoré (aucune écriture). */
export async function setActiveProfile(id: string): Promise<SettingsRoot> {
  const root = await getSettingsRoot();
  if (!root.profiles.some((p) => p.id === id) || root.activeProfileId === id) return root;
  return writeRoot({ ...root, activeProfileId: id });
}

/** Ajoute un profil vierge (URL par défaut, sans mot de passe). Ne devient pas actif. */
export async function createProfile(name: string): Promise<{ root: SettingsRoot; profile: ServerProfile }> {
  const root = await getSettingsRoot();
  const profile: ServerProfile = { ...DEFAULT_SETTINGS, id: newProfileId(), name: name.trim() || DEFAULT_PROFILE_NAME };
  const next = await writeRoot({ ...root, profiles: [...root.profiles, profile] });
  return { root: next, profile };
}

/**
 * Duplique un profil existant — chemin de création par défaut dans les options : partir d'une
 * configuration qui marche évite de ressaisir dossiers favoris et preset. La copie est profonde
 * (`favoriteFolders` est un tableau d'objets : un `...spread` le partagerait entre les profils).
 */
export async function duplicateProfile(id: string): Promise<{ root: SettingsRoot; profile: ServerProfile | null }> {
  const root = await getSettingsRoot();
  const source = root.profiles.find((p) => p.id === id);
  if (!source) return { root, profile: null };
  const profile: ServerProfile = {
    ...source,
    favoriteFolders: source.favoriteFolders.map((folder) => ({ ...folder })),
    id: newProfileId(),
    name: `${source.name} (copie)`,
  };
  const next = await writeRoot({ ...root, profiles: [...root.profiles, profile] });
  return { root: next, profile };
}

/** Applique un patch à un profil donné (renommage inclus). Identifiant inconnu : no-op. */
export async function updateProfile(id: string, patch: Partial<ServerProfile>): Promise<SettingsRoot> {
  const root = await getSettingsRoot();
  return updateProfileIn(root, id, patch);
}

async function updateProfileIn(root: SettingsRoot, id: string, patch: Partial<ServerProfile>): Promise<SettingsRoot> {
  if (!root.profiles.some((p) => p.id === id)) return root;
  const profiles = root.profiles.map((profile) => {
    if (profile.id !== id) return profile;
    const merged = { ...profile, ...patch, id: profile.id };
    // Un nom vide rendrait le profil invisible dans le sélecteur : on garde l'ancien.
    return { ...merged, name: merged.name.trim().length > 0 ? merged.name : profile.name };
  });
  return writeRoot({ ...root, profiles });
}

/**
 * Supprime un profil. Le dernier profil n'est jamais supprimable (l'extension resterait sans
 * aucune configuration) ; supprimer l'actif bascule sur le premier profil restant.
 */
export async function deleteProfile(id: string): Promise<SettingsRoot> {
  const root = await getSettingsRoot();
  if (root.profiles.length <= 1 || !root.profiles.some((p) => p.id === id)) return root;
  const profiles = root.profiles.filter((p) => p.id !== id);
  const first = profiles[0] as ServerProfile;
  const activeProfileId = root.activeProfileId === id ? first.id : root.activeProfileId;
  return writeRoot({ version: 2, profiles, activeProfileId });
}

function newProfileId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Observation des changements (popup et options ouvertes en même temps)
// ---------------------------------------------------------------------------

/**
 * Notifie à chaque écriture de la clé `settings` par un autre contexte, avec la racine déjà
 * normalisée. Retourne la fonction de désinscription.
 */
export function watchSettingsRoot(onChange: (root: SettingsRoot) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>) => {
    const change = changes[SETTINGS_KEY];
    if (!change) return;
    onChange(normalizeRoot(change.newValue));
  };
  browser.storage.local.onChanged.addListener(listener);
  return () => browser.storage.local.onChanged.removeListener(listener);
}

/**
 * Vrai si le **serveur** effectivement utilisé change (URL ou mot de passe du profil actif).
 * Le background s'en sert pour ne vider son cache de règles apprises que quand c'est utile :
 * ni l'écriture de migration, ni un ajout de favori, ni un renommage ne doivent le déclencher.
 */
export function hasActiveServerChanged(oldValue: unknown, newValue: unknown): boolean {
  const before = findActive(normalizeRoot(oldValue));
  const after = findActive(normalizeRoot(newValue));
  return before.serverUrl !== after.serverUrl || before.password !== after.password;
}
