"""Paramètres du serveur, chargés depuis les variables d'environnement (préfixe EZDL_)."""

from __future__ import annotations

import re
import secrets
from functools import lru_cache
from pathlib import Path

from pydantic import BaseModel, PrivateAttr, ValidationInfo, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

APP_VERSION = "0.1.0"

# 24 octets aléatoires -> 32 caractères URL-safe : suffisant pour un Bearer token.
_GENERATED_PASSWORD_BYTES = 24


def generate_password() -> str:
    """Génère un mot de passe fort pour un serveur démarré sans `EZDL_PASSWORD`."""
    return secrets.token_urlsafe(_GENERATED_PASSWORD_BYTES)


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
    # Positionné par `get_settings()` quand le mot de passe a été généré faute d'EZDL_PASSWORD ;
    # attribut privé pour qu'il ne soit jamais surchargeable via l'environnement.
    _is_password_generated: bool = PrivateAttr(default=False)
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
    def _normalize_password(self) -> Settings:
        """Normalise le mot de passe : une valeur composée uniquement d'espaces vaut « absent »
        (elle déclenchera la génération automatique dans `get_settings()`)."""
        self.password = self.password.strip()
        return self

    @property
    def is_password_generated(self) -> bool:
        """Vrai si le mot de passe a été généré automatiquement (EZDL_PASSWORD absent/vide)."""
        return self._is_password_generated

    @field_validator("data_dir", "temp_dir")
    @classmethod
    def _validate_dir_absolute(cls, value: Path, info: ValidationInfo) -> Path:
        """Un chemin relatif dépend du cwd du process : en Docker il produit un PermissionError
        opaque (mkdir refusé dans /app). On échoue tôt avec un message actionnable.

        Validateur de CHAMP et non de modèle : pydantic joint la valeur d'entrée au message
        d'erreur, et l'entrée d'un validateur de modèle est le dict complet des réglages —
        le mot de passe s'y retrouverait, donc dans les logs de démarrage."""
        if value.is_absolute():
            return value
        env_name = f"EZDL_{info.field_name.upper()}"
        raise ValueError(
            f"{env_name} doit être un chemin absolu (reçu : {value}). "
            "En Docker, garder les valeurs par défaut : "
            "EZDL_DATA_DIR=/config et EZDL_TEMP_DIR=/tmp/ez-dl."
        )

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


def ensure_password(settings: Settings) -> Settings:
    """Garantit un mot de passe non vide : sans `EZDL_PASSWORD`, en génère un fort et marque
    les réglages pour que le démarrage l'affiche en console. Pas de mode sans authentification."""
    if not settings.password:
        settings.password = generate_password()
        settings._is_password_generated = True
    return settings


@lru_cache
def get_settings() -> Settings:
    """Retourne les réglages applicatifs (mis en cache pour tout le process)."""
    return ensure_password(Settings())
