/**
 * Gestion des règles de site apprises : liste (`GET /api/rules`) et suppression
 * (`DELETE /api/rules/{id}`). La création se fait depuis la popup (mode picker).
 */

import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '@/src/lib/api';
import type { SiteRule } from '@/src/lib/types';

interface RulesSectionProps {
  apiClient: ApiClient | null;
}

export function RulesSection({ apiClient }: RulesSectionProps) {
  const [rules, setRules] = useState<SiteRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!apiClient) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    apiClient
      .listRules()
      .then(setRules)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Erreur de chargement.'))
      .finally(() => setLoading(false));
  }, [apiClient]);

  useEffect(() => {
    load();
  }, [load]);

  const remove = useCallback(
    async (id: string) => {
      if (!apiClient) return;
      await apiClient.deleteRule(id);
      setRules((prev) => prev.filter((rule) => rule.id !== id));
    },
    [apiClient],
  );

  return (
    <section className="options-section">
      <h2>Règles de site apprises</h2>
      <p className="options-section-description">
        Motifs d'URL mémorisés (via le mode « Aider à détecter » de la popup) pour reconnaître automatiquement les
        flux vidéo de sites dont l'extension ne reconnaît pas nativement les formats.
      </p>
      {!apiClient ? <p className="options-hint">Configurez le serveur ci-dessus pour gérer les règles.</p> : null}
      {loading && apiClient ? <p className="options-hint">Chargement…</p> : null}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {!loading && apiClient && rules.length === 0 && !error ? (
        <p className="options-hint">Aucune règle enregistrée pour l'instant.</p>
      ) : null}
      {rules.length > 0 ? (
        <ul className="rules-list">
          {rules.map((rule) => (
            <li key={rule.id} className="rule-row">
              <div className="rule-row-info">
                <p className="rule-row-domain">
                  {rule.domain}
                  <span className="rule-row-source"> · {rule.source === 'manual' ? 'manuelle' : 'apprise'}</span>
                </p>
                <p className="rule-row-pattern">{rule.url_pattern}</p>
                {rule.label ? <p className="rule-row-label">{rule.label}</p> : null}
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-small"
                onClick={() => void remove(rule.id)}
                aria-label={`Supprimer la règle pour ${rule.domain}`}
              >
                Supprimer
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
