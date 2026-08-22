/**
 * Racine de la popup : charge réglages/onglet actif, orchestre les vues Sources/Jobs.
 * Écran d'accueil dédié si le serveur n'est pas encore configuré (renvoie vers les options).
 */

import { useMemo, useState } from 'react';
import { createApiClient, toApiConfig } from '@/src/lib/api';
import { EmptyState } from './components/EmptyState';
import { Header, type PopupView } from './components/Header';
import { JobsView } from './components/JobsView';
import { ProfileSelect } from './components/ProfileSelect';
import { SourcesView } from './components/SourcesView';
import { UpdateBanner } from './components/UpdateBanner';
import { useCapabilities } from '@/src/hooks/useCapabilities';
import { useActiveTab } from './hooks/useActiveTab';
import { useExtensionUpdate } from './hooks/useExtensionUpdate';
import { useJobs } from './hooks/useJobs';
import { useSettings } from './hooks/useSettings';
import { useSources } from './hooks/useSources';

export default function App() {
  const { settings, profiles, activeProfileId, loading: settingsLoading, configured, selectProfile } = useSettings();
  const { tab, loading: tabLoading } = useActiveTab();
  const [view, setView] = useState<PopupView>('sources');

  const activeSettings = configured ? settings : null;
  const { presets } = useCapabilities(activeSettings);
  const { jobs, connectionMode, actionError, cancelJob, pauseJob, resumeJob } = useJobs(activeSettings);
  const sourcesState = useSources(activeSettings, tab);
  const update = useExtensionUpdate(activeSettings);
  const apiClient = useMemo(() => (settings ? createApiClient(toApiConfig(settings)) : null), [settings]);

  if (settingsLoading || tabLoading) {
    return (
      <div className="popup-root popup-root-centered">
        <p className="loading-hint" role="status">
          Chargement…
        </p>
      </div>
    );
  }

  if (!settings || !configured) {
    return (
      <div className="popup-root popup-root-centered">
        <span className="popup-brand popup-brand-standalone">ez-dl</span>
        {/* Sélecteur présent ici aussi : basculé sur un profil vide, il reste la seule porte
            de sortie vers un serveur déjà configuré. */}
        <ProfileSelect profiles={profiles} activeProfileId={activeProfileId} onSelect={(id) => void selectProfile(id)} />
        <EmptyState variant="not-configured" />
      </div>
    );
  }

  return (
    <div className="popup-root">
      <Header
        activeView={view}
        onChangeView={setView}
        sourceCount={sourcesState.sources.length}
        jobCount={jobs.length}
        profiles={profiles}
        activeProfileId={activeProfileId}
        onSelectProfile={(id) => void selectProfile(id)}
      />
      <UpdateBanner update={update} />
      <main className="popup-main">
        {view === 'sources' ? (
          tab && apiClient ? (
            <SourcesView
              settings={settings}
              tab={tab}
              apiClient={apiClient}
              presets={presets}
              sources={sourcesState.sources}
              loading={sourcesState.loading}
              error={sourcesState.error}
              pickedElement={sourcesState.pickedElement}
              onRefresh={sourcesState.refresh}
              onJobCreated={() => setView('jobs')}
            />
          ) : (
            <EmptyState variant="server-error" message="Impossible de déterminer l'onglet actif." />
          )
        ) : (
          <JobsView
            jobs={jobs}
            connectionMode={connectionMode}
            actionError={actionError}
            onCancel={(job, options) => void cancelJob(job, options)}
            onPause={(id) => void pauseJob(id)}
            onResume={(job) => void resumeJob(job)}
          />
        )}
      </main>
    </div>
  );
}
