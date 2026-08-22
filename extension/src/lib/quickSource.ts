/**
 * Choix de « ce qui est téléchargé » quand l'utilisateur ne choisit rien : bouton en overlay sur
 * la page, et valeurs pré-remplies de la fiche source de la popup.
 *
 * Module **pur** (aucun accès storage/réseau/DOM) : c'est la référence unique des défauts, pour
 * que la popup et l'overlay envoient exactement le même job sur la même page.
 */

import { classifyUrl, collapseVariantPlaylists, groupQualityVariants } from './detection';
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

/**
 * Vidéo précise désignée par l'utilisateur en cliquant son bouton en overlay. Ces données
 * viennent de la page : elles ne servent qu'à choisir un média et un nom de fichier, et passent
 * toutes par `sanitizeClickedVideo` avant usage.
 */
export interface ClickedVideo {
  /** `currentSrc` de l'élément, `null` pour un lecteur MSE (`blob:`) ou une source inutilisable. */
  mediaUrl: string | null;
  /** Titre le plus probable trouvé autour de la vidéo dans la page. */
  title: string | null;
  /** Vrai si c'est la seule vidéo exploitable de la page : le probe couvre alors bien celle-ci. */
  isOnlyVideo: boolean;
}

export interface QuickSourceInput {
  /** Résultat de `/api/probe` sur l'URL de l'onglet, ou `null` si absent/sans extracteur. */
  probe: ProbeResponse | null;
  /** Flux détectés par le sniffer réseau pour cet onglet. */
  candidates: MediaCandidate[];
  pageUrl: string;
  pageTitle: string;
  /** Vidéo cliquée dans la page ; absente quand la demande vient de la popup. */
  clicked?: ClickedVideo | null;
}

const MAX_MEDIA_URL_LENGTH = 2048;

/**
 * Normalise ce que le content script rapporte de la vidéo cliquée. Une page hostile contrôle ces
 * champs : seules des URL `http(s)` de longueur raisonnable sont retenues (le serveur revalide le
 * schéma de son côté), et le titre est ramené à une ligne bornée avant d'atteindre le nom de
 * fichier — qui passe encore par `sanitizeFilename`.
 */
export function sanitizeClickedVideo(raw: unknown): ClickedVideo | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { mediaUrl, title, isOnlyVideo } = raw as Record<string, unknown>;
  return {
    mediaUrl: isUsableMediaUrl(mediaUrl) ? mediaUrl : null,
    title: typeof title === 'string' && title.trim().length > 0 ? title.replace(/\s+/g, ' ').trim().slice(0, 200) : null,
    isOnlyVideo: isOnlyVideo === true,
  };
}

function isUsableMediaUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_MEDIA_URL_LENGTH) return false;
  return value.startsWith('http://') || value.startsWith('https://');
}

/**
 * Source à télécharger sans intervention de l'utilisateur, `null` si la page n'en offre aucune.
 * Le probe prime : il donne un titre, un nom de fichier et toutes les qualités. À défaut, le
 * meilleur flux sniffé (manifeste avant fichier progressif, meilleure résolution du groupe).
 */
export function pickQuickSource({ probe, candidates, pageUrl, pageTitle, clicked }: QuickSourceInput): QuickJobSource | null {
  const clickedTitle = clicked?.title ?? null;

  // Plusieurs vidéos sur la page : le probe ne décrit que la principale, alors que l'utilisateur
  // a désigné un élément précis. Son média direct prime donc sur tout le reste.
  if (clicked?.mediaUrl && !clicked.isOnlyVideo) return fromClickedMedia(clicked.mediaUrl, clickedTitle, pageTitle);

  if (probe && probe.formats.length > 0) {
    const formatId = probe.best_format_id ?? sortFormatsBestFirst(probe.formats)[0]?.format_id ?? null;
    const title = probe.title ?? clickedTitle ?? pageTitle;
    return {
      url: pageUrl,
      formatId,
      filename: defaultFilenameForProbe(probe, title, formatId),
      title,
    };
  }

  // Vidéo unique mais sans extracteur yt-dlp : son `currentSrc` reste plus fiable qu'un flux
  // sniffé choisi au jugé (une page peut charger d'autres médias en arrière-plan).
  if (clicked?.mediaUrl) return fromClickedMedia(clicked.mediaUrl, clickedTitle, pageTitle);

  const best = pickBestCandidate(candidates);
  if (!best) return null;
  const title = clickedTitle ?? pageTitle;
  return {
    url: best.url,
    formatId: null,
    filename: defaultFilenameForMedia(best.kind, title, pageTitle),
    title,
  };
}

function fromClickedMedia(mediaUrl: string, clickedTitle: string | null, pageTitle: string): QuickJobSource {
  const title = clickedTitle ?? pageTitle;
  return {
    url: mediaUrl,
    formatId: null,
    filename: defaultFilenameForMedia(classifyUrl(mediaUrl) ?? 'other-video', title, pageTitle),
    title,
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
