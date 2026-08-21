/**
 * États vides/erreurs explicites de la popup : serveur non configuré, 401, injoignable,
 * erreur serveur générique, ou aucune vidéo détectée (avec bouton d'apprentissage).
 */

export type EmptyStateVariant = 'not-configured' | 'unauthorized' | 'network-error' | 'server-error' | 'no-sources';

interface EmptyStateProps {
  variant: EmptyStateVariant;
  message?: string;
  onHelpDetect?: () => void;
  onRetry?: () => void;
}

const COPY: Record<EmptyStateVariant, { title: string; description: string }> = {
  'not-configured': {
    title: 'Serveur non configuré',
    description: "Renseignez l'adresse de votre serveur ez-dl et le mot de passe dans les réglages.",
  },
  unauthorized: {
    title: 'Mot de passe invalide',
    description: 'Le serveur a refusé le mot de passe configuré pour cette extension.',
  },
  'network-error': {
    title: 'Serveur injoignable',
    description: 'Vérifiez que le serveur ez-dl est démarré et accessible depuis ce réseau.',
  },
  'server-error': {
    title: 'Erreur serveur',
    description: 'Le serveur a renvoyé une erreur inattendue.',
  },
  'no-sources': {
    title: 'Aucune vidéo détectée',
    description: "Naviguez vers une page vidéo, ou aidez l'extension à repérer le lecteur.",
  },
};

export function EmptyState({ variant, message, onHelpDetect, onRetry }: EmptyStateProps) {
  const copy = COPY[variant];
  const showOpenOptions = variant === 'not-configured' || variant === 'unauthorized';
  const showRetry = (variant === 'network-error' || variant === 'server-error') && onRetry;

  return (
    <div className="empty-state" role="status">
      <p className="empty-state-title">{copy.title}</p>
      <p className="empty-state-description">{message ?? copy.description}</p>
      <div className="empty-state-actions">
        {showOpenOptions ? (
          <button type="button" className="btn btn-primary" onClick={() => browser.runtime.openOptionsPage()}>
            Ouvrir les réglages
          </button>
        ) : null}
        {variant === 'no-sources' && onHelpDetect ? (
          <button type="button" className="btn btn-primary" onClick={onHelpDetect}>
            Aider à détecter
          </button>
        ) : null}
        {showRetry ? (
          <button type="button" className="btn btn-secondary" onClick={onRetry}>
            Réessayer
          </button>
        ) : null}
      </div>
    </div>
  );
}
