# MEMORY.md — ez-dl

Mémoire de travail courte. À lire avant de coder, à mettre à jour après chaque edit significatif.
Ne pas laisser grossir au-delà de ~150 lignes : archiver les détails stables dans `docs/fr/`.

## État courant

Squelette complet et vérifié, jamais commité (aucun `git commit` fait à ce stade).

- **Serveur** : routes `/api/{health,capabilities,probe,folders,jobs,jobs/events,rules}`, wrappers
  yt-dlp/ffmpeg, queue asyncio + SQLite, auth Bearer. `ruff` clean, **26 tests pytest** verts.
  Smoke test réel validé : health public, 401 sans/avec mauvais mot de passe, 200 avec le bon,
  destination `/etc` refusée en 400, démarrage normal (génération auto du mot de passe si absent).
- **Extension** : sniffer `background.ts`, popup (sources, qualité, renommage, dossier, preset,
  jobs en SSE), options, content script picker. `compile` + `build` OK, **57 tests Vitest** verts.
  Manifest MV3 : `webRequest, storage, tabs, activeTab, cookies, scripting` + `<all_urls>`.
- **Infra** : Dockerfile multi-stage non-root, `docker-compose.yml` (+ override GPU), CI GitHub
  Actions, Makefile. `docker compose config` validé.
- **Cohérence** : routes appelées par l'extension comparées à l'OpenAPI réel du serveur — alignées.

## Prochaines étapes

- [x] Premier commit : `9e5576d` (131 fichiers). Fix SSE + tests e2e non commités à ce stade.
- [x] Test e2e local extension→serveur : validé le 2026-08-21 (voir « Décisions récentes »).
- [ ] Publication du dépôt. **Avant push** : décider de l'email git (gmail réel dans les commits
      ET dans les exports beads `owner:` — passer sur l'adresse noreply GitHub ?).
- [ ] Test bout en bout Docker : `docker compose up -d --build`, puis un vrai téléchargement
      (x.com et un site HLS) avec vérification du fichier déposé dans le bon dossier.
- [x] `ez-dl-buq` : `/api/jobs` désormais numérique (`speed` float o/s, `eta` int s, `size` int
      octets = taille réelle post-move). Validé en job réel. 2026-08-21.
- [x] `ez-dl-6mp` : variante `nvenc` du Dockerfile (ARG `FFMPEG_VARIANT`, binaire BtbN, amd64
      only), activée par `docker-compose.gpu.yml`. Build des 2 variantes validé. 2026-08-21.
- [x] `ez-dl-ek5` : `generalizeUrlPattern` (detection.ts) branchée sur le flux picker — ids
      variables et valeurs de query réduits en `*`. 2026-08-21.
- [ ] **Gros lot non commité** (fix SSE + issues + docs) : en attente de validation utilisateur
      pour committer.
- [x] 2026-08-21 (soir) : `ez-dl-3qz` (chemins relatifs rejetés), `ez-dl-5jw` (mot de passe
      auto-généré + bandeau console + docs), `ez-dl-5pg` (yt-dlp par TARGETARCH), `ez-dl-aod`
      (contrat probe/cookies + erreurs 422 lisibles), `ez-dl-gvi` (dédup variantes + dropdown
      qualité). Audit security-reviewer lancé sur le lot auth/cookies.
