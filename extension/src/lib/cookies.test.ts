import { describe, expect, it } from 'vitest';
import { formatNetscapeCookies } from './cookies';

describe('formatNetscapeCookies', () => {
  it('retourne uniquement le header pour une liste vide', () => {
    expect(formatNetscapeCookies([])).toBe('# Netscape HTTP Cookie File\n');
  });

  it('formate un cookie de domaine (non hostOnly) avec un point préfixe et includeSubdomains=TRUE', () => {
    const result = formatNetscapeCookies([
      { domain: 'example.com', path: '/', secure: true, expirationDate: 1999999999, name: 'sid', value: 'abc', hostOnly: false },
    ]);
    expect(result).toBe('# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tTRUE\t1999999999\tsid\tabc\n');
  });

  it('formate un cookie hostOnly sans point préfixe et includeSubdomains=FALSE', () => {
    const result = formatNetscapeCookies([
      { domain: 'example.com', path: '/', secure: false, name: 'sid', value: 'abc', hostOnly: true },
    ]);
    expect(result).toBe('# Netscape HTTP Cookie File\nexample.com\tFALSE\t/\tFALSE\t0\tsid\tabc\n');
  });

  it('gère plusieurs cookies sur des lignes distinctes', () => {
    const result = formatNetscapeCookies([
      { domain: 'example.com', path: '/', secure: false, name: 'a', value: '1', hostOnly: true },
      { domain: 'example.com', path: '/', secure: false, name: 'b', value: '2', hostOnly: true },
    ]);
    expect(result.split('\n')).toHaveLength(4); // header + 2 lignes + '' final
  });
});
