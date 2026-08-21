# Architecture

## Vue d'ensemble

ez-dl est composé de deux applications qui communiquent en HTTP/SSE sur le réseau local :

- **`extension/`** — extension Chrome MV3 (WXT + React + TypeScript). Détecte les vidéos présentes
  sur la page active, propose une interface de sélection (qualité, dossier, preset) et pilote le
  serveur via son API.
- **`server/`** — serveur FastAPI (Python 3.13, SQLModel/SQLite) packagé en Docker. Reçoit les
  demandes de téléchargement, orchestre `yt-dlp` et `ffmpeg`, gère une file d'attente de jobs et
  expose leur progression en temps réel via SSE.

Les deux composants sont indépendants : le serveur n'a aucune dépendance à Chrome, l'extension n'a
aucune dépendance à Docker. Un même serveur peut être partagé par plusieurs extensions/navigateurs
sur le réseau local.

## Schéma du flux

```
┌─────────────────────┐        HTTP (Bearer)        ┌──────────────────────────────────────┐
│   Extension (MV3)    │ ───────────────────────────▶ │              Serveur FastAPI          │
│                       │                              │                                        │
│ - background.ts       │  POST /api/jobs               │  ┌──────────┐   ┌────────────────┐   │
│   (sniffer réseau,     │◀────────────────────────────  │  │  Queue   │──▶│  Worker (yt-dlp) │   │
│    corrélation)        │  GET  /api/jobs/events (SSE)   │  │ (asyncio) │   │  télécharge      │   │
│ - popup (React)        │                              │  └──────────┘   └────────┬────────┘   │
│ - content.ts           │                              │                            │            │
│   (picker DOM)         │                              │                            ▼            │
└──────────┬─────────────┘                              │                   ┌────────────────┐   │
           │ sniffing chrome.webRequest                  │                   │ ffmpeg (preset) │   │
           ▼                                              │                   └────────┬────────┘   │
   pages web (vidéo)                                     │                            ▼            │
                                                            │                 déplacement final     │
                                                            │           (EZDL_DOWNLOAD_ROOTS, NAS…)  │
                                                            └──────────────────────────────────────┘
```

Flux détaillé pour un téléchargement :

1. L'utilisateur ouvre le popup ; l'extension appelle `GET/POST /api/probe` avec l'URL de l'onglet
   actif (et les cookies si l'option est activée) et fusionne le résultat avec les flux sniffés côté
   `background.ts`.
2. L'utilisateur choisit qualité, dossier de destination, preset de conversion, éventuellement un
   nom de fichier, puis valide → `POST /api/jobs`.
3. Le serveur crée un job en base (`status: queued`), le place dans la file d'attente asyncio.
4. Un worker de la queue le prend en charge dès qu'un slot est libre
   (`EZDL_MAX_CONCURRENT_JOBS`) : `status: probing` → `downloading` (yt-dlp, progression parsée et
   persistée) → `converting` (ffmpeg, si un preset autre que `copy` est choisi) → `moving`
   (déplacement du fichier temporaire vers le dossier final, vérifié contre
   `EZDL_DOWNLOAD_ROOTS`) → `done`.
5. À chaque changement d'état, le job mis à jour est publié sur `GET /api/jobs/events` (SSE,
   événement `job`) ; le popup ou une page d'options ouverte se met à jour en temps réel.
6. En cas d'erreur à n'importe quelle étape → `status: error`, message dans `error`. L'utilisateur
   peut annuler un job en cours (`DELETE /api/jobs/{id}` → `status: canceled`) ou le supprimer de
   l'historique une fois terminé.

## Structure des dossiers

### `server/`

```
server/
├── pyproject.toml         # dépendances (uv), Python >=3.13
├── app/
│   ├── main.py             # création de l'app FastAPI, montage des routers, lifespan (startup/shutdown)
│   ├── config.py           # Settings pydantic-settings, préfixe EZDL_
│   ├── auth.py              # dépendance FastAPI d'authentification (Bearer, constant-time)
│   ├── models.py            # modèles SQLModel : Job, SiteRule
│   ├── db.py                 # engine SQLite, session, init des tables
│   ├── routers/
│   │   ├── health.py         # GET /api/health
│   │   ├── capabilities.py   # GET /api/capabilities
│   │   ├── probe.py          # GET/POST /api/probe
│   │   ├── folders.py        # GET /api/folders (navigation sécurisée)
│   │   ├── jobs.py           # POST/GET/DELETE /api/jobs, GET /api/jobs/events (SSE)
│   │   └── rules.py          # GET/POST/DELETE /api/rules
│   ├── services/
│   │   ├── ytdlp.py           # wrapper subprocess yt-dlp (probe, download, progression)
│   │   ├── ffmpeg.py          # wrapper subprocess ffmpeg, détection des encodeurs, presets
│   │   ├── queue.py           # file d'attente asyncio, workers concurrents
│   │   ├── paths.py           # résolution/validation des chemins vs EZDL_DOWNLOAD_ROOTS
│   │   └── cookies.py         # écriture du fichier cookies temporaire (0600), nettoyage
│   └── events.py             # bus d'événements pour le SSE (pub/sub des jobs)
└── tests/
    ├── test_auth.py
    ├── test_probe.py
    ├── test_queue.py
    ├── test_paths.py
    └── test_capabilities.py
```

### `extension/`

