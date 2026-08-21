import { describe, expect, it } from 'vitest';
import { buildDefaultFilename, ensureExtension, sanitizeFilename } from './filename';

describe('sanitizeFilename', () => {
  it('retire les séparateurs de chemin', () => {
    expect(sanitizeFilename('a/b\\c')).toBe('a b c');
  });

  it("retire les tentatives de traversée de chemin ('..')", () => {
    // '..' -> '.' (collapse), '/' -> espace, puis les '.' isolés en bordure sont coupés.
    expect(sanitizeFilename('../../etc/passwd')).toBe('etc passwd');
  });

  it('retire les caractères interdits Windows/Unix', () => {
    expect(sanitizeFilename('a:b*c?d"e<f>g|h')).toBe('a b c d e f g h');
  });

  it('retire les caractères de contrôle', () => {
    expect(sanitizeFilename('titre\x00avec\x1fcontrole')).toBe('titre avec controle');
  });

  it('réduit les espaces multiples et coupe les bords', () => {
    expect(sanitizeFilename('   plein   d espaces   ')).toBe('plein d espaces');
  });

  it('coupe les points en bordure', () => {
    expect(sanitizeFilename('...titre...')).toBe('titre');
  });

  it('tronque les noms trop longs', () => {
    const long = 'x'.repeat(300);
    const result = sanitizeFilename(long);
    expect(result.length).toBeLessThanOrEqual(150);
  });

  it('retombe sur "video" pour une chaîne vide', () => {
    expect(sanitizeFilename('')).toBe('video');
  });

  it('retombe sur "video" pour une chaîne composée uniquement de caractères interdits', () => {
    expect(sanitizeFilename('///\\\\***')).toBe('video');
  });

  it('conserve un titre normal inchangé', () => {
    expect(sanitizeFilename('Ma Super Vidéo 2026')).toBe('Ma Super Vidéo 2026');
  });
});

describe('ensureExtension', () => {
  it("ajoute l'extension si absente", () => {
    expect(ensureExtension('mon-fichier', 'mp4')).toBe('mon-fichier.mp4');
  });

  it("n'ajoute pas l'extension si déjà présente", () => {
    expect(ensureExtension('mon-fichier.mp4', 'mp4')).toBe('mon-fichier.mp4');
  });

  it('est insensible à la casse', () => {
    expect(ensureExtension('mon-fichier.MP4', 'mp4')).toBe('mon-fichier.MP4');
  });

  it("accepte une extension préfixée d'un point", () => {
    expect(ensureExtension('mon-fichier', '.mkv')).toBe('mon-fichier.mkv');
  });

  it('ne modifie rien sans extension fournie', () => {
    expect(ensureExtension('mon-fichier', undefined)).toBe('mon-fichier');
    expect(ensureExtension('mon-fichier', null)).toBe('mon-fichier');
    expect(ensureExtension('mon-fichier', '')).toBe('mon-fichier');
  });
});

describe('buildDefaultFilename', () => {
  it('privilégie le titre vidéo sur le titre de page', () => {
    expect(buildDefaultFilename({ videoTitle: 'Titre vidéo', pageTitle: 'Titre page', ext: 'mp4' })).toBe(
      'Titre vidéo.mp4',
    );
  });

  it("retombe sur le titre de page si aucun titre vidéo n'est fourni", () => {
    expect(buildDefaultFilename({ videoTitle: null, pageTitle: 'Titre page', ext: 'mp4' })).toBe('Titre page.mp4');
  });

  it('sanitize les caractères interdits présents dans le titre', () => {
    expect(buildDefaultFilename({ videoTitle: 'Saison 1/Épisode 2', ext: 'mp4' })).toBe('Saison 1 Épisode 2.mp4');
  });

  it('retombe sur "video" quand tous les titres sont vides', () => {
    expect(buildDefaultFilename({ videoTitle: '', pageTitle: '   ', ext: 'mp4' })).toBe('video.mp4');
  });

  it("fonctionne sans extension fournie", () => {
    expect(buildDefaultFilename({ videoTitle: 'Titre' })).toBe('Titre');
  });
});
