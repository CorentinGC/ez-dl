[English](README.md) | **Français**

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo-light.svg" alt="ez-dl" width="198">
  </picture>
</p>

# ez-dl

**Téléchargement vidéo self-hosted, à un clic depuis votre navigateur.**

![Licence : PolyForm Noncommercial](https://img.shields.io/badge/licence-PolyForm%20Noncommercial-blue)
![Python 3.13](https://img.shields.io/badge/python-3.13-blue)
![Manifest V3](https://img.shields.io/badge/chrome-manifest%20v3-yellow)

ez-dl associe une extension Chrome qui repère les vidéos de la page que vous consultez à un
serveur auto-hébergé qui les télécharge directement sur votre propre stockage (NAS, serveur
maison, ce que vous voulez). Aucun cloud tiers, aucun envoi de vos liens ailleurs.

---

- [Ce que c'est](#ce-que-cest)
- [Cadre légal](#cadre-légal)
- [Installation rapide](#installation-rapide)
- [Installation manuelle](#installation-manuelle)
- [Documentation](#documentation)

## Ce que c'est

- **Détection automatique** — l'extension combine l'extraction [yt-dlp](https://github.com/yt-dlp/yt-dlp)
  et le sniffing réseau en direct (`chrome.webRequest`) pour trouver les flux vidéo lisibles sur
  presque n'importe quelle page, pas seulement sur les sites explicitement listés par yt-dlp.
- **Choix de la qualité** — chaque format détecté est listé avec sa résolution, son codec et sa
  taille ; la meilleure qualité disponible est présélectionnée, mais vous pouvez toujours choisir
  autre chose.
- **Renommage à la volée** — le champ du nom de fichier est prérempli à partir du titre de la
  vidéo (à défaut, du titre de la page) et nettoyé automatiquement ; modifiable avant le départ du
  téléchargement.
- **Destinations favorites** — enregistrez vos dossiers habituels pour y aller directement, ou
  parcourez les racines autorisées du serveur depuis la popup.
- **Conversion optionnelle** — remux en `copy` (sans réencodage) par défaut, ou transcodage avec
  accélération matérielle (NVIDIA NVENC, Intel QuickSync, VAAPI) ou encodeurs CPU (x264/x265)
  quand le serveur les détecte.
- **Mode apprentissage** — quand rien n'est détecté automatiquement, un picker vous laisse cliquer
  la vidéo dans la page ; ez-dl corrèle ce clic avec le trafic réseau récent et peut mémoriser le
  motif pour ce site.

Le serveur est une application FastAPI qui pilote `yt-dlp` et `ffmpeg` via une file de jobs, et
n'écrit que dans les dossiers que vous l'autorisez à écrire. Vue complète :
[`docs/fr/architecture.md`](docs/fr/architecture.md).

## Cadre légal

ez-dl est un outil pour télécharger du contenu vidéo **que vous avez déjà le droit de
télécharger** — vos propres publications, du contenu sous licence permissive, du matériel dont les
conditions d'utilisation du site autorisent la sauvegarde, etc.

- **Aucun contournement de DRM.** ez-dl n'implémente pas, n'embarque pas et n'accepte pas de
  contributions qui contournent Widevine, PlayReady, FairPlay ou tout autre système de protection
  de contenu. Les flux protégés par DRM sont explicitement hors périmètre.
- **Votre responsabilité.** Il vous revient de respecter les conditions d'utilisation des sites
  sur lesquels vous utilisez ez-dl, ainsi que le droit d'auteur qui vous est applicable. Ce projet
  ne vous accorde aucun droit sur des contenus que vous n'avez pas déjà.
- ez-dl est une infrastructure de téléchargement et de rangement de fichiers — il n'a pas d'avis
  sur ce que vous téléchargez, mais il ne vous aidera pas à casser une mesure de protection pour
  l'obtenir.

## Installation rapide

Il faut Docker avec le plugin Compose, et Chrome (ou Chromium). Rien d'autre — pas de clone, pas
de Python, pas de Node.js.

### 1. Serveur — une commande

```bash
curl -fsSL https://github.com/CorentinGC/ez-dl/releases/latest/download/install.sh | sh
```

Le script télécharge le compose autonome de la dernière release, **vérifie sa somme SHA-256**,
génère un mot de passe fort dans un `.env` en `0600`, démarre le stack et attend que `/api/health`
réponde. Il ne pose aucune question et n'utilise jamais `sudo`. Il affiche l'URL et le mot de passe
une fois à la fin — à conserver.

Valeurs par défaut : `~/ez-dl` comme dossier d'installation, port `8000`, téléchargements dans
`~/ez-dl/downloads`, mise à jour automatique activée. Tout est surchargeable par variables
d'environnement, et `--dry-run` montre ce qui serait fait sans rien écrire :

```bash
curl -fsSL https://github.com/CorentinGC/ez-dl/releases/latest/download/install.sh \
  | EZDL_PORT=9000 EZDL_DOWNLOADS_DIR=/mnt/media/downloads sh
```

Les variables se placent **après** le pipe : devant `curl`, elles configureraient `curl` et non le
script.

Un script tiré du réseau et exécuté mérite d'être lu avant : `curl -fsSL <url> | less`. C'est un
asset de release figé, pas un fichier de la branche `main`. Variables, mode mise à jour et
équivalent manuel :
[`docs/fr/setup.md`](docs/fr/setup.md#installation-en-une-commande-voie-facile).

### 2. Extension dans Chrome

Le serveur publie lui-même l'extension empaquetée.

1. Ouvrir `http://<serveur>:8000/extension` (ex. `http://nas.local:8000/extension`) — cette page
   est publique — et télécharger le `.zip`.
2. Le décompresser dans un dossier **qui restera en place** : Chrome le relit à chaque démarrage.
3. Ouvrir `chrome://extensions`, activer le **Mode développeur**, cliquer sur **Charger
   l'extension non empaquetée** et choisir ce dossier.

Chrome n'autorise aucune installation en un clic hors Chrome Web Store (la publication est dans la
[feuille de route](ROADMAP.fr.md)). Pour éviter le Mode développeur et avoir les mises à jour
automatiques, le serveur publie aussi un `.crx` signé et son manifeste de mise à jour pour une
installation par **politique système** — instructions par OS dans
[`docs/fr/setup.md`](docs/fr/setup.md#voie-sans-mode-développeur--installation-par-politique-système).

### 3. Relier les deux

Ouvrir la page **Options** de l'extension, renseigner l'**URL du serveur** (par défaut
`http://localhost:8000`) et le **mot de passe** affiché par l'installeur, puis cliquer sur **Tester
la connexion**. Ouvrir n'importe quelle page avec une vidéo et cliquer sur l'icône ez-dl.

## Installation manuelle

Même résultat que la commande unique, étape par étape — pour qui préfère ne pas passer un script
dans un shell.

```bash
mkdir -p ~/ez-dl && cd ~/ez-dl
curl -fsSLO https://github.com/CorentinGC/ez-dl/releases/latest/download/docker-compose.yml
curl -fsSLO https://github.com/CorentinGC/ez-dl/releases/latest/download/docker-compose.yml.sha256
sha256sum -c docker-compose.yml.sha256      # macOS : shasum -a 256 -c

mkdir -p downloads
umask 077 && cat > .env <<EOF
EZDL_PASSWORD=$(openssl rand -base64 24)
EZDL_PORT=8000
EZDL_DOWNLOADS_DIR=$PWD/downloads
PUID=$(id -u)
PGID=$(id -g)
COMPOSE_PROFILES=autoupdate
EOF

docker compose up -d
```

`PUID`/`PGID` sont l'identité sous laquelle tourne le serveur : les mettre sur le propriétaire de
vos dossiers média fait atterrir les fichiers téléchargés avec le bon propriétaire, sans aucun
rebuild.

Pour ajouter des destinations, les monter et les déclarer dans `EZDL_DOWNLOAD_ROOTS` — seules ces
racines (et leurs sous-dossiers) sont accessibles en écriture par le serveur :

```yaml
    environment:
      EZDL_DOWNLOAD_ROOTS: "Films=/data/movies,Downloads=/data/downloads"
    volumes:
      - /mnt/media/movies:/data/movies
      - /mnt/media/downloads:/data/downloads
```

Puis installer l'extension comme à l'[étape 2 ci-dessus](#2-extension-dans-chrome).

**Build depuis le dépôt** — pour le développement, ou pour la variante d'image NVENC (le
passthrough GPU ne suffit pas : le ffmpeg de Debian est livré sans NVENC) :

```bash
git clone https://github.com/CorentinGC/ez-dl.git && cd ez-dl
cp .env.example .env      # renseigner EZDL_PASSWORD
docker compose up -d --build
```

## Documentation

| | |
|---|---|
| [Setup](docs/fr/setup.md) | Installation, variables d'environnement, `PUID`/`PGID`, reverse proxy, mises à jour automatiques |
| [FAQ](docs/fr/faq.md) | Site non détecté, mauvais propriétaire de fichier, `latest` vs `edge`, NVENC |
| [Architecture](docs/fr/architecture.md) | Composants, contrat d'API, modèle de données, cycle de vie d'un job |
| [Modules](docs/fr/modules/) | Détection, conversion, apprentissage, marque |
| [Décisions (ADR)](docs/fr/decisions/) | Pourquoi cette stack, cette licence, cette auth, ces canaux de publication |
| [Feuille de route](ROADMAP.fr.md) · [Changelog](CHANGELOG.fr.md) | Ce qui est prévu · ce qui est livré |
| [Contribuer](CONTRIBUTING.fr.md) · [Sécurité](SECURITY.md) · [Code de conduite](CODE_OF_CONDUCT.md) | Comment aider, comment signaler une faille |

`docs/fr/` est la version canonique ; `docs/en/` en est le miroir.

## Licence

[PolyForm Noncommercial License 1.0.0](LICENSE). L'usage non commercial est libre. **Tout usage
commercial requiert une licence commerciale payante distincte** — ouvrir une issue GitHub ou
contacter le mainteneur à `<contact@example.com>`.

PolyForm Noncommercial est une licence source-available, pas une licence open source approuvée par
l'OSI : vous pouvez lire, utiliser à des fins non commerciales, modifier et redistribuer le code,
mais l'usage commercial est restreint sauf licence séparée.
