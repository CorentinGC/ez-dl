/**
 * Suivi des jobs de téléchargement : flux SSE authentifié `/api/jobs/events` en premier choix,
 * repli automatique sur le polling `GET /api/jobs` (toutes les 2s) si le flux échoue.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { type ApiClient, createApiClient, toApiConfig } from '@/src/lib/api';
import { isServerConfigured } from '@/src/lib/storage';
import type { ExtensionSettings, Job } from '@/src/lib/types';

const POLL_INTERVAL_MS = 2000;

export type JobsConnectionMode = 'idle' | 'sse' | 'polling';

export interface UseJobsResult {
  jobs: Job[];
  connectionMode: JobsConnectionMode;
  cancelJob: (id: string) => Promise<void>;
}

export function useJobs(settings: ExtensionSettings | null): UseJobsResult {
  const [jobsById, setJobsById] = useState<Map<string, Job>>(new Map());
  const [connectionMode, setConnectionMode] = useState<JobsConnectionMode>('idle');
  const clientRef = useRef<ApiClient | null>(null);

  useEffect(() => {
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

  const cancelJob = useCallback(async (id: string) => {
    await clientRef.current?.deleteJob(id);
    setJobsById((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const jobs = Array.from(jobsById.values()).sort((a, b) => b.created_at.localeCompare(a.created_at));

  return { jobs, connectionMode, cancelJob };
}
