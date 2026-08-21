/**
 * Groupes de statuts de job, miroir exact des ensembles du serveur
 * (`_ACTIVE_STATUSES`, `_PAUSABLE_STATUSES`, `_RESUMABLE_STATUSES` dans
 * `server/app/api/jobs.py`). Toute divergence produit un bouton qui déclenche un 409.
 *
 * @author ez-dl
 */

import type { Job, JobStatus } from './types';

/** Job encore pris en charge par la file : `DELETE` l'**annule** au lieu de le supprimer. */
const ACTIVE_STATUSES: JobStatus[] = ['queued', 'probing', 'downloading', 'converting', 'moving'];

/** Seuls statuts acceptés par `POST /api/jobs/{id}/pause`. */
const PAUSABLE_STATUSES: JobStatus[] = ['queued', 'downloading'];

/** Statuts acceptés par `POST /api/jobs/{id}/resume` (reprise d'une pause ou retry). */
const RESUMABLE_STATUSES: JobStatus[] = ['paused', 'error', 'canceled'];

/**
 * Le job tourne encore côté serveur.
 *
 * @param job - Job à tester.
 * @returns `true` si un `DELETE` l'annulerait (le job reste dans l'historique en `canceled`).
 */
export function isActive(job: Job): boolean {
  return ACTIVE_STATUSES.includes(job.status);
}

/**
 * Le job peut être suspendu.
 *
 * @param job - Job à tester.
 * @returns `true` si `POST /pause` est accepté pour ce statut.
 */
export function isPausable(job: Job): boolean {
  return PAUSABLE_STATUSES.includes(job.status);
}

/**
 * Le job peut être relancé — reprise depuis le fichier partiel, ou retry après échec.
 *
 * @param job - Job à tester.
 * @returns `true` si `POST /resume` est accepté pour ce statut.
 */
export function isResumable(job: Job): boolean {
  return RESUMABLE_STATUSES.includes(job.status);
}

/**
 * Le job peut être retiré définitivement de l'historique.
 *
 * Un job actif n'est jamais « supprimable » : son `DELETE` l'annule d'abord, et c'est un
 * second `DELETE` (une fois en `canceled`) qui le retire réellement de la liste.
 *
 * @param job - Job à tester.
 * @returns `true` si un `DELETE` retire la ligne de l'historique.
 */
export function isRemovable(job: Job): boolean {
  return !isActive(job);
}

/**
 * Le job a déposé un fichier à sa destination — donc « Supprimer » a deux sens distincts
 * (retirer de la liste / effacer aussi le fichier) et mérite une confirmation.
 *
 * Seul `done` compte : un job échoué ou annulé n'a jamais écrit sa destination, et le serveur
 * refuse (`409`) d'effacer un fichier pour lui.
 *
 * @param job - Job à tester.
 * @returns `true` si un fichier téléchargé correspond à ce job.
 */
export function hasStoredFile(job: Job): boolean {
  return job.status === 'done' && Boolean(job.filename);
}
