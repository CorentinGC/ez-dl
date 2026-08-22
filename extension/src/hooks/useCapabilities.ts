/**
 * Charge les capacités serveur (`GET /api/capabilities`) : presets de conversion disponibles.
 * Partagé entre la popup (sélecteur de preset par téléchargement) et les options (preset par
 * défaut).
 */

import { useEffect, useState } from 'react';
import { createApiClient, toApiConfig } from '@/src/lib/api';
import { isServerConfigured } from '@/src/lib/storage';
import type { ExtensionSettings, Preset } from '@/src/lib/types';

export function useCapabilities(settings: ExtensionSettings | null): { presets: Preset[]; loading: boolean } {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Les presets dépendent du ffmpeg du serveur : ceux du serveur précédent n'ont plus cours.
    setPresets([]);
    if (!settings || !isServerConfigured(settings)) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    createApiClient(toApiConfig(settings))
      .getCapabilities()
      .then((capabilities) => {
        if (!cancelled) setPresets(capabilities.presets);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [settings]);

  return { presets, loading };
}
