"""Paramètres du serveur, chargés depuis les variables d'environnement (préfixe EZDL_)."""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

from pydantic import BaseModel, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

APP_VERSION = "0.1.0"


class DownloadRoot(BaseModel):
    """Racine de téléchargement autorisée : label affiché + chemin absolu."""

    label: str
    path: Path


def parse_download_roots(raw: str) -> list[DownloadRoot]:
    """Parse `Label=/chemin,Label2=/chemin2` en liste de `DownloadRoot`."""
    roots: list[DownloadRoot] = []
    for chunk in raw.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "=" not in chunk:
            raise ValueError(f"Format de racine invalide (attendu Label=/chemin) : {chunk!r}")
        label, _, path_str = chunk.partition("=")
        label = label.strip()
        path_str = path_str.strip()
        if not label or not path_str:
            raise ValueError(f"Format de racine invalide (attendu Label=/chemin) : {chunk!r}")
        roots.append(DownloadRoot(label=label, path=Path(path_str)))
    return roots


def _origin_to_regex(pattern: str) -> str:
    """Convertit un pattern d'origine CORS (avec `*` en wildcard) en regex ancrée."""
    escaped = re.escape(pattern).replace(r"\*", ".*")
    return f"^{escaped}$"


class Settings(BaseSettings):
    """Paramètres de l'application, tous surchargeables via l'environnement `EZDL_*`."""

    model_config = SettingsConfigDict(env_prefix="EZDL_", extra="ignore")

    password: str = ""
    host: str = "0.0.0.0"
    port: int = 8000
    download_roots: str = "Downloads=/data/downloads"
    data_dir: Path = Path("/config")
    temp_dir: Path = Path("/tmp/ez-dl")
    max_concurrent_jobs: int = 2
    ytdlp_update_interval_hours: int = 24
    ytdlp_binary: str = "yt-dlp"
    ffmpeg_binary: str = "ffmpeg"
    cors_origins: str = "chrome-extension://*"
    log_level: str = "info"

    @model_validator(mode="after")
    def _validate_password(self) -> Settings:
        """Refuse de démarrer si le mot de passe est vide : pas de mode sans authentification."""
        if not self.password or not self.password.strip():
            raise ValueError(
                "EZDL_PASSWORD est requis et ne peut pas être vide : "
                "le serveur refuse de démarrer sans mot de passe."
            )
        return self

    @property
    def roots(self) -> list[DownloadRoot]:
        """Racines de téléchargement autorisées, parsées depuis `download_roots`."""
        return parse_download_roots(self.download_roots)

    @property
    def cors_origin_list(self) -> list[str]:
        """Liste des patterns d'origine CORS autorisés."""
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def cors_origin_regex(self) -> str:
        """Regex combinée pour `CORSMiddleware` (supporte les wildcards `*`)."""
        patterns = [_origin_to_regex(o) for o in self.cors_origin_list]
        return "|".join(patterns) if patterns else "$^"


@lru_cache
def get_settings() -> Settings:
    """Retourne les réglages applicatifs (mis en cache pour tout le process)."""
    return Settings()
