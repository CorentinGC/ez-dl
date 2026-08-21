# MEMORY.md — ez-dl

Mémoire de travail courte. À lire avant de coder, à mettre à jour après chaque edit significatif.
Ne pas laisser grossir au-delà de ~150 lignes : archiver les détails stables dans `docs/fr/`.

## État courant

Squelette complet et vérifié, jamais commité (aucun `git commit` fait à ce stade).

- **Serveur** : routes `/api/{health,capabilities,probe,folders,jobs,jobs/events,rules}`, wrappers
  yt-dlp/ffmpeg, queue asyncio + SQLite, auth Bearer. `ruff` clean, **26 tests pytest** verts.
  Smoke test réel validé : health public, 401 sans/avec mauvais mot de passe, 200 avec le bon,
  destination `/etc` refusée en 400, démarrage impossible sans `EZDL_PASSWORD`.
- **Extension** : sniffer `background.ts`, popup (sources, qualité, renommage, dossier, preset,
  jobs en SSE), options, content script picker. `compile` + `build` OK, **57 tests Vitest** verts.
  Manifest MV3 : `webRequest, storage, tabs, activeTab, cookies, scripting` + `<all_urls>`.
- **Infra** : Dockerfile multi-stage non-root, `docker-compose.yml` (+ override GPU), CI GitHub
  Actions, Makefile. `docker compose config` validé.
- **Cohérence** : routes appelées par l'extension comparées à l'OpenAPI réel du serveur — alignées.

## Prochaines étapes

- [ ] Premier commit (rien n'est encore versionné) puis publication du dépôt.
- [ ] Test bout en bout réel : `docker compose up -d --build`, puis un vrai téléchargement
      (x.com et un site HLS) avec vérification du fichier déposé dans le bon dossier.
- [ ] Tester l'extension dans Chrome via le MCP `chrome-devtools` (badge, popup, envoi de job).
- [ ] `ez-dl-6mp` : ffmpeg avec NVENC dans l'image Docker (le ffmpeg Debian ne l'a pas).
- [ ] `ez-dl-ek5` : généraliser les patterns du mode apprentissage (aujourd'hui l'URL exacte est
      enregistrée telle quelle, sans réduction des identifiants variables en `*`).

## Décisions récentes (2026-08-21)

- **FastAPI plutôt que Node** : yt-dlp est nativement Python, évite un wrapper CLI supplémentaire.
- **Détection hybride** : yt-dlp probe + sniffing réseau côté extension (`chrome.webRequest`), plus
  règles apprises par site.
- **Licence PolyForm Noncommercial 1.0.0** : gratuit non commercial, licence commerciale payante sur
  demande.
- **Doc bilingue** : FR canonique, EN miroir synchronisé dans le même commit.
- **npm au lieu de pnpm** pour l'extension : pnpm absent de la machine de dev.
- **Auth par mot de passe obligatoire** (`EZDL_PASSWORD`, Bearer, constant-time) : pas de mode
  "sans mot de passe", le serveur refuse de démarrer sinon.
- **Auto-update yt-dlp périodique** : `-U` non bloquant au démarrage + tâche asyncio configurable
  (`EZDL_YTDLP_UPDATE_INTERVAL_HOURS`).

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
- **`ffmpeg` de Debian n'a pas NVENC** (dépendances non-libres exclues) : le passthrough GPU seul
  ne suffit pas pour les presets `*_nvenc`, il faut une image ffmpeg compilée avec NVENC (`ez-dl-6mp`).
- **`/api/capabilities` doit rester filtré** : `ffmpeg -encoders` en retourne ~192 (images,
  sous-titres, PCM). `relevant_encoders()` réduit à ceux exploitables — ne pas exposer la liste brute.
- **`EventSource` ne peut pas porter d'en-tête `Authorization`** : le suivi des jobs en SSE est donc
  fait à la main via `fetch` + `ReadableStream`, avec repli sur du polling.
