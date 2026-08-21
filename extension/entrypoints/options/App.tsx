/**
 * Page d'options : configuration du serveur, dossiers favoris, preset par défaut, cookies,
 * et gestion des règles de site apprises.
 */

import { useMemo } from 'react';
import { createApiClient, toApiConfig } from '@/src/lib/api';
import { useCapabilities } from '@/src/hooks/useCapabilities';
import { isServerConfigured } from '@/src/lib/storage';
import { CookiesSection } from './components/CookiesSection';
import { FoldersSection } from './components/FoldersSection';
import { PresetSection } from './components/PresetSection';
import { RulesSection } from './components/RulesSection';
import { ServerSection } from './components/ServerSection';
import { useSettingsForm } from './hooks/useSettingsForm';

export default function App() {
  const { settings, loading, update } = useSettingsForm();
  const configured = settings ? isServerConfigured(settings) : false;
  const { presets, loading: presetsLoading } = useCapabilities(configured ? settings : null);
  const apiClient = useMemo(() => (settings && configured ? createApiClient(toApiConfig(settings)) : null), [settings, configured]);

  if (loading || !settings) {
    return (
      <main className="options-root">
        <p className="options-hint">Chargement…</p>
      </main>
    );
  }

  return (
    <main className="options-root">
      <h1>Réglages ez-dl</h1>
      <ServerSection settings={settings} onUpdate={update} />
      <FoldersSection settings={settings} apiClient={apiClient} onUpdate={update} />
      <PresetSection settings={settings} presets={presets} presetsLoading={presetsLoading} onUpdate={update} />
      <CookiesSection settings={settings} onUpdate={update} />
      <RulesSection apiClient={apiClient} />
    </main>
  );
}
