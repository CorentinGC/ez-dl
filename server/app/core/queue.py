"""File d'attente asyncio + workers : exécute le pipeline de chaque job (download ->
[convert] -> move) et publie les mises à jour aux abonnés SSE."""

from __future__ import annotations

import asyncio
import logging
import shutil
import signal
from pathlib import Path
from typing import Any

from sqlalchemy.engine import Engine
from sqlmodel import Session

from app.config import Settings
from app.core import ffmpeg, ytdlp
from app.core.broadcaster import JobBroadcaster
from app.core.convert import run_conversion
from app.core.cookies import cookie_jar_file
from app.core.job_context import JobContext
from app.core.paths import PathSecurityError, resolve_destination
from app.core.process import kill_and_reap, stop_process_group, terminate_and_reap
from app.core.progress import ProgressThrottle, progress_fields
from app.core.queue_recovery import (
    INTERRUPTED_MESSAGE,
    purge_stale_temp_residue,
    queued_job_ids,
    recover_interrupted_jobs,
)
from app.core.stderr_tail import StderrTail
from app.core.workdir import downloaded_file, final_name, move_to_reserved
from app.models import Job, JobStatus, utcnow

logger = logging.getLogger(__name__)

# Temps laissé aux workers, à l'arrêt, pour inscrire la suspension de leur job en base.
_SHUTDOWN_DRAIN_SECONDS = 2.0


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
        self._running: set[str] = set()
        self._cancel_requested: set[str] = set()
        self._pause_requested: set[str] = set()
        self._is_shutting_down = False

    async def start(self) -> None:
        """Démarre les workers ; réconcilie la base avec l'état perdu au redémarrage.

        Les jobs interrompus sont suspendus, les jobs encore `queued` (leur entrée en
        mémoire n'a pas survécu) sont ré-enfilés avec un contexte vide, les résidus
        temporaires sont purgés.
        """
        self._is_shutting_down = False
        recover_interrupted_jobs(self._engine)
        for job_id in queued_job_ids(self._engine):
            self.enqueue(job_id)
        purge_stale_temp_residue(self._engine, self._settings.temp_dir)
        for _ in range(max(1, self._settings.max_concurrent_jobs)):
            self._workers.append(asyncio.create_task(self._worker_loop()))

    async def shutdown(self) -> None:
        """Arrête proprement : tue les groupes de process, laisse les jobs se suspendre, puis
        annule les workers.

        Annuler les seules tasks laisserait yt-dlp/ffmpeg tourner, orphelins. Le drapeau
        d'arrêt fait classer les jobs coupés en `paused` (reprenables), pas en `error`.
        """
        self._is_shutting_down = True
        await asyncio.gather(
            *(terminate_and_reap(process) for process in list(self._processes.values())),
            return_exceptions=True,
        )
        try:
            async with asyncio.timeout(_SHUTDOWN_DRAIN_SECONDS):
                while self._running:
                    await asyncio.sleep(0.01)
        except TimeoutError:
            logger.warning("Arrêt : des jobs n'ont pas fini de se suspendre à temps")
        for task in self._workers:
            task.cancel()
        await asyncio.gather(*self._workers, return_exceptions=True)
        self._workers.clear()

    def enqueue(self, job_id: str, context: JobContext | None = None) -> None:
        """Place un job en file d'attente avec son contexte éphémère (cookies/headers).

        Enfiler un job annule toute demande d'arrêt antérieure : sans cela, une reprise
        héritée d'un drapeau de pause verrait son premier échec réel classé « suspendu ».
        """
        self._cancel_requested.discard(job_id)
        self._pause_requested.discard(job_id)
        self._contexts[job_id] = context or JobContext()
        self._queue.put_nowait(job_id)

    def cancel(self, job_id: str) -> None:
        """Demande l'annulation d'un job (kill du groupe de process s'il est en cours)."""
        self._cancel_requested.add(job_id)
        stop_process_group(self._processes.get(job_id), signal.SIGKILL)

    def pause(self, job_id: str) -> None:
        """Demande la suspension d'un job.

        SIGTERM et non SIGKILL : yt-dlp doit pouvoir laisser son `.part` et son état de
        reprise en place, c'est ce fichier partiel qui évite de tout retélécharger. Le
        dossier de travail n'est pas purgé pour un job suspendu.
        """
        self._pause_requested.add(job_id)
        stop_process_group(self._processes.get(job_id), signal.SIGTERM)

    def work_dir(self, job_id: str) -> Path:
        """Dossier de travail dédié à un job (fichier partiel, sortie de conversion)."""
        return self._settings.temp_dir / job_id

    def discard_work_dir(self, job_id: str) -> None:
        """Supprime le dossier de travail d'un job : plus rien n'est reprenable ensuite."""
        shutil.rmtree(self.work_dir(job_id), ignore_errors=True)

    async def _worker_loop(self) -> None:
        """Boucle d'un worker : dépile un job et exécute son pipeline."""
        while True:
            job_id = await self._queue.get()
            try:
                await self._run_job(job_id)
            except Exception:
                logger.exception("Erreur inattendue dans le pipeline du job %s", job_id)
            finally:
                self._queue.task_done()

    def update(self, job_id: str, **fields: Any) -> Job | None:
        """Applique des champs à un job depuis l'extérieur de la file (routes API).

        Passe par la même diffusion SSE que le pipeline : un changement de statut décidé par
        une route (pause d'un job encore en attente, reprise) doit atteindre les clients
        abonnés exactement comme une mise à jour de progression.
        """
        with Session(self._engine) as session:
            job = session.get(Job, job_id)
            if job is None:
                return None
            return self._update_job(session, job, **fields)

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
        """Prend un job `queued` et exécute son pipeline complet.

        Le nettoyage de l'état en mémoire (process, drapeaux, contexte) n'a lieu que si ce
        passage a **réellement pris** le job : une entrée périmée de la file ne doit pas
        effacer le process d'un run en cours du même job, sous peine de le rendre
        inannulable (téléchargement fantôme).
        """
        with Session(self._engine) as session:
            job = session.get(Job, job_id)
            # Le statut en base fait office de jeton de prise : une reprise ré-enfile l'id
            # sans pouvoir retirer l'entrée obsolète de la file, et une annulation/pause
            # d'un job encore en attente ne fait que changer son statut. Tout ce qui n'est
            # plus `queued` a donc déjà été traité — ou ne doit pas l'être.
            if job is None or job.status != JobStatus.QUEUED.value:
                return
            self._running.add(job_id)
            try:
                await self._execute(session, job)
            finally:
                self._running.discard(job_id)
                self._processes.pop(job_id, None)
                self._cancel_requested.discard(job_id)
                self._pause_requested.discard(job_id)
                self._contexts.pop(job_id, None)

    async def _execute(self, session: Session, job: Job) -> None:
        """Enchaîne download -> [convert] -> move, en vérifiant les arrêts demandés."""
        context = self._contexts.get(job.id, JobContext())
        if self._destination_or_error(session, job) is None:
            return
        # Aucun `await` entre la lecture du statut et cette écriture : deux workers ne
        # peuvent pas prendre le même job.
        job = self._update_job(session, job, status=JobStatus.DOWNLOADING, error=None)

        # Dossier de travail dédié : yt-dlp choisit lui-même le nom final du fichier,
        # l'isoler permet de le retrouver sans le deviner. Conservé tant que le job
        # reste reprenable (pause, erreur), supprimé dès qu'il ne l'est plus.
        work_dir = self.work_dir(job.id)
        temp_path = await self._download_phase(session, job, context, work_dir)
        # Un arrêt demandé alors que le process venait de se terminer n'a pas fait échouer
        # la phase : on le constate ici plutôt que de convertir un job annulé.
        if temp_path is None or self._apply_stop_request(session, job, can_pause=True):
            return
        source = await self._convert_phase(session, job, temp_path, work_dir)
        # Pas de pause ici : après conversion le téléchargement est supprimé, une reprise
        # devrait tout retélécharger.
        if source is None or self._apply_stop_request(session, job, can_pause=False):
            return
        await self._move_phase(session, job, source)

    def _register_process(self, job_id: str, process: asyncio.subprocess.Process) -> None:
        """Enregistre le process du job, puis honore un arrêt demandé entre-temps.

        `cancel()`/`pause()` ne voient que les process déjà enregistrés : un arrêt demandé
        pendant le lancement serait sinon perdu et le job irait au bout.
        """
        self._processes[job_id] = process
        if job_id in self._cancel_requested:
            stop_process_group(process, signal.SIGKILL)
        elif job_id in self._pause_requested or self._is_shutting_down:
            stop_process_group(process, signal.SIGTERM)

    async def _download_phase(
        self, session: Session, job: Job, context: JobContext, work_dir: Path
    ) -> Path | None:
        """Télécharge le job dans `work_dir`, en reprenant un éventuel `.part` déjà présent.

        Retourne le chemin du fichier produit, ou `None` en cas d'échec/annulation/pause.
        """
        work_dir.mkdir(parents=True, exist_ok=True)
        job_id = job.id
        throttle = ProgressThrottle()
        process = None
        stderr_tail = None

        async def on_progress(data: dict[str, Any]) -> None:
            fields = progress_fields(data)
            if fields and throttle.should_emit():
                self._update_job(session, job, **fields)

        with cookie_jar_file(context.cookies, self._settings.temp_dir) as cookies_file:
            try:
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
                    proxy=self._settings.proxy,
                    playlist_items=job.playlist_items,
                )
                self._register_process(job_id, process)
                stderr_tail = StderrTail(process.stderr)
                await ytdlp.stream_progress(process, on_progress)
                await stderr_tail.raise_unless_success(process)
                return downloaded_file(work_dir)
            except asyncio.CancelledError:
                await kill_and_reap(process)
                raise
            except Exception as exc:
                self._handle_phase_failure(session, job, exc, "téléchargement")
                return None
            finally:
                if stderr_tail is not None:
                    await stderr_tail.stop()

    def _apply_stop_request(self, session: Session, job: Job, *, can_pause: bool) -> bool:
        """Applique une annulation, un arrêt du serveur ou une pause demandés ; vrai si le
        job s'est arrêté.

        Le dossier de travail n'est purgé que pour une annulation — une pause comme un
        arrêt du serveur restent reprenables (l'arrêt du serveur porte son motif).
        """
        job_id = job.id
        if job_id in self._cancel_requested:
            self._update_job(session, job, status=JobStatus.CANCELED, speed=None, eta=None)
            self.discard_work_dir(job_id)
            return True
        if not can_pause:
            return False
        if self._is_shutting_down or job_id in self._pause_requested:
            error = INTERRUPTED_MESSAGE if self._is_shutting_down else None
            self._update_job(
                session, job, status=JobStatus.PAUSED, error=error, speed=None, eta=None
            )
            return True
        return False

    def _handle_phase_failure(self, session: Session, job: Job, exc: Exception, phase: str) -> None:
        """Traduit l'échec d'une phase en statut final : annulation, pause ou erreur.

        Un SIGTERM/SIGKILL volontaire fait échouer la phase comme n'importe quelle panne :
        seuls les drapeaux posés par `cancel()`/`pause()` (ou l'arrêt du serveur) distinguent
        un arrêt demandé d'une vraie erreur.
        """
        if self._apply_stop_request(session, job, can_pause=True):
            return
        logger.warning("Échec %s job %s : %s", phase, job.id, exc)
        self._update_job(session, job, status=JobStatus.ERROR, error=str(exc), speed=None, eta=None)

    async def _convert_phase(
        self, session: Session, job: Job, temp_path: Path, work_dir: Path
    ) -> Path | None:
        """Conversion optionnelle. Retourne le chemin source final, ou `None` en cas d'échec.

        La sortie est écrite dans un **sous-dossier** : `downloaded_file` ne regarde que les
        fichiers à la racine du dossier de travail, une conversion tronquée par un arrêt
        brutal ne peut donc jamais être confondue avec le fichier téléchargé lors d'une
        reprise. Ce sous-dossier est reconstruit à chaque tentative.
        """
        preset = self._resolve_preset(job.preset_id)
        if preset is None:
            return temp_path
        job_id = job.id
        self._update_job(session, job, status=JobStatus.CONVERTING)
        convert_dir = work_dir / "converted"
        shutil.rmtree(convert_dir, ignore_errors=True)
        convert_dir.mkdir(parents=True, exist_ok=True)
        converted_path = convert_dir / f"output.{preset.container}"
        try:
            await run_conversion(
                self._settings.ffmpeg_binary,
                preset,
                temp_path,
                converted_path,
                lambda process: self._register_process(job_id, process),
            )
        except Exception as exc:
            # Le fichier téléchargé est conservé : une reprise après un échec de conversion
            # ne doit pas repasser par le réseau (yt-dlp saute un fichier déjà complet).
            self._handle_phase_failure(session, job, exc, "conversion")
            return None
        temp_path.unlink(missing_ok=True)
        return converted_path

    def _destination_or_error(self, session: Session, job: Job) -> Path | None:
        """Résout la destination du job, ou passe le job en erreur et retourne `None`."""
        try:
            return resolve_destination(job.folder, job.filename or job.url, self._settings.roots)
        except PathSecurityError as exc:
            self._update_job(session, job, status=JobStatus.ERROR, error=str(exc))
            return None

    async def _move_phase(self, session: Session, job: Job, source: Path) -> None:
        """Étape finale : déplacement atomique vers la destination, puis statut `done`.

        La destination est **re-résolue ici** : un volume démonté entre la création du job
        et la fin du téléchargement ferait sinon recréer l'arborescence sur la couche
        inscriptible du conteneur, avec un job `done` alors que rien n'a atteint le NAS.

        Le déplacement tourne dans un thread : le dossier temporaire et la destination sont
        presque toujours sur deux volumes, donc une copie de plusieurs Go bloquerait sinon la
        boucle d'évènements (API, SSE, autres workers). `size` est recalculé sur le fichier
        final (taille réelle après conversion éventuelle).
        """
        self._update_job(session, job, status=JobStatus.MOVING)
        destination = self._destination_or_error(session, job)
        if destination is None:
            return
        try:
            final_path = await asyncio.to_thread(
                move_to_reserved, source, final_name(destination, source)
            )
        except OSError as exc:
            self._handle_phase_failure(session, job, exc, "déplacement")
            return
        # `filename` reflète le fichier réellement écrit : l'UI ne doit pas annoncer un nom
        # que la déduplication ou l'extension réelle ont changé.
        self._update_job(
            session,
            job,
            status=JobStatus.DONE,
            progress=100.0,
            size=final_path.stat().st_size,
            filename=final_path.name,
        )
        # Job terminé : plus rien à reprendre, le dossier de travail peut partir.
        self.discard_work_dir(job.id)
