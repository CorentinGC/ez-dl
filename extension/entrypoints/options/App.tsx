/**
 * Page d'options : serveurs enregistrés, puis configuration du serveur sélectionné (adresse,
 * dossiers favoris, preset par défaut, cookies) et gestion des règles de site apprises.
 */

import { useMemo } from 'react';
import { createApiClient, toApiConfig } from '@/src/lib/api';
import { useCapabilities } from '@/src/hooks/useCapabilities';
import { isServerConfigured } from '@/src/lib/storage';
import { CookiesSection } from './components/CookiesSection';
import { FoldersSection } from './components/FoldersSection';
import { PresetSection } from './components/PresetSection';
import { ProfilesSection } from './components/ProfilesSection';
import { RulesSection } from './components/RulesSection';
import { ServerSection } from './components/ServerSection';
import { useProfilesForm } from './hooks/useProfilesForm';

export default function App() {
  const { profiles, activeProfileId, selected, loading, select, update, rename, activate, duplicate, remove } = useProfilesForm();
  const configured = selected ? isServerConfigured(selected) : false;
  const { presets, loading: presetsLoading } = useCapabilities(configured ? selected : null);
  const apiClient = useMemo(() => (selected && configured ? createApiClient(toApiConfig(selected)) : null), [selected, configured]);

  if (loading || !selected) {
    return (
      <main className="options-root">
        <p className="options-hint">Chargement…</p>
      </main>
    );
  }

  return (
    <main className="options-root">
      <h1>Réglages ez-dl</h1>

      <ProfilesSection
        profiles={profiles}
        activeProfileId={activeProfileId}
        selectedId={selected.id}
        onSelect={select}
        onRename={(id, name) => void rename(id, name)}
        onActivate={(id) => void activate(id)}
        onDuplicate={(id) => void duplicate(id)}
        onRemove={(id) => void remove(id)}
      />

      {/* `key` sur le profil sélectionné : changer de serveur remonte toutes les sections, ce qui
          purge d'un coup leurs états locaux (formulaire, navigation de dossiers, règles chargées)
          qui appartiennent au serveur précédent. */}
      <div key={selected.id}>
        <ServerSection profile={selected} onUpdate={update} />
        <FoldersSection settings={selected} apiClient={apiClient} onUpdate={update} />
        <PresetSection settings={selected} presets={presets} presetsLoading={presetsLoading} onUpdate={update} />
        <CookiesSection settings={selected} onUpdate={update} />
        <RulesSection apiClient={apiClient} />
      </div>
    </main>
  );
}
