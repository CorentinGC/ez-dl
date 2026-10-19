"""Route `GET /api/capabilities` — encodeurs détectés et presets de conversion disponibles."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from app.core.ffmpeg import available_presets, build_conversion_args, relevant_encoders
from app.schemas import CapabilitiesResponse, EncoderOut, PresetOut
from app.security import require_auth

router = APIRouter(tags=["capabilities"], dependencies=[Depends(require_auth)])


@router.get("/capabilities", response_model=CapabilitiesResponse)
async def get_capabilities(request: Request) -> CapabilitiesResponse:
    """Liste les encodeurs ffmpeg détectés et les presets de conversion disponibles."""
    encoders = request.app.state.encoders
    presets = available_presets(encoders)
    return CapabilitiesResponse(
        proxy_enabled=bool(request.app.state.settings.proxy),
        encoders=[
            EncoderOut(id=e.id, name=e.name, hwaccel=e.hwaccel, codec=e.codec)
            for e in relevant_encoders(encoders)
        ],
        presets=[
            PresetOut(
                id=p.id,
                label=p.label,
                description=p.description,
                container=p.container,
                video_codec=p.video_codec,
                args_preview=" ".join(build_conversion_args(p, "input", "output")),
            )
            for p in presets
        ],
    )
