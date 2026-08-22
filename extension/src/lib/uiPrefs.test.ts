import { describe, expect, it } from 'vitest';
import { DEFAULT_UI_PREFS, normalizeUiPrefs } from './uiPrefs';

describe('normalizeUiPrefs', () => {
  it('active le bouton en overlay par défaut', () => {
    expect(DEFAULT_UI_PREFS.showPageOverlay).toBe(true);
    expect(normalizeUiPrefs(undefined)).toEqual(DEFAULT_UI_PREFS);
  });

  it('respecte une désactivation explicite', () => {
    expect(normalizeUiPrefs({ showPageOverlay: false })).toEqual({ showPageOverlay: false });
  });

  it('ignore une valeur du mauvais type et retombe sur le défaut', () => {
    expect(normalizeUiPrefs({ showPageOverlay: 'non' })).toEqual(DEFAULT_UI_PREFS);
    expect(normalizeUiPrefs([{ showPageOverlay: false }])).toEqual(DEFAULT_UI_PREFS);
    expect(normalizeUiPrefs('cassé')).toEqual(DEFAULT_UI_PREFS);
    expect(normalizeUiPrefs(null)).toEqual(DEFAULT_UI_PREFS);
  });

  it('ignore les clés inconnues (nettoyage du stockage)', () => {
    expect(normalizeUiPrefs({ showPageOverlay: false, legacy: 42 })).toEqual({ showPageOverlay: false });
  });
});
