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

/** Segment de fil d'Ariane. `path: null` = retour à la liste des racines (`open(undefined)`). */
export interface BreadcrumbSegment {
  label: string;
  path: string | null;
}

const ROOTS_LABEL = 'Racines';

/**
 * Fil d'Ariane du dossier courant : `Racines › <racine> › <sous-dossier> › …`.
 *
 * Les libellés intermédiaires sont dérivés du **chemin**, jamais de `current.label` : pour un
 * dossier imbriqué, le serveur renvoie le label de la *racine* dans `current.label`
 * (`server/app/api/folders.py`), ce qui afficherait « Films » à tous les niveaux.
 */
export function buildBreadcrumb(folders: FoldersResponse | null): BreadcrumbSegment[] {
  if (!folders) return [];
  const rootsSegment: BreadcrumbSegment = { label: ROOTS_LABEL, path: null };
  const current = folders.current;
  if (!current) return [rootsSegment];

  const root = folders.roots.find((candidate) => isWithinRoot(current.path, candidate.path));
  // Dossier hors des racines connues : aucun chemin intermédiaire n'est inventé, le serveur
  // refuserait (400) tout chemin situé au-dessus d'une racine autorisée.
  if (!root) return [rootsSegment, { label: current.label, path: current.path }];

  const segments: BreadcrumbSegment[] = [rootsSegment, { label: root.label, path: root.path }];
  // Racine « / » : le préfixe cumulé part vide, sinon chaque segment produirait un `//`.
  let cumulated = root.path === '/' ? '' : root.path;
  for (const name of relativeSegments(current.path, root.path)) {
    cumulated = `${cumulated}/${name}`;
    segments.push({ label: name, path: cumulated });
  }
  return segments;
}

function isWithinRoot(path: string, rootPath: string): boolean {
  return path === rootPath || path.startsWith(rootPath === '/' ? '/' : `${rootPath}/`);
}

function relativeSegments(path: string, rootPath: string): string[] {
  if (path === rootPath) return [];
  const prefixLength = rootPath === '/' ? 1 : rootPath.length + 1;
  return path.slice(prefixLength).split('/').filter(Boolean);
}

/**
 * Chemin à utiliser comme `parent` pour créer un sous-dossier, ou `null` si on est à la racine
 * (liste des racines) — la création n'y est pas possible, il faut d'abord entrer dans une racine.
 */
export function creationParentPath(folders: FoldersResponse | null): string | null {
  return folders?.current?.path ?? null;
}