```
extension/
├── wxt.config.ts            # config WXT, modules (@wxt-dev/module-react)
├── entrypoints/
│   ├── background.ts         # service worker MV3 : sniffer réseau, état par onglet (storage.session)
│   ├── content.ts             # content script : picker DOM pour le mode apprentissage
│   └── popup/
│       ├── App.tsx             # composant racine du popup
│       ├── main.tsx
│       └── components/         # liste vidéos, sélecteur qualité/dossier/preset, suivi jobs (SSE)
├── entrypoints/options/       # page d'options (URL serveur, mot de passe, dossiers favoris…)
├── lib/
│   ├── api.ts                  # client HTTP (fetch + Bearer), typé sur le contrat d'API
│   ├── storage.ts              # wrappers chrome.storage.local / chrome.storage.session
│   ├── sniffer.ts              # patterns de détection réseau (extensions, content-types)
│   └── correlation.ts          # corrélation picker DOM ↔ requêtes réseau (mode apprentissage)
└── tests/                     # Vitest : patterns de détection, corrélation
```

## Contrat d'API

Toutes les routes sont préfixées par `/api`. Authentification obligatoire (`Authorization: Bearer
<EZDL_PASSWORD>`) sur toutes les routes sauf `GET /api/health`. Voir
[conventions.md](conventions.md#sécurité) pour la comparaison constant-time et
[ADR 0003](decisions/0003-auth-mot-de-passe.md) pour le choix de ce schéma d'auth.

```
GET    /api/health          -> {status:"ok", version, ytdlp_version, ffmpeg_available}  [public]
GET    /api/capabilities    -> {encoders:[{id,name,hwaccel,codec}], presets:[{id,label,description,container,video_codec,args_preview}]}
GET    /api/probe?url=...   -> {url,title,uploader,duration,thumbnail,extractor,
                                formats:[{format_id,ext,height,width,fps,vcodec,acodec,filesize,tbr,label,has_audio,has_video}],
                                best_format_id, suggested_filename}
       (POST /api/probe accepte en plus {cookies, headers, referer} pour les pages authentifiées)
GET    /api/folders?path=   -> {roots:[{label,path}], current:{path,label}, entries:[{name,path,is_dir}], parent}
POST   /api/jobs            -> body {url, format_id?, folder, filename?, preset_id?, cookies?, headers?, referer?, title?}
                            -> {job_id, status}
GET    /api/jobs            -> [job]
GET    /api/jobs/{id}       -> job
DELETE /api/jobs/{id}       -> annule / supprime de l'historique
GET    /api/jobs/events     -> SSE, event `job` avec le job sérialisé à chaque update
GET    /api/rules           -> [site_rule]
POST   /api/rules           -> body {domain, url_pattern, label?, notes?, source:"manual"|"learned"} -> site_rule
DELETE /api/rules/{id}      -> supprime
```

## Modèle de données

### `Job`

| Champ | Type | Description |
|---|---|---|
| `id` | str (uuid) | Identifiant unique du job |
| `url` | str | URL source (page ou flux direct) |
| `title` | str? | Titre récupéré par probe ou fourni par l'utilisateur |
| `filename` | str | Nom de fichier final, sanitizé |
| `folder` | str | Chemin de destination, résolu sous une racine `EZDL_DOWNLOAD_ROOTS` |
| `status` | enum | Voir cycle de vie ci-dessous |
| `progress` | float | 0.0–100.0 |
| `speed` | str? | Vitesse de téléchargement courante (ex. `"3.2MiB/s"`) |
| `eta` | str? | Temps restant estimé |
| `size` | int? | Taille en octets, connue une fois le téléchargement démarré |
| `error` | str? | Message d'erreur si `status == error` |
| `preset_id` | str? | Preset de conversion ffmpeg choisi (`copy` par défaut) |
| `format_id` | str? | Format yt-dlp choisi |
| `created_at` / `updated_at` | datetime | Horodatage |

### `SiteRule`

| Champ | Type | Description |
|---|---|---|
| `id` | str (uuid) | Identifiant unique |
| `domain` | str | Domaine cible (ex. `example.com`) |
| `url_pattern` | str | Glob/regex simple appliqué aux URLs réseau sniffées |
| `label` | str? | Libellé lisible |
| `notes` | str? | Notes libres |
| `source` | enum | `manual` \| `learned` |
| `created_at` | datetime | Horodatage |

Les `SiteRule` permettent au sniffer de l'extension de reconnaître un flux vidéo sur un domaine où
la détection automatique échoue, sans redemander une session d'apprentissage à chaque visite (voir
[modules/apprentissage.md](modules/apprentissage.md)).

## Cycle de vie d'un job

```
queued ──▶ probing ──▶ downloading ──▶ converting ──▶ moving ──▶ done
   │           │             │              │            │
   └───────────┴─────────────┴──────────────┴────────────┴──▶ error
                                                          
   (queued | probing | downloading | converting | moving) ──▶ canceled
```

- **`queued`** : job créé, en attente d'un slot de worker libre.
- **`probing`** : yt-dlp interroge la source pour confirmer les formats disponibles.
- **`downloading`** : téléchargement en cours, `progress`/`speed`/`eta` mis à jour périodiquement.
- **`converting`** : ffmpeg réencode selon le `preset_id` choisi (étape sautée si `preset_id ==
  "copy"` ou absent).
- **`moving`** : déplacement atomique du fichier temporaire (`EZDL_TEMP_DIR`) vers `folder`, après
  revalidation du chemin.
- **`done`** : terminé avec succès.
- **`error`** : échec à n'importe quelle étape, `error` renseigné, ressources temporaires nettoyées.
- **`canceled`** : annulation demandée par l'utilisateur (`DELETE /api/jobs/{id}`) pendant que le job
  est encore actif.

Toute transition d'état déclenche une publication SSE sur `/api/jobs/events`.
