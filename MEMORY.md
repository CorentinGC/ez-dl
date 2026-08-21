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
- [ ] **Gros lot non commité** (fix SSE + 3 issues + docs) : en attente de validation utilisateur
      pour committer.

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
- **SSE : sse-starlette émet des fins de ligne `\r\n`** : tout parsing côté client doit découper
  les frames sur `\r?\n\r?\n`, jamais sur `'\n\n'` littéral (bug corrigé dans `api.ts`).
- **Chrome de marque ≥ 137 ne supporte plus `--load-extension`** : pour tester l'extension
  unpacked, utiliser le Chromium de Playwright. Le MCP `chrome-devtools` ne convient pas non
  plus pour ça (puppeteer lance Chrome avec `--disable-extensions` par défaut).
- **Assets vidéo externes piégeux pour les e2e** : `commondatastorage.googleapis.com` refuse les
  UA non-navigateur (403 pour yt-dlp/curl), `media.w3.org` 403 par intermittence quand yt-dlp
  envoie un `Referer` étranger. Servir la vidéo de test en local (`python3 -m http.server`).
