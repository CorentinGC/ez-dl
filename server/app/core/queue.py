"""File d'attente asyncio + workers : exécute le pipeline de chaque job (probe ->
download -> [convert] -> move) et publie les mises à jour aux abonnés SSE."""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import signal
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from sqlalchemy.engine import Engine
from sqlmodel import Session, select

from app.config import Settings
from app.core import ffmpeg, ytdlp
from app.core.cookies import cookie_jar_file
from app.core.paths import PathSecurityError, resolve_destination
from app.core.workdir import (
    atomic_move,
    downloaded_file,
    free_destination,
    purge_temp_residue,
)
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

# Message porté par un job suspendu par un arrêt du serveur : la reprise est possible, ce
# n'est donc pas une erreur, mais l'UI doit pouvoir expliquer pourquoi le job s'est arrêté.
INTERRUPTED_MESSAGE = "Interrompu par un redémarrage du serveur"

# Statuts dont le dossier de travail doit survivre à un redémarrage : leur fichier partiel
# est encore exploitable par une reprise.
_RESUMABLE_STATUSES = [
    JobStatus.QUEUED.value,
    JobStatus.PAUSED.value,
    JobStatus.ERROR.value,
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


def _stop_process_group(process: asyncio.subprocess.Process | None, sig: int) -> None:
    """Envoie `sig` au **groupe** de process du job, pas au seul process lancé.

    Le binaire yt-dlp standalone est un exécutable PyInstaller : un bootloader parent qui
    ré-exécute le vrai interpréteur dans un process enfant. Le bootloader relaie SIGTERM,
    mais un SIGKILL le tue sans que l'enfant en sache rien : celui-ci continuait à
    télécharger et à écrire sur le pipe de progression, ce qui faisait avancer la barre
    d'un job « annulé » jusqu'à 100 % — l'annulation paraissait sans effet (ez-dl-1xu).

    Les process sont lancés avec `start_new_session=True` : leur pgid vaut leur pid. Le
    garde-fou vérifie cette égalité avant `killpg`, sinon un process lancé autrement ferait
    signaler le groupe du serveur lui-même.
    """
    if process is None or process.returncode is not None:
        return
    try:
        is_group_leader = os.getpgid(process.pid) == process.pid
    except (ProcessLookupError, PermissionError, OSError):
        is_group_leader = False
    try:
        if is_group_leader:
            os.killpg(process.pid, sig)
        else:
            process.send_signal(sig)
    except (ProcessLookupError, PermissionError):
        # Course normale : le process s'est terminé entre le test et l'envoi du signal.
        return


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
        self._pause_requested: set[str] = set()

    async def start(self) -> None:
        """Démarre les workers, suspend les jobs interrompus, purge les résidus temporaires."""
        self._recover_interrupted_jobs()
        self._purge_temp_residue()
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
        _stop_process_group(self._processes.get(job_id), signal.SIGKILL)

    def pause(self, job_id: str) -> None:
        """Demande la suspension d'un job.

        SIGTERM et non SIGKILL : yt-dlp doit pouvoir laisser son `.part` et son état de
        reprise en place, c'est ce fichier partiel qui évite de tout retélécharger. Le
        dossier de travail n'est pas purgé pour un job suspendu.
        """
        self._pause_requested.add(job_id)
        _stop_process_group(self._processes.get(job_id), signal.SIGTERM)

    def work_dir(self, job_id: str) -> Path:
        """Dossier de travail dédié à un job (fichier partiel, sortie de conversion)."""
        return self._settings.temp_dir / job_id

    def discard_work_dir(self, job_id: str) -> None:
        """Supprime le dossier de travail d'un job : plus rien n'est reprenable ensuite."""
        shutil.rmtree(self.work_dir(job_id), ignore_errors=True)

    def _recover_interrupted_jobs(self) -> None:
        """Au démarrage, suspend les jobs restés en cours lors de l'arrêt précédent.

        Ils passent en `paused` et non en `error` : leur fichier partiel est toujours dans
        le dossier de travail, une reprise repartira de là (à condition qu'`EZDL_TEMP_DIR`
        survive au redémarrage — voir docs/fr/setup.md).
        """
        with Session(self._engine) as session:
            jobs = session.exec(select(Job).where(Job.status.in_(_STUCK_STATUSES))).all()
            if not jobs:
                return
            for job in jobs:
                job.status = JobStatus.PAUSED
                job.error = INTERRUPTED_MESSAGE
                job.speed = None
                job.eta = None
                job.updated_at = utcnow()
                session.add(job)
            session.commit()

    def _purge_temp_residue(self) -> None:
        """Nettoie `EZDL_TEMP_DIR` des restes de l'exécution précédente.

        Appelé **après** `_recover_interrupted_jobs`, pour que les jobs coupés par l'arrêt
        précédent soient déjà repassés en `paused` et gardent donc leur fichier partiel.
        """
        with Session(self._engine) as session:
            resumable = {
                job.id
                for job in session.exec(select(Job).where(Job.status.in_(_RESUMABLE_STATUSES)))
            }
        purge_temp_residue(self._settings.temp_dir, resumable)

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
                self._pause_requested.discard(job_id)
                self._contexts.pop(job_id, None)
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
        """Exécute le pipeline complet d'un job."""
        context = self._contexts.get(job_id, JobContext())
        with Session(self._engine) as session:
            job = session.get(Job, job_id)
            # Le statut en base fait office de jeton de prise : une reprise ré-enfile l'id
            # sans pouvoir retirer l'entrée obsolète de la file, et une annulation/pause
            # d'un job encore en attente ne fait que changer son statut. Tout ce qui n'est
            # plus `queued` a donc déjà été traité — ou ne doit pas l'être.
            if job is None or job.status != JobStatus.QUEUED.value:
                return
            if self._destination_or_error(session, job) is None:
                return
            # Aucun `await` entre la lecture du statut et cette écriture : deux workers ne
            # peuvent pas prendre le même job.
            job = self._update_job(session, job, status=JobStatus.DOWNLOADING, error=None)

            # Dossier de travail dédié : yt-dlp choisit lui-même le nom final du fichier,
            # l'isoler permet de le retrouver sans le deviner. Conservé tant que le job
            # reste reprenable (pause, erreur), supprimé dès qu'il ne l'est plus.
            work_dir = self.work_dir(job_id)
            temp_path = await self._download_phase(session, job, context, work_dir)
            if temp_path is None:
                return
            source = await self._convert_phase(session, job, temp_path, work_dir)
            if source is None:
                return
            self._move_phase(session, job, source)

    async def _download_phase(
        self, session: Session, job: Job, context: JobContext, work_dir: Path
    ) -> Path | None:
        """Télécharge le job dans `work_dir`, en reprenant un éventuel `.part` déjà présent.

        Retourne le chemin du fichier produit, ou `None` en cas d'échec/annulation/pause.
        """
        work_dir.mkdir(parents=True, exist_ok=True)
        job_id = job.id
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
                )
                self._processes[job_id] = process

                async def on_progress(data: dict[str, Any]) -> None:
                    fields = _progress_fields(data)
                    if fields:
                        self._update_job(session, job, **fields)

                await ytdlp.stream_progress(process, on_progress)
                await ytdlp.wait_download(process)
                return downloaded_file(work_dir)
            except Exception as exc:
                self._handle_phase_failure(session, job, exc, "téléchargement")
                return None

    def _handle_phase_failure(
        self, session: Session, job: Job, exc: Exception, phase: str
    ) -> None:
        """Traduit l'échec d'une phase en statut final : annulation, pause ou erreur.

        Un SIGTERM/SIGKILL volontaire fait échouer la phase comme n'importe quelle panne :
        seuls les drapeaux posés par `cancel()`/`pause()` distinguent un arrêt demandé d'une
        vraie erreur. Le dossier de travail n'est purgé que pour une annulation — une pause
        comme une erreur restent reprenables.
        """
        job_id = job.id
        if job_id in self._cancel_requested:
            self._update_job(session, job, status=JobStatus.CANCELED, speed=None, eta=None)
            self.discard_work_dir(job_id)
            return
        if job_id in self._pause_requested:
            self._update_job(session, job, status=JobStatus.PAUSED, speed=None, eta=None)
            return
        logger.warning("Échec %s job %s : %s", phase, job_id, exc)
        self._update_job(
            session, job, status=JobStatus.ERROR, error=str(exc), speed=None, eta=None
        )

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
        args = ffmpeg.build_conversion_args(preset, str(temp_path), str(converted_path))
        try:
            process = await asyncio.create_subprocess_exec(
                self._settings.ffmpeg_binary,
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                # Groupe de process dédié : `_stop_process_group` peut alors signaler tout
                # l'arbre sans risquer de viser le groupe du serveur.
                start_new_session=True,
            )
            self._processes[job_id] = process
            _, stderr = await process.communicate()
            if process.returncode != 0:
                raise RuntimeError(
                    f"ffmpeg a échoué : {stderr.decode('utf-8', errors='replace')[-300:]}"
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
            return resolve_destination(
                job.folder, job.filename or job.url, self._settings.roots
            )
        except PathSecurityError as exc:
            self._update_job(session, job, status=JobStatus.ERROR, error=str(exc))
            return None

    def _move_phase(self, session: Session, job: Job, source: Path) -> None:
        """Étape finale : déplacement atomique vers la destination, puis statut `done`.

        La destination est **re-résolue ici** : un volume démonté entre la création du job
        et la fin du téléchargement ferait sinon recréer l'arborescence sur la couche
        inscriptible du conteneur, avec un job `done` alors que rien n'a atteint le NAS.

        `size` est recalculé sur le fichier final (taille réelle après conversion
        éventuelle), plutôt que de conserver la dernière estimation de téléchargement.
        """
        self._update_job(session, job, status=JobStatus.MOVING)
        destination = self._destination_or_error(session, job)
        if destination is None:
            return
        try:
            final_path = free_destination(destination)
            atomic_move(source, final_path)
        except OSError as exc:
            self._handle_phase_failure(session, job, exc, "déplacement")
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
        # Job terminé : plus rien à reprendre, le dossier de travail peut partir.
        self.discard_work_dir(job.id)
