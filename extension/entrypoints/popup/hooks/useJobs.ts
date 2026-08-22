/**
 * Suivi des jobs de téléchargement : flux SSE authentifié `/api/jobs/events` en premier choix,
 * repli automatique sur le polling `GET /api/jobs` (toutes les 2s) si le flux échoue.
 * Expose aussi les actions de la liste : annuler, suspendre, reprendre.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { type ApiClient, createApiClient, toApiConfig } from '@/src/lib/api';
import { isActive } from '@/src/lib/jobStatus';
import { isServerConfigured } from '@/src/lib/storage';
import type { ExtensionSettings, Job } from '@/src/lib/types';
import { readCookiesForUrl } from '@/src/lib/cookies';

const POLL_INTERVAL_MS = 2000;

export type JobsConnectionMode = 'idle' | 'sse' | 'polling';

export interface UseJobsResult {
  jobs: Job[];
  connectionMode: JobsConnectionMode;
  /** Dernière action de la liste ayant échoué (409, 400, serveur injoignable…), à afficher. */
  actionError: string | null;
  /** Annule (job en cours) ou retire de l'historique ; `deleteFile` efface aussi le fichier. */
  cancelJob: (job: Job, options?: { deleteFile?: boolean }) => Promise<void>;
  pauseJob: (id: string) => Promise<void>;
  resumeJob: (job: Job) => Promise<void>;
}

/** Message lisible d'une erreur d'API, avec repli si l'exception n'en porte pas. */
function actionMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function useJobs(settings: ExtensionSettings | null): UseJobsResult {
  const [jobsById, setJobsById] = useState<Map<string, Job>>(new Map());
  const [connectionMode, setConnectionMode] = useState<JobsConnectionMode>('idle');
  const [actionError, setActionError] = useState<string | null>(null);
  const clientRef = useRef<ApiClient | null>(null);
  const sendCookies = settings?.sendCookies ?? false;

  useEffect(() => {
    // Changement de serveur : la liste affichée appartient au serveur précédent, la garder
    // ferait cohabiter les jobs de deux machines jusqu'au premier rafraîchissement.
    setJobsById(new Map());
    setActionError(null);
    if (!settings || !isServerConfigured(settings)) {
      setConnectionMode('idle');
      return;
    }
    const client = createApiClient(toApiConfig(settings));
    clientRef.current = client;
    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let stopStream: (() => void) | null = null;

    const applyList = (list: Job[]) => setJobsById(new Map(list.map((job) => [job.id, job])));

    const startPolling = () => {
      if (pollTimer) return;
      setConnectionMode('polling');
      pollTimer = setInterval(() => {
        void client.listJobs().then(applyList).catch(() => undefined);
      }, POLL_INTERVAL_MS);
    };

    void (async () => {
      try {
        applyList(await client.listJobs());
      } catch {
        // Le flux SSE ci-dessous (ou le polling en repli) rattrapera l'état.
      }
      if (cancelled) return;
      stopStream = client.streamJobEvents(
        (job) => {
          setConnectionMode('sse');
          setJobsById((prev) => new Map(prev).set(job.id, job));
        },
        () => startPolling(),
      );
    })();

    return () => {
      cancelled = true;
      stopStream?.();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [settings]);

  const applyJob = useCallback((job: Job) => setJobsById((prev) => new Map(prev).set(job.id, job)), []);

  const cancelJob = useCallback(async (job: Job, options?: { deleteFile?: boolean }) => {
    const client = clientRef.current;
    if (!client) return;
    setActionError(null);
    try {
      await client.deleteJob(job.id, options);
    } catch (error) {
      // Retirer la ligne alors que le serveur a refusé donnerait une liste mensongère.
      setActionError(actionMessage(error, 'Impossible de supprimer ce job.'));
      return;
    }
    if (isActive(job)) {
      // Annulation, pas suppression : le serveur garde le job en `canceled` (reprenable).
      // Retirer la ligne ici la ferait réapparaître à la première mise à jour du flux —
      // c'est ce clignotement qui donnait l'impression que « Annuler » ne faisait rien.
      return;
    }
    setJobsById((prev) => {
      const next = new Map(prev);
      next.delete(job.id);
      return next;
    });
  }, []);

  const pauseJob = useCallback(
    async (id: string) => {
      const client = clientRef.current;
      if (!client) return;
      setActionError(null);
      try {
        applyJob(await client.pauseJob(id));
      } catch (error) {
        setActionError(actionMessage(error, 'Impossible de suspendre ce job.'));
      }
    },
    [applyJob],
  );

  const resumeJob = useCallback(
    async (job: Job) => {
      const client = clientRef.current;
      if (!client) return;
      setActionError(null);
      try {
        // Le serveur ne persiste aucun cookie : sans nouvelle lecture, une reprise sur un site
        // authentifié repartirait anonyme et échouerait.
        const cookies = sendCookies ? await readCookiesForUrl(job.url) : undefined;
        applyJob(await client.resumeJob(job.id, cookies?.length ? { cookies } : undefined));
      } catch (error) {
        setActionError(actionMessage(error, 'Impossible de reprendre ce job.'));
      }
    },
    [applyJob, sendCookies],
  );

  const jobs = Array.from(jobsById.values()).sort((a, b) => b.created_at.localeCompare(a.created_at));

  return { jobs, connectionMode, actionError, cancelJob, pauseJob, resumeJob };
}
