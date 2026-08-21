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
def cookie_jar_file(cookies: list[CookieItem] | None) -> Iterator[Path | None]:
    """Fournit le chemin d'un fichier `cookies.txt` temporaire (permissions 0600),
    supprimé à la sortie du contexte. Retourne `None` si aucun cookie n'est fourni
    (aucun fichier n'est créé dans ce cas). Les cookies ne sont jamais loggés."""
    if not cookies:
        yield None
        return
    fd, raw_path = tempfile.mkstemp(prefix="ez-dl-cookies-", suffix=".txt")
    path = Path(raw_path)
    try:
        os.chmod(path, 0o600)
        lines = [_NETSCAPE_HEADER, *(_format_cookie_line(c) for c in cookies)]
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
        yield path
    finally:
        path.unlink(missing_ok=True)
