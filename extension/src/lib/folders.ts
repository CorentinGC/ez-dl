/**
 * Logique pure de navigation/sélection sur l'arborescence renvoyée par `GET /api/folders`,
 * extraite du hook React `useFolderBrowser` (src/hooks/useFolderBrowser.ts) pour rester testable
 * sans moteur de rendu — voir folders.test.ts.
 */

import type { FolderEntry, FoldersResponse } from './types';

/** Sous-dossiers naviguables d'un listing : les fichiers ne sont jamais des destinations. */
export function listSubfolders(entries: FolderEntry[]): FolderEntry[] {
  return entries.filter((entry) => entry.is_dir);
}

/**
 * Cible de navigation pour le bouton "dossier parent" : `undefined` si aucun dossier n'est ouvert,
 * ou si on est au premier niveau d'une racine (le serveur renvoie alors `parent: null` — il n'y a
 * pas de parent *autorisé*, distinct de "revenir à la liste des racines").
 */
export function parentNavigationTarget(folders: FoldersResponse | null): string | undefined {
  if (!folders?.current) return undefined;
  return folders.parent ?? undefined;
}

/** Vrai si un raccourci "dossier parent" doit être affiché (on est dans un dossier avec parent connu). */
export function hasParentNavigation(folders: FoldersResponse | null): boolean {
  return Boolean(folders?.current) && folders?.parent !== null;
}

/**
 * Chemin à utiliser comme `parent` pour créer un sous-dossier, ou `null` si on est à la racine
 * (liste des racines) — la création n'y est pas possible, il faut d'abord entrer dans une racine.
 */
export function creationParentPath(folders: FoldersResponse | null): string | null {
  return folders?.current?.path ?? null;
}
