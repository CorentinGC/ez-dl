"""Schémas pydantic d'entrée/sortie de l'API (distincts des modèles SQLModel de persistance)."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models import JobStatus, RuleSource


class CookieItem(BaseModel):
    """Un cookie transmis par l'extension pour une requête authentifiée."""

    model_config = ConfigDict(populate_by_name=True)

    name: str
    value: str
    domain: str
    path: str = "/"
    secure: bool = False
    http_only: bool = Field(default=False, alias="httpOnly")
    expires: float | None = None


class ProbeRequest(BaseModel):
    """Corps de `POST /api/probe` : URL + contexte optionnel (cookies, headers, referer)."""

    url: str
    cookies: list[CookieItem] | None = None
    headers: dict[str, str] | None = None
    referer: str | None = None


class FormatOut(BaseModel):
    """Un format téléchargeable proposé par yt-dlp, normalisé pour l'UI."""

    format_id: str
    ext: str
    height: int | None = None
    width: int | None = None
    fps: float | None = None
    vcodec: str | None = None
    acodec: str | None = None
    filesize: int | None = None
    tbr: float | None = None
    label: str
    has_audio: bool
    has_video: bool


class ProbeResponse(BaseModel):
    """Résultat d'une analyse d'URL."""

    url: str
    title: str | None = None
    uploader: str | None = None
    duration: float | None = None
    thumbnail: str | None = None
    extractor: str | None = None
    formats: list[FormatOut]
    best_format_id: str | None = None
    suggested_filename: str


class EncoderOut(BaseModel):
    """Un encodeur ffmpeg détecté sur le serveur."""

    id: str
    name: str
    hwaccel: str | None = None
    codec: str


class PresetOut(BaseModel):
    """Un preset de conversion proposé au client."""

    id: str
    label: str
    description: str
    container: str
    video_codec: str | None = None
    args_preview: str


class CapabilitiesResponse(BaseModel):
    """Encodeurs et presets disponibles sur ce serveur."""

    encoders: list[EncoderOut]
    presets: list[PresetOut]


class HealthResponse(BaseModel):
    """Statut public du serveur."""

    status: str
    version: str
    ytdlp_version: str | None = None
    ffmpeg_available: bool


class RootOut(BaseModel):
    """Une racine de téléchargement autorisée."""

    label: str
    path: str


class FolderEntryOut(BaseModel):
    """Une entrée (fichier ou dossier) d'un répertoire listé."""

    name: str
    path: str
    is_dir: bool


class CurrentFolderOut(BaseModel):
    """Le dossier actuellement navigué."""

    path: str
    label: str


class FoldersResponse(BaseModel):
    """Résultat de la navigation dans les racines de téléchargement."""

    roots: list[RootOut]
    current: CurrentFolderOut | None = None
    entries: list[FolderEntryOut]
    parent: str | None = None


class JobCreate(BaseModel):
    """Corps de `POST /api/jobs`."""

    url: str
    format_id: str | None = None
    folder: str
    filename: str | None = None
    preset_id: str | None = None
    cookies: list[CookieItem] | None = None
    headers: dict[str, str] | None = None
    referer: str | None = None
    title: str | None = None


class JobOut(BaseModel):
    """Représentation sérialisée d'un job."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    url: str
    title: str | None = None
    filename: str | None = None
    folder: str
    status: JobStatus
    progress: float
    speed: str | None = None
    eta: str | None = None
    size: str | None = None
    error: str | None = None
    preset_id: str | None = None
    format_id: str | None = None
    created_at: datetime
    updated_at: datetime


class JobCreateResponse(BaseModel):
    """Réponse de création d'un job."""

    job_id: str
    status: JobStatus


class RuleCreate(BaseModel):
    """Corps de `POST /api/rules`."""

    domain: str
    url_pattern: str
    label: str | None = None
    notes: str | None = None
    source: RuleSource = RuleSource.MANUAL


class RuleOut(BaseModel):
    """Représentation sérialisée d'une règle de site."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    domain: str
    url_pattern: str
    label: str | None = None
    notes: str | None = None
    source: RuleSource
    created_at: datetime
