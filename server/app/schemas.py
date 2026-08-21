"""Schémas pydantic d'entrée/sortie de l'API (distincts des modèles SQLModel de persistance)."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Annotated

from pydantic import AfterValidator, BaseModel, ConfigDict, Field

from app.models import JobStatus, RuleSource

_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")


def _validate_media_url(value: str) -> str:
    """Restreint les URL soumises à http/https. Défense en profondeur : `yt-dlp` reçoit déjà
    l'URL après un `--`, mais un schéma libre ouvrirait `file://` et les URL en `-`."""
    if not value.startswith(("http://", "https://")):
        raise ValueError("URL invalide : seuls les schémas http:// et https:// sont acceptés.")
    return value


def _reject_control_chars(value: str) -> str:
    """Refuse les caractères de contrôle : dans un cookie ils casseraient le format TSV du
    cookie-jar Netscape, et yt-dlp recopierait alors la ligne fautive sur stderr."""
    if _CONTROL_CHARS.search(value):
        raise ValueError("Caractère de contrôle interdit.")
    return value


MediaUrl = Annotated[str, AfterValidator(_validate_media_url)]
CookieField = Annotated[str, AfterValidator(_reject_control_chars)]


class CookieItem(BaseModel):
    """Un cookie transmis par l'extension pour une requête authentifiée."""

    model_config = ConfigDict(populate_by_name=True)

    name: CookieField
    value: CookieField
    domain: CookieField
    path: CookieField = "/"
    secure: bool = False
    http_only: bool = Field(default=False, alias="httpOnly")
    expires: float | None = None


class ProbeRequest(BaseModel):
    """Corps de `POST /api/probe` : URL + contexte optionnel (cookies, headers, referer)."""

    url: MediaUrl
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
    """Une racine de téléchargement autorisée.

    `is_available` est faux quand la racine est déclarée mais absente/non inscriptible côté
    serveur : le client doit la montrer désactivée plutôt que de laisser créer un job voué
    à un `400`. L'espace disque est `None` quand il n'a pas pu être lu.
    """

    label: str
    path: str
    is_available: bool = True
    free_bytes: int | None = None
    total_bytes: int | None = None


class FolderEntryOut(BaseModel):
    """Une entrée (fichier ou dossier) d'un répertoire listé."""

    name: str
    path: str
    is_dir: bool


class CurrentFolderOut(BaseModel):
    """Le dossier actuellement navigué, avec l'espace disque du volume qui le porte."""

    path: str
    label: str
    free_bytes: int | None = None
    total_bytes: int | None = None


class FolderCreate(BaseModel):
    """Corps de `POST /api/folders` : création d'un sous-dossier sous une racine autorisée.

    Les longueurs sont bornées ici : sans cela, un chemin dépassant `PATH_MAX` fait remonter
    `ENAMETOOLONG` depuis les appels système (`500` au lieu d'un `400` explicite).
    """

    parent: str = Field(max_length=1024)
    name: str = Field(min_length=1, max_length=180)


class FoldersResponse(BaseModel):
    """Résultat de la navigation dans les racines de téléchargement."""

    roots: list[RootOut]
    current: CurrentFolderOut | None = None
    entries: list[FolderEntryOut]
    parent: str | None = None


class JobCreate(BaseModel):
    """Corps de `POST /api/jobs`."""

    url: MediaUrl
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
    speed: float | None = None  # octets/s
    eta: int | None = None  # secondes restantes
    size: int | None = None  # octets
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
