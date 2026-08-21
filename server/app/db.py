"""Moteur SQLModel/SQLite : création, initialisation du schéma, dépendance de session."""

from __future__ import annotations

from collections.abc import Iterator
from functools import lru_cache

from fastapi import Request
from sqlalchemy.engine import Engine
from sqlmodel import Session, SQLModel, create_engine

from app.config import Settings


@lru_cache
def _build_engine(db_path: str) -> Engine:
    """Construit (et met en cache) le moteur SQLAlchemy pour un chemin de base donné."""
    return create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})


def get_engine(settings: Settings) -> Engine:
    """Retourne le moteur SQLite pour les réglages donnés (créé au besoin)."""
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    db_path = settings.data_dir / "ez-dl.db"
    return _build_engine(str(db_path))


def init_db(settings: Settings) -> None:
    """Crée les tables SQLModel si elles n'existent pas encore."""
    SQLModel.metadata.create_all(get_engine(settings))


def get_session(request: Request) -> Iterator[Session]:
    """Dépendance FastAPI : ouvre une session DB liée au moteur de l'application."""
    with Session(request.app.state.engine) as session:
        yield session
