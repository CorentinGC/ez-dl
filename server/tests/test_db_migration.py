"""Migration additive de `init_db` : colonnes ajoutées à une base créée avant leur apparition."""

from __future__ import annotations

import sqlite3

from sqlmodel import Session, select

from app.config import Settings
from app.db import get_engine, init_db
from app.models import Job


def test_init_db_adds_columns_missing_from_an_existing_table(tmp_path) -> None:
    settings = Settings(
        password="test-secret",
        download_roots=f"Downloads={tmp_path}",
        data_dir=tmp_path / "data",
        temp_dir=tmp_path / "temp",
    )
    settings.data_dir.mkdir(parents=True)
    # Table `job` d'avant `playlist_items`.
    with sqlite3.connect(settings.data_dir / "ez-dl.db") as connection:
        connection.execute(
            "CREATE TABLE job (id VARCHAR PRIMARY KEY, url VARCHAR NOT NULL, title VARCHAR, "
            "filename VARCHAR, folder VARCHAR NOT NULL, status VARCHAR NOT NULL, "
            "progress FLOAT NOT NULL, speed FLOAT, eta INTEGER, size INTEGER, error VARCHAR, "
            "preset_id VARCHAR, format_id VARCHAR, created_at DATETIME NOT NULL, "
            "updated_at DATETIME NOT NULL)"
        )
        connection.execute(
            "INSERT INTO job VALUES ('j1', 'https://example.com/v', NULL, NULL, '/mnt/media', "
            "'done', 100.0, NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-01', '2026-01-01')"
        )

    init_db(settings)
    init_db(settings)  # idempotent

    with Session(get_engine(settings)) as session:
        job = session.exec(select(Job)).one()
    assert job.id == "j1"
    assert job.playlist_items is None