- [x] Correctifs de l'audit sécurité (2026-08-21) : `ez-dl-z1k` (injection d'arguments yt-dlp,
      élevée), `ez-dl-vi2` (fuite `EZDL_PASSWORD` dans l'erreur de démarrage), `ez-dl-0su`
      (cookie-jar hors tmpfs), `ez-dl-aml` (compare_digest bytes, caractères de contrôle,
      filtrage du stderr yt-dlp). Chaque correctif vérifié en red-green. 50 tests pytest.

## Décisions récentes (2026-08-21)

- **FastAPI plutôt que Node** : yt-dlp est nativement Python, évite un wrapper CLI supplémentaire.
- **Détection hybride** : yt-dlp probe + sniffing réseau côté extension (`chrome.webRequest`), plus
  règles apprises par site.
- **Licence PolyForm Noncommercial 1.0.0** : gratuit non commercial, licence commerciale payante sur
  demande.
- **Doc bilingue** : FR canonique, EN miroir synchronisé dans le même commit.
- **npm au lieu de pnpm** pour l'extension : pnpm absent de la machine de dev.
- **Auth par mot de passe obligatoire** (`EZDL_PASSWORD`, Bearer, constant-time) : pas de mode
  "sans mot de passe". Depuis `ez-dl-5jw`, si `EZDL_PASSWORD` est absent le serveur ne refuse
  plus de démarrer : il **génère** un mot de passe fort à chaque démarrage et l'affiche dans un
  bandeau console isolé (pause 5 s avant les logs de bootstrap).
- **Auto-update yt-dlp périodique** : `-U` non bloquant au démarrage + tâche asyncio configurable
  (`EZDL_YTDLP_UPDATE_INTERVAL_HOURS`).
- **E2E validé (2026-08-21)** : Chromium Playwright (`launchPersistentContext` +
  `--load-extension` sur `.output/chrome-mv3`), page vidéo locale → sniff mp4 + badge « 1 » →
  popup → job → fichier 4,2 Mo déposé dans la racine autorisée. Fix au passage : parsing SSE
  côté extension cassé par les fins de ligne CRLF de sse-starlette (`api.ts`, 6 tests ajoutés).

## Pièges / gotchas

- **yt-dlp doit être le binaire standalone**, pas la version installée via pip : `-U` (self-update)
  ne fonctionne que sur le binaire standalone.
- **MV3 = service worker qui s'endort** : ne jamais garder d'état important en mémoire seule dans
  `background.ts`, utiliser `chrome.storage.session` (état par onglet, badge...).
- **`chrome.webRequest` en MV3 est observationnel uniquement** (pas de blocage synchrone comme en
  MV2) : le sniffing détecte, il ne peut pas intercepter/modifier les requêtes.
- **Cookies sensibles** : opt-in explicite côté utilisateur, jamais loggés côté serveur ni côté
  extension, fichier temporaire `0600` supprimé après usage.
- **Chemins de destination** : toujours vérifiés comme descendants d'une racine
  `EZDL_DOWNLOAD_ROOTS` avant toute écriture — y compris pour la navigation `/api/folders`.
- **`ffmpeg` de Debian n'a pas NVENC** (dépendances non-libres exclues) : résolu par la variante
  `FFMPEG_VARIANT=nvenc` du Dockerfile (binaire statique BtbN, amd64 only) — c'est elle qu'active
  `docker-compose.gpu.yml`, le passthrough GPU seul ne suffit pas. Rebuild avec `--build` requis.
- **Changement de schéma `Job` sans migration (politique pré-1.0)** : une base `data/` créée avec
  un ancien schéma fait échouer la validation de réponse de **toute** la liste `/api/jobs` (500) —
  supprimer `data/` des instances de dev après un changement de schéma.
- **zsh et les globs sans correspondance** : `rm -rf dossier/*` avorte TOUTE la commande si un
  glob ne matche rien (« no matches found ») — piège vu en test ; préférer `rm -rf dossier` + `mkdir`.
- **`/api/capabilities` doit rester filtré** : `ffmpeg -encoders` en retourne ~192 (images,
  sous-titres, PCM). `relevant_encoders()` réduit à ceux exploitables — ne pas exposer la liste brute.
- **`EventSource` ne peut pas porter d'en-tête `Authorization`** : le suivi des jobs en SSE est donc
  fait à la main via `fetch` + `ReadableStream`, avec repli sur du polling.
- **`--` obligatoire avant l'URL passée à yt-dlp** : sans lui, une URL en `-...` est parsée
  comme une option (`--exec`, `--paths`) → exécution de commande et écriture hors
  `EZDL_DOWNLOAD_ROOTS`, ce qui annule toute la validation de chemins. Doublé d'un type
  `MediaUrl` (http/https only) sur les schémas d'entrée.
- **Validateurs pydantic de `Settings` : par CHAMP, jamais de modèle** — pydantic joint la
  valeur d'entrée au message d'erreur, et l'entrée d'un `model_validator` est le dict complet
  des réglages : `EZDL_PASSWORD` se retrouverait dans les logs de démarrage.
- **FastAPI : `url: MediaUrl = Query(...)` ignore silencieusement l'`AfterValidator`** — il faut
  écrire `url: Annotated[MediaUrl, Query()]`. Vérifié sur FastAPI 0.141.1 (200 vs 422).
- **Cookie-jar temporaire dans `EZDL_TEMP_DIR`**, jamais dans le `/tmp` du système :
  c'est ce répertoire qui est monté en tmpfs, donc le seul où des cookies en clair ne touchent
  pas la couche disque du conteneur.
- **Contrat cookies extension→serveur** : liste structurée `CookieParam[]` (miroir de
  `CookieItem`), JAMAIS une chaîne Netscape — c'est le serveur qui écrit le cookie-jar yt-dlp.
  Et le `POST /api/probe` lit l'URL dans le **corps**, pas en query (la query n'est lue que par
  la variante GET). Violé une fois → 422 sur tout x.com (`ez-dl-aod`).
