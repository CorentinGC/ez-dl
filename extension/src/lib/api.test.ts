/**
 * Tests du parsing SSE de api.ts : les frames doivent être reconnus quelle que soit la
 * convention de fin de ligne du serveur (`\n` simple ou `\r\n` façon sse-starlette).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient, errorMessageFromBody, parseJobFrame, splitSseFrames } from './api';

const JOB_JSON = '{"id":"j1","url":"https://example.com/v.mp4","title":null,"filename":"v.mp4","folder":"/data","status":"downloading","progress":42,"speed":null,"eta":null,"size":null,"error":null,"preset_id":"copy","format_id":null,"created_at":"2026-01-01T00:00:00","updated_at":"2026-01-01T00:00:01"}';

describe('splitSseFrames', () => {
  it('découpe les frames séparés par \\n\\n', () => {
    const { frames, rest } = splitSseFrames('event: job\ndata: a\n\nevent: job\ndata: b\n\npartiel');
    expect(frames).toEqual(['event: job\ndata: a', 'event: job\ndata: b']);
    expect(rest).toBe('partiel');
  });

  it('découpe les frames séparés par \\r\\n\\r\\n (sse-starlette)', () => {
    const { frames, rest } = splitSseFrames('event: job\r\ndata: a\r\n\r\nevent: job\r\ndata: b\r\n\r\n');
    expect(frames).toEqual(['event: job\r\ndata: a', 'event: job\r\ndata: b']);
    expect(rest).toBe('');
  });

  it('conserve un frame incomplet dans le reste', () => {
    const { frames, rest } = splitSseFrames('event: job\r\ndata: pas-encore-fini');
    expect(frames).toEqual([]);
    expect(rest).toBe('event: job\r\ndata: pas-encore-fini');
  });
});

describe('errorMessageFromBody', () => {
  it('retourne un detail texte tel quel', () => {
    expect(errorMessageFromBody({ detail: 'Dossier hors racines autorisées' }, 400)).toBe(
      'Dossier hors racines autorisées',
    );
  });

  it('rend lisible la liste de validation pydantic d\'un 422 (jamais [object Object])', () => {
    const body = {
      detail: [
        { loc: ['body', 'url'], msg: 'Field required', type: 'missing' },
        { loc: ['body', 'cookies'], msg: 'Input should be a valid list', type: 'list_type' },
      ],
    };
    const message = errorMessageFromBody(body, 422);
    expect(message).toBe('Requête invalide — url : Field required ; cookies : Input should be a valid list');
    expect(message).not.toContain('[object Object]');
  });

  it('retombe sur un message générique pour un corps inattendu', () => {
    expect(errorMessageFromBody(null, 500)).toBe('Erreur serveur (500).');
    expect(errorMessageFromBody({ detail: [] }, 422)).toBe('Erreur serveur (422).');
  });
});

describe('createApiClient().createFolder', () => {
  const config = { baseUrl: 'http://localhost:8000', password: 'secret' };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('envoie un POST /api/folders avec { parent, name } et le header Authorization', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ name: 'Films', path: '/data/Films', is_dir: true }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const entry = await createApiClient(config).createFolder({ parent: '/data', name: 'Films' });

    expect(entry).toEqual({ name: 'Films', path: '/data/Films', is_dir: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8000/api/folders');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ parent: '/data', name: 'Films' });
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer secret');
  });

  it('remonte le detail lisible du serveur sur 409 (dossier déjà existant)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: 'Le dossier existe déjà.' }), { status: 409 })),
    );

    await expect(createApiClient(config).createFolder({ parent: '/data', name: 'Films' })).rejects.toMatchObject({
      message: 'Le dossier existe déjà.',
      status: 409,
    });
  });

  it('remonte le detail lisible du serveur sur 400 (parent hors racine)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: 'Dossier hors racines autorisées.' }), { status: 400 })),
    );

    await expect(createApiClient(config).createFolder({ parent: '/etc', name: 'x' })).rejects.toMatchObject({
      message: 'Dossier hors racines autorisées.',
      status: 400,
    });
  });
});

describe('createApiClient() — pause / resume', () => {
  const config = { baseUrl: 'http://localhost:8000', password: 'secret' };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const jobResponse = (status: string) =>
    new Response(JOB_JSON.replace('"status":"downloading"', `"status":"${status}"`), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  it('POST /api/jobs/{id}/pause et retourne le job suspendu', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jobResponse('paused'));
    vi.stubGlobal('fetch', fetchMock);

    const job = await createApiClient(config).pauseJob('j1');

    expect(job.status).toBe('paused');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8000/api/jobs/j1/pause');
    expect(init.method).toBe('POST');
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer secret');
  });

  it('POST /api/jobs/{id}/resume avec les cookies refournis', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jobResponse('queued'));
    vi.stubGlobal('fetch', fetchMock);

    const cookies = [{ name: 'sid', value: 'abc', domain: '.example.com', path: '/', secure: true, httpOnly: true, expires: null }];
    const job = await createApiClient(config).resumeJob('j1', { cookies });

    expect(job.status).toBe('queued');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8000/api/jobs/j1/resume');
    expect(JSON.parse(init.body as string)).toEqual({ cookies });
  });

  it('envoie un corps vide quand aucun contexte n\'est fourni', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jobResponse('queued'));
    vi.stubGlobal('fetch', fetchMock);

    await createApiClient(config).resumeJob('j1');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it('remonte le detail lisible du serveur sur 409 (statut incompatible)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: 'Un job « done » ne peut pas être repris.' }), { status: 409 }),
      ),
    );

    await expect(createApiClient(config).resumeJob('j1')).rejects.toMatchObject({
      message: 'Un job « done » ne peut pas être repris.',
      status: 409,
    });
  });

  it('encode l\'identifiant dans le chemin', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jobResponse('paused'));
    vi.stubGlobal('fetch', fetchMock);

    await createApiClient(config).pauseJob('a/b');

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8000/api/jobs/a%2Fb/pause');
  });
});

describe('parseJobFrame', () => {
  it('parse un frame job avec fins de ligne \\n', () => {
    const job = parseJobFrame(`event: job\ndata: ${JOB_JSON}`);
    expect(job?.id).toBe('j1');
    expect(job?.status).toBe('downloading');
  });

  it('parse un frame job avec fins de ligne \\r\\n', () => {
    const job = parseJobFrame(`event: job\r\ndata: ${JOB_JSON}\r`);
    expect(job?.id).toBe('j1');
    expect(job?.progress).toBe(42);
  });

  it('ignore les événements non-job et les données invalides', () => {
    expect(parseJobFrame('event: ping\ndata: {}')).toBeNull();
    expect(parseJobFrame(`data: ${JOB_JSON}`)).toBeNull();
    expect(parseJobFrame('event: job\ndata: {invalide')).toBeNull();
  });
});

describe('createApiClient().deleteJob', () => {
  const config = { baseUrl: 'http://localhost:8000', password: 'secret' };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const noContent = () => new Response(null, { status: 204 });

  it('n’ajoute pas delete_file par défaut : le fichier téléchargé est épargné', async () => {
    const fetchMock = vi.fn().mockResolvedValue(noContent());
    vi.stubGlobal('fetch', fetchMock);

    await createApiClient(config).deleteJob('j1');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8000/api/jobs/j1');
    expect(init.method).toBe('DELETE');
  });

  it('n’ajoute pas non plus delete_file quand l’option est explicitement fausse', async () => {
    const fetchMock = vi.fn().mockResolvedValue(noContent());
    vi.stubGlobal('fetch', fetchMock);

    await createApiClient(config).deleteJob('j1', { deleteFile: false });

    expect((fetchMock.mock.calls[0] as [string, RequestInit])[0]).toBe('http://localhost:8000/api/jobs/j1');
  });

  it('ajoute delete_file=true quand l’utilisateur choisit d’effacer le fichier', async () => {
    const fetchMock = vi.fn().mockResolvedValue(noContent());
    vi.stubGlobal('fetch', fetchMock);

    await createApiClient(config).deleteJob('j1', { deleteFile: true });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8000/api/jobs/j1?delete_file=true');
    expect(init.method).toBe('DELETE');
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer secret');
  });
});

describe('createApiClient().getPublishedExtension', () => {
  const config = { baseUrl: 'http://localhost:8000/', password: 'secret' };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('interroge la route publique /extension/version (hors /api, slash final normalisé)', async () => {
    const body = { available: true, version: '0.1.0', filename: 'ez-dl-extension-0.1.0.crx', size: 1234 };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createApiClient(config).getPublishedExtension()).resolves.toEqual(body);
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[0]).toBe('http://localhost:8000/extension/version');
  });

  it('remonte une erreur sur un serveur sans la route (404) — l’appelant la traite en silence', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Not Found', { status: 404 })));

    await expect(createApiClient(config).getPublishedExtension()).rejects.toThrow();
  });
});
