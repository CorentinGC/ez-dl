"""Route publique `GET /api/health` — aucune authentification requise."""

from __future__ import annotations

from fastapi import APIRouter, Request

from app.config import APP_VERSION
from app.schemas import HealthResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
async def health(request: Request) -> HealthResponse:
    """Statut du serveur : version de l'app, version yt-dlp, disponibilité ffmpeg."""
    state = request.app.state
    return HealthResponse(
        status="ok",
        version=APP_VERSION,
        ytdlp_version=getattr(state, "ytdlp_version", None),
        ffmpeg_available=bool(getattr(state, "ffmpeg_available", False)),
    )
