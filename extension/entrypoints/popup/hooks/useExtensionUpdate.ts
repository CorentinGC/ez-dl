/**
 * Vérifie si le serveur actif publie une version d'extension plus récente que celle installée.
 *
 * Tout échec est silencieux : la route `/extension/version` n'existe pas sur un serveur antérieur
 * à cette fonctionnalité (404), l'image peut avoir été construite sans artefact
 * (`available: false`), et le serveur peut simplement être injoignable. Aucun de ces cas n'est un
 * problème pour l'utilisateur — l'extension fonctionne, on ne l'alerte pas.
 */

import { useEffect, useState } from 'react';
import { createApiClient, normalizeBaseUrl, toApiConfig } from '@/src/lib/api';
import { isNewerVersion } from '@/src/lib/version';
import type { ExtensionSettings } from '@/src/lib/types';

export interface ExtensionUpdate {
  version: string;
  /** Page d'installation du serveur, à ouvrir dans un onglet. */
  pageUrl: string;
}

export function useExtensionUpdate(settings: ExtensionSettings | null): ExtensionUpdate | null {
  const [update, setUpdate] = useState<ExtensionUpdate | null>(null);

  useEffect(() => {
    // Changement de serveur : la version publiée par le précédent ne veut plus rien dire.
    setUpdate(null);
    if (!settings) return;
    const baseUrl = normalizeBaseUrl(settings.serverUrl);
    if (!baseUrl) return;

    let cancelled = false;
    void createApiClient(toApiConfig(settings))
      .getPublishedExtension()
      .then((published) => {
        if (cancelled || !published.available || !published.version) return;
        if (!isNewerVersion(published.version, browser.runtime.getManifest().version)) return;
        setUpdate({ version: published.version, pageUrl: `${baseUrl}/extension` });
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [settings]);

  return update;
}
