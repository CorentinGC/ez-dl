/**
 * Réglage du serveur : URL, mot de passe (masqué), test de connexion via `/api/health`.
 */

import { useCallback, useEffect, useState } from 'react';
import { createApiClient } from '@/src/lib/api';
import type { ExtensionSettings, HealthResponse } from '@/src/lib/types';

interface ServerSectionProps {
  settings: ExtensionSettings;
  onUpdate: (patch: Partial<ExtensionSettings>) => Promise<ExtensionSettings>;
}

type TestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'success'; health: HealthResponse }
  | { status: 'error'; message: string };

export function ServerSection({ settings, onUpdate }: ServerSectionProps) {
  const [serverUrl, setServerUrl] = useState(settings.serverUrl);
  const [password, setPassword] = useState(settings.password);
  const [testState, setTestState] = useState<TestState>({ status: 'idle' });

  useEffect(() => {
    setServerUrl(settings.serverUrl);
    setPassword(settings.password);
  }, [settings.serverUrl, settings.password]);

  const testConnection = useCallback(async () => {
    setTestState({ status: 'testing' });
    try {
      const health = await createApiClient({ baseUrl: serverUrl, password }).getHealth();
      setTestState({ status: 'success', health });
    } catch (err) {
      setTestState({ status: 'error', message: err instanceof Error ? err.message : 'Erreur inconnue.' });
    }
  }, [serverUrl, password]);

  return (
    <section className="options-section">
      <h2>Serveur</h2>
      <p className="options-section-description">Adresse et mot de passe de votre serveur ez-dl self-hosted.</p>

      <div className="field">
        <label className="field-label" htmlFor="server-url">
          URL du serveur
        </label>
        <input
          id="server-url"
          className="field-input"
          type="url"
          placeholder="http://nas.local:8000"
          value={serverUrl}
          onChange={(event) => setServerUrl(event.target.value)}
          onBlur={() => void onUpdate({ serverUrl: serverUrl.trim() })}
        />
      </div>

      <div className="field">
        <label className="field-label" htmlFor="server-password">
          Mot de passe
        </label>
        <input
          id="server-password"
          className="field-input"
          type="password"
          autoComplete="off"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          onBlur={() => void onUpdate({ password })}
        />
      </div>

      <button type="button" className="btn btn-primary" disabled={testState.status === 'testing'} onClick={() => void testConnection()}>
        {testState.status === 'testing' ? 'Test en cours…' : 'Tester la connexion'}
      </button>

      {testState.status === 'success' ? (
        <p className="field-success" role="status">
          Connecté — serveur v{testState.health.version}, yt-dlp {testState.health.ytdlp_version}, ffmpeg{' '}
          {testState.health.ffmpeg_available ? 'disponible' : 'indisponible'}.
        </p>
      ) : null}
      {testState.status === 'error' ? (
        <p className="field-error" role="alert">
          {testState.message}
        </p>
      ) : null}
    </section>
  );
}
