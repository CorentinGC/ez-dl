/**
 * Types propres à l'UI de la popup : fusionne les résultats `/api/probe` (formats précis,
 * choisis par yt-dlp) et les flux sniffés par le background (URL brute, aucun format connu)
 * en un modèle unique affiché par `SourceCard`.
 */

import type { MediaKind, ProbeFormat } from '@/src/lib/types';

/** Source issue de `/api/probe` : plusieurs formats/qualités au choix. */
export interface ProbeSource {
  kind: 'probe';
  /** URL de la page, envoyée telle quelle à `POST /api/jobs` (yt-dlp gère l'extraction). */
  pageUrl: string;
  title: string;
  thumbnail: string | null;
  formats: ProbeFormat[];
  bestFormatId: string | null;
  suggestedFilename: string | null;
}

/** Source sniffée sur le réseau, non couverte par `/api/probe` : une seule URL directe. */
export interface SniffedSource {
  kind: 'sniffed';
  mediaUrl: string;
  mediaKind: MediaKind;
  /** Titre de la page (aucun titre propre à ce flux). */
  title: string;
}

export type Source = ProbeSource | SniffedSource;

/** Identifiant stable d'une source, utilisé comme clé React et pour dédupliquer. */
export function sourceId(source: Source): string {
  return source.kind === 'probe' ? `probe:${source.pageUrl}` : `sniffed:${source.mediaUrl}`;
}
