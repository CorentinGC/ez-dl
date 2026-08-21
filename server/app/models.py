"""Modèles SQLModel persistés : `Job` (téléchargement) et `SiteRule` (règle apprise)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from enum import StrEnum

from sqlmodel import Field, SQLModel


class JobStatus(StrEnum):
    """États successifs du pipeline de traitement d'un job."""

    QUEUED = "queued"
    PROBING = "probing"
    DOWNLOADING = "downloading"
    CONVERTING = "converting"
    MOVING = "moving"
    DONE = "done"
    ERROR = "error"
    CANCELED = "canceled"


class RuleSource(StrEnum):
    """Origine d'une règle de reconnaissance de site."""

    MANUAL = "manual"
    LEARNED = "learned"


def utcnow() -> datetime:
    """Horodatage UTC courant (timezone-aware)."""
    return datetime.now(UTC)


# NB : les champs `status`/`source` sont stockés en `str` brut (et non en colonne Enum
# SQLAlchemy) pour éviter l'ambiguïté nom/valeur des Enum lors de la persistance ; la
# validation forte reste assurée côté API par les schémas pydantic (voir schemas.py).
class Job(SQLModel, table=True):
    """Un job de téléchargement (et conversion optionnelle) d'une vidéo."""

    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    url: str
    title: str | None = None
    filename: str | None = None
    folder: str
    status: str = Field(default=JobStatus.QUEUED.value, index=True)
    progress: float = 0.0
    speed: float | None = None  # octets/s
    eta: int | None = None  # secondes restantes
    size: int | None = None  # octets (taille finale une fois le job terminé)
    error: str | None = None
    preset_id: str | None = None
    format_id: str | None = None
    created_at: datetime = Field(default_factory=utcnow, index=True)
    updated_at: datetime = Field(default_factory=utcnow)


class SiteRule(SQLModel, table=True):
    """Règle de reconnaissance d'un flux vidéo sur un domaine donné."""

    id: int | None = Field(default=None, primary_key=True)
    domain: str
    url_pattern: str
    label: str | None = None
    notes: str | None = None
    source: str = Field(default=RuleSource.MANUAL.value)
    created_at: datetime = Field(default_factory=utcnow)
