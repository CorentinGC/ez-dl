/**
 * Vue "Jobs" de la popup : liste des jobs de téléchargement avec barre de progression,
 * vitesse, ETA et actions (pause, reprise/retry, annulation, suppression). `aria-live` sur
 * la liste pour annoncer les mises à jour.
 */

import { formatEta, formatProgress, formatSize, formatSpeed } from '@/src/lib/format';
import { isActive, isPausable, isResumable } from '@/src/lib/jobStatus';
import type { Job, JobStatus } from '@/src/lib/types';
import type { JobsConnectionMode } from '../hooks/useJobs';

interface JobsViewProps {
  jobs: Job[];
  connectionMode: JobsConnectionMode;
  actionError: string | null;
  onCancel: (job: Job) => void;
  onPause: (id: string) => void;
  onResume: (job: Job) => void;
}

const STATUS_LABELS: Record<JobStatus, string> = {
  queued: 'En attente',
  probing: 'Analyse',
  downloading: 'Téléchargement',
  converting: 'Conversion',
  moving: 'Déplacement',
  done: 'Terminé',
  error: 'Erreur',
  paused: 'Suspendu',
  canceled: 'Annulé',
};

export function JobsView({ jobs, connectionMode, actionError, onCancel, onPause, onResume }: JobsViewProps) {
  if (jobs.length === 0) {
    return (
      <p className="loading-hint" role="status">
        Aucun job pour le moment.
      </p>
    );
  }

  return (
    <div className="jobs-view">
      {connectionMode === 'polling' ? <p className="jobs-connection-hint">Suivi périodique (flux en direct indisponible)</p> : null}
      {actionError ? (
        <p className="field-error" role="alert">
          {actionError}
        </p>
      ) : null}
      <ul className="jobs-list" aria-live="polite">
        {jobs.map((job) => (
          <li key={job.id}>
            <JobRow
              job={job}
              onCancel={() => onCancel(job)}
              onPause={() => onPause(job.id)}
              onResume={() => onResume(job)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function JobRow({
  job,
  onCancel,
  onPause,
  onResume,
}: {
  job: Job;
  onCancel: () => void;
  onPause: () => void;
  onResume: () => void;
}) {
  // job.progress est déjà un pourcentage 0.0–100.0 (contrat serveur), pas une fraction 0–1.
  const progressPct = job.progress !== null ? Math.round(Math.min(Math.max(job.progress, 0), 100)) : null;
  // Même route `DELETE`, deux actions distinctes : sur un job en cours elle **annule** le
  // téléchargement (la ligne reste, en « Annulé ») ; sur un job terminé elle le **retire**
  // de l'historique. Tout job a donc toujours une sortie, y compris `done` et `error`.
  const active = isActive(job);
  const pausable = isPausable(job);
  const resumable = isResumable(job);
  const label = job.title || job.filename;

  return (
    <article className="job-row">
      <div className="job-row-header">
        <p className="job-row-title" title={label}>
          {label}
        </p>
        <span className={`job-status job-status-${job.status}`}>{STATUS_LABELS[job.status]}</span>
      </div>

      {progressPct !== null ? (
        <div
          className="job-progress"
          role="progressbar"
          aria-valuenow={progressPct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Progression du job : ${formatProgress(job.progress)}`}
        >
          <div className="job-progress-bar" style={{ width: `${progressPct}%` }} />
        </div>
      ) : null}

      <p className="job-row-meta">
        {[
          formatProgress(job.progress),
          formatSpeed(job.speed),
          job.eta !== null ? `ETA ${formatEta(job.eta)}` : null,
          job.size !== null ? formatSize(job.size) : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>

      {job.error ? (
        <p className="field-error" role="alert">
          {job.error}
        </p>
      ) : null}

      <div className="job-row-actions">
        {pausable ? (
          <button type="button" className="btn btn-ghost btn-small" onClick={onPause}>
            Pause
          </button>
        ) : null}
        {resumable ? (
          <button type="button" className="btn btn-ghost btn-small" onClick={onResume}>
            {job.status === 'paused' ? 'Reprendre' : 'Réessayer'}
          </button>
        ) : null}
        <button type="button" className="btn btn-ghost btn-small" onClick={onCancel}>
          {active ? 'Annuler' : 'Supprimer'}
        </button>
      </div>
    </article>
  );
}
