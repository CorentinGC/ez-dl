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
