/**
 * Préférences d'interface, indépendantes des profils serveur.
 *
 * Clé `uiPrefs` de `storage.local`, distincte de `settings` : l'affichage du bouton en overlay
 * est une préférence de l'utilisateur, pas une propriété d'un serveur ez-dl — la dupliquer dans
 * chaque profil obligerait à la rebasculer à chaque changement de serveur.
 */

export interface UiPrefs {
  /** Affiche un bouton de téléchargement ancré sur les vidéos de la page visitée. */
  showPageOverlay: boolean;
}

const UI_PREFS_KEY = 'uiPrefs';

export const DEFAULT_UI_PREFS: UiPrefs = {
  showPageOverlay: true,
};

/** Ramène n'importe quel contenu stocké (absent, partiel, corrompu) à des préférences valides. */
export function normalizeUiPrefs(stored: unknown): UiPrefs {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return { ...DEFAULT_UI_PREFS };
  const raw = stored as Record<string, unknown>;
  return {
    showPageOverlay:
      typeof raw.showPageOverlay === 'boolean' ? raw.showPageOverlay : DEFAULT_UI_PREFS.showPageOverlay,
  };
}

export async function getUiPrefs(): Promise<UiPrefs> {
  const stored = await browser.storage.local.get<Record<string, unknown>>(UI_PREFS_KEY);
  return normalizeUiPrefs(stored[UI_PREFS_KEY]);
}

/** Fusionne un patch partiel dans les préférences et les persiste. */
export async function saveUiPrefs(patch: Partial<UiPrefs>): Promise<UiPrefs> {
  const next = { ...(await getUiPrefs()), ...patch };
  await browser.storage.local.set({ [UI_PREFS_KEY]: next });
  return next;
}

/**
 * Notifie à chaque écriture de la clé `uiPrefs` par un autre contexte (page options ouverte
 * pendant qu'un content script tourne). Retourne la fonction de désinscription.
 */
export function watchUiPrefs(onChange: (prefs: UiPrefs) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>) => {
    const change = changes[UI_PREFS_KEY];
    if (!change) return;
    onChange(normalizeUiPrefs(change.newValue));
  };
  browser.storage.local.onChanged.addListener(listener);
  return () => browser.storage.local.onChanged.removeListener(listener);
}
