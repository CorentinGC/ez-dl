import { describe, expect, it } from 'vitest';
import { creationParentPath, hasParentNavigation, listSubfolders, parentNavigationTarget } from './folders';
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

const NESTED_FOLDER: FoldersResponse = {
  roots: ROOTS_VIEW.roots,
  current: { path: '/data/films/Action', label: 'Action', free_bytes: 1000, total_bytes: 2000 },
  entries: [],
  parent: '/data/films',
};

describe('listSubfolders', () => {
  it('ne garde que les entrées is_dir : les fichiers ne sont pas des destinations', () => {
    expect(listSubfolders(TOP_OF_ROOT.entries)).toEqual([{ name: 'Action', path: '/data/films/Action', is_dir: true }]);
  });

  it('retourne un tableau vide sans entrée', () => {
    expect(listSubfolders([])).toEqual([]);
  });
});

describe('parentNavigationTarget', () => {
  it('retourne undefined si aucun dossier courant (liste des racines) ou folders absent', () => {
    expect(parentNavigationTarget(null)).toBeUndefined();
    expect(parentNavigationTarget(ROOTS_VIEW)).toBeUndefined();
  });

  it('retourne undefined au premier niveau d\'une racine (parent serveur = null)', () => {
    expect(parentNavigationTarget(TOP_OF_ROOT)).toBeUndefined();
  });

  it('retourne le chemin parent renvoyé par le serveur pour un dossier imbriqué', () => {
    expect(parentNavigationTarget(NESTED_FOLDER)).toBe('/data/films');
  });
});

describe('hasParentNavigation', () => {
  it('est faux sans dossier courant', () => {
    expect(hasParentNavigation(null)).toBe(false);
    expect(hasParentNavigation(ROOTS_VIEW)).toBe(false);
  });

  it('est faux au premier niveau d\'une racine (pas de parent autorisé)', () => {
    expect(hasParentNavigation(TOP_OF_ROOT)).toBe(false);
  });

  it('est vrai pour un dossier imbriqué avec parent connu', () => {
    expect(hasParentNavigation(NESTED_FOLDER)).toBe(true);
  });
});

describe('creationParentPath', () => {
  it('retourne null depuis la liste des racines (création impossible)', () => {
    expect(creationParentPath(null)).toBeNull();
    expect(creationParentPath(ROOTS_VIEW)).toBeNull();
  });

  it('retourne le chemin du dossier courant une fois entré dans une racine', () => {
    expect(creationParentPath(TOP_OF_ROOT)).toBe('/data/films');
    expect(creationParentPath(NESTED_FOLDER)).toBe('/data/films/Action');
  });
});
