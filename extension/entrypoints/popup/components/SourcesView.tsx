/**
 * Vue "Sources" de la popup : bannière de picker le cas échéant, liste des sources fusionnées
 * (probe + sniffing), et états vides/erreurs explicites.
 */

import { useCallback, useMemo, useState } from 'react';
import type { ApiClient } from '@/src/lib/api';
import { generalizeUrlPattern } from '@/src/lib/detection';
import type { SaveRuleRequest, SaveRuleResponse, StartPickerRequest } from '@/src/lib/messaging';
import type { ExtensionSettings, PickedElementInfo, Preset } from '@/src/lib/types';
import type { ActiveTabInfo } from '../hooks/useActiveTab';
import type { SourcesError } from '../hooks/useSources';
import type { Source } from '../types';
import { sourceId } from '../types';
import { EmptyState, type EmptyStateVariant } from './EmptyState';
import { SourceCard } from './SourceCard';

interface SourcesViewProps {
  settings: ExtensionSettings;
  tab: ActiveTabInfo;
  apiClient: ApiClient;
  presets: Preset[];
  sources: Source[];
  loading: boolean;
  error: SourcesError | null;
  pickedElement: PickedElementInfo | null;
  onRefresh: () => void;
  onJobCreated: () => void;
}

export function SourcesView({
  settings,
  tab,
  apiClient,
  presets,
  sources,
  loading,
  error,
  pickedElement,
  onRefresh,
  onJobCreated,
}: SourcesViewProps) {
  const startPicker = useCallback(() => {
    const request: StartPickerRequest = { type: 'START_PICKER', tabId: tab.id };
    void browser.runtime.sendMessage(request);
    window.close(); // libère l'interaction avec la page pour que l'utilisateur puisse cliquer dessus.
  }, [tab.id]);

  if (loading) {
    return (
      <p className="loading-hint" role="status">
        Recherche de vidéos…
      </p>
    );
  }

  if (sources.length === 0) {
    return (
      <EmptyState
        variant={errorToVariant(error) ?? 'no-sources'}
        message={error?.kind === 'server' ? error.message : undefined}
        onHelpDetect={startPicker}
        onRetry={onRefresh}
      />
    );
  }

  return (
    <div className="sources-view">
      {pickedElement ? (
        <PickedElementBanner element={pickedElement} domain={hostnameOf(tab.url)} onSaved={onRefresh} />
      ) : null}
      <ul className="source-list">
        {sources.map((source) => (
          <li key={sourceId(source)}>
            <SourceCard
              source={source}
              apiClient={apiClient}
              settings={settings}
              presets={presets}
              pageUrl={tab.url}
              pageTitle={tab.title}
              onDownloaded={onJobCreated}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function errorToVariant(error: SourcesError | null): EmptyStateVariant | null {
  if (!error) return null;
  if (error.kind === 'unauthorized') return 'unauthorized';
  if (error.kind === 'network') return 'network-error';
  if (error.kind === 'listing') return 'listing';
  return 'server-error';
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

interface PickedElementBannerProps {
  element: PickedElementInfo;
  domain: string;
  onSaved: () => void;
}

function PickedElementBanner({ element, domain, onSaved }: PickedElementBannerProps) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const candidateUrl = element.currentSrc || element.src;
  // Pattern réellement mémorisé : identifiants variables (id, hash, uuid, token) réduits à `*`
  // pour que la règle reste valable sur les prochaines vidéos du site, pas seulement celle-ci.
  const generalizedPattern = useMemo(() => (candidateUrl ? generalizeUrlPattern(candidateUrl) : null), [candidateUrl]);

  const save = useCallback(async () => {
    if (!generalizedPattern) return;
    setSaving(true);
    const request: SaveRuleRequest = {
      type: 'SAVE_RULE',
      domain,
      urlPattern: generalizedPattern,
      label: `Élément choisi via le picker (${element.selector})`,
      source: 'learned',
    };
    const response = (await browser.runtime.sendMessage(request)) as SaveRuleResponse;
    setSaving(false);
    if (response.ok) {
      setSaved(true);
      onSaved();
    }
  }, [domain, element.selector, generalizedPattern, onSaved]);

  return (
    <div className="picker-banner" role="status">
      {generalizedPattern ? (
        <>
          <p>
            Flux détecté via le picker, règle mémorisée : <code>{truncate(generalizedPattern)}</code>
          </p>
          {saved ? (
            <p className="field-success">Règle enregistrée pour {domain}.</p>
          ) : (
            <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => void save()}>
              {saving ? 'Enregistrement…' : 'Mémoriser ce flux pour ce site'}
            </button>
          )}
        </>
      ) : (
        <p>Élément choisi ({element.selector}), mais aucune URL de flux exploitable n'a été trouvée directement dessus.</p>
      )}
    </div>
  );
}

function truncate(url: string, max = 64): string {
  return url.length > max ? `${url.slice(0, max)}…` : url;
}
