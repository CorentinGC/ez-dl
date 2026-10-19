"""Pub/sub in-memory des mises à jour de jobs pour les abonnés SSE."""

from __future__ import annotations

import asyncio

from app.models import Job
from app.schemas import JobOut

#: Taille maximale de la file d'un abonné : un client lent ne doit pas faire grossir la mémoire.
SUBSCRIBER_QUEUE_SIZE = 100


class JobBroadcaster:
    """Diffuse des instantanés `JobOut` ; chaque abonné a une file bornée (drop-oldest)."""

    def __init__(self, queue_size: int = SUBSCRIBER_QUEUE_SIZE) -> None:
        self._queue_size = queue_size
        self._subscribers: set[asyncio.Queue[JobOut]] = set()

    def subscribe(self) -> asyncio.Queue[JobOut]:
        """Crée et enregistre une nouvelle file d'écoute."""
        queue: asyncio.Queue[JobOut] = asyncio.Queue(maxsize=self._queue_size)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[JobOut]) -> None:
        """Retire une file d'écoute."""
        self._subscribers.discard(queue)

    def publish(self, job: Job) -> None:
        """Diffuse l'état courant d'un job à tous les abonnés.

        On publie un **instantané** : l'objet ORM est vivant, il serait muté (ou expiré) par
        la mise à jour suivante avant que l'abonné ne le lise. Une file pleine perd son
        message le plus ancien — le plus récent décrit de toute façon l'état à jour.
        """
        snapshot = JobOut.model_validate(job)
        for queue in list(self._subscribers):
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(snapshot)
