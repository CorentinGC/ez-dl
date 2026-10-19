"""Réconciliation de la base et du disque au démarrage de la file de jobs."""

from __future__ import annotations

from pathlib import Path

from sqlalchemy.engine import Engine
from sqlmodel import Session, select

from app.core.workdir import purge_temp_residue
from app.models import Job, JobStatus, utcnow

_STUCK_STATUSES = [
    JobStatus.PROBING.value,
    JobStatus.DOWNLOADING.value,
    JobStatus.CONVERTING.value,
    JobStatus.MOVING.value,
]

# Message porté par un job suspendu par un arrêt du serveur : la reprise est possible, ce
# n'est donc pas une erreur, mais l'UI doit pouvoir expliquer pourquoi le job s'est arrêté.
INTERRUPTED_MESSAGE = "Interrompu par un redémarrage du serveur"

# Statuts dont le dossier de travail doit survivre à un redémarrage : leur fichier partiel
# est encore exploitable par une reprise.
_RESUMABLE_STATUSES = [
    JobStatus.QUEUED.value,
    JobStatus.PAUSED.value,
    JobStatus.ERROR.value,
]


def recover_interrupted_jobs(engine: Engine) -> None:
    """Suspend les jobs restés en cours lors de l'arrêt précédent.

    Ils passent en `paused` et non en `error` : leur fichier partiel est toujours dans
    le dossier de travail, une reprise repartira de là (à condition qu'`EZDL_TEMP_DIR`
    survive au redémarrage — voir docs/fr/setup.md).
    """
    with Session(engine) as session:
        jobs = session.exec(select(Job).where(Job.status.in_(_STUCK_STATUSES))).all()
        if not jobs:
            return
        for job in jobs:
            job.status = JobStatus.PAUSED
            job.error = INTERRUPTED_MESSAGE
            job.speed = None
            job.eta = None
            job.updated_at = utcnow()
            session.add(job)
        session.commit()


def queued_job_ids(engine: Engine) -> list[str]:
    """Identifiants des jobs `queued` en base, du plus ancien au plus récent.

    La file d'attente vit en mémoire : après un redémarrage, ces jobs n'ont plus d'entrée
    et resteraient `queued` pour toujours.
    """
    with Session(engine) as session:
        statement = (
            select(Job.id).where(Job.status == JobStatus.QUEUED.value).order_by(Job.created_at)
        )
        return list(session.exec(statement).all())


def purge_stale_temp_residue(engine: Engine, temp_dir: Path) -> None:
    """Nettoie `EZDL_TEMP_DIR` des restes de l'exécution précédente.

    À appeler **après** `recover_interrupted_jobs`, pour que les jobs coupés par l'arrêt
    précédent soient déjà repassés en `paused` et gardent donc leur fichier partiel.
    """
    with Session(engine) as session:
        resumable = {
            job.id for job in session.exec(select(Job).where(Job.status.in_(_RESUMABLE_STATUSES)))
        }
    purge_temp_residue(temp_dir, resumable)
