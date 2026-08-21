/**
 * Résout l'onglet actif de la fenêtre courante (id/URL/titre), point de départ de toutes
 * les autres requêtes de la popup (sniffing, probe, cookies).
 */

import { useEffect, useState } from 'react';

export interface ActiveTabInfo {
  id: number;
  url: string;
  title: string;
}

export function useActiveTab(): { tab: ActiveTabInfo | null; loading: boolean } {
  const [tab, setTab] = useState<ActiveTabInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void browser.tabs.query({ active: true, lastFocusedWindow: true }).then(([current]) => {
      if (cancelled) return;
      if (current?.id !== undefined && current.url) {
        setTab({ id: current.id, url: current.url, title: current.title ?? current.url });
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return { tab, loading };
}
