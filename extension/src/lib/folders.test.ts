import { describe, expect, it } from 'vitest';
import { buildBreadcrumb, creationParentPath, listSubfolders } from './folders';
import type { FoldersResponse } from './types';

const ROOTS_VIEW: FoldersResponse = {
  roots: [{ label: 'Films', path: '/data/films', is_available: true, free_bytes: 1000, total_bytes: 2000 }],
  current: null,
  entries: [],
  parent: null,
};

const TOP_OF_ROOT: FoldersResponse = {
  roots: ROOTS_VIEW.roots,
  current: { path: '/data/films', label: 'Films', free_bytes: 1000, total_bytes: 2000 },
  entries: [
    { name: 'Action', path: '/data/films/Action', is_dir: true },
    { name: 'poster.jpg', path: '/data/films/poster.jpg', is_dir: false },
  ],
  parent: null,
};

// Le serveur renvoie ici `label: 'Films'` (le label de la RACINE) pour un dossier imbriqué :
// le fil d'Ariane doit donc dériver ses libellés du chemin, pas de `current.label`.
const NESTED_FOLDER: FoldersResponse = {
  roots: ROOTS_VIEW.roots,
  current: { path: '/data/films/Action/2024', label: 'Films', free_bytes: 1000, total_bytes: 2000 },
  entries: [],
  parent: '/data/films/Action',
};

describe('listSubfolders', () => {
  it('ne garde que les entrées is_dir : les fichiers ne sont pas des destinations', () => {
    expect(listSubfolders(TOP_OF_ROOT.entries)).toEqual([{ name: 'Action', path: '/data/films/Action', is_dir: true }]);
  });

  it('retourne un tableau vide sans entrée', () => {
    expect(listSubfolders([])).toEqual([]);
  });
});

describe('buildBreadcrumb', () => {
  it('ne produit rien tant qu\'aucun listing n\'est chargé', () => {
    expect(buildBreadcrumb(null)).toEqual([]);
  });

  it('affiche le seul segment « Racines » sur la liste des racines', () => {
    expect(buildBreadcrumb(ROOTS_VIEW)).toEqual([{ label: 'Racines', path: null }]);
  });

  it('ajoute la racine ouverte, avec son libellé serveur', () => {
    expect(buildBreadcrumb(TOP_OF_ROOT)).toEqual([
      { label: 'Racines', path: null },
      { label: 'Films', path: '/data/films' },
    ]);
  });

  it('cumule les chemins des sous-dossiers et ignore current.label', () => {
    expect(buildBreadcrumb(NESTED_FOLDER)).toEqual([
      { label: 'Racines', path: null },
      { label: 'Films', path: '/data/films' },
      { label: 'Action', path: '/data/films/Action' },
      { label: '2024', path: '/data/films/Action/2024' },
    ]);
  });

  it('s\'ancre sur la première racine qui contient le dossier courant', () => {
    const nestedRoots: FoldersResponse = {
      ...NESTED_FOLDER,
      roots: [
        { label: 'Données', path: '/data', is_available: true, free_bytes: null, total_bytes: null },
        { label: 'Films', path: '/data/films', is_available: true, free_bytes: null, total_bytes: null },
      ],
      current: { path: '/data/films/Action', label: 'Données', free_bytes: null, total_bytes: null },
    };
    expect(buildBreadcrumb(nestedRoots)).toEqual([
      { label: 'Racines', path: null },
      { label: 'Données', path: '/data' },
      { label: 'films', path: '/data/films' },
      { label: 'Action', path: '/data/films/Action' },
    ]);
  });

  it('n\'insère pas de double slash sous une racine « / »', () => {
    const slashRoot: FoldersResponse = {
      roots: [{ label: 'Disque', path: '/', is_available: true, free_bytes: null, total_bytes: null }],
      current: { path: '/downloads', label: 'Disque', free_bytes: null, total_bytes: null },
      entries: [],
      parent: '/',
    };
    expect(buildBreadcrumb(slashRoot)).toEqual([
      { label: 'Racines', path: null },
      { label: 'Disque', path: '/' },
      { label: 'downloads', path: '/downloads' },
    ]);
  });

  it('n\'invente aucun segment pour un dossier hors des racines connues', () => {
    const orphan: FoldersResponse = {
      ...NESTED_FOLDER,
      current: { path: '/ailleurs/videos', label: 'Ailleurs', free_bytes: null, total_bytes: null },
    };
    expect(buildBreadcrumb(orphan)).toEqual([
      { label: 'Racines', path: null },
      { label: 'Ailleurs', path: '/ailleurs/videos' },
    ]);
  });
});

describe('creationParentPath', () => {
  it('retourne null depuis la liste des racines (création impossible)', () => {
    expect(creationParentPath(null)).toBeNull();
    expect(creationParentPath(ROOTS_VIEW)).toBeNull();
  });

  it('retourne le chemin du dossier courant une fois entré dans une racine', () => {
    expect(creationParentPath(TOP_OF_ROOT)).toBe('/data/films');
    expect(creationParentPath(NESTED_FOLDER)).toBe('/data/films/Action/2024');
  });
});
