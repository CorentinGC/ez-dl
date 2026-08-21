import { describe, expect, it } from 'vitest';
import { formatEta, formatFreeSpace, formatProgress, formatSize, formatSpeed } from './format';

describe('formatSize', () => {
  it('retourne "—" pour null/undefined', () => {
    expect(formatSize(null)).toBe('—');
    expect(formatSize(undefined)).toBe('—');
  });

  it('retourne "—" pour une valeur négative ou non finie', () => {
    expect(formatSize(-1)).toBe('—');
    expect(formatSize(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatSize(Number.NaN)).toBe('—');
  });

  it('formate 0 octet', () => {
    expect(formatSize(0)).toBe('0 o');
  });

  it('formate des octets bruts sans décimale', () => {
    expect(formatSize(512)).toBe('512 o');
  });

  it('formate en Ko avec une décimale à virgule sous 10', () => {
    expect(formatSize(1536)).toBe('1,5 Ko');
  });

  it('formate en Mo avec une décimale à virgule sous 10', () => {
    expect(formatSize(Math.round(4.2 * 1024 * 1024))).toBe('4,2 Mo');
  });

  it('arrondit à l\'entier au-delà de 10 dans une unité', () => {
    expect(formatSize(12 * 1024 * 1024)).toBe('12 Mo');
  });

  it('monte jusqu\'au Go/To pour de grandes tailles', () => {
    expect(formatSize(2 * 1024 ** 3)).toBe('2,0 Go');
    expect(formatSize(5 * 1024 ** 4)).toBe('5,0 To');
  });
});

describe('formatSpeed', () => {
  it('retourne "—" pour null/undefined/négatif', () => {
    expect(formatSpeed(null)).toBe('—');
    expect(formatSpeed(undefined)).toBe('—');
    expect(formatSpeed(-10)).toBe('—');
  });

  it('formate une vitesse en octets/s avec le suffixe /s', () => {
    expect(formatSpeed(Math.round(1.2 * 1024 * 1024))).toBe('1,2 Mo/s');
  });

  it('formate une petite vitesse en Ko/s', () => {
    expect(formatSpeed(2048)).toBe('2,0 Ko/s');
  });
});

describe('formatEta', () => {
  it('retourne "—" pour null/undefined/négatif', () => {
    expect(formatEta(null)).toBe('—');
    expect(formatEta(undefined)).toBe('—');
    expect(formatEta(-1)).toBe('—');
  });

  it('formate 0 seconde', () => {
    expect(formatEta(0)).toBe('0:00');
  });

  it('formate en mm:ss sous l\'heure', () => {
    expect(formatEta(42)).toBe('0:42');
    expect(formatEta(90)).toBe('1:30');
  });

  it('formate en h:mm:ss au-delà de l\'heure', () => {
    expect(formatEta(3661)).toBe('1:01:01');
  });

  it('arrondit les secondes fractionnaires', () => {
    expect(formatEta(41.6)).toBe('0:42');
  });
});

describe('formatFreeSpace', () => {
  it('retourne un message explicite si free_bytes ou total_bytes est null/undefined', () => {
    expect(formatFreeSpace(null, 1000)).toBe('Espace disque inconnu');
    expect(formatFreeSpace(1000, null)).toBe('Espace disque inconnu');
    expect(formatFreeSpace(undefined, undefined)).toBe('Espace disque inconnu');
  });

  it('formate "X libres sur Y" avec les unités de formatSize', () => {
    const free = Math.round(4.2 * 1024 ** 3);
    const total = Math.round(1.8 * 1024 ** 4);
    expect(formatFreeSpace(free, total)).toBe('4,2 Go libres sur 1,8 To');
  });

  it('gère un dossier plein (0 octet libre)', () => {
    expect(formatFreeSpace(0, 1024 ** 3)).toBe('0 o libres sur 1,0 Go');
  });
});

describe('formatProgress', () => {
  it('retourne "—" pour null/undefined', () => {
    expect(formatProgress(null)).toBe('—');
    expect(formatProgress(undefined)).toBe('—');
  });

  it('formate un pourcentage 0.0–100.0 en entier arrondi', () => {
    expect(formatProgress(42)).toBe('42%');
    expect(formatProgress(42.6)).toBe('43%');
  });

  it('borne les valeurs hors intervalle [0, 100]', () => {
    expect(formatProgress(-10)).toBe('0%');
    expect(formatProgress(150)).toBe('100%');
  });
});
