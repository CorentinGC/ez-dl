"""File d'attente asyncio + workers : exécute le pipeline de chaque job (probe ->
download -> [convert] -> move) et publie les mises à jour aux abonnés SSE."""

from __future__ import annotations

import asyncio
import logging
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from sqlalchemy.engine import Engine
from sqlmodel import Session, select

from app.config import Settings
from app.core import ffmpeg, ytdlp
from app.core.cookies import cookie_jar_file
from app.core.paths import PathSecurityError, resolve_destination
from app.models import Job, JobStatus, utcnow

if TYPE_CHECKING:
    from app.schemas import CookieItem

logger = logging.getLogger(__name__)

_STUCK_STATUSES = [
    JobStatus.PROBING.value,
    JobStatus.DOWNLOADING.value,
    JobStatus.CONVERTING.value,
    JobStatus.MOVING.value,
]


@dataclass
class JobContext:
    """Contexte éphémère d'un job (jamais persisté en base) : cookies et en-têtes HTTP."""

    cookies: list[CookieItem] | None = None
    headers: dict[str, str] | None = None
    referer: str | None = None


class JobBroadcaster:
    """Pub/sub in-memory des mises à jour de jobs pour les abonnés SSE."""

    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[Job]] = set()

    def subscribe(self) -> asyncio.Queue[Job]:
        """Crée et enregistre une nouvelle file d'écoute."""
        queue: asyncio.Queue[Job] = asyncio.Queue()
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[Job]) -> None:
        """Retire une file d'écoute."""
        self._subscribers.discard(queue)

    def publish(self, job: Job) -> None:
        """Diffuse un job mis à jour à tous les abonnés courants."""
        for queue in list(self._subscribers):
            queue.put_nowait(job)


def _progress_fields(data: dict[str, Any]) -> dict[str, Any]:
    """Convertit un évènement de progression yt-dlp brut en champs de job.

    Les valeurs restent numériques brutes (octets, octets/s, secondes) conformément au
    contrat d'API (`speed: float|null`, `eta: int|null`, `size: int|null`) : le formatage
    lisible (ex. `"3.2 MB/s"`) est de la responsabilité du client.
    """
    fields: dict[str, Any] = {}
    downloaded = data.get("downloaded_bytes") or 0
    total = data.get("total_bytes") or data.get("total_bytes_estimate")
    if total:
        fields["progress"] = round(min(downloaded / total, 1.0) * 100, 1)
        fields["size"] = int(total)
    speed = data.get("speed")
    if speed:
        fields["speed"] = float(speed)
    eta = data.get("eta")
    if eta is not None:
        fields["eta"] = int(eta)
    return fields


# Résidus laissés par yt-dlp dans le dossier de travail (téléchargement partiel, état de
# reprise, fragments) : jamais le fichier final, même quand ils survivent à un succès.
_LEFTOVER_SUFFIXES = (".part", ".ytdl", ".temp")


def _downloaded_file(work_dir: Path) -> Path:
    """Retourne le fichier produit par yt-dlp dans son dossier de travail dédié.

    Le nom de sortie n'est pas prédictible : yt-dlp impose l'extension du conteneur
    réellement produit (un merge/remux peut la changer). On prend donc le plus gros
    fichier restant, hors résidus.
    """
    candidates = [
        path
        for path in work_dir.iterdir()
        if path.is_file() and not path.suffix.startswith(_LEFTOVER_SUFFIXES)
    ]
    if not candidates:
        raise RuntimeError("yt-dlp n'a produit aucun fichier")
    return max(candidates, key=lambda path: path.stat().st_size)


# Au-delà, c'est que quelque chose tourne en rond : mieux vaut échouer que boucler.
_MAX_DEDUPE_ATTEMPTS = 999


def _free_destination(destination: Path) -> Path:
    """Retourne `destination`, ou un nom libre dérivé (`film (2).mkv`) si elle est prise.

    `os.rename` écrase la cible **sans erreur** : sur une bibliothèque média, un job dont le
    nom coïncide avec un fichier existant le détruirait définitivement. On dérive donc un nom
    libre, comme le fait un navigateur, plutôt que d'écraser.
    """
    if not destination.exists():
        return destination
    stem, suffix = destination.stem, destination.suffix
    for index in range(2, _MAX_DEDUPE_ATTEMPTS + 2):
        candidate = destination.with_name(f"{stem} ({index}){suffix}")
        if not candidate.exists():
            return candidate
    raise OSError(f"Impossible de dériver un nom libre pour {destination.name}")


