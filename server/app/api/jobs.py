"""Routes `/api/jobs` : création, liste, détail, suppression/annulation, flux SSE."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlmodel import Session, select
from sse_starlette.sse import EventSourceResponse

from app.core.paths import PathSecurityError, resolve_destination, sanitize_filename
from app.core.queue import JobContext
from app.db import get_session
from app.models import Job, JobStatus
from app.schemas import JobCreate, JobCreateResponse, JobOut
from app.security import require_auth

router = APIRouter(tags=["jobs"], dependencies=[Depends(require_auth)])

_HEARTBEAT_SECONDS = 15
_ACTIVE_STATUSES = {
    JobStatus.QUEUED,
    JobStatus.PROBING,
    JobStatus.DOWNLOADING,
    JobStatus.CONVERTING,
    JobStatus.MOVING,
}


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
    job = session.get(Job, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job introuvable")
    return job


@router.delete("/jobs/{job_id}", status_code=204)
async def delete_job(
    job_id: str, request: Request, session: Session = Depends(get_session)
) -> Response:
    """Annule un job actif, ou le supprime de l'historique s'il est déjà terminé."""
    queue = request.app.state.job_queue
    job = session.get(Job, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job introuvable")

    if JobStatus(job.status) in _ACTIVE_STATUSES:
        queue.cancel(job_id)
        if job.status == JobStatus.QUEUED.value:
            job.status = JobStatus.CANCELED.value
            session.add(job)
            session.commit()
            session.refresh(job)
            queue.broadcaster.publish(job)
    else:
        session.delete(job)
        session.commit()
    return Response(status_code=204)
