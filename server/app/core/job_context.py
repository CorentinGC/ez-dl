"""Contexte éphémère d'un job."""

from __future__ import annotations

from dataclasses import dataclass

from app.schemas import CookieItem


@dataclass
class JobContext:
    """Contexte éphémère d'un job (jamais persisté en base) : cookies et en-têtes HTTP."""

    cookies: list[CookieItem] | None = None
    headers: dict[str, str] | None = None
    referer: str | None = None
