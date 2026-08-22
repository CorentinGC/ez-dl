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
7. Un téléchargement peut être suspendu (`POST /api/jobs/{id}/pause` → `status: paused`) puis repris
   (`POST /api/jobs/{id}/resume`) ; un arrêt du serveur suspend de la même façon les jobs en cours.
   La reprise repart du fichier partiel conservé dans `EZDL_TEMP_DIR/<job_id>` — voir
   [Reprise et retry](#reprise-et-retry).

## Structure des dossiers

### `server/`

```
server/
├── pyproject.toml         # dépendances (uv), Python >=3.13
├── app/
│   ├── main.py             # création de l'app FastAPI, montage des routers, lifespan (startup/shutdown)
│   ├── config.py           # Settings pydantic-settings, préfixe EZDL_
│   ├── security.py          # dépendance FastAPI d'authentification (Bearer, constant-time)
│   ├── models.py            # modèles SQLModel : Job, SiteRule
│   ├── schemas.py           # schémas pydantic d'entrée/sortie des routes
│   ├── db.py                 # engine SQLite, session, init des tables
│   ├── api/
│   │   ├── health.py         # GET /api/health
│   │   ├── capabilities.py   # GET /api/capabilities
│   │   ├── probe.py          # GET/POST /api/probe
│   │   ├── folders.py        # GET/POST /api/folders (navigation + création sécurisées)
│   │   ├── jobs.py           # CRUD /api/jobs, pause/resume, GET /api/jobs/events (SSE)
│   │   └── rules.py          # GET/POST/DELETE /api/rules
│   └── core/
│       ├── ytdlp.py           # wrapper subprocess yt-dlp (probe, download, progression)
│       ├── ffmpeg.py          # wrapper subprocess ffmpeg, détection des encodeurs, presets
│       ├── queue.py           # file d'attente asyncio, workers, pipeline, pub/sub SSE
│       ├── workdir.py         # dossier de travail d'un job : fichier produit, nom libre, move
│       ├── paths.py           # résolution/validation des chemins vs EZDL_DOWNLOAD_ROOTS
│       └── cookies.py         # écriture du fichier cookies temporaire (0600), nettoyage
└── tests/                    # pytest : auth, config, cookies, ffmpeg, paths, queue, ytdlp,
                              # routes jobs et folders
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
├── entrypoints/options/       # page d'options (serveurs enregistrés, dossiers favoris…)
├── src/components/            # composants partagés popup/options, dont le navigateur de dossiers
│                              # (navigation, création de dossier, espace disque restant)
├── src/hooks/                 # hooks React partagés (profils de serveur, navigateur de dossiers…)
├── lib/
│   ├── api.ts                  # client HTTP (fetch + Bearer), typé sur le contrat d'API
│   ├── folders.ts              # logique pure de navigation dans l'arborescence des racines
│   ├── profiles.ts             # profils de serveur : migration, CRUD, profil actif
│   ├── storage.ts              # wrappers chrome.storage.local / chrome.storage.session
│   ├── sniffer.ts              # patterns de détection réseau (extensions, content-types)
│   └── correlation.ts          # corrélation picker DOM ↔ requêtes réseau (mode apprentissage)
└── tests/                     # Vitest : patterns de détection, corrélation
```

#### Profils de serveur

Plusieurs serveurs ez-dl peuvent être enregistrés (poste local, NAS, serveur distant), un seul
est **actif** à la fois. Tout tient dans l'unique clé `settings` de `chrome.storage.local` :

```
{ version: 2, profiles: [{ id, name, serverUrl, password, favoriteFolders, … }], activeProfileId }
```

Chaque profil porte une configuration complète : les dossiers favoris, le preset par défaut et
l'envoi de cookies suivent le serveur, puisqu'ils dépendent de ses racines et de son ffmpeg.

L'ancien format — un objet plat sans `version`, un seul serveur — est migré **paresseusement** à
la première lecture, puis persisté une fois pour toutes. La migration est déterministe
(identifiant fixe `default`, jamais un UUID aléatoire) : popup, page d'options et service worker
peuvent migrer en même temps, ils écrivent exactement le même objet.

Le reste du code ne voit qu'un serveur : `getSettings()`/`saveSettings()` sont une **vue aplatie**
du profil actif, ce qui laisse inchangés le client d'API, le sniffer et les vues de la popup. Deux
mécanismes complètent ce contrat :

- `watchSettingsRoot()` (sur `storage.local.onChanged`) resynchronise popup et options ouvertes en
  parallèle ;
- le service worker vide son cache de règles apprises quand `hasActiveServerChanged()` est vrai —
  c'est-à-dire quand l'URL ou le mot de passe **effectifs** changent, pas à chaque renommage de
  profil ou ajout de favori.

Dans la popup, la bascule se fait par un sélecteur compact dans l'en-tête (masqué tant qu'un seul
profil existe) ; la gestion complète — création par duplication, renommage, suppression — est dans
la page d'options. Cette page édite le profil **sélectionné**, qui n'est pas forcément l'actif :
un nouveau serveur se configure de bout en bout sans que la popup bascule dessus.

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
GET    /api/folders?path=   -> {roots:[{label,path,is_available,free_bytes,total_bytes}],
                                current:{path,label,free_bytes,total_bytes}, entries:[{name,path,is_dir}], parent}
