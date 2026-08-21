"""Écriture d'un cookie-jar Netscape temporaire pour yt-dlp, avec suppression garantie."""

from __future__ import annotations

import os
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.schemas import CookieItem

_NETSCAPE_HEADER = "# Netscape HTTP Cookie File\n"

# Sous-dossier dédié aux cookie-jars, à l'intérieur d'`EZDL_TEMP_DIR`. Le reste du dossier
# temporaire doit **persister** (les fichiers partiels servent à reprendre un téléchargement),
# les cookies non : le compose monte ce seul sous-chemin en tmpfs pour qu'ils ne touchent
# jamais la couche disque du conteneur.
COOKIES_DIRNAME = "cookies"
COOKIE_JAR_PREFIX = "ez-dl-cookies-"


def cookie_jar_dir(temp_dir: Path) -> Path:
    """Dossier des cookie-jars temporaires pour un `EZDL_TEMP_DIR` donné."""
    return temp_dir / COOKIES_DIRNAME


def _format_cookie_line(cookie: CookieItem) -> str:
    """Formate un cookie en une ligne du format Netscape cookie-jar (TSV)."""
    include_subdomains = "TRUE" if cookie.domain.startswith(".") else "FALSE"
    secure = "TRUE" if cookie.secure else "FALSE"
    expires = str(int(cookie.expires)) if cookie.expires else "0"
    return "\t".join(
        [
            cookie.domain,
            include_subdomains,
            cookie.path or "/",
            secure,
            expires,
            cookie.name,
            cookie.value,
        ]
    )


@contextmanager
def cookie_jar_file(cookies: list[CookieItem] | None, temp_dir: Path) -> Iterator[Path | None]:
    """Fournit le chemin d'un fichier `cookies.txt` temporaire (permissions 0600),
    supprimé à la sortie du contexte. Retourne `None` si aucun cookie n'est fourni
    (aucun fichier n'est créé dans ce cas). Les cookies ne sont jamais loggés.

    Le fichier est créé dans `<temp_dir>/cookies` et non dans le `/tmp` du système : c'est ce
    sous-chemin d'`EZDL_TEMP_DIR` que le compose monte en tmpfs, donc le seul où des cookies
    en clair ne touchent pas la couche disque du conteneur."""
    if not cookies:
        yield None
        return
    jar_dir = cookie_jar_dir(temp_dir)
    jar_dir.mkdir(parents=True, exist_ok=True)
    fd, raw_path = tempfile.mkstemp(prefix=COOKIE_JAR_PREFIX, suffix=".txt", dir=jar_dir)
    path = Path(raw_path)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            # fchmod sur le descripteur déjà possédé : pas de fenêtre où le fichier existe
            # sous un autre chemin, et le fd est refermé même si le chmod échoue.
            os.fchmod(fh.fileno(), 0o600)
            lines = [_NETSCAPE_HEADER, *(_format_cookie_line(c) for c in cookies)]
            fh.write("\n".join(lines) + "\n")
        yield path
    finally:
        path.unlink(missing_ok=True)
