"""Routes publiques de marque : favicon et icône d'écran d'accueil.

Aucune authentification, pour la raison qui vaut déjà pour les routes `/extension`
(`docs/fr/decisions/0004-distribution-extension-crx.md`), et de façon encore plus nette ici :
un navigateur ne joint aucun en-tête `Authorization` à une requête de favicon — une route
protégée renverrait simplement 401 et l'onglet garderait l'icône générique. Ces fichiers ne
sont par ailleurs que l'identité visuelle d'un dépôt public.

Les fichiers servis sont des constantes du paquet, jamais un chemin dérivé d'une entrée :
il n'y a pas de surface de traversée de chemin dans ce module.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import FileResponse

router = APIRouter(tags=["brand"])

_STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

# Une journée : la marque bouge rarement, mais un cache plus long rendrait un changement de
# logo invisible pendant des semaines sur les postes déjà passés par le serveur.
_CACHE_CONTROL = "public, max-age=86400"


def _brand_file(name: str, media_type: str) -> FileResponse:
    """Sert un fichier de `app/static/` avec un cache court et un type explicite."""
    return FileResponse(
        _STATIC_DIR / name,
        media_type=media_type,
        headers={"Cache-Control": _CACHE_CONTROL},
    )


@router.get("/favicon.ico", include_in_schema=False)
def favicon_ico() -> FileResponse:
    """Favicon multi-résolution (16/32/48), repli pour les navigateurs sans favicon SVG."""
    return _brand_file("favicon.ico", "image/x-icon")


@router.get("/favicon.svg", include_in_schema=False)
def favicon_svg() -> FileResponse:
    """Favicon vectoriel : sa tuile suit le thème clair/sombre du navigateur."""
    return _brand_file("favicon.svg", "image/svg+xml")


@router.get("/apple-touch-icon.png", include_in_schema=False)
def apple_touch_icon() -> FileResponse:
    """Icône reprise par iOS/iPadOS quand la page est ajoutée à l'écran d'accueil."""
    return _brand_file("apple-touch-icon.png", "image/png")