POST   /api/folders         -> body {parent, name} -> 201 {name,path,is_dir}  (409 si déjà existant)
POST   /api/jobs            -> body {url, format_id?, folder, filename?, preset_id?, cookies?, headers?, referer?, title?}
                            -> {job_id, status}
GET    /api/jobs            -> [job]
GET    /api/jobs/{id}       -> job
POST   /api/jobs/{id}/pause  -> job (409 hors `queued`/`downloading`) ; conserve le fichier partiel
POST   /api/jobs/{id}/resume -> body optionnel {cookies?, headers?, referer?} -> job `queued`
                                (409 hors `paused`/`error`/`canceled`, 400 si racine indisponible)
DELETE /api/jobs/{id}       -> annule / supprime de l'historique (+ purge du fichier partiel)
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
| `speed` | float? | Vitesse de téléchargement courante, en octets/s |
| `eta` | int? | Temps restant estimé, en secondes |
| `size` | int? | Taille en octets ; taille totale connue une fois le téléchargement démarré, taille réelle du fichier une fois `done` |
| `error` | str? | Message d'erreur si `status == error` ; motif de l'interruption pour un job `paused` par un redémarrage du serveur |
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

   (queued | downloading) ──▶ paused        (pause, ou redémarrage du serveur)
   (paused | error | canceled) ──▶ queued   (reprise / retry)
