/**
 * Bandeau discret annonçant une version d'extension plus récente publiée par le serveur actif.
 * Il n'apparaît que dans ce cas précis : ni erreur, ni « à jour », ni chargement — l'absence de
 * bandeau est l'état normal.
 */

import type { ExtensionUpdate } from '../hooks/useExtensionUpdate';

interface UpdateBannerProps {
  update: ExtensionUpdate | null;
}

export function UpdateBanner({ update }: UpdateBannerProps) {
  if (!update) return null;

  return (
    <button
      type="button"
      className="popup-update-banner"
      // La page d'installation explique la marche à suivre : rien à dupliquer ici.
      onClick={() => void browser.tabs.create({ url: update.pageUrl })}
    >
      Nouvelle version {update.version} disponible — installer
    </button>
  );
}