- **Binaire yt-dlp du Dockerfile par TARGETARCH** : `yt-dlp_linux` (amd64) vs
  `yt-dlp_linux_aarch64` (arm64). Un asset x86_64 codé en dur casse sur Apple Silicon avec
  « rosetta error: failed to open elf » au premier job.
- **Routes FastAPI qui touchent le disque : `def`, pas `async def`** — `stat`/`statvfs`/`scandir`
  sur un montage NAS mort partent en sommeil ininterruptible et figeraient toute la boucle
  asyncio (health, SSE, jobs en cours). En fonction synchrone, Starlette les exécute en
  threadpool. Vaut pour `/api/folders` (GET et POST) depuis `ez-dl-wxh`.
- **La validation de chemin est lexicale, pas physique** : `resolve()` + `is_relative_to` ne dit
  rien d'une racine non montée ou non inscriptible. Depuis `ez-dl-keh`, `root_issue()` vérifie
  existence/dossier/`os.access(W_OK|X_OK)` → `WARNING` au démarrage par racine cassée et
  `RootUnavailableError` (400) avant tout téléchargement.
- **Le nom de sortie de yt-dlp n'est PAS prédictible** : `-o` reçoit un *template*, et yt-dlp
  impose l'extension du conteneur réellement produit (un merge/remux la change en cours de
  route). `-o <dir>/<id>.part` produit `<id>.part.mp4` → `[Errno 2]` à 100 % au moment du
  déplacement (`ez-dl-1i9`). Correctif : un dossier de travail par job + récupération du fichier
  réellement écrit (`_downloaded_file`), jamais un nom deviné.
- **SSE : sse-starlette émet des fins de ligne `\r\n`** : tout parsing côté client doit découper
  les frames sur `\r?\n\r?\n`, jamais sur `'\n\n'` littéral (bug corrigé dans `api.ts`).
- **Chrome de marque ≥ 137 ne supporte plus `--load-extension`** : pour tester l'extension
  unpacked, utiliser le Chromium de Playwright. Le MCP `chrome-devtools` ne convient pas non
  plus pour ça (puppeteer lance Chrome avec `--disable-extensions` par défaut).
- **`EZDL_DATA_DIR`/`EZDL_TEMP_DIR` sont des chemins DANS le conteneur** (`/config`,
  `/tmp/ez-dl`) : une valeur relative (`./test`) donnait un `PermissionError` opaque au démarrage.
  Depuis `ez-dl-3qz`, `Settings` rejette tout chemin relatif avec un message explicite (non commité).
- **Assets vidéo externes piégeux pour les e2e** : `commondatastorage.googleapis.com` refuse les
  UA non-navigateur (403 pour yt-dlp/curl), `media.w3.org` 403 par intermittence quand yt-dlp
  envoie un `Referer` étranger. Servir la vidéo de test en local (`python3 -m http.server`).
