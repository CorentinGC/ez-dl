[English](README.md) | **Français**

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo-light.svg" alt="ez-dl" width="198">
  </picture>
</p>

# ez-dl

**Téléchargement vidéo self-hosted, en un clic depuis votre navigateur.**

![License: PolyForm Noncommercial](https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue)
![Python 3.13](https://img.shields.io/badge/python-3.13-blue)
![Manifest V3](https://img.shields.io/badge/chrome-manifest%20v3-yellow)

ez-dl associe une extension Chrome qui repère les vidéos sur la page que vous consultez à un
serveur self-hosted qui les télécharge directement sur votre propre stockage (NAS, serveur
personnel, ce que vous voulez). Aucun cloud tiers, aucun envoi de vos liens ailleurs.

---

## Sommaire

- [Ce que c'est](#ce-que-cest)
- [Cadre légal](#cadre-légal)
- [Architecture](#architecture)
- [Démarrage rapide](#démarrage-rapide)
- [Configuration](#configuration)
- [Sécurité](#sécurité)
- [Développement](#développement)
- [FAQ](#faq)
- [Roadmap](#roadmap)
- [Contribuer](#contribuer)
- [Licence](#licence)

## Ce que c'est

- **Détection automatique** — l'extension combine l'extraction [yt-dlp](https://github.com/yt-dlp/yt-dlp)
  avec du sniffing réseau en direct (`chrome.webRequest`) pour trouver des flux vidéo lisibles sur
  quasiment n'importe quelle page, pas seulement la poignée de sites que yt-dlp connaît
  explicitement.
- **Choix de qualité** — chaque format détecté est listé avec sa résolution, son codec et sa
  taille ; la meilleure qualité disponible est présélectionnée, mais vous pouvez toujours en
  choisir une autre.
- **Renommage à la volée** — le champ nom de fichier est préfilli avec le titre de la vidéo (ou le
  titre de la page à défaut) et sanitizé automatiquement ; modifiable avant le lancement.
- **Dossiers de destination favoris** — enregistrez vos dossiers habituels et accédez-y
  directement, ou parcourez les racines autorisées du serveur depuis le popup.
- **Conversion optionnelle** — remux en `copy` (sans réencodage) par défaut, ou transcodage avec
  accélération matérielle (NVIDIA NVENC, Intel QuickSync, VAAPI) ou encodeurs CPU (x264/x265)
  quand le serveur les détecte.
- **Mode apprentissage** — quand rien n'est détecté automatiquement, un sélecteur vous permet de
  cliquer sur la vidéo dans la page ; ez-dl corrèle ce clic avec le trafic réseau récent et peut
  mémoriser le motif pour ce site la prochaine fois.

## Cadre légal

ez-dl est un outil pour télécharger du contenu vidéo **que vous avez déjà le droit de
télécharger** — vos propres publications, du contenu sous licence permissive, du contenu que les
conditions d'utilisation d'un site vous autorisent à enregistrer, etc.

- **Aucun contournement de DRM.** ez-dl n'implémente pas, n'embarque pas, et n'accepte aucune
  contribution qui contournerait Widevine, PlayReady, FairPlay, ou tout autre système de
  protection de contenu. Les flux protégés par DRM sont explicitement hors périmètre.
- **Votre responsabilité.** Vous êtes responsable du respect des conditions d'utilisation de tout
  site sur lequel vous utilisez ez-dl, ainsi que du droit d'auteur qui s'applique à vous. Ce
  projet ne vous accorde aucun droit sur un contenu que vous ne possédez pas déjà.
- ez-dl est une infrastructure de téléchargement et d'organisation de fichiers — il n'a pas
  d'opinion sur ce que vous téléchargez, mais il ne vous aidera pas à contourner des mesures de
  protection pour l'obtenir.

## Architecture

```text
┌────────────────────────┐      HTTP(S) + Bearer token      ┌─────────────────────────────┐
│  Navigateur + Extension │ ───────────────────────────────▶│            Serveur           │
│  (MV3, détection+sniff) │◀─────────────────────────────── │  FastAPI + yt-dlp + ffmpeg   │
│                          │      progression via SSE         │  file · conversion · renommage │
└────────────────────────┘                                   └───────────────┬─────────────┘
                                                                               │ écrit dans
                                                                               ▼
                                                                 ┌───────────────────────────┐
                                                                 │  Dossiers NAS / disque       │
                                                                 │  (EZDL_DOWNLOAD_ROOTS)       │
                                                                 └───────────────────────────┘
```

## Démarrage rapide

### 1. Lancer le serveur avec Docker Compose

Créez un fichier `.env` à côté de votre `docker-compose.yml` (voir [`.env.example`](.env.example)
pour la liste complète des variables), puis :

```yaml
# docker-compose.yml
services:
  ez-dl-server:
    build: ./server
    container_name: ez-dl-server
    restart: unless-stopped
    ports:
      - "8000:8000"
    environment:
      EZDL_PASSWORD: ${EZDL_PASSWORD}
      EZDL_DOWNLOAD_ROOTS: "Movies=/data/movies,Downloads=/data/downloads"
    volumes:
      - ./config:/config
      - /mnt/media/movies:/data/movies
      - /mnt/media/downloads:/data/downloads
    # Décommentez pour activer l'encodage matériel NVIDIA (presets NVENC) :
    # deploy:
    #   resources:
    #     reservations:
    #       devices:
    #         - driver: nvidia
    #           count: 1
    #           capabilities: [gpu]
```

```bash
docker compose up -d
```

**NVIDIA NVENC :** le passthrough GPU seul ne suffit pas — l'image serveur par défaut embarque le
ffmpeg du paquet Debian, qui n'inclut pas NVENC (les dépôts Debian excluent les dépendances
non-libres requises). Utilisez l'override fourni [`docker-compose.gpu.yml`](docker-compose.gpu.yml),
qui reconstruit aussi l'image avec un binaire ffmpeg statique incluant NVENC (amd64 uniquement) :

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
```

Voir [`docs/fr/modules/conversion.md`](docs/fr/modules/conversion.md#support-nvenc-dans-limage-docker)
pour le détail.

### 2. Installer l'extension

Le serveur publie lui-même l'extension empaquetée — aucun clone, aucun Node.js nécessaire sur la
machine depuis laquelle vous l'installez.

1. Ouvrez `http://<serveur>:8000/extension` (ex. `http://nas.local:8000/extension`) et téléchargez
   le `.zip`. Cette page est publique, tout comme les routes de téléchargement vers lesquelles elle
   pointe.
2. Décompressez-le dans un dossier **qui restera en place** — Chrome le relit à chaque démarrage.
3. Ouvrez `chrome://extensions` et activez le **mode développeur**.
4. Cliquez sur **Charger l'extension non empaquetée** et choisissez le dossier décompressé.

Chrome n'autorise aucune installation en un clic en dehors du Chrome Web Store, et refuse tout
paquet signé qui n'en vient pas : déposer un `.crx` sur `chrome://extensions` échoue avec
« Package incorrect CRX_REQUIRED_PROOF_MISSING », mode développeur ou non. Le `.crx` servi par
`/extension/download` est destiné à une installation par **politique système**, seul chemin que
Chrome accepte hors Web Store.

Pour publier une nouvelle version après avoir modifié l'extension, incrémentez `version` dans
`extension/package.json`, relancez `docker compose up -d --build` (ou `make publish-extension`),
puis remplacez le contenu du dossier décompressé et rechargez l'extension. Le `.crx` est signé à
l'exécution avec une clé stockée dans `EZDL_DATA_DIR/extension-signing-key.pem` — gardez ce dossier
sur un volume, car Chrome en dérive l'identifiant de l'extension pour la voie « politique système »,
et une clé perdue signifie un nouvel identifiant au lieu d'une mise à jour.

**Alternative développeur** — construire l'extension localement et la charger non empaquetée :

```bash
cd extension
npm install
npm run build
```

Puis dans Chrome : ouvrez `chrome://extensions`, activez le **mode développeur**, cliquez sur
**Charger l'extension non empaquetée**, et sélectionnez `extension/.output/chrome-mv3`.

### 3. Configurer

Ouvrez la page **Options** de l'extension et renseignez :

- **URL du serveur** — `http://localhost:8000` par défaut ; à changer uniquement pour un serveur
  distant (ex. `http://nas.local:8000`)
- **Mot de passe** — la valeur que vous avez définie pour `EZDL_PASSWORD`

Utilisez **Tester la connexion** pour vérifier que l'extension joint bien `/api/health`. C'est
prêt — ouvrez une page contenant une vidéo et cliquez sur l'icône ez-dl.

## Configuration

Tous les réglages serveur sont des variables d'environnement préfixées `EZDL_`. Voir
[`.env.example`](.env.example) pour un fichier prêt à copier.

| Variable                            | Défaut                    | Rôle                                                                                                |
| ------------------------------------ | -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `EZDL_PASSWORD`                      | *(recommandé)* | Mot de passe d'accès à l'API. Si absent ou vide, le serveur génère un mot de passe fort (32 caractères URL-safe) à chaque démarrage, l'affiche dans la console avec une pause de 5 secondes, puis démarre. Définiez-le dans `.env` pour un mot de passe stable. |
| `EZDL_HOST`                          | `0.0.0.0`                  | Adresse d'écoute uvicorn                                                                               |
| `EZDL_PORT`                          | `8000`                     | Port HTTP                                                                                               |
| `EZDL_DOWNLOAD_ROOTS`                | `Downloads=/data/downloads` | Racines de destination autorisées, format `Label=/chemin` séparé par `,`. Seuls ces chemins (et leurs sous-dossiers) sont accessibles en écriture. |
| `EZDL_DATA_DIR`                      | `/config`                  | Base SQLite + état de l'application                                                                    |
| `EZDL_TEMP_DIR`                      | `/tmp/ez-dl`                | Espace temporaire pour les fichiers partiels avant le déplacement final                                |
| `EZDL_EXTENSION_DIST_DIR`            | `/app/extension-dist`      | Artefacts de l'extension empaquetée servis par `/extension`. Intégrés à l'image ; en leur absence, la page d'installation l'explique et les routes de téléchargement renvoient `404`. |
| `EZDL_MAX_CONCURRENT_JOBS`           | `2`                        | Nombre de workers de la file d'attente                                                                  |
| `EZDL_YTDLP_UPDATE_INTERVAL_HOURS`   | `24`                       | Période de la tâche d'auto-update de yt-dlp (`0` la désactive)                                          |
| `EZDL_YTDLP_BINARY`                  | `yt-dlp`                   | Chemin du binaire yt-dlp                                                                                |
| `EZDL_FFMPEG_BINARY`                 | `ffmpeg`                   | Chemin du binaire ffmpeg                                                                                |
| `EZDL_CORS_ORIGINS`                  | `chrome-extension://*`     | Origines CORS autorisées                                                                                |
| `EZDL_LOG_LEVEL`                     | `info`                     | Niveau de verbosité des logs                                                                            |

**Format de `EZDL_DOWNLOAD_ROOTS` :** une liste de paires `Label=/chemin/absolu` séparées par des
virgules. Chaque label devient une racine de dossier que l'extension peut parcourir et dans
laquelle télécharger ; tout chemin en dehors de ces racines (y compris via une traversée `..`) est
rejeté. Exemple :

```
EZDL_DOWNLOAD_ROOTS=Movies=/mnt/media/movies,Shows=/mnt/media/shows,Downloads=/mnt/media/downloads
```

## Sécurité

- **L'authentification est toujours requise.** Si `EZDL_PASSWORD` n'est pas défini, le serveur génère un mot de passe fort (32 caractères) à chaque démarrage, l'affiche dans un bandeau isolé de la console avec une pause de 5 secondes, puis démarre normalement — récupérez ce mot de passe dans les logs de démarrage. Il n'existe pas de mode "sans authentification". Pour un mot de passe stable, définiez `EZDL_PASSWORD` dans `.env`. L'extension l'envoie en `Authorization: Bearer <EZDL_PASSWORD>` sur chaque requête sauf `/api/health`.
- **N'exposez pas le serveur directement sur Internet.** Si vous avez besoin d'un accès distant,
  placez un reverse proxy avec TLS devant. Exemples minimaux :

  Caddy :

  ```caddyfile
  dl.example.com {
      reverse_proxy 127.0.0.1:8000
  }
  ```

  nginx :

  ```nginx
  server {
      listen 443 ssl;
      server_name dl.example.com;
      ssl_certificate     /etc/ssl/certs/dl.example.com.pem;
      ssl_certificate_key /etc/ssl/private/dl.example.com.key;
      location / { proxy_pass http://127.0.0.1:8000; }
  }
  ```

- **Les chemins de destination sont toujours résolus et validés** par rapport à
  `EZDL_DOWNLOAD_ROOTS` côté serveur ; les noms de fichiers sont sanitizés ; les cookies que vous
  choisissez d'envoyer sont écrits dans un fichier temporaire en `0600` puis supprimés à la fin du
  job.

### Permissions de l'extension

| Permission                    | Pourquoi elle est nécessaire                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `webRequest`                     | Analyser les requêtes sortantes (`.m3u8`, `.mpd`, `.mp4`, …) pour repérer des flux vidéo que yt-dlp seul manquerait. |
| `storage`                        | Enregistrer localement l'URL du serveur, le mot de passe, les dossiers favoris et le preset par défaut dans `chrome.storage.local`. |
| `tabs`                           | Savoir quel onglet est actif, corréler les requêtes sniffées avec le bon onglet, mettre à jour le badge par onglet. |
| `cookies`                        | Lire éventuellement les cookies du site courant pour les transmettre à yt-dlp sur du contenu nécessitant une connexion — uniquement si vous l'activez. |
| `activeTab`                      | Permettre au popup d'agir sur l'onglet actuellement ouvert.                                               |
| `scripting`                      | Injecter le sélecteur "Aider à détecter" dans la page à la demande, pour le mode apprentissage.           |
| `host_permissions : <all_urls>`  | La détection doit fonctionner sur n'importe quel site visité — ez-dl ne fige pas de liste de sites.       |

## Développement

**Prérequis :** [uv](https://docs.astral.sh/uv/), Node.js + npm, `ffmpeg`/`ffprobe`, `yt-dlp`
(accessibles dans le `PATH`, ou pointés via `EZDL_FFMPEG_BINARY` / `EZDL_YTDLP_BINARY`).

```bash
# Serveur, avec rechargement automatique (depuis server/)
uv run uvicorn app.main:app --reload

# Extension, build de développement avec hot reload (depuis extension/)
npm run dev

# Tests serveur (depuis server/)
uv run pytest

# Lint serveur (depuis server/)
uv run ruff check .

# Build de production de l'extension (depuis extension/)
npm run build
```

Voir [CONTRIBUTING.fr.md](CONTRIBUTING.fr.md) pour le workflow complet, le style de code, et
comment ajouter un preset de conversion ou une règle de détection de site.

## FAQ

**Le site X n'est pas détecté ?**
Ouvrez le popup, cliquez sur "Aider à détecter", puis cliquez sur la vidéo dans la page. ez-dl
corrèle votre clic avec le trafic réseau récent et peut enregistrer une règle réutilisable pour ce
site.

**Ça fonctionne avec x.com / Twitter ?**
Oui, via yt-dlp — activez l'envoi des cookies dans les options si le contenu nécessite une session
connectée.

**Et les services protégés par DRM (Netflix, etc.) ?**
Non, et ça ne le sera jamais — voir [Cadre légal](#cadre-légal). C'est explicitement hors
périmètre.

**Pourquoi un mot de passe est-il nécessaire ?**
L'API pilote des téléchargements et écrit des fichiers sur votre disque. Sans authentification,
n'importe qui pouvant joindre le serveur sur votre réseau pourrait déclencher des téléchargements
ou remplir votre stockage.

## Roadmap

- [ ] Support Firefox
- [ ] Pause / reprise et réorganisation de la file
- [ ] Assistant HTTPS intégré pour la configuration du reverse proxy
- [ ] Interface compagnon adaptée au mobile
- [ ] Encodage matériel Apple VideoToolbox

## Contribuer

Les contributions sont les bienvenues — voir [CONTRIBUTING.fr.md](CONTRIBUTING.fr.md) pour le
workflow, le style de code, et comment ajouter un preset ou une règle de site. Merci de lire
également le [Code de conduite](CODE_OF_CONDUCT.md) et, pour les vulnérabilités,
[SECURITY.md](SECURITY.md).

## Licence

Ce projet est distribué sous la [licence PolyForm Noncommercial 1.0.0](LICENSE). L'usage non
commercial est libre. **Tout usage commercial nécessite une licence commerciale distincte et
payante.** Pour l'obtenir, ouvrez une issue GitHub dans ce dépôt, ou contactez le mainteneur à
`<contact@example.com>`.

Note : PolyForm Noncommercial est une licence source-available, pas une licence open source
approuvée par l'OSI — vous pouvez lire, utiliser à des fins non commerciales, modifier et
redistribuer le code, mais l'usage commercial est restreint sauf licence séparée.
