# MEMORY.md — ez-dl

Mémoire de travail courte. À lire avant de coder, à mettre à jour après chaque edit significatif.
Ne pas laisser grossir au-delà de ~150 lignes : archiver les détails stables dans `docs/fr/`.

## État courant

Squelette complet et vérifié, commité localement sur `main` — **rien n'est encore poussé**
(`git push` en attente de validation explicite de l'utilisateur).

- **Serveur** : routes `/api/{health,capabilities,probe,folders,jobs,jobs/events,rules}`, wrappers
  yt-dlp/ffmpeg, queue asyncio + SQLite, auth Bearer. `ruff` clean, **26 tests pytest** verts.
  Smoke test réel validé : health public, 401 sans/avec mauvais mot de passe, 200 avec le bon,
  destination `/etc` refusée en 400, démarrage normal (génération auto du mot de passe si absent).
- **Extension** : sniffer `background.ts`, popup (sources, qualité, renommage, dossier, preset,
  jobs en SSE + pause/reprise/retry, sélecteur de serveur), options (profils multi-serveurs),
  content script picker. `compile` OK, **151 tests Vitest** verts.
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

- [x] 2026-08-21 (nuit) : `ez-dl-a0u` pause / reprise / retry côté serveur — statut `paused`,
      `POST /api/jobs/{id}/{pause,resume}`, dossier de travail conservé tant que le job est
      reprenable, jobs coupés par un redémarrage suspendus au lieu d'être mis en erreur.
      90 tests pytest, red-green vérifié par mutation du correctif.
- [x] 2026-08-21 (nuit) : `ez-dl-x3s` `EZDL_TEMP_DIR` persistant (volume nommé `ezdl-temp`,
      tmpfs conservé sur le seul sous-dossier `cookies/`), Dockerfile qui crée et chowne le
      dossier, purge des résidus au démarrage de `JobQueue.start()`. 91 tests pytest.
- [x] 2026-08-21 (nuit) : `ez-dl-8sk` pause / reprise / retry côté extension — `pauseJob`/`resumeJob`
      dans `src/lib/api.ts`, exposés par `useJobs`, boutons Pause / Reprendre / Réessayer dans
      `JobsView`, cookies relus pour la reprise si l'option est active. 120 tests Vitest,
      red-green vérifié par mutation.

- [x] `ez-dl-b6e` : YouTube réparé — Deno dans l'image (runtime JS yt-dlp), sélecteur
      `<id>+bestaudio/<id>/bv*+ba/b`, filtrage storyboard/Premium au probe,
      `--ignore-no-formats-error` + erreur explicite si aucun format, validation de `format_id`.
      Vérifié en réel : probe 200 (`best_format_id` 270 au lieu du Premium 616), job 1080p avec
      piste audio opus, non-régression source sniffée x.com. 2026-08-21.

- [x] `ez-dl-1xu` / `ez-dl-m4q` : « Annuler » réparé — kill du groupe de process (l'enfant
      PyInstaller de yt-dlp survivait au kill), progression fragmentée corrigée, popup qui
      distingue Annuler (job actif) de Supprimer (job terminé, `done`/`error` compris, qui
      n'avaient aucun bouton). Pause/reprise/retry vérifiés en réel puis extension rebuildée.
      100 tests pytest + 124 Vitest. 2026-08-21.
- [x] `ez-dl-f4z` : « Supprimer » désambiguïsé — `?delete_file=true` sur le `DELETE` (jobs `done`
      uniquement) + modale de confirmation dans la popup (« Retirer de la liste » / « Retirer et
      effacer le fichier »). Vérifié sur le conteneur : défaut non destructif, effacement réel,
      409 sur un job en erreur, fichiers voisins intacts. 105 pytest + 129 Vitest. 2026-08-21.
- [x] `ez-dl-vh2` : déploiement prod sur le serveur perso derrière un tunnel Cloudflare (config
      réelle hors dépôt, cf. mémoire agent). Rien de commité côté dépôt. 2026-08-22.
- [x] `ez-dl-mdd` : profils multi-serveurs dans l'extension — `src/lib/profiles.ts` (clé `settings`
      versionnée v2, migration paresseuse déterministe du format plat, CRUD, vue aplatie
      `getSettings`/`saveSettings` sur le profil actif, `watchSettingsRoot`), sélecteur dans
      l'en-tête de la popup, section « Serveurs » dans les options (création par duplication),
      invalidation du cache de règles du background au changement de serveur effectif.
      151 tests Vitest, red-green vérifié par mutation. 2026-08-22.
- [ ] `ez-dl-8hm` : sélecteur de dossier en overlay plein écran + fil d'Ariane (en cours).

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
- **Message opérateur ≠ message client** (`ez-dl-0tk`) : `root_issue()` (logs) cite l'uid du
  process et le fichier de montage à corriger ; `_client_issue()` (réponses HTTP, `Job.error`)
  ne cite que le label de la racine. Un message d'erreur rendu au client est du contenu public.
- **Jamais de `Path.expanduser()` sur une entrée utilisateur** : lève `RuntimeError` (donc 500)
  sur `~utilisateur-inconnu`, cas courant sous un uid Docker sans entrée `/etc/passwd`. Le
  contrat exige déjà un chemin absolu, l'expansion n'a aucune raison d'exister.
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
- **La reprise d'un téléchargement dépend de la persistance d'`EZDL_TEMP_DIR`** : c'est le `.part`
  du dossier de travail qui permet à `yt-dlp --continue` de repartir de l'octet atteint. Monté en
  tmpfs, il disparaît au redémarrage du conteneur → la reprise refait tout le téléchargement.
  Depuis `ez-dl-x3s`, le compose monte le volume nommé `ezdl-temp` sur `/tmp/ez-dl` **et** un
  tmpfs par-dessus `/tmp/ez-dl/cookies` (les cookies ne doivent pas toucher le disque, les
  fichiers partiels si). Vérifié en conteneur : montages imbriqués OK, `.part` conservé entre
  deux runs, dossier `cookies/` vidé.
- **Un volume nommé vide hérite du propriétaire du dossier de l'IMAGE** : sans `mkdir -p
  /tmp/ez-dl && chown ezdl` dans le Dockerfile, le volume monté appartient à `root:root` et le
  serveur non-root ne peut rien y écrire (`Permission denied` au premier job). Vaut pour tout
  chemin monté en volume nommé.
- **Un arrêt demandé ressemble à une panne** : SIGTERM (pause) comme SIGKILL (annulation) font
  échouer `wait_download` exactement comme une erreur réseau. Seuls les drapeaux
  `_pause_requested`/`_cancel_requested` distinguent les trois cas — le code de retour, non.
- **Le statut en base sert de jeton de prise d'un job** : une reprise ré-enfile l'id sans pouvoir
  retirer l'entrée obsolète de la file asyncio. `_run_job` ignore donc tout job qui n'est plus
  `queued`, et prend le job sans `await` entre la lecture du statut et son passage en
  `downloading` (sinon deux workers exécuteraient le même job).
- **SSE : sse-starlette émet des fins de ligne `\r\n`** : tout parsing côté client doit découper
  les frames sur `\r?\n\r?\n`, jamais sur `'\n\n'` littéral (bug corrigé dans `api.ts`).
- **Chrome de marque ≥ 137 ne supporte plus `--load-extension`** : pour tester l'extension
  unpacked, utiliser le Chromium de Playwright. Le MCP `chrome-devtools` ne convient pas non
  plus pour ça (puppeteer lance Chrome avec `--disable-extensions` par défaut).
- **`EZDL_DATA_DIR`/`EZDL_TEMP_DIR` sont des chemins DANS le conteneur** (`/config`,
  `/tmp/ez-dl`) : une valeur relative (`./test`) donnait un `PermissionError` opaque au démarrage.
  Depuis `ez-dl-3qz`, `Settings` rejette tout chemin relatif avec un message explicite (non commité).
- **YouTube exige un runtime JS dans l'image** (Deno, `denoland/deno:bin`, multi-arch) : sans lui,
  yt-dlp avertit « No supported JavaScript runtime could be found », ne résout pas les challenges
  du player et peut ne renvoyer aucun format jouable — `yt-dlp -J` sort alors en erreur avec
  « Requested format is not available », remonté en **502** par `/api/probe` (`ez-dl-b6e`).
  Deno a besoin d'un cache inscriptible : `HOME=/home/ezdl` + `DENO_DIR=/home/ezdl/.cache/deno`,
  jamais dans `EZDL_TEMP_DIR` (tmpfs).
- **Ne jamais passer un `format_id` nu à `-f`** : sur YouTube tout format au-delà de 360p est
  video-only (`-f 137` → fichier **muet**), et les identifiants varient d'une extraction à l'autre
  (suffixes de langue `-0/-1`, formats `Premium` selon le client interrogé). `build_format_selector`
  produit `<id>+bestaudio/<id>/bv*+ba/b` : fusion audio, repli si déjà muxé, repli global si l'id a
  disparu depuis le probe. Storyboards (`mhtml`) et formats « Premium » sont filtrés du probe.
- **Tuer un job = tuer le GROUPE de process** : le binaire yt-dlp standalone est un exécutable
  PyInstaller (bootloader parent + interpréteur enfant). Le bootloader relaie SIGTERM mais pas
  SIGKILL : `process.kill()` ne tuait que lui, l'enfant continuait à télécharger et à écrire sur
  le pipe de progression — la barre d'un job « annulé » montait jusqu'à 100 % (`ez-dl-1xu`).
  Correctif : `start_new_session=True` au lancement (yt-dlp ET ffmpeg) + `os.killpg`, avec un
  garde-fou `pgid == pid` pour ne jamais signaler le groupe du serveur.
- **Progression yt-dlp sur un flux fragmenté (HLS/DASH)** : `downloaded_bytes`/`total_bytes`
  décrivent le **fragment** en cours, pas le média. Utiliser `fragment_index`/`fragment_count`,
  sinon la barre oscille et atteint 100 % à chaque fragment fini.
- **`DELETE /api/jobs/{id}` a deux sens** : annulation (job actif, la ligne reste en `canceled`,
  reprenable) ou suppression d'historique (job terminé). Le popup doit refléter les deux — retirer
  la ligne de façon optimiste après une annulation la fait réapparaître par SSE, ce qui donnait
  l'impression que « Annuler » ne faisait rien. Le fichier téléchargé n'est **jamais** effacé par
  défaut : il faut `?delete_file=true` (modale de confirmation côté popup, `ez-dl-f4z`).
- **Réglages de l'extension = un seul objet dans `storage.local`** : la clé `settings` porte
  désormais `{version: 2, profiles[], activeProfileId}`. La migration depuis l'ancien format plat
  est **paresseuse** (à la première lecture) et doit rester **déterministe** — identifiant fixe
  `default`, jamais `crypto.randomUUID()` : popup, options et service worker migrent parfois en
  même temps, un id aléatoire créerait deux profils divergents selon le dernier écrivain.
- **Ne pas invalider le cache de règles à chaque écriture de `settings`** : renommer un profil ou
  ajouter un favori réécrit la clé. Le background compare l'URL + le mot de passe du profil actif
  (`hasActiveServerChanged`) — sinon le cache TTL 5 min ne sert plus à rien.
- **Changer de serveur ne remonte pas les composants de la popup** : les hooks gardent leur état
  local (jobs, presets, sources) alors que leur effet se relance. Chaque effet doit vider son état
  en tête, sinon les jobs de deux serveurs cohabitent dans la liste (`ez-dl-mdd`).
- **`delete_file` n'est accepté que sur un job `done`** (409 sinon) : c'est le seul statut où le
  serveur a écrit ce chemin exact. Ailleurs `folder`/`filename` n'est qu'une destination *prévue*,
  et un job échoué porte souvent le nom d'un job voisin abouti — l'effacer détruirait le fichier de
  ce dernier. L'`unlink` repasse par `resolve_destination` et n'agit que sur un `is_file()`.
- **Assets vidéo externes piégeux pour les e2e** : `commondatastorage.googleapis.com` refuse les
  UA non-navigateur (403 pour yt-dlp/curl), `media.w3.org` 403 par intermittence quand yt-dlp
  envoie un `Referer` étranger. Servir la vidéo de test en local (`python3 -m http.server`).
