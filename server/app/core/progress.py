"""Progression d'un téléchargement : conversion des évènements yt-dlp en champs de job et
limitation de la cadence d'écriture."""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

#: Intervalle minimal entre deux écritures (SQLite + diffusion SSE) de progression d'un job.
PROGRESS_INTERVAL_SECONDS = 0.5


def progress_fields(data: dict[str, Any]) -> dict[str, Any]:
    """Convertit un évènement de progression yt-dlp brut en champs de job.

    Les valeurs restent numériques brutes (octets, octets/s, secondes) conformément au
    contrat d'API (`speed: float|null`, `eta: int|null`, `size: int|null`) : le formatage
    lisible (ex. `"3.2 MB/s"`) est de la responsabilité du client.
    """
    fields: dict[str, Any] = {}
    downloaded = data.get("downloaded_bytes") or 0
    total = data.get("total_bytes") or data.get("total_bytes_estimate")
    fragment_count = data.get("fragment_count")
    if fragment_count:
        # Téléchargement fragmenté (HLS/DASH) : `downloaded_bytes`/`total_bytes` décrivent le
        # FRAGMENT en cours, pas le média. S'en servir ferait osciller la barre et la bloquerait
        # à 100 % à chaque fragment fini — un job annulé à mi-course s'affichait « Annulé 100 % ».
        # La position globale, c'est le compteur de fragments ; la taille reste inconnue ici,
        # elle est fixée sur le fichier réellement écrit à la fin du job.
        done_fragments = data.get("fragment_index") or 0
        fields["progress"] = round(min(done_fragments / fragment_count, 1.0) * 100, 1)
    elif total:
        fields["progress"] = round(min(downloaded / total, 1.0) * 100, 1)
        fields["size"] = int(total)
    speed = data.get("speed")
    if speed:
        fields["speed"] = float(speed)
    eta = data.get("eta")
    if eta is not None:
        fields["eta"] = int(eta)
    return fields


class ProgressThrottle:
    """Laisse passer au plus une écriture de progression par intervalle.

    yt-dlp émet une ligne par rafale réseau : sans limite, chacune coûterait un commit
    SQLite et une diffusion SSE à tous les abonnés. Les changements de statut ne passent pas
    par ici, ils ne sont donc jamais retenus.
    """

    def __init__(
        self,
        interval: float = PROGRESS_INTERVAL_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._interval = interval
        self._clock = clock
        # `-inf` : la toute première mesure doit toujours être écrite.
        self._last_emit = float("-inf")

    def should_emit(self) -> bool:
        """Vrai si l'intervalle est écoulé ; consomme alors le créneau."""
        now = self._clock()
        if now - self._last_emit < self._interval:
            return False
        self._last_emit = now
        return True
