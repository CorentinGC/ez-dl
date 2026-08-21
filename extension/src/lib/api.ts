/**
 * Client HTTP du serveur ez-dl (voir CONTRACT.md pour le contrat exact des routes).
 *
 * Règles :
 * - `Authorization: Bearer <password>` sur toutes les requêtes ;
 * - timeout configurable (défaut 10s), erreurs typées (`UnauthorizedError`, `NetworkError`,
 *   `ServerError`) ;
 * - `/api/jobs/events` est en SSE mais authentifié : `EventSource` ne permettant pas d'en-tête
 *   `Authorization`, on relit le flux nous-même via `fetch` + `ReadableStream` ;
 * - **jamais** de `console.log`/`console.error` incluant le mot de passe ou des cookies.
 */

import type {
  CapabilitiesResponse,
  CreateJobRequest,
  CreateJobResponse,
  CreateSiteRuleRequest,
  ExtensionSettings,
  FoldersResponse,
  HealthResponse,
  Job,
  ProbeRequestBody,
  ProbeResponse,
  SiteRule,
} from './types';

const DEFAULT_TIMEOUT_MS = 10_000;

/** Erreur de base pour toutes les erreurs d'API typées. */
export class ApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Mot de passe invalide ou absent (401). */
export class UnauthorizedError extends ApiError {
  constructor() {
    super('Mot de passe invalide.', 401);
    this.name = 'UnauthorizedError';
  }
}

/** Serveur injoignable : timeout, DNS, connexion refusée, etc. — pas de réponse HTTP exploitable. */
export class NetworkError extends ApiError {
  constructor(message = 'Serveur injoignable.') {
    super(message);
    this.name = 'NetworkError';
  }
}

/** Réponse HTTP d'erreur renvoyée par le serveur (4xx hors 401, 5xx). */
export class ServerError extends ApiError {
  constructor(status: number, message: string) {
    super(message, status);
    this.name = 'ServerError';
  }
}

/** Retire le(s) `/` final(aux) d'une URL de base saisie par l'utilisateur. */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export interface ApiClientConfig {
  baseUrl: string;
  password: string;
  timeoutMs?: number;
}

/** Adapte les réglages de l'extension (`serverUrl`/`password`) à la config du client API. */
export function toApiConfig(settings: Pick<ExtensionSettings, 'serverUrl' | 'password'>): ApiClientConfig {
  return { baseUrl: settings.serverUrl, password: settings.password };
}

/**
 * Extrait un message lisible du corps d'erreur FastAPI. Le `detail` d'un 422 est une LISTE
 * d'objets de validation pydantic : la stringifier telle quelle donnerait `[object Object]`.
 */
export function errorMessageFromBody(data: unknown, status: number): string {
  if (data && typeof data === 'object' && 'detail' in data) {
    const detail = (data as { detail: unknown }).detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
      const items = detail
        .filter((item): item is { loc?: unknown[]; msg?: unknown } => !!item && typeof item === 'object')
        .map((item) => {
          const field = Array.isArray(item.loc) ? item.loc.filter((l) => l !== 'body').join('.') : '';
          const msg = typeof item.msg === 'string' ? item.msg : 'valeur invalide';
          return field ? `${field} : ${msg}` : msg;
        });
      if (items.length > 0) return `Requête invalide — ${items.join(' ; ')}`;
    }
  }
  return `Erreur serveur (${status}).`;
}

async function safeReadErrorMessage(response: Response): Promise<string> {
  try {
    const data: unknown = await response.clone().json();
    return errorMessageFromBody(data, response.status);
  } catch {
    // Corps non JSON ou vide : message générique.
    return `Erreur serveur (${response.status}).`;
  }
}

