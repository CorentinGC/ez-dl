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
// Contrat serveur — GET /extension/version (publique, hors /api)
// ---------------------------------------------------------------------------

/**
 * Artefact d'extension publié par le serveur. `available: false` (et champs `null`) si l'image a
 * été construite sans artefact ; un serveur antérieur à cette fonctionnalité répond `404`.
 */
export interface PublishedExtension {
  available: boolean;
  version: string | null;
  filename: string | null;
  size: number | null;
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
  /** Rang (1-based) de la vidéo voulue quand l'URL en porte plusieurs (tweet multi-vidéos). */
  playlist_items?: number;
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
  /** Suspendu (pause explicite ou redémarrage du serveur) : le fichier partiel est conservé. */
  | 'paused'
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

/**
 * Réponse de `GET /api/jobs/lookup` : cette vidéo a-t-elle déjà été téléchargée ? Deux signaux —
 * un job portant la même adresse (query ignorée : les liens de CDN sont signés), et la présence
 * réelle du fichier de destination, seul indice qui survit à une purge de l'historique.
 */
export interface JobDuplicate {
  found: boolean;
  reason: 'url' | 'file' | null;
  job: Job | null;
  file_exists: boolean;
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
  /** Rang (1-based) de la vidéo voulue quand l'URL en porte plusieurs (tweet multi-vidéos). */
  playlist_items?: number;
}

export interface CreateJobResponse {
  job_id: string;
  status: JobStatus;
}

/**
 * Corps du POST /api/jobs/{id}/resume. Le serveur ne conserve aucun cookie entre deux jobs :
 * une reprise sur un site authentifié doit les fournir à nouveau, sinon yt-dlp repart anonyme.
 */
export interface JobResumeRequest {
  cookies?: CookieParam[];
  headers?: Record<string, string>;
  referer?: string;
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

/**
 * Résultat mémorisé du probe déclenché par l'overlay de page, pour ne pas re-sonder le serveur
 * à chaque `<video>` détectée ni au clic. Vit dans l'état d'onglet : la navigation l'efface.
 */
export interface QuickProbeCache {
  /** URL d'onglet sondée — une redirection interne (SPA) invalide le cache. */
  url: string;
  /** Réponse du probe, `null` si le serveur n'a trouvé aucun extracteur exploitable. */
  probe: ProbeResponse | null;
  checkedAt: number;
}

export interface TabState {
  candidates: MediaCandidate[];
  pageInfo: PageInfo | null;
  pickedElement: PickedElementInfo | null;
  /** Absent tant qu'aucun probe n'a été déclenché (clic sur l'overlay) sur cet onglet. */
  quickProbe?: QuickProbeCache | null;
  /** Dernière URL vue pour l'onglet : sert à repérer une navigation SPA sans `status: loading`. */
  pageUrl?: string | null;
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

/**
 * Un serveur ez-dl enregistré, avec sa configuration complète. `ExtensionSettings` reste la
 * « vue aplatie » d'un profil : tous les consommateurs (popup, options, background) continuent
 * de travailler sur ce type, sans savoir combien de profils existent.
 */
export interface ServerProfile extends ExtensionSettings {
  id: string;
  name: string;
}

/**
 * Contenu réel de la clé `settings` de `storage.local` depuis la v2 : plusieurs profils et
 * celui qui est actif. Le champ `version` sert de discriminant de migration — son absence
 * identifie l'ancien format plat (v1, un seul serveur).
 */
export interface SettingsRoot {
  version: 2;
  profiles: ServerProfile[];
  activeProfileId: string;
}
