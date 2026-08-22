/**
 * Choix de « ce qui est téléchargé » quand l'utilisateur ne choisit rien : bouton en overlay sur
 * la page, et valeurs pré-remplies de la fiche source de la popup.
 *
 * Module **pur** (aucun accès storage/réseau/DOM) : c'est la référence unique des défauts, pour
 * que la popup et l'overlay envoient exactement le même job sur la même page.
 */

import { collapseVariantPlaylists, groupQualityVariants } from './detection';
import { buildDefaultFilename, sanitizeFilename } from './filename';
import type { ExtensionSettings, FavoriteFolder, MediaCandidate, MediaKind, ProbeFormat, ProbeResponse } from './types';

/** Rang de préférence d'un flux sniffé : un manifeste porte toutes les qualités, pas un fichier. */
const KIND_RANK: Record<MediaKind, number> = { hls: 0, dash: 1, mp4: 2, webm: 3, 'other-video': 4 };

/** Ce qu'un téléchargement en un clic enverra à `POST /api/jobs` (hors dossier/preset/cookies). */
export interface QuickJobSource {
  url: string;
  /** Format yt-dlp choisi (sources probe uniquement) ; `null` pour un flux sniffé. */
  formatId: string | null;
  filename: string;
  title: string;
}

export interface QuickSourceInput {
  /** Résultat de `/api/probe` sur l'URL de l'onglet, ou `null` si absent/sans extracteur. */
  probe: ProbeResponse | null;
  /** Flux détectés par le sniffer réseau pour cet onglet. */
  candidates: MediaCandidate[];
  pageUrl: string;
  pageTitle: string;
}

/**
 * Source à télécharger sans intervention de l'utilisateur, `null` si la page n'en offre aucune.
 * Le probe prime : il donne un titre, un nom de fichier et toutes les qualités. À défaut, le
 * meilleur flux sniffé (manifeste avant fichier progressif, meilleure résolution du groupe).
 */
export function pickQuickSource({ probe, candidates, pageUrl, pageTitle }: QuickSourceInput): QuickJobSource | null {
  if (probe && probe.formats.length > 0) {
    const formatId = probe.best_format_id ?? sortFormatsBestFirst(probe.formats)[0]?.format_id ?? null;
    return {
      url: pageUrl,
      formatId,
      filename: defaultFilenameForProbe(probe, pageTitle, formatId),
      title: probe.title ?? pageTitle,
    };
  }

  const best = pickBestCandidate(candidates);
  if (!best) return null;
  return {
    url: best.url,
    formatId: null,
    filename: defaultFilenameForMedia(best.kind, pageTitle, pageTitle),
    title: pageTitle,
  };
}

/** Meilleur flux sniffé après regroupement des variantes de qualité, `null` si aucun. */
export function pickBestCandidate(candidates: MediaCandidate[]): MediaCandidate | null {
  const grouped = groupQualityVariants(collapseVariantPlaylists(candidates));
  const sorted = [...grouped].sort(
    (a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.discoveredAt - b.discoveredAt,
  );
  return sorted[0] ?? null;
}

/** Formats du probe, meilleure qualité d'abord (hauteur puis débit). */
export function sortFormatsBestFirst(formats: ProbeFormat[]): ProbeFormat[] {
  return [...formats].sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.tbr ?? 0) - (a.tbr ?? 0));
}

/** Nom de fichier par défaut d'une source probe : suggestion du serveur, sinon titre + extension. */
export function defaultFilenameForProbe(
  probe: Pick<ProbeResponse, 'title' | 'suggested_filename' | 'formats'>,
  pageTitle: string,
  formatId: string | null,
): string {
  if (probe.suggested_filename) return sanitizeFilename(probe.suggested_filename);
  const format = probe.formats.find((f) => f.format_id === formatId);
  return buildDefaultFilename({ videoTitle: probe.title, pageTitle, ext: format?.ext ?? null });
}

/** Nom de fichier par défaut d'un flux sniffé : titre disponible + extension du conteneur. */
export function defaultFilenameForMedia(kind: MediaKind, videoTitle: string | null, pageTitle: string): string {
  return buildDefaultFilename({ videoTitle, pageTitle, ext: extensionForMediaKind(kind) });
}

export function extensionForMediaKind(kind: MediaKind): string | null {
  switch (kind) {
    case 'mp4':
      return 'mp4';
    case 'webm':
      return 'webm';
    case 'hls':
    case 'dash':
      return 'mp4'; // Conteneur de sortie typique après remux côté serveur.
    default:
      return null;
  }
}

/**
 * Dossier de destination par défaut : le favori marqué par défaut, sinon le premier favori,
 * sinon `null` (l'appelant doit demander un dossier à l'utilisateur).
 */
export function resolveDefaultFolder(settings: ExtensionSettings): FavoriteFolder | null {
  const match = settings.favoriteFolders.find((f) => f.path === settings.defaultFolderPath);
  if (match) return match;
  return settings.favoriteFolders[0] ?? null;
}
