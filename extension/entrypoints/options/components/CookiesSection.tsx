/**
 * Toggle d'envoi des cookies du site actif au serveur, avec explication explicite du risque
 * (les cookies transmis donnent accès aux sessions connectées de l'utilisateur).
 */

import type { ExtensionSettings } from '@/src/lib/types';

interface CookiesSectionProps {
  settings: ExtensionSettings;
  onUpdate: (patch: Partial<ExtensionSettings>) => Promise<ExtensionSettings>;
}

export function CookiesSection({ settings, onUpdate }: CookiesSectionProps) {
  return (
    <section className="options-section">
      <h2>Cookies du site</h2>
      <label className="field-checkbox">
        <input
          type="checkbox"
          checked={settings.sendCookies}
          onChange={(event) => void onUpdate({ sendCookies: event.target.checked })}
        />
        Envoyer les cookies du site actif au serveur pour les pages authentifiées
      </label>
      <p className="options-warning" role="note">
        ⚠️ Les cookies transmis donnent accès aux sessions connectées de cet onglet (identifiants de session,
        abonnements, etc.). Le serveur les utilise uniquement pour la durée du téléchargement, dans un fichier
        temporaire à permissions restreintes, puis les supprime. N'activez cette option que pour un serveur ez-dl de
        confiance, sous votre contrôle : quiconque a accès au serveur pourrait potentiellement les intercepter.
        Quand l'option est désactivée, aucun cookie n'est jamais envoyé, y compris pour les sites nécessitant une
        connexion.
      </p>
    </section>
  );
}
