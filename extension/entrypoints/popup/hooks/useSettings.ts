/**
 * Charge les réglages de l'extension (`storage.local`) au montage de la popup.
 */

import { useEffect, useState } from 'react';
import { getSettings, isServerConfigured } from '@/src/lib/storage';
import type { ExtensionSettings } from '@/src/lib/types';

export interface UseSettingsResult {
  settings: ExtensionSettings | null;
  loading: boolean;
  configured: boolean;
}

export function useSettings(): UseSettingsResult {
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

  return { settings, loading, configured: settings ? isServerConfigured(settings) : false };
}
