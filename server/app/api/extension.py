"""Routes publiques `/extension` — distribution de l'extension Chrome empaquetée par ce
serveur : page d'installation, archive `.crx` signée, zip pour la voie développeur, et
version publiée (consommée par la popup pour signaler une mise à jour).

Aucune authentification : ces routes ne servent que du code déjà public (dépôt ouvert), et un
en-tête `Authorization` est impossible à joindre à un simple lien de navigateur. Voir
`docs/fr/decisions/0004-distribution-extension-crx.md`.

Le contenu de `EZDL_EXTENSION_DIST_DIR` est déposé par un contexte de build, pas écrit par le
code : il est traité ici comme une entrée non fiable (version validée puis échappée, liens
symboliques refusés).
"""

from __future__ import annotations

import hashlib
import html
import logging
import re
from pathlib import Path
from string import Template

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, HTMLResponse

from app.config import APP_VERSION, Settings, get_settings
from app.core import crx
from app.schemas import ExtensionVersionResponse

logger = logging.getLogger(__name__)

router = APIRouter(tags=["extension"])

# Noms déposés dans `EZDL_EXTENSION_DIST_DIR` par le stage `extension-zip` du Dockerfile.
ZIP_FILENAME = "ez-dl-extension.zip"
VERSION_FILENAME = "extension-version.txt"

CRX_MEDIA_TYPE = "application/x-chrome-extension"
_CACHE_DIRNAME = "extension-cache"
_TEMPLATE_PATH = Path(__file__).resolve().parent.parent / "templates" / "extension.html"

# Une version publiée finit dans du HTML public et dans un en-tête `Content-Disposition` :
# seule la forme numérique est acceptée, comme côté extension (`src/lib/version.ts`).
_VERSION_PATTERN = re.compile(r"^\d+(\.\d+){0,3}$")
_MAX_VERSION_CHARS = 32

_UNAVAILABLE_DETAIL = (
    "Extension absente de cette image : elle a été construite sans le contexte de build "
    "`extension`. Reconstruire avec `docker compose up -d --build` depuis la racine du dépôt "
    "pour activer la distribution."
)
_UNSIGNABLE_DETAIL = (
    "Impossible de préparer le `.crx` signé : le dossier de données du serveur "
    "(EZDL_DATA_DIR) n'est pas inscriptible. Vérifier les droits du volume monté, puis "
    "réessayer. Le zip reste disponible sur /extension/zip."
)


def _zip_path(settings: Settings) -> Path | None:
    """Chemin du zip publié, `None` si l'image ne l'embarque pas.

    Un lien symbolique est refusé : déposé dans le dossier d'artefacts, il ferait servir —
    et surtout SIGNER avec la clé du serveur — un fichier arbitraire, sur une route publique.
    """
    candidate = settings.extension_dist_dir / ZIP_FILENAME
    if candidate.is_symlink() or not candidate.is_file():
        return None
    return candidate


def _published_version(settings: Settings) -> str | None:
    """Version écrite au build depuis `extension/package.json`, `None` si absente ou hors
    format numérique attendu."""
    version_file = settings.extension_dist_dir / VERSION_FILENAME
    try:
        with version_file.open(encoding="utf-8", errors="replace") as handle:
            version = handle.read(_MAX_VERSION_CHARS + 1).strip()
    except OSError:
        return None

    if not _VERSION_PATTERN.match(version):
        if version:
            logger.warning("Version d'extension publiée ignorée : format inattendu.")
        return None
    return version


def _artifact_name(version: str | None, suffix: str) -> str:
    """Nom de fichier proposé au téléchargement, suffixé par la version quand elle est connue."""
    return f"ez-dl-extension-{version}{suffix}" if version else f"ez-dl-extension{suffix}"


def _signed_crx(settings: Settings, archive: Path) -> Path:
    """Construit (ou réutilise) le `.crx` signé correspondant au zip publié."""
    return crx.build_signed_crx(archive, settings.data_dir / _CACHE_DIRNAME, settings.data_dir)


def _fingerprint(settings: Settings, signed: Path) -> tuple[str, str]:
    """Identifiant Chrome attendu et SHA-256 du `.crx` — les deux repères qui permettent de
    détecter un artefact substitué en chemin (installation en HTTP clair, tunnel hostile).

    L'identifiant ne vaut que pour une installation du paquet SIGNÉ (politique système) : une
    extension chargée non empaquetée reçoit un identifiant dérivé du chemin du dossier.
    """
    return crx.signing_identity(settings.data_dir), hashlib.sha256(signed.read_bytes()).hexdigest()


def _digest(path: Path) -> str:
    """SHA-256 d'un artefact publié."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


@router.get("/extension", response_class=HTMLResponse, include_in_schema=False)
def install_page(settings: Settings = Depends(get_settings)) -> HTMLResponse:
    """Page d'installation : téléchargement du `.crx` et marche à suivre dans Chrome."""
    archive = _zip_path(settings)
    version = _published_version(settings) if archive else None

    if archive is None:
        body = _unavailable_body()
    else:
        body = _install_steps(_artifact_name(version, ".zip"), _digest(archive))
        try:
            identity, _ = _fingerprint(settings, _signed_crx(settings, archive))
        except OSError:
            # La signature n'est pas nécessaire à la voie principale : la page reste utile,
            # seul le bloc du paquet signé disparaît.
            logger.warning("Préparation du .crx impossible pour /extension", exc_info=True)
        else:
            body += _signed_package_note(_artifact_name(version, ".crx"), identity)

    template = Template(_TEMPLATE_PATH.read_text(encoding="utf-8"))
    return HTMLResponse(
        template.substitute(
            version=html.escape(version or "indisponible"),
            server_version=html.escape(APP_VERSION),
            body=body,
        )
    )


