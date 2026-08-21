"""Manipulation du dossier de travail d'un job : retrouver le fichier produit par yt-dlp,
dériver un nom de destination libre, déplacer le résultat.

Chaque job dispose d'un dossier `EZDL_TEMP_DIR/<job_id>` isolé. Il est **conservé** tant que
le job reste reprenable (pause, erreur) : c'est le `.part` qu'il contient qui permet à
yt-dlp de reprendre là où il s'est arrêté au lieu de tout retélécharger.
"""

from __future__ import annotations

import re
import shutil
from collections.abc import Container
from pathlib import Path

from app.core.cookies import COOKIE_JAR_PREFIX, cookie_jar_dir

# Résidus laissés par yt-dlp dans le dossier de travail (téléchargement partiel, état de
# reprise, fragments) : jamais le fichier final, même quand ils survivent à un succès.
_LEFTOVER_SUFFIXES = (".part", ".ytdl", ".temp")

# Un dossier de travail porte l'identifiant (uuid4) de son job : tout le reste de
# `EZDL_TEMP_DIR` appartient à quelqu'un d'autre et ne doit pas être touché.
_JOB_DIR_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)

# Au-delà, c'est que quelque chose tourne en rond : mieux vaut échouer que boucler.
_MAX_DEDUPE_ATTEMPTS = 999


def downloaded_file(work_dir: Path) -> Path:
    """Retourne le fichier produit par yt-dlp dans son dossier de travail dédié.

    Le nom de sortie n'est pas prédictible : yt-dlp impose l'extension du conteneur
    réellement produit (un merge/remux peut la changer). On prend donc le plus gros
    fichier restant, hors résidus.

    Seule la racine du dossier est inspectée : la sortie de conversion vit dans un
    sous-dossier, une conversion tronquée ne peut donc pas être prise pour le fichier
    téléchargé lors d'une reprise.
    """
    # `is_file()` suit les liens : un symlink serait sélectionné puis déplacé tel quel vers
    # la destination, où il pointerait hors des racines autorisées. yt-dlp n'en crée pas —
    # c'est de la défense en profondeur.
    candidates = [
        path
        for path in work_dir.iterdir()
        if path.is_file()
        and not path.is_symlink()
        and not path.suffix.startswith(_LEFTOVER_SUFFIXES)
    ]
    if not candidates:
        raise RuntimeError("yt-dlp n'a produit aucun fichier")
    return max(candidates, key=lambda path: path.stat().st_size)


def free_destination(destination: Path) -> Path:
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


def atomic_move(source: Path, destination: Path) -> None:
    """Déplace `source` vers `destination` ; repli sur une copie si périphérique différent."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        source.replace(destination)
    except OSError:
        shutil.copy2(source, destination)
        source.unlink(missing_ok=True)


def purge_temp_residue(temp_dir: Path, resumable_job_ids: Container[str]) -> None:
    """Supprime les restes de l'exécution précédente dans `temp_dir`.

    Depuis que le dossier temporaire persiste (c'est ce qui rend la reprise utile), rien n'y
    disparaît plus tout seul au redémarrage : les dossiers de travail des jobs qui ne sont
    plus reprenables — terminés, annulés, supprimés de l'historique — s'accumuleraient avec
    leurs mégaoctets. Un `SIGKILL` laisse par ailleurs derrière lui des cookie-jars en clair
    que le `finally` de `cookie_jar_file` n'a jamais pu effacer.

    Seul ce qui est reconnaissable comme produit par ez-dl est supprimé : `EZDL_TEMP_DIR`
    peut pointer sur un dossier partagé.
    """
    if not temp_dir.is_dir():
        return
    for entry in temp_dir.iterdir():
        if entry.name in resumable_job_ids:
            continue
        if entry.is_dir() and not entry.is_symlink() and _JOB_DIR_PATTERN.match(entry.name):
            shutil.rmtree(entry, ignore_errors=True)
        elif entry.is_file() and entry.name.startswith(COOKIE_JAR_PREFIX):
            # Cookie-jar d'avant l'isolement dans `cookies/` (compatibilité ascendante).
            entry.unlink(missing_ok=True)
    # `cookies/` est un point de montage (tmpfs) : on purge son contenu, jamais lui-même.
    for jar in cookie_jar_dir(temp_dir).glob(f"{COOKIE_JAR_PREFIX}*"):
        jar.unlink(missing_ok=True)
