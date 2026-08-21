"""Routes `GET`/`POST /api/probe` — interrogation de yt-dlp pour une URL."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.core import ytdlp
from app.core.cookies import cookie_jar_file
from app.schemas import FormatOut, MediaUrl, ProbeRequest, ProbeResponse
from app.security import require_auth

router = APIRouter(tags=["probe"], dependencies=[Depends(require_auth)])


async def _do_probe(request: Request, url: str, body: ProbeRequest | None) -> ProbeResponse:
    """Factorise l'appel `yt-dlp` partagé entre les variantes GET et POST."""
    settings = request.app.state.settings
    cookies = body.cookies if body else None
    headers = body.headers if body else None
    referer = body.referer if body else None
    with cookie_jar_file(cookies, settings.temp_dir) as cookies_file:
        try:
            info = await ytdlp.probe(
                url,
                binary=settings.ytdlp_binary,
                cookies_file=cookies_file,
                headers=headers,
                referer=referer,
            )
        except ytdlp.YtDlpError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
    return ProbeResponse(
        url=url,
        title=info.get("title"),
        uploader=info.get("uploader"),
        duration=info.get("duration"),
        thumbnail=info.get("thumbnail"),
        extractor=info.get("extractor"),
        formats=[FormatOut(**f) for f in info["formats"]],
        best_format_id=info.get("best_format_id"),
        suggested_filename=info["suggested_filename"],
    )


@router.get("/probe", response_model=ProbeResponse)
async def probe_get(request: Request, url: Annotated[MediaUrl, Query()]) -> ProbeResponse:
    """Analyse une URL vidéo (sans contexte de page authentifiée)."""
    return await _do_probe(request, url, None)


@router.post("/probe", response_model=ProbeResponse)
async def probe_post(request: Request, body: ProbeRequest) -> ProbeResponse:
    """Analyse une URL vidéo avec cookies/headers/referer (pages authentifiées)."""
    return await _do_probe(request, body.url, body)
