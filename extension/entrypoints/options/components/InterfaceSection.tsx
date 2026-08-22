/**
 * Préférences d'interface, communes à tous les serveurs enregistrés (clé `uiPrefs`, hors profils) :
 * affichage du bouton de téléchargement ancré sur les vidéos des pages visitées.
 */

import { useEffect, useState } from 'react';
import { DEFAULT_UI_PREFS, getUiPrefs, saveUiPrefs, watchUiPrefs, type UiPrefs } from '@/src/lib/uiPrefs';

export function InterfaceSection() {
  const [prefs, setPrefs] = useState<UiPrefs>(DEFAULT_UI_PREFS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void getUiPrefs().then((stored) => {
      setPrefs(stored);
      setLoaded(true);
    });
    // Une autre page d'options ouverte en parallèle ne doit pas laisser cette case périmée.
    return watchUiPrefs(setPrefs);
  }, []);

  return (
    <section className="options-section">
      <h2>Interface</h2>
      <label className="field-checkbox">
        <input
          type="checkbox"
          checked={prefs.showPageOverlay}
          disabled={!loaded}
          onChange={(event) => void saveUiPrefs({ showPageOverlay: event.target.checked }).then(setPrefs)}
        />
        Afficher un bouton de téléchargement sur les vidéos des pages visitées
      </label>
      <p className="options-hint">
        Le bouton n'apparaît que si une source téléchargeable a été confirmée sur la page. Un clic crée le job
        directement avec les réglages par défaut du serveur actif : meilleure qualité, dossier favori par défaut,
        conversion par défaut. Ce réglage est commun à tous les serveurs enregistrés.
      </p>
    </section>
  );
}
