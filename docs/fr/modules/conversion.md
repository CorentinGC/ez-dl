# Module — Conversion

La conversion est optionnelle et pilotée par un système de **presets** ffmpeg, détectés au
démarrage du serveur en fonction des encodeurs réellement disponibles sur la machine/le conteneur.

## Détection des encodeurs

Au démarrage (`server/app/main.py`, lifespan), le service `server/app/services/ffmpeg.py` exécute :

```
ffmpeg -encoders
```

et parse la sortie pour établir la liste des encodeurs disponibles. Cette liste est mise en cache
en mémoire pour la durée de vie du process (redémarrer le serveur si le matériel/les drivers
changent).

`GET /api/capabilities` expose le résultat :

```json
{
  "encoders": [{"id": "h264_nvenc", "name": "NVIDIA H.264", "hwaccel": "nvenc", "codec": "h264"}],
  "presets": [{"id": "h264_nvenc", "label": "H.264 (GPU NVIDIA)", "description": "...", "container": "mp4", "video_codec": "h264_nvenc", "args_preview": "-c:v h264_nvenc -preset p4"}]
}
```

**Un preset n'est proposé à l'extension que si son encodeur sous-jacent est détecté disponible.**
Le popup n'affiche donc jamais un preset inutilisable sur le serveur cible.

## Presets fournis

| Preset | Encodeur | Cas d'usage |
|---|---|---|
| `copy` | — (remux) | **Défaut**, toujours disponible. Pas de réencodage : recopie les flux tels quels dans le conteneur final. Rapide, sans perte, mais ne change ni codec ni résolution. |
| `h264_nvenc` / `hevc_nvenc` | NVIDIA NVENC | Réencodage accéléré GPU sur machines avec carte NVIDIA. |
| `h264_qsv` / `hevc_qsv` | Intel QuickSync | Réencodage accéléré GPU sur CPU Intel avec iGPU. |
| `h264_vaapi` / `hevc_vaapi` | VAAPI (Linux) | Accélération matérielle générique Linux (Intel/AMD). |
| `libx264` / `libx265` | CPU (x264/x265) | Réencodage logiciel, sans dépendance matérielle, plus lent. |
| `audio_mp3` / `audio_opus` | CPU | Extraction audio seule (pas de flux vidéo dans la sortie). |

Chaque preset définit : le conteneur de sortie, le codec vidéo (ou l'absence de piste vidéo pour les
presets audio), et les arguments ffmpeg associés (`args_preview` exposé pour transparence côté UI).

## Support NVENC dans l'image Docker

Le ffmpeg installé par défaut dans `server/Dockerfile` (paquet Debian, build arg
`FFMPEG_VARIANT=debian`) **n'inclut pas** les encodeurs NVENC : les dépôts Debian excluent les
dépendances non-libres requises par NVIDIA. Résultat : même avec le passthrough GPU de
`docker-compose.gpu.yml`, `ffmpeg -encoders` ne liste pas `h264_nvenc`/`hevc_nvenc`, et ces
presets n'apparaissent jamais dans `/api/capabilities`.

Pour activer NVENC, reconstruire l'image serveur avec la variante `nvenc` : un binaire ffmpeg
statique [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) (`linux64-gpl`,
self-contained) remplace le paquet Debian dans l'image finale. `docker-compose.gpu.yml`
positionne ce build arg automatiquement — il suffit de (re)construire avec les deux fichiers
compose :

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
```

Limitations à connaître :

- La variante `nvenc` est disponible **uniquement en amd64** (BtbN ne publie pas de build
  `linux64` pour arm64) — sans conséquence pratique puisque NVENC est une technologie NVIDIA.
- Nécessite `nvidia-container-toolkit` sur l'hôte, et `NVIDIA_DRIVER_CAPABILITIES` incluant la
  capability `video` (déjà positionnée dans `docker-compose.gpu.yml`) pour exposer
  `libnvidia-encode` à l'intérieur du conteneur.

Détails d'implémentation : stages `ffmpeg-debian` / `ffmpeg-nvenc` de `server/Dockerfile`.

## Déroulement d'une conversion

1. Le job a un `preset_id` différent de `copy` (ou absent avec un défaut différent de `copy` si
   configuré côté extension).
2. Après le téléchargement (`status: downloading` → terminé), le worker de la queue invoque
   `server/app/services/ffmpeg.py` avec le fichier temporaire en entrée, un fichier de sortie dans
   `EZDL_TEMP_DIR`, et les arguments du preset.
3. `status: converting` est publié via SSE pendant l'exécution.
4. À la fin, le fichier converti remplace le fichier téléchargé pour l'étape `moving` (déplacement
   vers `folder`, revalidé contre `EZDL_DOWNLOAD_ROOTS`).
5. En cas d'échec ffmpeg (encodeur indisponible au moment de l'exécution, flux corrompu...) →
   `status: error`, fichiers temporaires nettoyés.

Comme pour yt-dlp, tout appel à ffmpeg passe par `subprocess` avec une **liste d'arguments**,
jamais `shell=True` (voir [conventions.md](../conventions.md#sécurité)).

## Ajouter un preset

1. Définir le preset dans `server/app/services/ffmpeg.py` : id, label, description, conteneur,
   codec vidéo (ou `None` pour un preset audio-only), liste d'arguments ffmpeg, et l'identifiant de
   l'encodeur ffmpeg requis (utilisé pour filtrer via `ffmpeg -encoders`).
2. Vérifier que le conteneur choisi est compatible avec le codec (ex. ne pas proposer H.265 dans un
   conteneur qui ne le supporte pas côté lecteurs cibles courants).
3. Ajouter un cas de test dans `server/tests/test_capabilities.py` : preset absent si l'encodeur
   n'est pas dans la sortie simulée de `ffmpeg -encoders`, présent sinon.
4. Documenter le preset dans le tableau ci-dessus (et son miroir dans `docs/en/modules/conversion.md`).
5. Pas de changement requis côté extension : la liste de presets est entièrement pilotée par
   `GET /api/capabilities`, le popup l'affiche dynamiquement.
