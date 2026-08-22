import { describe, expect, it } from 'vitest';
import { chooseVideoTitle, isPlausibleTitle, normalizeTitle, type TitleCandidate } from './videoTitle';

describe('normalizeTitle', () => {
  it('réduit les blancs des textes DOM multilignes', () => {
    expect(normalizeTitle('  Mon\n  super   titre \t')).toBe('Mon super titre');
  });

  it('tronque un texte trop long', () => {
    expect(normalizeTitle('a'.repeat(500))).toHaveLength(200);
  });
});

describe('isPlausibleTitle', () => {
  it('accepte un vrai titre', () => {
    expect(isPlausibleTitle('Concert live au Zénith')).toBe(true);
  });

  it('rejette un texte trop court', () => {
    expect(isPlausibleTitle('ok')).toBe(false);
    expect(isPlausibleTitle('   ')).toBe(false);
  });

  it('rejette une durée ou un horodatage', () => {
    expect(isPlausibleTitle('0:42')).toBe(false);
    expect(isPlausibleTitle('1:02:03')).toBe(false);
    expect(isPlausibleTitle('12.5')).toBe(false);
  });

  it('rejette les libellés de contrôles de lecteur, FR et EN, sans tenir compte de la casse', () => {
    expect(isPlausibleTitle('Lecture')).toBe(false);
    expect(isPlausibleTitle('PLAY')).toBe(false);
    expect(isPlausibleTitle('plein écran')).toBe(false);
    expect(isPlausibleTitle('Publicité')).toBe(false);
  });
});

describe('chooseVideoTitle', () => {
  const candidate = (text: string, depth: number, rank: number): TitleCandidate => ({ text, depth, rank });

  it('préfère le candidat le plus proche de la vidéo', () => {
    const chosen = chooseVideoTitle(
      [candidate('Titre de la page entière', 6, 0), candidate('Titre de cette vidéo', 2, 3)],
      'Titre de page',
    );
    expect(chosen).toBe('Titre de cette vidéo');
  });

  it('départage deux candidats à distance égale par la fiabilité de la source', () => {
    const chosen = chooseVideoTitle([candidate('Un intertitre', 3, 4), candidate('Libellé explicite', 3, 0)], 'Page');
    expect(chosen).toBe('Libellé explicite');
  });

  it('saute les candidats implausibles même s’ils sont les plus proches', () => {
    const chosen = chooseVideoTitle([candidate('Lecture', 0, 0), candidate('0:42', 1, 0), candidate('Le vrai titre', 4, 3)], 'Page');
    expect(chosen).toBe('Le vrai titre');
  });

  it('retombe sur le titre de page quand la vidéo n’a aucun texte autour d’elle', () => {
    expect(chooseVideoTitle([], '  Titre de page  ')).toBe('Titre de page');
    expect(chooseVideoTitle([candidate('Play', 0, 0)], 'Titre de page')).toBe('Titre de page');
  });

  it('normalise le titre retenu', () => {
    expect(chooseVideoTitle([candidate('  Titre\n avec   blancs ', 1, 0)], 'Page')).toBe('Titre avec blancs');
  });
});
