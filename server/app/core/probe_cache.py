"""Coordination des probes yt-dlp : concurrence bornée, coalescing des appels identiques
en vol, cache TTL des succès, annulation quand plus personne n'attend.

Sans cela, chaque réouverture de la popup empilait un nouveau yt-dlp (le client abandonne
bien avant le serveur) : plusieurs extractions lourdes en parallèle suffisaient à saturer
la mémoire du conteneur.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

#: Probes yt-dlp réellement exécutés en même temps.
MAX_CONCURRENT_PROBES = 2
CACHE_TTL_SECONDS = 60.0
CACHE_MAX_ENTRIES = 64
#: Période de surveillance de la déconnexion du client.
DISCONNECT_POLL_SECONDS = 0.5

ProbeFactory = Callable[[], Awaitable[dict[str, Any]]]
DisconnectCheck = Callable[[], Awaitable[bool]]


class ClientDisconnectedError(Exception):
    """Le client est parti avant la fin du probe."""


def probe_key(
    url: str,
    playlist_items: int | None,
    cookies: list[dict[str, Any]] | None,
    headers: dict[str, str] | None,
    referer: str | None,
) -> str:
    """Clé d'identité d'un probe : URL, rang, et empreinte sha256 du contexte d'auth.

    Le contexte (cookies, headers, referer) est haché pour ne jamais garder de secret en
    clair dans les structures de coalescing.
    """
    context = json.dumps([cookies, headers, referer], sort_keys=True, default=str)
    digest = hashlib.sha256(context.encode("utf-8")).hexdigest()
    return f"{url}\x00{playlist_items}\x00{digest}"


@dataclass
class _InFlight:
    task: asyncio.Task[dict[str, Any]]
    waiters: int = 0


class ProbeCoordinator:
    """Exécute les probes avec coalescing, cache de succès et annulation orpheline."""

    def __init__(
        self,
        max_concurrent: int = MAX_CONCURRENT_PROBES,
        ttl: float = CACHE_TTL_SECONDS,
        max_entries: int = CACHE_MAX_ENTRIES,
    ) -> None:
        self._semaphore = asyncio.Semaphore(max_concurrent)
        self._ttl = ttl
        self._max_entries = max_entries
        self._cache: OrderedDict[str, tuple[float, dict[str, Any]]] = OrderedDict()
        self._in_flight: dict[str, _InFlight] = {}

    def reset(self) -> None:
        """Vide cache et probes en vol (isolation des tests)."""
        self._cache.clear()
        for entry in self._in_flight.values():
            entry.task.cancel()
        self._in_flight.clear()

    def _cached(self, key: str) -> dict[str, Any] | None:
        hit = self._cache.get(key)
        if hit is None:
            return None
        if hit[0] < time.monotonic():
            del self._cache[key]
            return None
        return hit[1]

    def _store(self, key: str, info: dict[str, Any]) -> None:
        self._cache[key] = (time.monotonic() + self._ttl, info)
        self._cache.move_to_end(key)
        while len(self._cache) > self._max_entries:
            self._cache.popitem(last=False)

    async def _execute(self, key: str, factory: ProbeFactory) -> dict[str, Any]:
        """Corps de la tâche partagée : semaphore, probe, mise en cache du succès."""
        try:
            async with self._semaphore:
                info = await factory()
            self._store(key, info)
            return info
        finally:
            # Ne retire que sa propre entrée : une tâche remplaçante a pu prendre la clé.
            entry = self._in_flight.get(key)
            if entry is not None and entry.task is asyncio.current_task():
                del self._in_flight[key]

    def _join(self, key: str, factory: ProbeFactory) -> _InFlight:
        """Rejoint le probe en vol pour `key`, ou en démarre un."""
        entry = self._in_flight.get(key)
        # Une tâche en cours d'annulation (son dernier demandeur vient de partir) n'est pas
        # rejoignable : elle lèverait `CancelledError` chez le nouveau demandeur.
        if entry is not None and not entry.task.cancelling():
            return entry
        task = asyncio.create_task(self._execute(key, factory))
        # Récupère l'exception d'une tâche que plus personne n'attend (pas de warning asyncio).
        task.add_done_callback(lambda t: t.cancelled() or t.exception())
        entry = _InFlight(task)
        self._in_flight[key] = entry
        return entry

    async def run(
        self, key: str, factory: ProbeFactory, is_disconnected: DisconnectCheck
    ) -> dict[str, Any]:
        """Retourne le résultat du probe `key` (cache, tâche partagée ou nouvelle tâche).

        Lève `ClientDisconnectedError` si le client part ; la tâche partagée n'est annulée
        (donc le groupe yt-dlp tué) que lorsque son dernier demandeur s'en va.
        """
        cached = self._cached(key)
        if cached is not None:
            return cached
        entry = self._join(key, factory)
        entry.waiters += 1
        watcher = asyncio.create_task(_watch_disconnect(is_disconnected))
        try:
            await asyncio.wait({entry.task, watcher}, return_when=asyncio.FIRST_COMPLETED)
            if not entry.task.done():
                raise ClientDisconnectedError
            return entry.task.result()
        finally:
            watcher.cancel()
            entry.waiters -= 1
            if entry.waiters == 0 and not entry.task.done():
                entry.task.cancel()


async def _watch_disconnect(is_disconnected: DisconnectCheck) -> None:
    """Se termine dès que le client a coupé la connexion."""
    while not await is_disconnected():
        await asyncio.sleep(DISCONNECT_POLL_SECONDS)


#: Instance partagée par la route : un seul semaphore et un seul cache pour tout le process.
coordinator = ProbeCoordinator()
