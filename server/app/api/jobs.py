"""Routes `/api/jobs` : création, liste, détail, suppression/annulation, flux SSE."""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlmodel import Session, select
from sse_starlette.sse import EventSourceResponse

from app.core.paths import (
    PathSecurityError,
    remove_destination_file,
    resolve_destination,
    sanitize_filename,
)
from app.core.queue import JobContext
from app.db import get_session
from app.models import Job, JobStatus
from app.schemas import JobCreate, JobCreateResponse, JobOut, JobResume
from app.security import require_auth

logger = logging.getLogger(__name__)

router = APIRouter(tags=["jobs"], dependencies=[Depends(require_auth)])

_HEARTBEAT_SECONDS = 15
_ACTIVE_STATUSES = {
    JobStatus.QUEUED,
    JobStatus.PROBING,
    JobStatus.DOWNLOADING,
    JobStatus.CONVERTING,
    JobStatus.MOVING,
}
# Suspendre une conversion ou un déplacement n'aurait rien de reprenable : ffmpeg n'a pas
# d'état intermédiaire exploitable, et un déplacement dure le temps d'un `rename`.
_PAUSABLE_STATUSES = {JobStatus.QUEUED, JobStatus.DOWNLOADING}
# `error`/`canceled` sont repris de la même façon qu'une pause : c'est le fichier partiel
# éventuellement présent qui décide du travail réellement refait, pas le statut d'origine.
_RESUMABLE_STATUSES = {JobStatus.PAUSED, JobStatus.ERROR, JobStatus.CANCELED}


