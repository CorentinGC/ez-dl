"""Dépendance d'authentification : vérifie le Bearer token contre `EZDL_PASSWORD`."""

from __future__ import annotations

import secrets

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import Settings, get_settings

_bearer_scheme = HTTPBearer(auto_error=False)


async def require_auth(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer_scheme),
    settings: Settings = Depends(get_settings),
) -> None:
    """Exige un header `Authorization: Bearer <mot de passe>` valide, sinon lève un 401."""
    # `settings.password` non vide en fonctionnement normal (généré sinon) : ceinture-bretelles
    # pour qu'une config anormale ne devienne jamais un mode « sans mot de passe ».
    # Comparaison sur des `bytes` : `compare_digest` lève `TypeError` sur des `str` non-ASCII
    # (un token accentué donnerait un 500 au lieu d'un 401).
    valid = (
        bool(settings.password)
        and credentials is not None
        and secrets.compare_digest(
            credentials.credentials.encode("utf-8"), settings.password.encode("utf-8")
        )
    )
    if not valid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentification requise",
            headers={"WWW-Authenticate": "Bearer"},
        )
