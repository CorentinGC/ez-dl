/**
 * Types partagés par toute l'extension.
 *
 * Deux familles :
 * - types "contrat serveur" : miroir strict de CONTRACT.md (routes /api/*) ;
 * - types "extension" : état interne (onglets, réglages, messagerie).
 */

// ---------------------------------------------------------------------------
// Contrat serveur — GET /api/health
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: 'ok';
  version: string;
  ytdlp_version: string;
  ffmpeg_available: boolean;
}

// ---------------------------------------------------------------------------
// Contrat serveur — GET /api/capabilities
// ---------------------------------------------------------------------------

export interface Encoder {
  id: string;
  name: string;
  hwaccel: string | null;
  codec: string;
}

export interface Preset {
  id: string;
  label: string;
  description: string;
  container: string;
  video_codec: string | null;
  args_preview: string;
}

export interface CapabilitiesResponse {
  encoders: Encoder[];
  presets: Preset[];
}

// ---------------------------------------------------------------------------
// Contrat serveur — GET/POST /api/probe
// ---------------------------------------------------------------------------

export interface ProbeFormat {
  format_id: string;
  ext: string;
  height: number | null;
  width: number | null;
  fps: number | null;
  vcodec: string | null;
  acodec: string | null;
  filesize: number | null;
  tbr: number | null;
  label: string;
  has_audio: boolean;
  has_video: boolean;
}

export interface ProbeResponse {
  url: string;
  title: string | null;
  uploader: string | null;
  duration: number | null;
  thumbnail: string | null;
  extractor: string | null;
  formats: ProbeFormat[];
  best_format_id: string | null;
  suggested_filename: string | null;
}

/** Un cookie transmis au serveur (miroir du schéma `CookieItem` côté FastAPI). */
export interface CookieParam {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expires?: number | null;
}

/** Corps du POST /api/probe (pages authentifiées) — l'URL voyage dans le corps, pas en query. */
export interface ProbeRequestBody {
  url: string;
  cookies?: CookieParam[];
  headers?: Record<string, string>;
  referer?: string;
}

// ---------------------------------------------------------------------------
// Contrat serveur — GET/POST /api/folders
// ---------------------------------------------------------------------------

/** Racine de téléchargement déclarée côté serveur (`EZDL_DOWNLOAD_ROOTS`). */
export interface FolderRoot {
  label: string;
  path: string;
  /** `false` = racine déclarée mais non montée/non inscriptible : à afficher désactivée, jamais masquée. */
  is_available: boolean;
  /** Octets libres, `null` si l'espace disque n'a pas pu être lu (racine non montée). */
  free_bytes: number | null;
  /** Octets totaux, `null` si l'espace disque n'a pas pu être lu (racine non montée). */
  total_bytes: number | null;
}

/** Dossier actuellement parcouru (résultat de `GET /api/folders?path=...`), toujours disponible. */
export interface FolderCurrent {
  path: string;
  label: string;
  free_bytes: number | null;
  total_bytes: number | null;
}

export interface FolderEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export interface FoldersResponse {
  roots: FolderRoot[];
  current: FolderCurrent | null;
  entries: FolderEntry[];
  parent: string | null;
}

/** Corps du POST /api/folders : crée `name` dans le dossier `parent` (chemin absolu). */
export interface CreateFolderRequest {
  parent: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Contrat serveur — /api/jobs
// ---------------------------------------------------------------------------

export type JobStatus =
  | 'queued'
  | 'probing'
  | 'downloading'
  | 'converting'
  | 'moving'
  | 'done'
  | 'error'
  | 'canceled';

export interface Job {
  id: string;
  url: string;
  title: string | null;
  filename: string;
  folder: string;
  status: JobStatus;
  /** Avancement du téléchargement, en pourcentage (0.0–100.0). `null` tant qu'inconnu. */
  progress: number | null;
  /** Vitesse de téléchargement courante, en octets par seconde (o/s). `null` tant qu'inconnue. */
  speed: number | null;
  /** Temps restant estimé, en secondes (s). `null` tant qu'inconnu. */
  eta: number | null;
  /** Taille totale du fichier, en octets (o). `null` tant qu'inconnue. */
  size: number | null;
  error: string | null;
  preset_id: string | null;
  format_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateJobRequest {
  url: string;
  format_id?: string;
  folder: string;
  filename?: string;
  preset_id?: string;
  cookies?: CookieParam[];
  headers?: Record<string, string>;
  referer?: string;
  title?: string;
}

export interface CreateJobResponse {
  job_id: string;
  status: JobStatus;
}

// ---------------------------------------------------------------------------
// Contrat serveur — /api/rules
// ---------------------------------------------------------------------------

export type SiteRuleSource = 'manual' | 'learned';

export interface SiteRule {
  id: string;
  domain: string;
  url_pattern: string;
  label: string | null;
  notes: string | null;
  source: SiteRuleSource;
  created_at: string;
}

export interface CreateSiteRuleRequest {
  domain: string;
  url_pattern: string;
  label?: string;
  notes?: string;
  source: SiteRuleSource;
}

// ---------------------------------------------------------------------------
// Extension — détection réseau (sniffer background)
// ---------------------------------------------------------------------------

/** Nature du flux média détecté côté sniffer. */
export type MediaKind = 'hls' | 'dash' | 'mp4' | 'webm' | 'other-video';

/** Origine d'un candidat : sniffing générique, règle de site apprise, ou picker manuel. */
export type CandidateSource = 'sniffed' | 'learned' | 'picked';

/** Requête réseau brute observée par `chrome.webRequest`, avant classification. */
export interface RawRequest {
  url: string;
  contentType?: string | null;
  contentLength?: number | null;
  tabId: number;
  timeStamp?: number;
}

/** Candidat vidéo détecté sur un onglet, prêt à être proposé dans la popup. */
export interface MediaCandidate {
  url: string;
  kind: MediaKind;
  source: CandidateSource;
  contentType?: string | null;
  size?: number | null;
  discoveredAt: number;
}

// ---------------------------------------------------------------------------
// Extension — informations de page (content script)
// ---------------------------------------------------------------------------

export interface VideoElementInfo {
  src: string | null;
  currentSrc: string | null;
  poster: string | null;
  duration: number | null;
}

export interface PageInfo {
  pageTitle: string;
  videos: VideoElementInfo[];
  ogTitle: string | null;
  ogVideoUrl: string | null;
}

/** Descriptif d'un élément DOM choisi via le mode picker (apprentissage). */
export interface PickedElementInfo {
  tagName: string;
  src: string | null;
  currentSrc: string | null;
  poster: string | null;
  selector: string;
  rect: { x: number; y: number; width: number; height: number };
}

// ---------------------------------------------------------------------------
// Extension — état par onglet (storage.session)
// ---------------------------------------------------------------------------

export interface TabState {
  candidates: MediaCandidate[];
  pageInfo: PageInfo | null;
  pickedElement: PickedElementInfo | null;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Extension — réglages (storage.local)
// ---------------------------------------------------------------------------

export interface FavoriteFolder {
  label: string;
  path: string;
}

export interface ExtensionSettings {
  serverUrl: string;
  password: string;
  favoriteFolders: FavoriteFolder[];
  /** Chemin du dossier favori utilisé par défaut (clic 1-clic sur "Télécharger"). */
  defaultFolderPath: string | null;
  defaultPresetId: string | null;
  /** Envoyer les cookies du site actif au serveur pour les pages authentifiées. */
  sendCookies: boolean;
}
