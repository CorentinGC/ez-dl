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
| `EZDL_TEMP_DIR` | `/tmp/ez-dl` | Fichiers partiels avant déplacement final. Doit **persister** pour que la reprise d'un téléchargement interrompu serve à quelque chose (voir ci-dessous) |
| `EZDL_MAX_CONCURRENT_JOBS` | `2` | Nombre de workers de la queue |
| `EZDL_YTDLP_UPDATE_INTERVAL_HOURS` | `24` | Période de l'auto-update yt-dlp (`0` = désactivé) |
| `EZDL_YTDLP_BINARY` | `yt-dlp` | Chemin du binaire yt-dlp |
| `EZDL_FFMPEG_BINARY` | `ffmpeg` | Chemin du binaire ffmpeg |
| `EZDL_CORS_ORIGINS` | `chrome-extension://*` | Origines autorisées |
| `EZDL_LOG_LEVEL` | `info` | Niveau de log |

Exemple générique de `EZDL_DOWNLOAD_ROOTS` pour un NAS : `Films=/mnt/media/movies,Séries=/mnt/media/tv`.

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

### Voie recommandée — `.crx` publié par le serveur

1. Ouvrir `http://<serveur>:8000/extension` (ex. `http://nas.local:8000/extension`). La page est
   **publique** (aucun mot de passe requis, contrairement au reste de l'API) et affiche la version
   de l'extension et celle du serveur. Elle affiche aussi l'**identifiant Chrome attendu** et
   l'**empreinte SHA-256** du fichier.
2. Télécharger le fichier `.crx` via le bouton de téléchargement.
3. Ouvrir `chrome://extensions` et activer le **Mode développeur** (coin supérieur droit).
4. **Glisser-déposer** le `.crx` téléchargé sur la page `chrome://extensions`.
5. Vérifier que l'**identifiant affiché** sous le nom de l'extension correspond à celui annoncé
   par la page à l'étape 1. Chrome ne valide un `.crx` glissé contre aucune racine de confiance :
   cette comparaison est le seul moyen de détecter un artefact substitué en chemin.
6. Ouvrir la page d'options de l'extension pour configurer l'URL du serveur et le mot de passe
   (étape suivante).

> **Recommandation de sécurité.** Sur un réseau non maîtrisé (Internet, WiFi public), préférer
> accéder au serveur via **HTTPS** (reverse proxy devant le serveur, tunnel cloudflared, etc.)
> plutôt que HTTP. Un attaquant en position d'intercepteur peut substituer l'archive `.crx` et
> faire installer une extension disposant de permissions étendues (`<all_urls>`, `cookies`,
> `webRequest`). Vérifier l'identifiant affiché dans `chrome://extensions` permet de détecter
> cette substitution.

Routes publiques exposées par le serveur :

| Route | Contenu |
|---|---|
| `GET /extension` | Page HTML d'installation (versions, bouton de téléchargement, étapes d'installation, identifiant attendu et empreinte SHA-256, lien secondaire vers le zip) |
| `GET /extension/download` | Archive `.crx` signée (`ez-dl-extension-<version>.crx`, media type `application/x-chrome-extension`) |
| `GET /extension/zip` | Zip brut, pour la voie « Charger l'extension non empaquetée » |
| `GET /extension/version` | JSON `{available, version, filename, size, extension_id, sha256}`, consommé par l'extension pour signaler qu'une nouvelle version est disponible. `extension_id` et `sha256` valent `null` si la signature a échoué |

> **Limite connue.** Chrome n'autorise aucune installation « en un clic » depuis une page web en
> dehors du Chrome Web Store : le Mode développeur reste obligatoire. L'installation et la mise à
> jour silencieuses via politique système (`update.xml` + `ExtensionInstallSources` /
> `ExtensionInstallForcelist`) sont prévues plus tard (issue `ez-dl-upc`) et ne sont pas encore
> disponibles.

Si l'image serveur a été construite **sans** le contexte `extension` (par exemple un `docker build`
lancé à la main dans `server/`), le build réussit quand même mais la distribution est indisponible :
la page l'explique, les deux routes de téléchargement renvoient `404`, et `GET /extension/version`
renvoie `200` avec `{"available": false, "version": null, ...}` (jamais `404`).

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
> de l'extension **dérive de cette clé** : la perdre change l'identifiant, et Chrome voit alors une
> extension différente au lieu d'une mise à jour. Garder le volume `./data:/config` persistant et le
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

## Vérification

```bash
curl http://localhost:8000/api/health
# {"status":"ok","version":"0.1.0","ytdlp_version":"2026.xx.xx","ffmpeg_available":true}
```

Un `status: "ok"` avec `ffmpeg_available: true` confirme que le serveur, yt-dlp et ffmpeg sont
correctement installés et accessibles. Cette route est publique (pas d'en-tête `Authorization`
requis), pratique pour un healthcheck Docker.