@router.post("/jobs", response_model=JobCreateResponse, status_code=201)
async def create_job(
    request: Request, body: JobCreate, session: Session = Depends(get_session)
) -> JobCreateResponse:
    """Crée un job de téléchargement, valide la destination, l'ajoute à la file."""
    settings = request.app.state.settings
    filename = sanitize_filename(body.filename or body.title or "download")
    try:
        resolve_destination(body.folder, filename, settings.roots)
    except PathSecurityError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    job = Job(
        id=str(uuid.uuid4()),
        url=body.url,
        title=body.title,
        filename=filename,
        folder=body.folder,
        status=JobStatus.QUEUED.value,
        preset_id=body.preset_id,
        format_id=body.format_id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    context = JobContext(cookies=body.cookies, headers=body.headers, referer=body.referer)
    request.app.state.job_queue.enqueue(job.id, context)
    return JobCreateResponse(job_id=job.id, status=JobStatus(job.status))


@router.get("/jobs", response_model=list[JobOut])
async def list_jobs(session: Session = Depends(get_session)) -> list[Job]:
    """Liste tous les jobs (historique inclus), plus récents en premier."""
    return list(session.exec(select(Job).order_by(Job.created_at.desc())).all())


@router.get("/jobs/events")
async def job_events(request: Request) -> EventSourceResponse:
    """Flux SSE des mises à jour de jobs (event `job`), avec heartbeat périodique."""
    broadcaster = request.app.state.job_queue.broadcaster
    subscriber = broadcaster.subscribe()

    async def event_generator() -> AsyncIterator[dict[str, str]]:
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    job = await asyncio.wait_for(subscriber.get(), timeout=_HEARTBEAT_SECONDS)
                    yield {"event": "job", "data": JobOut.model_validate(job).model_dump_json()}
                except TimeoutError:
                    yield {"event": "heartbeat", "data": ""}
        finally:
            broadcaster.unsubscribe(subscriber)

    return EventSourceResponse(event_generator())


@router.get("/jobs/{job_id}", response_model=JobOut)
async def get_job(job_id: str, session: Session = Depends(get_session)) -> Job:
    """Détail d'un job."""
    return _job_or_404(session, job_id)


@router.post("/jobs/{job_id}/pause", response_model=JobOut)
async def pause_job(
    job_id: str, request: Request, session: Session = Depends(get_session)
) -> Job:
    """Suspend un job en attente ou en cours de téléchargement.

    Le fichier partiel est conservé : la reprise repart de là plutôt que du début.
    """
    job = _job_or_404(session, job_id)
    _require_status(job, _PAUSABLE_STATUSES, "suspendu")
    queue = request.app.state.job_queue
    queue.pause(job_id)
    if job.status != JobStatus.QUEUED.value:
        # Job en cours : c'est l'arrêt du process yt-dlp qui fera basculer le statut, une
        # fois la phase de téléchargement dénouée. Ne pas anticiper l'écriture.
        return job
    # Job encore en attente : aucun process à interrompre, le worker verra le statut en
    # dépilant l'entrée devenue obsolète.
    return queue.update(job_id, status=JobStatus.PAUSED, speed=None, eta=None) or job


@router.post("/jobs/{job_id}/resume", response_model=JobOut)
async def resume_job(
    job_id: str,
    request: Request,
    body: JobResume | None = None,
    session: Session = Depends(get_session),
) -> Job:
    """Reprend un job suspendu, en erreur ou annulé (retry).

    La destination est **re-validée** : reprendre un job vers une racine entre-temps
    démontée doit échouer tout de suite, pas après le téléchargement. Le contexte
    d'authentification (cookies/headers/referer) n'étant jamais persisté, c'est au client de
    le re-fournir s'il est nécessaire.
    """
    job = _job_or_404(session, job_id)
    _require_status(job, _RESUMABLE_STATUSES, "repris")
    settings = request.app.state.settings
    try:
        resolve_destination(job.folder, job.filename or job.url, settings.roots)
    except PathSecurityError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    queue = request.app.state.job_queue
    context = JobContext(
        cookies=body.cookies if body else None,
        headers=body.headers if body else None,
        referer=body.referer if body else None,
    )
    resumed = queue.update(job_id, status=JobStatus.QUEUED, error=None, speed=None, eta=None)
    queue.enqueue(job_id, context)
    return resumed or job


@router.delete("/jobs/{job_id}", status_code=204)
async def delete_job(
    job_id: str,
    request: Request,
    delete_file: bool = Query(
        default=False,
        description="Effacer aussi le fichier téléchargé (jobs « done » uniquement).",
    ),
    session: Session = Depends(get_session),
) -> Response:
    """Annule un job actif, ou le supprime de l'historique s'il est déjà terminé.

    Par défaut le fichier téléchargé n'est **pas** touché : seule la ligne d'historique (et le
    dossier de travail temporaire) disparaît. `delete_file=true` efface en plus le fichier
    final, et n'est accepté que sur un job `done` — c'est le seul statut pour lequel le
    serveur a lui-même écrit ce chemin exact. Sur les autres, `folder`/`filename` ne sont
    qu'une destination *prévue* : elle peut désigner le fichier d'un job voisin homonyme.
    """
    queue = request.app.state.job_queue
    job = _job_or_404(session, job_id)

    if delete_file and JobStatus(job.status) is not JobStatus.DONE:
        raise HTTPException(
            status_code=409,
            detail=f"Un job « {job.status} » n'a pas de fichier téléchargé à effacer.",
        )

    if JobStatus(job.status) in _ACTIVE_STATUSES:
        queue.cancel(job_id)
        if job.status == JobStatus.QUEUED.value:
            # Jamais dépilé : personne ne passera derrière pour purger son dossier de
            # travail (une reprise annulée peut en avoir laissé un).
            queue.update(job_id, status=JobStatus.CANCELED, speed=None, eta=None)
            queue.discard_work_dir(job_id)
    else:
        if delete_file and job.filename:
            _remove_downloaded_file(request, job)
        session.delete(job)
        session.commit()
        queue.discard_work_dir(job_id)
    return Response(status_code=204)


def _remove_downloaded_file(request: Request, job: Job) -> None:
    """Efface le fichier produit par un job terminé, avant de retirer sa ligne d'historique.

    Le fichier part **avant** le `session.delete` : si la suppression échoue (racine démontée,
    permissions), le job reste dans la liste et l'utilisateur peut réessayer, plutôt que de
    perdre la seule référence au fichier resté sur le disque.
    """
    settings = request.app.state.settings
    try:
        removed = remove_destination_file(job.folder, job.filename or "", settings.roots)
    except PathSecurityError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        # Typiquement un volume monté en lecture seule ou un uid sans droit d'écriture : la
        # cause précise va dans les logs de l'opérateur, pas dans la réponse HTTP.
        logger.warning("Job %s : échec de la suppression du fichier — %s", job.id, exc)
        raise HTTPException(
            status_code=500,
            detail="Impossible d'effacer le fichier sur le serveur. Voir les logs du serveur.",
        ) from exc
    if not removed:
        logger.info("Job %s : fichier déjà absent de la destination, rien à effacer.", job.id)


def _job_or_404(session: Session, job_id: str) -> Job:
    """Retourne le job demandé, ou lève un 404."""
    job = session.get(Job, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job introuvable")
    return job


def _require_status(job: Job, allowed: set[JobStatus], action: str) -> None:
    """Refuse (409) une transition demandée depuis un statut qui ne la permet pas."""
    if JobStatus(job.status) not in allowed:
        raise HTTPException(
            status_code=409,
            detail=f"Un job « {job.status} » ne peut pas être {action}.",
        )
