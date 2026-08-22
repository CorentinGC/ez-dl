# Setup

## Prérequis

| Outil | Version | Rôle |
|---|---|---|
| Python | ≥ 3.13 | Serveur |
| [uv](https://docs.astral.sh/uv/) | dernière stable | Gestionnaire de paquets/venv Python |
| Node.js | ≥ 20 (LTS) | Build de l'extension (voie développeur uniquement) |
| npm | livré avec Node.js | Gestionnaire de paquets extension (voie développeur uniquement) |
| Docker + Docker Compose | dernière stable | Déploiement du serveur |
| `yt-dlp` | binaire **standalone** (pas la version pip) | Téléchargement vidéo — voir [MEMORY.md](../../MEMORY.md) pour la raison |
| `ffmpeg` / `ffprobe` | dernière stable | Conversion et probe des flux |
| `deno` | dernière stable | Runtime JS requis par yt-dlp pour YouTube (fourni par l'image Docker) |
| Google Chrome ou Chromium | dernière stable | Chargement de l'extension MV3 |

## Installation dev locale

### Serveur

```bash
cd server
uv sync                 # installe les dépendances (dont le groupe dev : pytest, ruff, httpx)
cp ../.env.example .env # (optionnel) renseigner EZDL_PASSWORD pour un mot de passe stable
uv run uvicorn app.main:app --reload --port 8000
```

### Extension

```bash
cd extension
npm install
npm run dev              # ouvre Chrome avec l'extension chargée en mode watch (WXT)
```

## Variables d'environnement

Toutes préfixées `EZDL_`. À définir dans `server/.env` (jamais commité — voir `.env.example` à la
racine pour le gabarit avec valeurs génériques).

| Variable | Défaut | Rôle |
|---|---|---|
| `EZDL_PASSWORD` | *(recommandé)* | Mot de passe d'accès à l'API. Si absent ou vide, le serveur génère un mot de passe fort (32 caractères URL-safe) à chaque démarrage, l'affiche dans la console avec une pause de 5 secondes, puis démarre. Définiez-le dans `.env` pour un mot de passe stable. |
| `EZDL_HOST` | `0.0.0.0` | Bind uvicorn |
| `EZDL_PORT` | `8000` | Port HTTP |
| `EZDL_DOWNLOAD_ROOTS` | `Downloads=/data/downloads` | Racines autorisées, format `Label=/chemin` séparées par `,`. Seuls ces chemins (et leurs sous-dossiers) sont accessibles en écriture. **Important** : aucune racine ne doit contenir (ou être contenue dans) `EZDL_DATA_DIR` ou `EZDL_EXTENSION_DIST_DIR`. Le serveur refuse de démarrer en cas de violation. |
| `EZDL_DATA_DIR` | `/config` | SQLite + état persistant (dont la clé de signature du `.crx` — voir [Republier l'extension](#republier-lextension)) |
| `EZDL_EXTENSION_DIST_DIR` | `/app/extension-dist` | Dossier contenant l'extension empaquetée publiée par le serveur (zip + `extension-version.txt`, dont le contenu doit être une version strictement numérique — `1`, `1.2`, `1.2.3` ou `1.2.3.4` —, toute autre valeur étant ignorée), produit lors du build de l'image Docker. Si le dossier est vide, les routes `/extension/*` restent joignables mais aucun téléchargement n'est disponible. Le dossier appartient à `root` dans l'image : le serveur, non-root, ne fait que le lire. |
| `EZDL_PUBLIC_URL` | *(vide)* | URL publique du serveur telle qu'un navigateur la voit (`https://ez-dl.example.com`). Nécessaire **uniquement derrière un reverse proxy** : `/extension/update.xml` doit y publier une URL absolue de téléchargement du `.crx`, et l'adresse vue par uvicorn n'est pas celle du client. Vide = déduite de la requête. Doit commencer par `http://` ou `https://`, sinon le serveur refuse de démarrer |
| `EZDL_TEMP_DIR` | `/tmp/ez-dl` | Fichiers partiels avant déplacement final. Doit **persister** pour que la reprise d'un téléchargement interrompu serve à quelque chose (voir ci-dessous) |
| `EZDL_MAX_CONCURRENT_JOBS` | `2` | Nombre de workers de la queue |
| `EZDL_YTDLP_UPDATE_INTERVAL_HOURS` | `24` | Période de l'auto-update yt-dlp (`0` = désactivé) |
| `EZDL_YTDLP_BINARY` | `yt-dlp` | Chemin du binaire yt-dlp |
| `EZDL_FFMPEG_BINARY` | `ffmpeg` | Chemin du binaire ffmpeg |
| `EZDL_CORS_ORIGINS` | `chrome-extension://*` | Origines autorisées |
| `EZDL_LOG_LEVEL` | `info` | Niveau de log |
| `EZDL_AUTO_UPDATE` | `false` | Lue par `deploy/auto-update.sh` **côté hôte** (voie build local) — voir [Mise à jour automatique du serveur](#mise-à-jour-automatique-du-serveur) |
| `EZDL_AUTO_UPDATE_INTERVAL_SECONDS` | `300` | Période de vérification du registre par le service `watchtower` (profil `autoupdate`) |
| `EZDL_IMAGE` | `ghcr.io/corentingc/ez-dl:latest` | Image exécutée par le compose — à surcharger pour épingler un sha ou utiliser un fork |

Exemple générique de `EZDL_DOWNLOAD_ROOTS` pour un NAS : `Films=/mnt/media/movies,Séries=/mnt/media/tv`.

### Identité d'exécution : `PUID` / `PGID`

Ces deux variables ne portent pas le préfixe `EZDL_` : elles sont lues par l'entrypoint du
conteneur, pas par l'application.

| Variable | Défaut | Rôle |
|---|---|---|
| `PUID` | `1000` | uid sous lequel le serveur s'exécute dans le conteneur |
| `PGID` | `1000` | gid correspondant |

Renseignez-les avec l'uid/gid **propriétaire de vos volumes** (`id -u` et `id -g` sur l'hôte, ou le
propriétaire du partage sur un NAS). Elles sont appliquées **au démarrage du conteneur** : l'image
publiée fonctionne telle quelle sur un hôte dont l'utilisateur n'est pas `1000`, sans avoir à la
reconstruire.

L'entrypoint démarre `root` le temps de rendre `EZDL_DATA_DIR`, `EZDL_TEMP_DIR` et les racines de
`EZDL_DOWNLOAD_ROOTS` inscriptibles par ce couple, puis passe à l'utilisateur applicatif via `gosu`.
Aucun code applicatif ne s'exécute en `root` — vérifiable avec
`docker exec ez-dl grep Uid /proc/1/status`. `PUID=0` est refusé.

Une racine de téléchargement **déjà inscriptible** n'est jamais touchée, et seul son premier niveau
est ajusté le cas échéant : une bibliothèque média partagée avec d'autres applications n'est pas
réécrite. Pour un conteneur non-root de bout en bout, fixez `user:` dans le compose — l'entrypoint
détecte alors qu'il n'est pas `root`, ne tente aucun changement de propriétaire et exécute
directement la commande ; c'est à vous de fournir des volumes déjà inscriptibles.

## Installation en une commande (voie facile)

Pour un serveur qui ne sert qu'à faire tourner ez-dl, sans cloner le dépôt :

```bash
curl -fsSL https://github.com/CorentinGC/ez-dl/releases/latest/download/install.sh | sh
```

Le script télécharge le compose autonome de la dernière release, **vérifie sa somme SHA-256**,
génère un mot de passe fort dans un `.env` en `0600`, crée le dossier de téléchargements, démarre
le stack et attend que `/api/health` réponde. Il ne pose aucune question et n'utilise jamais
`sudo` ; tout se règle par variables d'environnement :

| Variable | Défaut | Rôle |
|---|---|---|
| `EZDL_DIR` | `~/ez-dl` | Dossier d'installation |
| `EZDL_PORT` | `8000` | Port publié sur l'hôte |
| `EZDL_DOWNLOADS_DIR` | `$EZDL_DIR/downloads` | Destination des téléchargements |
| `EZDL_PASSWORD` | généré | Mot de passe imposé plutôt que généré |
| `EZDL_TAG` | `latest` | Tag d'image (`0.1.0`, `edge`…) |
| `EZDL_AUTOUPDATE` | `true` | Service watchtower de mise à jour automatique |

`sh install.sh --dry-run` montre ce qui serait fait sans rien écrire. Relancé sur une
installation existante, le script passe en **mode mise à jour** : il ne touche pas au `.env`,
donc pas au mot de passe.

Un script tiré du réseau et exécuté mérite d'être lu avant : `curl -fsSL <url> | less`. C'est un
asset de release figé, pas un fichier de la branche `main`.

### Équivalent manuel

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

Cette voie n'a **pas** de section `build:` : elle tire l'image publiée. Pour builder localement
(développement, variante GPU), utiliser le dépôt cloné et son `docker-compose.yml` racine —
c'est la section suivante.

## Docker Compose

```bash
docker compose up -d --build
```

Points d'attention dans `docker-compose.yml` (voir [modules GPU](decisions/0001-stack-fastapi-wxt.md)
pour le contexte) :

- Monter les racines de `EZDL_DOWNLOAD_ROOTS` en volumes, avec les **mêmes chemins côté conteneur
  que dans la variable d'environnement**. Une racine déclarée mais non montée (ou non inscriptible
  par l'utilisateur du conteneur) déclenche un `WARNING` au démarrage, et tout job la visant est
  refusé en `400` avant le téléchargement.
- Monter un volume persistant sur `EZDL_DATA_DIR` (SQLite + état).
- `EZDL_TEMP_DIR` est monté sur le **volume nommé `ezdl-temp`**, et non en tmpfs : un
  téléchargement coupé par un redémarrage repart alors de son fichier partiel au lieu d'être
  refait en entier. Le serveur purge à chaque démarrage les dossiers de travail des jobs qui ne
  sont plus reprenables. Pour repasser en RAM (aucune écriture disque, mais aucune reprise
  possible et taille limitée par la RAM), remplacer la ligne `- ezdl-temp:/tmp/ez-dl` par une
  section `tmpfs: [ "/tmp/ez-dl" ]`.
- Le sous-dossier `/tmp/ez-dl/cookies` reste monté en **tmpfs par-dessus** ce volume : les
  cookies transmis par l'extension ne touchent jamais le disque, contrairement aux fichiers
  partiels. Ne pas retirer ce montage.
- Bloc GPU optionnel (NVIDIA/QuickSync/VAAPI) uniquement si des presets matériels sont utilisés —
  voir [modules/conversion.md](modules/conversion.md).
- Charger `EZDL_PASSWORD` et les autres variables via un fichier `.env` (jamais commité) ou les
  secrets Docker, jamais en dur dans `docker-compose.yml`.

## Chargement de l'extension dans Chrome

Le serveur publie lui-même l'extension empaquetée : installer ez-dl sur une nouvelle machine ne
demande ni de cloner le dépôt, ni d'installer Node.

### Voie recommandée — archive publiée par le serveur

1. Ouvrir `http://<serveur>:8000/extension` (ex. `http://nas.local:8000/extension`). La page est
   **publique** (aucun mot de passe requis, contrairement au reste de l'API) et affiche la version
   de l'extension, celle du serveur, et l'**empreinte SHA-256** de l'archive.
2. Télécharger le zip via le bouton de téléchargement.
3. Décompresser l'archive dans un dossier **qui restera en place** : Chrome le relit à chaque
   démarrage, un dossier supprimé désactive l'extension.
4. Ouvrir `chrome://extensions` et activer le **Mode développeur** (coin supérieur droit).
5. **Charger l'extension non empaquetée** → sélectionner le dossier décompressé.
6. Ouvrir la page d'options de l'extension pour configurer l'URL du serveur et le mot de passe
   (étape suivante).

Pour mettre à jour ensuite : remplacer le contenu du dossier par celui de la nouvelle archive,
puis recharger l'extension depuis `chrome://extensions`.

> **Le glisser-déposer du `.crx` ne fonctionne pas.** Chrome rejette tout `.crx` déposé sur
> `chrome://extensions` qui n'est pas signé par le Chrome Web Store, avec « Package incorrect
> CRX_REQUIRED_PROOF_MISSING » — le Mode développeur n'y change rien. Aucun serveur auto-hébergé
> ne peut produire cette signature. Le `.crx` servi par `/extension/download` reste utile pour
> une seule chose : l'installation pilotée par **politique système**, seul chemin où Chrome
> vérifie une extension hors Web Store sans exiger de preuve d'éditeur — voir
> [Voie sans Mode développeur](#voie-sans-mode-développeur--installation-par-politique-système).

> **Recommandation de sécurité.** Sur un réseau non maîtrisé (Internet, WiFi public), préférer
> accéder au serveur via **HTTPS** (reverse proxy devant le serveur, tunnel cloudflared, etc.)
> plutôt que HTTP. Un attaquant en position d'intercepteur peut substituer l'archive et faire
> installer une extension disposant de permissions étendues (`<all_urls>`, `cookies`,
> `webRequest`). Comparer le SHA-256 du fichier téléchargé à celui affiché par la page permet
> de détecter cette substitution — à condition que la page elle-même soit servie en HTTPS.

Routes publiques exposées par le serveur :

| Route | Contenu |
|---|---|
| `GET /extension` | Page HTML d'installation (versions, bouton de téléchargement du zip, étapes, empreinte SHA-256, bloc secondaire sur le paquet signé) |
| `GET /extension/zip` | Zip de l'extension, artefact de la voie recommandée (« Charger l'extension non empaquetée ») |
| `GET /extension/download` | Archive `.crx` signée (`ez-dl-extension-<version>.crx`, media type `application/x-chrome-extension`), destinée à l'installation par politique système — **non installable par glisser-déposer** |
| `GET /extension/update.xml` | Manifeste de mise à jour Chrome (protocole Omaha) : identifiant du paquet signé, version publiée, URL absolue du `.crx`. Cible de la politique système. `503` si la version publiée est inconnue |
| `GET /extension/version` | JSON `{available, version, filename, size, extension_id, sha256}`, consommé par l'extension pour signaler qu'une nouvelle version est disponible. `extension_id` et `sha256` valent `null` si la signature a échoué |

> **Limite connue.** Hors Chrome Web Store, Chrome n'offre aucune installation « en un clic »
> depuis une page web. La voie ci-dessus impose donc le Mode développeur et le chargement non
> empaqueté ; la seule autre option est la politique système, décrite juste en dessous.

Si l'image serveur a été construite **sans** le contexte `extension` (par exemple un `docker build`
lancé à la main dans `server/`), le build réussit quand même mais la distribution est indisponible :
la page l'explique, les deux routes de téléchargement renvoient `404`, et `GET /extension/version`
renvoie `200` avec `{"available": false, "version": null, ...}` (jamais `404`).

### Voie sans Mode développeur — installation par politique système

C'est le **seul** moyen d'installer l'extension sans Mode développeur, et le seul qui apporte la
mise à jour automatique. Une extension déployée par politique est vérifiée par Chrome en
`VerifierFormat::CRX3`, sans preuve d'éditeur : le `.crx` signé par le serveur est accepté. En
contrepartie, il faut des droits d'administration sur chaque poste, et la politique doit être de
niveau **mandatory** — une politique « recommandée » ou posée dans le domaine utilisateur ramène
l'erreur `CRX_REQUIRED_PROOF_MISSING`.

Deux valeurs à récupérer d'abord, sur `http://<serveur>:8000/extension` ou via
`GET /extension/version` :

- l'**identifiant** du paquet signé (32 caractères `a`-`p`, dérivé de la clé du serveur) ;
- l'URL du **manifeste de mise à jour** : `https://<serveur>/extension/update.xml`.

La page d'installation affiche directement la valeur concaténée à coller dans la politique, sous
la forme `<identifiant>;<url du manifeste>`. La politique pointe le **manifeste**, jamais le `.crx`.

> **HTTPS obligatoire.** Chrome exige une URL `https` pour le téléchargement du `.crx` sur ce
> chemin. Derrière un reverse proxy, renseigner `EZDL_PUBLIC_URL` (voir le tableau des variables) :
> sans elle, le serveur déduit l'URL de la requête et publie l'adresse interne, que le poste
> client ne sait pas joindre.

**Windows** — registre, ruche `HKEY_LOCAL_MACHINE` (une GPO produit la même chose) :

```
HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist
  "1" = "<identifiant>;https://ez-dl.example.com/extension/update.xml"
```

**Linux** — fichier JSON dans `/etc/opt/chrome/policies/managed/` (`/etc/chromium/policies/managed/`
pour Chromium), appartenant à `root` et non inscriptible par les autres :

```json
{
  "ExtensionInstallForcelist": [
    "<identifiant>;https://ez-dl.example.com/extension/update.xml"
  ]
}
```

**macOS** — profil de configuration déployé par MDM, écrivant dans
`/Library/Managed Preferences/com.google.Chrome.plist` :

```xml
<key>ExtensionInstallForcelist</key>
<array>
  <string>&lt;identifiant&gt;;https://ez-dl.example.com/extension/update.xml</string>
</array>
```

> Un `defaults write com.google.Chrome …` lancé depuis le compte utilisateur **ne suffit pas** :
> il écrit une préférence de domaine utilisateur, que Chrome traite comme « recommandée ». Seul
> un profil managé (MDM) produit une politique *mandatory*.

Vérifier ensuite dans `chrome://policy` que la politique est chargée et à l'état **OK**, puis
forcer un contrôle depuis `chrome://extensions`. Chrome relit le manifeste périodiquement (quelques
heures) : après un `docker compose up -d --build` avec une version bumpée, la mise à jour arrive
seule.

### Voie développeur — extension non empaquetée

Pour travailler sur l'extension elle-même :

1. `cd extension && npm run build` (ou laisser `npm run dev` actif).
2. Ouvrir `chrome://extensions`.
3. Activer le **Mode développeur** (coin supérieur droit).
4. **Charger l'extension non empaquetée** → sélectionner `extension/.output/chrome-mv3` (build) ou
   le dossier généré par `npm run dev`.
5. Ouvrir la page d'options de l'extension pour configurer l'URL du serveur et le mot de passe
   (étape suivante).

Le zip publié par le serveur (`GET /extension/zip`) sert la même voie : le décompresser puis charger
le dossier obtenu de la même façon.

## Republier l'extension

Après une modification du client :

1. Bumper le champ `version` dans `extension/package.json`.
2. Reconstruire et redémarrer :

```bash
docker compose up -d --build   # ou : make publish-extension
```

L'image serveur reçoit l'extension via le **contexte nommé BuildKit `extension`**, déclaré dans
`docker-compose.yml` (`build.additional_contexts: { extension: ./extension }`) : un stage
`node:22-slim` exécute `npm ci` puis `npm run zip`, et le zip obtenu est copié dans
`EZDL_EXTENSION_DIST_DIR` de l'image finale. Aucun Node ne subsiste dans l'image finale.

Deux cibles Makefile encadrent l'opération : `make zip-extension` (produire le zip seul) et
`make publish-extension` (rebuild + redémarrage du serveur).

> **`./data` doit être persistant.** Le `.crx` est signé à l'exécution par le serveur avec une clé
> RSA 2048 générée au premier besoin dans `EZDL_DATA_DIR/extension-signing-key.pem` (permissions
> `0600`), le résultat étant mis en cache dans `EZDL_DATA_DIR/extension-cache/`. L'identifiant Chrome
> du **paquet signé** dérive de cette clé : la perdre change l'identifiant, et une installation par
> politique système verrait alors une extension différente au lieu d'une mise à jour. (Une extension
> chargée non empaquetée reçoit, elle, un identifiant dérivé du chemin de son dossier.) Garder le
> volume `./data:/config` persistant et le
> sauvegarder.

## Configuration serveur + mot de passe

1. (Optionnel) Définir `EZDL_PASSWORD` côté serveur (fichier `.env` ou variable d'environnement du conteneur) pour un mot de passe stable. Si vous ne le définissez pas, le serveur générera un mot de passe à chaque démarrage — voir [ADR 0003](decisions/0003-auth-mot-de-passe.md).
2. Démarrer le serveur. S'il n'y a pas de mot de passe défini, il affiche un bandeau isolé dans la console avec un mot de passe généré (32 caractères URL-safe) et pause 5 secondes pour permettre de le copier. Vous pouvez récupérer ce mot de passe dans les logs de démarrage.
3. Dans la page d'options de l'extension : l'URL du serveur vaut `http://localhost:8000` par
   défaut — rien à saisir si le serveur tourne sur la même machine, sinon la remplacer (ex.
   `http://nas.local:8000`). Renseigner le mot de passe (celui défini dans `.env` ou celui
   généré et affiché au démarrage), puis utiliser le bouton **Tester la connexion**.
4. Le mot de passe est stocké côté extension dans `chrome.storage.local` et envoyé en
   `Authorization: Bearer <mot de passe>` à chaque requête.

## Mise à jour automatique du serveur

Deux voies, exclusives l'une de l'autre
(voir [ADR 0005](decisions/0005-auto-update-image-ghcr-watchtower.md), amendée par
[ADR 0006](decisions/0006-versionnement-et-canaux-de-publication.md)).

Ce que vous suivez dépend du tag choisi :

| Tag | Contenu | Pour qui |
|---|---|---|
| `latest` (défaut), `X.Y.Z`, `X.Y` | versions taguées uniquement | déploiements — recommandé |
| `edge`, `main-<sha>` | chaque commit vert sur `main` | qui suit le dépôt de près |

`latest` ne suit donc **pas** `main` : un déploiement ne bouge qu'aux versions publiées. Pour
retrouver le suivi continu, fixer `EZDL_IMAGE=ghcr.io/corentingc/ez-dl:edge` dans le `.env`.

### Voie recommandée — intégrée au stack Docker (image GHCR + watchtower)

La CI publie l'image de production sur GHCR en **amd64 et arm64** (`latest` sur les tags semver,
`edge` sur `main`). Le compose embarque un service **watchtower** (profil `autoupdate`) qui
vérifie le
registre (défaut : toutes les 5 min, `EZDL_AUTO_UPDATE_INTERVAL_SECONDS`) et recrée le conteneur
`server` à l'identique quand une nouvelle image existe. Rien à installer sur l'hôte :

```bash
# Dans le .env à côté du docker-compose.yml :
echo 'COMPOSE_PROFILES=autoupdate' >> .env      # ajouter aux profils déjà actifs le cas échéant
docker compose up -d
```

Watchtower est confiné au stack (`WATCHTOWER_LABEL_ENABLE` + scope `ez-dl`) : les autres
conteneurs de l'hôte ne sont jamais touchés. Réservé aux déploiements qui utilisent l'**image
publiée** (`docker compose up -d`, sans `--build`). Un UID hôte différent de 1000 ne demande
plus de build local — il suffit de renseigner `PUID`/`PGID` ; seule la variante GPU reste sur la
voie ci-dessous.

### Voie alternative — build local + cron hôte

Pour les hôtes qui construisent l'image localement, `deploy/auto-update.sh` (lancé par cron ou
timer systemd) fetch la branche suivie et, si l'origin a avancé, fait `git pull --ff-only` puis
rebuild **du seul service `server`**, avant de vérifier `/api/health`. Garde-fous : inactif sans
`EZDL_AUTO_UPDATE=true` dans le `.env` du clone, refuse un clone avec des modifications locales,
jamais de merge ni de reset, verrou anti-chevauchement.

```bash
# 1. Activer le flag dans le .env du clone déployé
echo 'EZDL_AUTO_UPDATE=true' >> .env

# 2. Programmer le check (ici toutes les 15 minutes)
crontab -e
# */15 * * * * /chemin/du/clone/deploy/auto-update.sh >> ~/.local/state/ez-dl-update.log 2>&1
```

Le script est silencieux quand il n'y a rien à faire : le log ne contient que les mises à jour et
les erreurs.

## Vérification

```bash
curl http://localhost:8000/api/health
# {"status":"ok","version":"0.1.0","ytdlp_version":"2026.xx.xx","ffmpeg_available":true}
```

Un `status: "ok"` avec `ffmpeg_available: true` confirme que le serveur, yt-dlp et ffmpeg sont
correctement installés et accessibles. Cette route est publique (pas d'en-tête `Authorization`
requis), pratique pour un healthcheck Docker.
