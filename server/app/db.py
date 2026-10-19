"""Moteur SQLModel/SQLite : création, initialisation du schéma, dépendance de session."""

from __future__ import annotations

from collections.abc import Iterator
from functools import lru_cache

from fastapi import Request
from sqlalchemy import inspect
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
    """Crée les tables SQLModel si elles n'existent pas encore, puis ajoute les colonnes
    apparues depuis la création de la base."""
    engine = get_engine(settings)
    SQLModel.metadata.create_all(engine)
    _add_missing_columns(engine)


def _add_missing_columns(engine: Engine) -> None:
    """Migration additive minimale : `ALTER TABLE ... ADD COLUMN` pour toute colonne du
    modèle absente de la table existante.

    `create_all` ne touche jamais à une table déjà créée : sans cela, une base d'avant
    l'ajout d'un champ ferait échouer toute requête sur le modèle. SQLite n'accepte ici que
    des colonnes sans contrainte `NOT NULL` ; elles sont donc ajoutées nullables.
    """
    inspector = inspect(engine)
    preparer = engine.dialect.identifier_preparer
    with engine.begin() as connection:
        for table in SQLModel.metadata.sorted_tables:
            existing = {column["name"] for column in inspector.get_columns(table.name)}
            for column in table.columns:
                if column.name in existing:
                    continue
                column_type = column.type.compile(dialect=engine.dialect)
                connection.exec_driver_sql(
                    f"ALTER TABLE {preparer.quote(table.name)} "
                    f"ADD COLUMN {preparer.quote(column.name)} {column_type}"
                )


def get_session(request: Request) -> Iterator[Session]:
    """Dépendance FastAPI : ouvre une session DB liée au moteur de l'application."""
    with Session(request.app.state.engine) as session:
        yield session
