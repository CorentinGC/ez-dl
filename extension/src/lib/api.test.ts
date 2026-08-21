/**
 * Tests du parsing SSE de api.ts : les frames doivent être reconnus quelle que soit la
 * convention de fin de ligne du serveur (`\n` simple ou `\r\n` façon sse-starlette).
 */

import { describe, expect, it } from 'vitest';
import { errorMessageFromBody, parseJobFrame, splitSseFrames } from './api';

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
