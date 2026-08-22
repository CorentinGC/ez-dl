/**
 * Gestion des profils de serveur côté options : liste, profil en cours d'édition, CRUD.
 *
 * Le profil **édité** n'est pas forcément le profil **actif** : on doit pouvoir configurer un
 * nouveau serveur de bout en bout (URL, test, favoris, preset) sans que la popup bascule dessus.
 * Chaque modification est persistée au fil de l'eau (pas de bouton « Enregistrer » global).
 */

import { useCallback, useState } from 'react';
import {
  deleteProfile,
  duplicateProfile,
  setActiveProfile,
  updateProfile as persistProfile,
} from '@/src/lib/profiles';
import { useSettingsRoot } from '@/src/hooks/useSettingsRoot';
import type { ExtensionSettings, ServerProfile } from '@/src/lib/types';

export interface UseProfilesFormResult {
  profiles: ServerProfile[];
  activeProfileId: string | null;
  /** Profil affiché par les sections de réglages (repli sur l'actif s'il vient d'être supprimé). */
  selected: ServerProfile | null;
  loading: boolean;
  select: (id: string) => void;
  /** Patch du profil sélectionné — signature attendue par les sections existantes. */
  update: (patch: Partial<ExtensionSettings>) => Promise<ExtensionSettings>;
  rename: (id: string, name: string) => Promise<void>;
  activate: (id: string) => Promise<void>;
  duplicate: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export function useProfilesForm(): UseProfilesFormResult {
  const { root, activeProfile, loading, applyRoot } = useSettingsRoot();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const profiles = root?.profiles ?? [];
  // Un profil supprimé depuis une autre fenêtre d'options ne doit pas vider la page.
  const selected = profiles.find((p) => p.id === selectedId) ?? activeProfile;

  const update = useCallback(
    async (patch: Partial<ExtensionSettings>): Promise<ExtensionSettings> => {
      if (!selected) throw new Error('Aucun profil sélectionné.');
      const next = await persistProfile(selected.id, patch);
      applyRoot(next);
      return next.profiles.find((p) => p.id === selected.id) ?? { ...selected, ...patch };
    },
    [applyRoot, selected],
  );

  const rename = useCallback(
    async (id: string, name: string) => {
      applyRoot(await persistProfile(id, { name }));
    },
    [applyRoot],
  );

  const activate = useCallback(
    async (id: string) => {
      applyRoot(await setActiveProfile(id));
    },
    [applyRoot],
  );

  const duplicate = useCallback(
    async (id: string) => {
      const { root: next, profile } = await duplicateProfile(id);
      applyRoot(next);
      if (profile) setSelectedId(profile.id);
    },
    [applyRoot],
  );

  const remove = useCallback(
    async (id: string) => {
      const next = await deleteProfile(id);
      applyRoot(next);
      if (selectedId === id) setSelectedId(null);
    },
    [applyRoot, selectedId],
  );

  return {
    profiles,
    activeProfileId: root?.activeProfileId ?? null,
    selected,
    loading,
    select: setSelectedId,
    update,
    rename,
    activate,
    duplicate,
    remove,
  };
}
