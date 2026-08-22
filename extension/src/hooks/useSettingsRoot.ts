/**
 * Charge les profils de serveur et reste synchronisé avec les autres contextes de l'extension :
 * popup et page d'options peuvent être ouvertes en même temps, une écriture d'un côté doit se
 * voir de l'autre — d'où l'abonnement à `storage.local.onChanged` en plus du chargement initial.
 */

import { useEffect, useState } from 'react';
import { getSettingsRoot, watchSettingsRoot } from '@/src/lib/profiles';
import type { ServerProfile, SettingsRoot } from '@/src/lib/types';

export interface UseSettingsRootResult {
  root: SettingsRoot | null;
  activeProfile: ServerProfile | null;
  loading: boolean;
  /** Applique une racine déjà persistée (retour d'un CRUD) sans attendre l'événement storage. */
  applyRoot: (root: SettingsRoot) => void;
}

export function useSettingsRoot(): UseSettingsRootResult {
  const [root, setRoot] = useState<SettingsRoot | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void getSettingsRoot().then((loaded) => {
      if (cancelled) return;
      setRoot(loaded);
      setLoading(false);
    });
    // Le watcher ne fait que du `setState` : aucune écriture, donc aucune boucle.
    const unwatch = watchSettingsRoot((next) => {
      if (!cancelled) setRoot(next);
    });
    return () => {
      cancelled = true;
      unwatch();
    };
  }, []);

  const activeProfile = root ? (root.profiles.find((p) => p.id === root.activeProfileId) ?? root.profiles[0] ?? null) : null;

  return { root, activeProfile, loading, applyRoot: setRoot };
}