async function request<T>(config: ApiClientConfig, path: string, init: RequestInit = {}): Promise<T> {
  const base = normalizeBaseUrl(config.baseUrl);
  if (!base) throw new NetworkError('URL du serveur non configurée.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const headers = new Headers(init.headers);
  if (config.password) headers.set('Authorization', `Bearer ${config.password}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  let response: Response;
  try {
    response = await fetch(`${base}${path}`, { ...init, headers, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new NetworkError('Délai dépassé en contactant le serveur.');
    }
    throw new NetworkError();
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401) throw new UnauthorizedError();
  if (!response.ok) throw new ServerError(response.status, await safeReadErrorMessage(response));
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * Découpe un tampon SSE en frames complets + reste. Les serveurs peuvent terminer les lignes
 * en `\n` ou `\r\n` (sse-starlette émet `\r\n`) : le séparateur de frame est donc `\r?\n\r?\n`.
 */
export function splitSseFrames(buffer: string): { frames: string[]; rest: string } {
  const frames = buffer.split(/\r?\n\r?\n/);
  return { frames: frames.slice(0, -1), rest: frames[frames.length - 1] ?? '' };
}

/** Un frame SSE `event: job\ndata: {...}` -> le `Job` désérialisé, ou `null` si non pertinent. */
export function parseJobFrame(frame: string): Job | null {
  let eventName = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
  }
  if (eventName !== 'job' || dataLines.length === 0) return null;
  try {
    return JSON.parse(dataLines.join('\n')) as Job;
  } catch {
    return null;
  }
}

/**
 * Ouvre le flux SSE authentifié `/api/jobs/events` et appelle `onJob` à chaque événement `job`.
 * Retourne une fonction de nettoyage à appeler pour fermer la connexion.
 */
function streamJobEvents(
  config: ApiClientConfig,
  onJob: (job: Job) => void,
  onError?: (error: ApiError) => void,
): () => void {
  const controller = new AbortController();
  const base = normalizeBaseUrl(config.baseUrl);
  const headers = new Headers({ Accept: 'text/event-stream' });
  if (config.password) headers.set('Authorization', `Bearer ${config.password}`);

  void (async () => {
    try {
      const response = await fetch(`${base}/api/jobs/events`, { headers, signal: controller.signal });
      if (response.status === 401) throw new UnauthorizedError();
      if (!response.ok || !response.body) {
        throw new ServerError(response.status, `Flux de suivi des jobs indisponible (${response.status}).`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { frames, rest } = splitSseFrames(buffer);
        buffer = rest;
        for (const frame of frames) {
          const job = parseJobFrame(frame);
          if (job) onJob(job);
        }
      }
    } catch (error) {
      if (controller.signal.aborted) return; // fermeture volontaire (unsubscribe) : pas une erreur
      onError?.(error instanceof ApiError ? error : new NetworkError());
    }
  })();

  return () => controller.abort();
}

/** Construit un client HTTP lié à une configuration serveur (URL + mot de passe) donnée. */
export function createApiClient(config: ApiClientConfig) {
  return {
    getHealth: () => request<HealthResponse>(config, '/api/health'),

    getCapabilities: () => request<CapabilitiesResponse>(config, '/api/capabilities'),

    /** Sonde une URL sans contexte d'authentification (page publique). */
    probe: (url: string) => request<ProbeResponse>(config, `/api/probe?url=${encodeURIComponent(url)}`),

    /** Sonde une URL avec cookies/headers/referer (page authentifiée). L'URL voyage dans le
     * corps : la variante POST du serveur ne lit pas la query. */
    probeWithContext: (url: string, context: Omit<ProbeRequestBody, 'url'>) =>
      request<ProbeResponse>(config, '/api/probe', {
        method: 'POST',
        body: JSON.stringify({ url, ...context } satisfies ProbeRequestBody),
      }),

    listFolders: (path?: string) =>
      request<FoldersResponse>(config, `/api/folders${path ? `?path=${encodeURIComponent(path)}` : ''}`),

    createJob: (body: CreateJobRequest) =>
      request<CreateJobResponse>(config, '/api/jobs', { method: 'POST', body: JSON.stringify(body) }),

    listJobs: () => request<Job[]>(config, '/api/jobs'),

    getJob: (id: string) => request<Job>(config, `/api/jobs/${encodeURIComponent(id)}`),

    deleteJob: (id: string) => request<void>(config, `/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    listRules: () => request<SiteRule[]>(config, '/api/rules'),

    createRule: (body: CreateSiteRuleRequest) =>
      request<SiteRule>(config, '/api/rules', { method: 'POST', body: JSON.stringify(body) }),

    deleteRule: (id: string) => request<void>(config, `/api/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    streamJobEvents: (onJob: (job: Job) => void, onError?: (error: ApiError) => void) =>
      streamJobEvents(config, onJob, onError),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
