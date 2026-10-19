/**
 * Sauvegarde des réglages dans un fichier JSON, et restauration.
 *
 * Une extension chargée « non empaquetée » sans clé de manifeste reçoit un identifiant dérivé du
 * chemin de son dossier : la supprimer, ou la recharger depuis un autre dossier, change cet
 * identifiant et Chrome repart d'un `storage.local` vide. L'export est le filet de sécurité
 * (ez-dl-vjr). Le fichier contient les mots de passe des serveurs **en clair**.
 */

import { getSettingsRoot, normalizeRoot, replaceSettingsRoot } from './profiles';
import { getUiPrefs, normalizeUiPrefs, saveUiPrefs, type UiPrefs } from './uiPrefs';
import type { SettingsRoot } from './types';

export const BACKUP_FORMAT = 'ez-dl-settings';
const BACKUP_VERSION = 1;

/** Garde-fou : un réglage ez-dl tient en quelques Ko, un fichier énorme n'est pas une sauvegarde. */
export const MAX_BACKUP_BYTES = 1024 * 1024;

export interface SettingsBackup {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  settings: SettingsRoot;
  uiPrefs: UiPrefs;
}

export function buildBackup(settings: SettingsRoot, uiPrefs: UiPrefs, now: Date = new Date()): SettingsBackup {
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: now.toISOString(), settings, uiPrefs };
}

/** Lit un fichier de sauvegarde ; lève une `Error` au message affichable s'il n'en est pas un. */
export function parseBackup(text: string): { settings: SettingsRoot; uiPrefs: UiPrefs } {
  if (text.length > MAX_BACKUP_BYTES) throw new Error('Fichier trop volumineux pour une sauvegarde ez-dl.');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Ce fichier n'est pas du JSON valide.");
  }
  if (typeof raw !== 'object' || raw === null || (raw as Record<string, unknown>).format !== BACKUP_FORMAT) {
    throw new Error("Ce fichier n'est pas une sauvegarde de réglages ez-dl.");
  }
  const backup = raw as Record<string, unknown>;
  if (typeof backup.version !== 'number' || backup.version > BACKUP_VERSION) {
    throw new Error('Sauvegarde produite par une version plus récente de l’extension.');
  }
  return { settings: normalizeRoot(backup.settings), uiPrefs: normalizeUiPrefs(backup.uiPrefs) };
}

export async function exportSettings(): Promise<string> {
  const backup = buildBackup(await getSettingsRoot(), await getUiPrefs());
  return JSON.stringify(backup, null, 2);
}

/** Remplace les réglages courants par ceux du fichier. Retourne le nombre de serveurs restaurés. */
export async function importSettings(text: string): Promise<number> {
  const { settings, uiPrefs } = parseBackup(text);
  await replaceSettingsRoot(settings);
  await saveUiPrefs(uiPrefs);
  return settings.profiles.length;
}
