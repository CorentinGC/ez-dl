/**
 * Charge les réglages et expose une fonction de mise à jour partielle qui persiste
 * immédiatement dans `storage.local` (pas de bouton "Enregistrer" global : chaque section
 * sauvegarde ses propres champs au fil de l'eau).
 */

import { useCallback, useEffect, useState } from 'react';
import { getSettings, saveSettings } from '@/src/lib/storage';
import type { ExtensionSettings } from '@/src/lib/types';

export interface UseSettingsFormResult {
  settings: ExtensionSettings | null;
  loading: boolean;
  update: (patch: Partial<ExtensionSettings>) => Promise<ExtensionSettings>;
}

export function useSettingsForm(): UseSettingsFormResult {
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void getSettings().then((loaded) => {
      if (cancelled) return;
      setSettings(loaded);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback(async (patch: Partial<ExtensionSettings>) => {
    const next = await saveSettings(patch);
    setSettings(next);
    return next;
  }, []);

  return { settings, loading, update };
}
