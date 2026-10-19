"""Routes `GET`/`POST /api/probe` — interrogation de yt-dlp pour une URL."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.core import ytdlp
from app.core.cookies import cookie_jar_file
from app.core.probe_cache import ClientDisconnectedError, coordinator, probe_key
from app.schemas import FormatOut, MediaUrl, ProbeRequest, ProbeResponse
from app.security import require_auth

router = APIRouter(tags=["probe"], dependencies=[Depends(require_auth)])

#: Seules clés du JSON yt-dlp lues par la réponse : le cache n'en garde pas plus (le `-J`
#: complet, sous-titres et vignettes compris, pèse souvent plusieurs centaines de Ko).
_RESPONSE_KEYS = (
    "title",
    "uploader",
    "duration",
    "thumbnail",
    "extractor",
    "formats",
    "best_format_id",
    "suggested_filename",
)

# Code non standard (convention nginx) : le client a fermé la connexion avant la réponse.
_CLIENT_CLOSED_REQUEST = 499


async def _do_probe(
    request: Request, url: str, playlist_items: int | None, body: ProbeRequest | None
) -> ProbeResponse:
    """Factorise l'appel `yt-dlp` partagé entre les variantes GET et POST."""
    settings = request.app.state.settings
    cookies = body.cookies if body else None
    headers = body.headers if body else None
    referer = body.referer if body else None

    async def run_probe() -> dict:
        # Le cookie-jar vit dans la tâche partagée : elle peut survivre au premier demandeur.
        with cookie_jar_file(cookies, settings.temp_dir) as cookies_file:
            info = await ytdlp.probe(
                url,
                binary=settings.ytdlp_binary,
                cookies_file=cookies_file,
                headers=headers,
                referer=referer,
                proxy=settings.proxy,
                playlist_items=playlist_items,
                timeout=settings.probe_timeout_seconds,
            )
        return {key: info.get(key) for key in _RESPONSE_KEYS}

    key = probe_key(
        url,
        playlist_items,
        [c.model_dump(by_alias=True) for c in cookies] if cookies else None,
        headers,
        referer,
    )
    try:
        info = await coordinator.run(key, run_probe, request.is_disconnected)
    except ClientDisconnectedError as exc:
        raise HTTPException(status_code=_CLIENT_CLOSED_REQUEST, detail="Client déconnecté") from exc
    except ytdlp.YtDlpListingError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
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
async def probe_get(
    request: Request,
    url: Annotated[MediaUrl, Query()],
    playlist_items: Annotated[int | None, Query(ge=1, le=50)] = None,
) -> ProbeResponse:
    """Analyse une URL vidéo (sans contexte de page authentifiée)."""
    return await _do_probe(request, url, playlist_items, None)


@router.post("/probe", response_model=ProbeResponse)
async def probe_post(request: Request, body: ProbeRequest) -> ProbeResponse:
    """Analyse une URL vidéo avec cookies/headers/referer (pages authentifiées)."""
    return await _do_probe(request, body.url, body.playlist_items, body)