def _unavailable_body() -> str:
    """Corps de la page quand l'image ne publie aucune extension."""
    return (
        '<p class="unavailable">Aucune extension n\'est publiée par ce serveur.</p>'
        "<p>L'image a été construite sans le contexte de build <code>extension</code>. "
        "Reconstruire avec <code>docker compose up -d --build</code> depuis la racine du "
        "dépôt pour activer la distribution.</p>"
    )


def _install_steps(zip_name: str, zip_digest: str) -> str:
    """Corps de la page quand une extension est publiée : bouton, étapes et empreintes.

    Le zip est la voie principale, et non le `.crx` : Chrome refuse tout `.crx` auto-signé
    déposé sur `chrome://extensions` (`CRX_REQUIRED_PROOF_MISSING`), il exige sur ce chemin
    une signature du Chrome Web Store. Le paquet signé n'est installable que par politique
    système, où la vérification se fait sans preuve d'éditeur.
    """
    return (
        f'<a class="download" href="/extension/zip" download>Télécharger '
        f"{html.escape(zip_name)}</a>"
        "<ol>"
        "<li>Décompresser l'archive dans un dossier <strong>qui restera en place</strong> : "
        "Chrome le relit à chaque démarrage.</li>"
        "<li>Ouvrir <code>chrome://extensions</code> dans Chrome.</li>"
        "<li>Activer le <strong>Mode développeur</strong> (interrupteur en haut à droite).</li>"
        "<li>Cliquer sur <strong>Charger l'extension non empaquetée</strong> et choisir le "
        "dossier décompressé.</li>"
        "</ol>"
        '<p class="note">SHA-256 de l\'archive :<br />'
        f'<span class="mono">{html.escape(zip_digest)}</span></p>'
        '<p class="note">Pour mettre à jour plus tard, remplacer le contenu du dossier par '
        "celui de la nouvelle archive, puis recharger l'extension depuis "
        "<code>chrome://extensions</code>.</p>"
    )


def _signed_package_note(crx_name: str, identity: str) -> str:
    """Bloc secondaire décrivant le paquet signé et le seul chemin qui l'accepte."""
    return (
        "<hr />"
        '<p class="note"><strong>Paquet signé — installation par politique système.</strong> '
        f'<a href="/extension/download">{html.escape(crx_name)}</a> est destiné à une '
        "installation pilotée par politique d'entreprise, seul chemin où Chrome accepte une "
        "extension signée hors Chrome Web Store. Identifiant du paquet :<br />"
        f'<span class="mono">{html.escape(identity)}</span></p>'
        '<p class="note">Le <strong>glisser-déposer de ce fichier sur '
        "<code>chrome://extensions</code> échoue</strong> avec « Package incorrect "
        "CRX_REQUIRED_PROOF_MISSING » : sur ce chemin Chrome exige une signature du Chrome Web "
        "Store, qu'aucun serveur auto-hébergé ne peut produire. Utiliser l'archive ci-dessus.</p>"
    )


@router.get("/extension/download", include_in_schema=False)
def download_crx(settings: Settings = Depends(get_settings)) -> FileResponse:
    """Archive `.crx` signée, destinée à l'installation par politique système.

    Elle n'est PAS installable par glisser-déposer : voir `_signed_package_note`.
    """
    archive = _zip_path(settings)
    if archive is None:
        raise HTTPException(status_code=404, detail=_UNAVAILABLE_DETAIL)

    try:
        signed = _signed_crx(settings, archive)
    except OSError as error:
        logger.warning("Signature du .crx impossible", exc_info=True)
        raise HTTPException(status_code=503, detail=_UNSIGNABLE_DETAIL) from error

    return FileResponse(
        signed,
        media_type=CRX_MEDIA_TYPE,
        filename=_artifact_name(_published_version(settings), ".crx"),
    )


@router.get("/extension/zip", include_in_schema=False)
def download_zip(settings: Settings = Depends(get_settings)) -> FileResponse:
    """Zip de l'extension, pour la voie « Charger l'extension non empaquetée »."""
    archive = _zip_path(settings)
    if archive is None:
        raise HTTPException(status_code=404, detail=_UNAVAILABLE_DETAIL)

    return FileResponse(
        archive,
        media_type="application/zip",
        filename=_artifact_name(_published_version(settings), ".zip"),
    )


@router.get("/extension/version", response_model=ExtensionVersionResponse)
def published_version(settings: Settings = Depends(get_settings)) -> ExtensionVersionResponse:
    """Version publiée, comparée par la popup à celle de l'extension installée."""
    archive = _zip_path(settings)
    if archive is None:
        return ExtensionVersionResponse(available=False)

    version = _published_version(settings)
    try:
        signed = _signed_crx(settings, archive)
        identity, digest = _fingerprint(settings, signed)
        size: int | None = signed.stat().st_size
    except OSError:
        # Signature impossible (disque plein, données non inscriptibles) : la version reste
        # annonçable, seules les empreintes manquent.
        logger.warning("Préparation du .crx impossible pour /extension/version", exc_info=True)
        identity = digest = None
        size = None

    return ExtensionVersionResponse(
        available=True,
        version=version,
        filename=_artifact_name(version, ".crx"),
        size=size,
        extension_id=identity,
        sha256=digest,
    )