def _atomic_move(source: Path, destination: Path) -> None:
    """Déplace `source` vers `destination` ; repli sur une copie si périphérique différent."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        source.replace(destination)
    except OSError:
        shutil.copy2(source, destination)
        source.unlink(missing_ok=True)


class JobQueue:
    """Orchestre le pipeline `queued -> ... -> done/error/canceled` avec N workers."""

    def __init__(
        self, settings: Settings, engine: Engine, encoders: dict[str, ffmpeg.Encoder]
    ) -> None:
        self._settings = settings
        self._engine = engine
        self._presets = ffmpeg.available_presets(encoders)
        self.broadcaster = JobBroadcaster()
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._contexts: dict[str, JobContext] = {}
        self._workers: list[asyncio.Task[None]] = []
        self._processes: dict[str, asyncio.subprocess.Process] = {}
        self._cancel_requested: set[str] = set()

    async def start(self) -> None:
        """Démarre les workers et remet en erreur les jobs interrompus par un crash."""
        self._recover_interrupted_jobs()
        for _ in range(max(1, self._settings.max_concurrent_jobs)):
            self._workers.append(asyncio.create_task(self._worker_loop()))

    async def shutdown(self) -> None:
        """Arrête proprement les workers."""
        for task in self._workers:
            task.cancel()
        for task in self._workers:
            try:
                await task
            except asyncio.CancelledError:
                pass
        self._workers.clear()

    def enqueue(self, job_id: str, context: JobContext | None = None) -> None:
        """Place un job en file d'attente avec son contexte éphémère (cookies/headers)."""
        self._contexts[job_id] = context or JobContext()
        self._queue.put_nowait(job_id)

    def cancel(self, job_id: str) -> None:
        """Demande l'annulation d'un job (kill du process enfant s'il est en cours)."""
        self._cancel_requested.add(job_id)
        process = self._processes.get(job_id)
        if process is not None and process.returncode is None:
            process.kill()

    def _recover_interrupted_jobs(self) -> None:
        """Au démarrage, marque en erreur les jobs restés bloqués par un crash précédent."""
        with Session(self._engine) as session:
            jobs = session.exec(select(Job).where(Job.status.in_(_STUCK_STATUSES))).all()
            if not jobs:
                return
            for job in jobs:
                job.status = JobStatus.ERROR
                job.error = "Interrompu par un redémarrage du serveur"
                job.updated_at = utcnow()
                session.add(job)
            session.commit()

    async def _worker_loop(self) -> None:
        """Boucle d'un worker : dépile un job et exécute son pipeline."""
        while True:
            job_id = await self._queue.get()
            try:
                await self._run_job(job_id)
            except Exception:
                logger.exception("Erreur inattendue dans le pipeline du job %s", job_id)
            finally:
                self._processes.pop(job_id, None)
                self._cancel_requested.discard(job_id)
                self._contexts.pop(job_id, None)
                self._queue.task_done()

    def _update_job(self, session: Session, job: Job, **fields: Any) -> Job:
        """Applique des champs à un job, persiste et publie la mise à jour."""
        for key, value in fields.items():
            setattr(job, key, value)
        job.updated_at = utcnow()
        session.add(job)
        session.commit()
        session.refresh(job)
        self.broadcaster.publish(job)
        return job

    def _resolve_preset(self, preset_id: str | None) -> ffmpeg.Preset | None:
        """Retrouve un preset disponible par id (`None`/`copy` => pas de conversion)."""
        if not preset_id or preset_id == "copy":
            return None
        return next((p for p in self._presets if p.id == preset_id), None)

    async def _run_job(self, job_id: str) -> None:
        """Exécute le pipeline complet d'un job."""
        context = self._contexts.get(job_id, JobContext())
        with Session(self._engine) as session:
            job = session.get(Job, job_id)
            if job is None:
                return
            if job_id in self._cancel_requested:
                self._update_job(session, job, status=JobStatus.CANCELED)
                return

            try:
                destination = resolve_destination(
                    job.folder, job.filename or job.url, self._settings.roots
                )
            except PathSecurityError as exc:
                self._update_job(session, job, status=JobStatus.ERROR, error=str(exc))
                return

            # Dossier de travail dédié : yt-dlp choisit lui-même le nom final du fichier,
            # l'isoler permet de le retrouver sans le deviner. Supprimé quoi qu'il arrive.
            work_dir = self._settings.temp_dir / job_id
            try:
                temp_path = await self._download_phase(session, job, context, work_dir)
                if temp_path is None:
                    return
                source = await self._convert_phase(session, job, temp_path, work_dir)
                if source is None:
                    return
                self._move_phase(session, job, source, destination)
            finally:
                shutil.rmtree(work_dir, ignore_errors=True)

    async def _download_phase(
        self, session: Session, job: Job, context: JobContext, work_dir: Path
    ) -> Path | None:
        """Télécharge le job dans `work_dir`.

        Retourne le chemin du fichier produit, ou `None` en cas d'échec/annulation.
        """
        work_dir.mkdir(parents=True, exist_ok=True)
        job_id = job.id
        with cookie_jar_file(context.cookies, self._settings.temp_dir) as cookies_file:
            try:
                job = self._update_job(session, job, status=JobStatus.DOWNLOADING)
                process = await ytdlp.start_download(
                    job.url,
                    # `%(ext)s` : le conteneur réel n'est connu qu'après un éventuel
                    # merge/remux, yt-dlp l'impose au nom de sortie.
                    work_dir / "download.%(ext)s",
                    binary=self._settings.ytdlp_binary,
                    format_id=job.format_id,
                    cookies_file=cookies_file,
                    headers=context.headers,
                    referer=context.referer,
                )
                self._processes[job_id] = process

                async def on_progress(data: dict[str, Any]) -> None:
                    fields = _progress_fields(data)
                    if fields:
                        self._update_job(session, job, **fields)

                await ytdlp.stream_progress(process, on_progress)
                await ytdlp.wait_download(process)
                return _downloaded_file(work_dir)
            except Exception as exc:
                if job_id in self._cancel_requested:
                    self._update_job(session, job, status=JobStatus.CANCELED)
                else:
                    logger.warning("Échec téléchargement job %s : %s", job_id, exc)
                    self._update_job(session, job, status=JobStatus.ERROR, error=str(exc))
                return None

    async def _convert_phase(
        self, session: Session, job: Job, temp_path: Path, work_dir: Path
    ) -> Path | None:
        """Conversion optionnelle. Retourne le chemin source final, ou `None` en cas d'échec."""
        preset = self._resolve_preset(job.preset_id)
        if preset is None:
            return temp_path
        job_id = job.id
        self._update_job(session, job, status=JobStatus.CONVERTING)
        converted_path = work_dir / f"converted.{preset.container}"
        args = ffmpeg.build_conversion_args(preset, str(temp_path), str(converted_path))
        try:
            process = await asyncio.create_subprocess_exec(
                self._settings.ffmpeg_binary,
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            self._processes[job_id] = process
            _, stderr = await process.communicate()
            if process.returncode != 0:
                raise RuntimeError(
                    f"ffmpeg a échoué : {stderr.decode('utf-8', errors='replace')[-300:]}"
                )
        except Exception as exc:
            logger.warning("Échec conversion job %s : %s", job_id, exc)
            self._update_job(session, job, status=JobStatus.ERROR, error=str(exc))
            temp_path.unlink(missing_ok=True)
            return None
        temp_path.unlink(missing_ok=True)
        return converted_path

    def _move_phase(self, session: Session, job: Job, source: Path, destination: Path) -> None:
        """Étape finale : déplacement atomique vers la destination, puis statut `done`.

        `size` est recalculé sur le fichier final (taille réelle après conversion
        éventuelle), plutôt que de conserver la dernière estimation de téléchargement.
        """
        self._update_job(session, job, status=JobStatus.MOVING)
        try:
            final_path = _free_destination(destination)
            _atomic_move(source, final_path)
        except OSError as exc:
            self._update_job(session, job, status=JobStatus.ERROR, error=str(exc))
            return
        # `filename` reflète le fichier réellement écrit : l'UI ne doit pas annoncer un nom
        # que la déduplication a changé.
        self._update_job(
            session,
            job,
            status=JobStatus.DONE,
            progress=100.0,
            size=final_path.stat().st_size,
            filename=final_path.name,
        )
