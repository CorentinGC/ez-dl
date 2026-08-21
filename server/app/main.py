"""Point d'entrée de l'application FastAPI : lifespan (DB, auto-update yt-dlp, workers),
CORS, montage des routers, gestion d'erreurs."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api import capabilities, folders, health, jobs, probe, rules
from app.config import APP_VERSION, Settings, get_settings
from app.core import ffmpeg, ytdlp
from app.core.paths import PathSecurityError
from app.core.queue import JobQueue
from app.db import get_engine, init_db

logger = logging.getLogger(__name__)


def _configure_logging(level: str) -> None:
    """Configure le logging standard selon `EZDL_LOG_LEVEL`."""
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


async def _periodic_ytdlp_update(binary: str, interval_hours: int) -> None:
    """Boucle d'auto-update périodique de yt-dlp (désactivée si `interval_hours == 0`)."""
    if interval_hours <= 0:
        return
    while True:
        await asyncio.sleep(interval_hours * 3600)
        before = await ytdlp.version(binary)
        await ytdlp.update(binary)
        after = await ytdlp.version(binary)
        logger.info("Auto-update yt-dlp périodique : %s -> %s", before, after)


async def _bootstrap_state(app: FastAPI, settings: Settings) -> JobQueue:
    """Initialise DB, encodeurs ffmpeg, version yt-dlp et file de jobs ; peuple `app.state`."""
    engine = get_engine(settings)
    init_db(settings)

    encoders = await ffmpeg.detect_encoders(settings.ffmpeg_binary)
    # On ne journalise que les encodeurs utiles : `ffmpeg -encoders` en liste ~200.
    presets = ffmpeg.available_presets(encoders)
    logger.info(
        "%d encodeurs ffmpeg détectés, presets disponibles : %s",
        len(encoders),
        ", ".join(p.id for p in presets) or "aucun",
    )

    app.state.settings = settings
    app.state.engine = engine
    app.state.encoders = encoders
    app.state.ffmpeg_available = await ffmpeg.is_available(settings.ffmpeg_binary)
    app.state.ytdlp_version = await ytdlp.version(settings.ytdlp_binary)

    job_queue = JobQueue(settings, engine, encoders=encoders)
    await job_queue.start()
    app.state.job_queue = job_queue
    return job_queue


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Initialise l'état applicatif au démarrage, lance l'auto-update yt-dlp et les workers."""
    settings = get_settings()
    _configure_logging(settings.log_level)

    job_queue = await _bootstrap_state(app, settings)

    # Auto-update non bloquant au démarrage, puis boucle périodique.
    update_task = asyncio.create_task(ytdlp.update(settings.ytdlp_binary))
    periodic_task = asyncio.create_task(
        _periodic_ytdlp_update(settings.ytdlp_binary, settings.ytdlp_update_interval_hours)
    )

    try:
        yield
    finally:
        periodic_task.cancel()
        update_task.cancel()
        await job_queue.shutdown()


def create_app() -> FastAPI:
    """Construit l'application FastAPI (CORS, routers, gestion d'erreurs)."""
    settings = get_settings()
    app = FastAPI(title="ez-dl", version=APP_VERSION, lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[],
        allow_origin_regex=settings.cors_origin_regex,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(health.router, prefix="/api")
    app.include_router(capabilities.router, prefix="/api")
    app.include_router(probe.router, prefix="/api")
    app.include_router(folders.router, prefix="/api")
    app.include_router(jobs.router, prefix="/api")
    app.include_router(rules.router, prefix="/api")

    @app.exception_handler(PathSecurityError)
    async def _path_security_handler(request: Request, exc: PathSecurityError) -> JSONResponse:
        """Convertit toute erreur de sécurité de chemin en réponse 400."""
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    return app


app = create_app()
