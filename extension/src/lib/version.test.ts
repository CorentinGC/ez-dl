import { describe, expect, it } from 'vitest';
import { isNewerVersion } from './version';

describe('isNewerVersion', () => {
  it('détecte une version publiée plus récente', () => {
    expect(isNewerVersion('0.1.0', '0.0.0')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true);
    expect(isNewerVersion('0.2.1', '0.2.0')).toBe(true);
  });

  it('est faux à version identique ou plus ancienne', () => {
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.1.0', '0.2.0')).toBe(false);
    expect(isNewerVersion('1.0.0', '10.0.0')).toBe(false);
  });

  it('compare les segments numériquement, pas alphabétiquement', () => {
    expect(isNewerVersion('0.10.0', '0.9.0')).toBe(true);
    expect(isNewerVersion('0.9.0', '0.10.0')).toBe(false);
  });

  it('traite les segments absents comme des zéros', () => {
    expect(isNewerVersion('1.2', '1.2.0')).toBe(false);
    expect(isNewerVersion('1.2.0.0', '1.2')).toBe(false);
    expect(isNewerVersion('1.2.1', '1.2')).toBe(true);
  });

  it('supporte les 4 segments autorisés par Chrome', () => {
    expect(isNewerVersion('1.0.0.1', '1.0.0.0')).toBe(true);
  });

  it('refuse toute version illisible plutôt que d\'annoncer une mise à jour', () => {
    expect(isNewerVersion('', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.1.0', '')).toBe(false);
    expect(isNewerVersion('next', '0.1.0')).toBe(false);
    expect(isNewerVersion('1.0.0-beta', '0.1.0')).toBe(false);
    expect(isNewerVersion('-1.0.0', '0.1.0')).toBe(false);
  });
});