```

- **`queued`** : job créé, en attente d'un slot de worker libre.
- **`probing`** : yt-dlp interroge la source pour confirmer les formats disponibles.
- **`downloading`** : téléchargement en cours, `progress`/`speed`/`eta` mis à jour périodiquement.
  Chaque job travaille dans son propre dossier `EZDL_TEMP_DIR/<job_id>` : le nom de sortie de
  yt-dlp n'est pas prédictible (il impose l'extension du conteneur réellement produit, qu'un
  merge/remux peut changer), le serveur récupère donc le fichier effectivement écrit.
- **`converting`** : ffmpeg réencode selon le `preset_id` choisi (étape sautée si `preset_id ==
  "copy"` ou absent).
- **`moving`** : déplacement atomique du fichier temporaire (`EZDL_TEMP_DIR`) vers `folder`, après
  revalidation du chemin.
- **`done`** : terminé avec succès.
- **`error`** : échec à n'importe quelle étape, `error` renseigné.
- **`canceled`** : annulation demandée par l'utilisateur (`DELETE /api/jobs/{id}`) pendant que le job
  est encore actif.
- **`paused`** : suspendu volontairement (`POST /api/jobs/{id}/pause`, SIGTERM sur yt-dlp) ou par un
  arrêt du serveur — dans ce cas `error` porte le motif de l'interruption sans que le job soit en
  échec. Un job suspendu est toujours reprenable.

### Reprise et retry

`POST /api/jobs/{id}/resume` remet le job en `queued`. Le dossier de travail
`EZDL_TEMP_DIR/<job_id>` est **conservé** tant que le job reste reprenable (`paused`, `error`) et
n'est purgé que sur `done`, `canceled` ou suppression du job : c'est le `.part` qu'il contient qui
permet à `yt-dlp --continue` de repartir de l'octet atteint plutôt que du début. Un fichier déjà
complet est sauté par yt-dlp, si bien qu'un échec survenu en conversion ou en déplacement ne
provoque pas un second téléchargement.

Deux conséquences opérationnelles :

- la reprise après un redémarrage du serveur n'économise du réseau que si `EZDL_TEMP_DIR` **survit**
  au redémarrage (volume nommé, pas tmpfs — voir [setup.md](setup.md)) ;
- le serveur ne persiste **jamais** les cookies d'un job. Pour reprendre un téléchargement sur une
  page authentifiée après un redémarrage, le client les re-fournit dans le corps de la requête de
  reprise.

Côté extension, la vue Jobs du popup expose ces transitions : **Pause** sur un job `queued` ou
`downloading`, **Reprendre** sur un job `paused`, **Réessayer** sur un job `error` ou `canceled`.
Si l'option « envoyer les cookies » est active, la reprise relit les cookies du navigateur pour
`job.url` et les joint à la requête — sans cette relecture, yt-dlp repartirait anonyme.

### Annulation et suppression

`DELETE /api/jobs/{id}` porte **deux** actions selon l'état du job :

- job encore actif (`queued`, `probing`, `downloading`, `converting`, `moving`) → le
  téléchargement est **arrêté** et le job passe en `canceled`, en restant dans l'historique
  (il peut être réessayé). Le signal est envoyé au **groupe de process**, pas au seul process
  lancé : le binaire yt-dlp standalone est un exécutable PyInstaller (bootloader + enfant), et
  tuer le bootloader seul laissait l'enfant télécharger jusqu'au bout ;
- job terminé (`done`, `error`, `canceled`, `paused`) → il est **retiré** de l'historique et son
  dossier de travail purgé.

Le popup reflète exactement cette bascule : un même bouton affiche « Annuler » tant que le job est
actif, « Supprimer » ensuite (`src/lib/jobStatus.ts`, miroir des ensembles de statuts du serveur).
Il ne retire donc pas la ligne de la liste lors d'une annulation — c'est la mise à jour SSE qui la
repasse en « Annulé ».

**Le fichier téléchargé n'est jamais effacé par défaut** : `DELETE` ne touche qu'à la ligne
d'historique et au dossier de travail temporaire. Pour effacer aussi le fichier déposé à la
destination, le client passe `?delete_file=true`.

Ce paramètre n'est accepté **que sur un job `done`** (`409` sinon) : c'est le seul statut pour
lequel le serveur a lui-même écrit ce chemin exact. Sur les autres, `folder`/`filename` n'est
qu'une destination *prévue* — un job échoué peut porter le même nom qu'un job voisin abouti, et
l'effacer détruirait le fichier de ce dernier. Le chemin visé repasse par `resolve_destination`
avant l'`unlink` (racine autorisée, racine montée, liens symboliques résolus), et seul un
`is_file()` est supprimé : jamais un dossier. Un fichier déjà absent n'est pas une erreur — la
suppression est idempotente. À l'inverse, un échec d'effacement (`400` racine indisponible, `500`
permissions) **conserve le job dans la liste**, pour ne pas perdre la seule référence au fichier
resté sur le disque.

Côté popup, « Supprimer » sur un job terminé ouvre une modale de confirmation
(`components/ConfirmDialog.tsx`) qui sépare explicitement les deux gestes : « Retirer de la liste »
et « Retirer et effacer le fichier ». Les autres statuts n'ayant aucun fichier déposé, ils sont
supprimés sans confirmation.

Toute transition d'état déclenche une publication SSE sur `/api/jobs/events`.
