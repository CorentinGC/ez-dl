/**
 * Tests des groupes de statuts de job : ils pilotent l'affichage des boutons de la popup et
 * doivent rester alignés sur les ensembles du serveur, sinon un bouton déclenche un 409.
 *
 * @author ez-dl
 */

import { describe, expect, it } from 'vitest';
import { hasStoredFile, isActive, isPausable, isRemovable, isResumable } from './jobStatus';
import type { Job, JobStatus } from './types';

function jobWith(status: JobStatus): Job {
  return {
    id: 'job-1',
    url: 'https://example.com/video',
    title: null,
    filename: 'video.mp4',
    folder: '/data/downloads',
    status,
    progress: 0,
    speed: null,
    eta: null,
    size: null,
    error: null,
    preset_id: null,
    format_id: null,
    created_at: '2026-08-21T22:00:00Z',
    updated_at: '2026-08-21T22:00:00Z',
  };
}

describe('groupes de statuts', () => {
  it('considère actifs les seuls statuts encore pris en charge par la file', () => {
    for (const status of ['queued', 'probing', 'downloading', 'converting', 'moving'] as JobStatus[]) {
      expect(isActive(jobWith(status))).toBe(true);
    }
    for (const status of ['done', 'error', 'paused', 'canceled'] as JobStatus[]) {
      expect(isActive(jobWith(status))).toBe(false);
    }
  });

  it('rend supprimable tout job non actif — done et error compris', () => {
    // Sans ça, un job terminé ou en erreur reste dans la liste sans aucun moyen de l'en sortir.
    for (const status of ['done', 'error', 'paused', 'canceled'] as JobStatus[]) {
      expect(isRemovable(jobWith(status))).toBe(true);
    }
    expect(isRemovable(jobWith('downloading'))).toBe(false);
  });

  it('n’autorise la pause que sur les statuts acceptés par le serveur', () => {
    expect(isPausable(jobWith('downloading'))).toBe(true);
    expect(isPausable(jobWith('queued'))).toBe(true);
    expect(isPausable(jobWith('converting'))).toBe(false);
    expect(isPausable(jobWith('paused'))).toBe(false);
  });

  it('ne reconnaît un fichier déposé que sur un job terminé', () => {
    // Le serveur refuse (409) d'effacer le fichier d'un job non terminé : proposer le choix
    // ailleurs que sur `done` mènerait à une modale dont une option échoue toujours.
    expect(hasStoredFile(jobWith('done'))).toBe(true);
    for (const status of ['error', 'canceled', 'paused', 'downloading'] as JobStatus[]) {
      expect(hasStoredFile(jobWith(status))).toBe(false);
    }
  });

  it('ne propose pas d’effacer un fichier quand le nom de fichier est vide', () => {
    // `JobOut.filename` est optionnel côté serveur : sans nom, il n'y a pas de chemin à viser.
    expect(hasStoredFile({ ...jobWith('done'), filename: '' })).toBe(false);
  });

  it('autorise la reprise après pause comme le retry après échec ou annulation', () => {
    expect(isResumable(jobWith('paused'))).toBe(true);
    expect(isResumable(jobWith('error'))).toBe(true);
    expect(isResumable(jobWith('canceled'))).toBe(true);
    expect(isResumable(jobWith('done'))).toBe(false);
    expect(isResumable(jobWith('downloading'))).toBe(false);
  });
});
