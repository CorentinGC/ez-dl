/**
 * Réglages vus par la popup : le profil de serveur actif, la liste des profils disponibles
 * et la bascule de l'un à l'autre (la gestion complète — création, renommage, suppression —
 * reste dans la page d'options).
 */

import { useCallback } from 'react';
import { setActiveProfile } from '@/src/lib/profiles';
import { isServerConfigured } from '@/src/lib/storage';
import { useSettingsRoot } from '@/src/hooks/useSettingsRoot';
import type { ServerProfile } from '@/src/lib/types';

export interface UseSettingsResult {
  settings: ServerProfile | null;
  profiles: ServerProfile[];
  activeProfileId: string | null;
  loading: boolean;
  configured: boolean;
  selectProfile: (id: string) => Promise<void>;
}

export function useSettings(): UseSettingsResult {
  const { root, activeProfile, loading, applyRoot } = useSettingsRoot();

  const selectProfile = useCallback(
    async (id: string) => {
      applyRoot(await setActiveProfile(id));
    },
    [applyRoot],
  );

  return {
    settings: activeProfile,
    profiles: root?.profiles ?? [],
    activeProfileId: root?.activeProfileId ?? null,
    loading,
    configured: activeProfile ? isServerConfigured(activeProfile) : false,
    selectProfile,
  };
}
