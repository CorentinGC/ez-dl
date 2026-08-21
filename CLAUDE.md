@AGENTS.md

# CLAUDE.md — ez-dl

Guide agent pour le projet **ez-dl** : téléchargeur vidéo self-hosted (extension Chrome MV3 +
serveur FastAPI/yt-dlp/ffmpeg dans Docker).

> **Avant toute tâche de code**, lire dans l'ordre : `AGENTS.md`, `MEMORY.md`, `llms.txt`.
> Ce sont les sources de vérité du workflow, de l'état courant et de l'index de doc.

## Stack

| Côté | Techno |
|---|---|
| Serveur | Python 3.13, FastAPI, uvicorn, SQLModel (SQLite), pydantic-settings, sse-starlette, gestionnaire **uv** |
| Extension | WXT 0.21.4, React, TypeScript, gestionnaire **npm** |
| Binaires externes | `yt-dlp` (standalone), `ffmpeg`/`ffprobe` |
| Base de données | SQLite |

## Commandes

| Action | Serveur (`server/`) | Extension (`extension/`) |
|---|---|---|
| Install | `uv sync` | `npm install` |
| Dev | `uv run uvicorn app.main:app --reload --port 8000` | `npm run dev` |
| Build | — (pas de build, déployé via Docker) | `npm run build` |
| Test | `uv run pytest` | `npm run test` |
| Lint | `uv run ruff check --fix` | `npm run compile` |
| Docker | `docker compose up -d --build` | — |

## Mémoire & documentation (obligatoire)

- Lire `MEMORY.md` **avant** de commencer à coder : il contient l'état courant, les prochaines
  étapes et les pièges connus.
- Mettre à jour `MEMORY.md` **après chaque edit** significatif (nouvelle décision, piège découvert,
  étape terminée).
- Mettre à jour `docs/` et `llms.txt` à chaque changement d'architecture, de pattern ou de module.
- **`docs/fr/` est canonique. `docs/en/` est un miroir** qui doit être synchronisé **dans le même
  commit** que toute modification de `docs/fr/`. Ne jamais laisser les deux langues diverger.

## Projet public — règles absolues

- **Jamais d'information personnelle** dans un fichier commité : pas d'email réel, pas de nom réel,
  pas de chemin NAS réel, pas d'IP privée réelle, pas de token/mot de passe en dur.
- Utiliser des **exemples génériques** uniquement (`/mnt/media/movies`, `http://nas.local:8000`,
  `<your-email>`, `<contact@example.com>`).
- **Aucun code de contournement de DRM** (Widevine/PlayReady/FairPlay), ni suggestion allant dans
  ce sens.
- **Secrets uniquement via variables d'environnement et `.env`** (fichier gitignoré, jamais commité).

## Qualité de code

- DRY, SRP : un fichier = une responsabilité.
- Warning à **400 LOC**, découpage **obligatoire au-delà de 500 LOC**.
- Naming explicite : booléens préfixés `is`/`has`/`can`/`should`.
- Early returns, maximum **3 niveaux d'indentation**.
- Pas de dead code, pas de `TODO` sans issue beads associée (`TODO(ez-dl-xxx): ...`).
- Colocation : les fichiers liés (composant + styles + tests) vivent ensemble.

## Conventions du projet

- **Tests** : côté serveur, pytest + pytest-asyncio + httpx, couverture sur formats, capabilities,
  queue, auth, paths. Côté extension, Vitest sur les patterns de détection et la corrélation
  d'apprentissage.
- **Lint** : `ruff` côté serveur, `tsc --noEmit` (`npm run compile`) côté extension.
- **Commits** : Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`...).
- **Validation des entrées** : pydantic côté serveur, zod ou types stricts côté extension.
- **Langue** : commentaires de code en **FR**, identifiants/API en **EN**.

## Sécurité (non négociable)

- **Jamais de `shell=True`** : tout appel `subprocess` prend une liste d'arguments.
- **Path traversal** : tout chemin de destination est résolu (`Path.resolve()`) puis vérifié comme
  descendant d'une des racines `EZDL_DOWNLOAD_ROOTS`, sinon `400`. Même règle pour `/api/folders`.
- **Sanitize des noms de fichiers** : retirer `/`, `\`, `..`, caractères de contrôle, limiter la
  longueur.
- **Cookies** reçus de l'extension : écrits dans un fichier temporaire à permissions `0600`,
  supprimé après le job. Jamais loggés.
- **Mot de passe** (`EZDL_PASSWORD`) : comparaison **constant-time** (`secrets.compare_digest`, sur
  des `bytes`), obligatoire sur toutes les routes sauf `/api/health`. Jamais loggé. Si `EZDL_PASSWORD`
  est absent/vide, le serveur **génère** un mot de passe fort au démarrage et l'affiche dans un
  bandeau console — il n'existe aucun mode « sans authentification » (ADR 0003, amendé par
  `ez-dl-5jw`).
- **URL passées à yt-dlp** : toujours précédées d'un `--` dans la liste d'arguments, et validées
  `http`/`https` côté schéma — sinon une URL en `-...` devient une option (`--exec`, `--paths`).

## Parallélisation des subagents

Pour tout travail décomposable en tâches indépendantes, **lancer 5 à 10 subagents en parallèle
dans une seule réponse** plutôt que de séquentialiser. Ne séquentialiser que les vraies
dépendances (ex : attendre que le scaffold serveur existe avant d'écrire ses tests).

Optimiser le modèle par agent :
- **haiku** : recherche, exploration read-only, synchronisation de doc.
- **sonnet** : implémentation de code, revue standard.
- **opus** : architecture, ADR, audit de sécurité, debug difficile.

## Agents projet (`.claude/agents/`)

| Agent | Modèle | Rôle |
|---|---|---|
| `architecte` | opus | Décisions d'architecture, ADR, debug difficile |
| `dev-server` | sonnet | FastAPI, yt-dlp, ffmpeg, queue, SQLite |
| `dev-extension` | sonnet | WXT, MV3, sniffer réseau, React |
| `ux-ui-designer` | sonnet | Popup, options, accessibilité |
| `devops-docker` | sonnet | Dockerfile, compose, GPU, CI |
| `security-reviewer` | opus | Auth, subprocess, path traversal, permissions |
| `test-writer` | sonnet | Tests pytest + Vitest |
| `doc-maintainer` | haiku | Synchronisation docs FR↔EN, llms.txt, README |
| `explorer` | haiku | Recherche read-only dans le code |

Invoquer `architecte` pour toute décision structurante ou tout bug qui résiste à une première
tentative. Invoquer `security-reviewer` avant de merger tout code touchant l'auth, les chemins de
fichiers ou les appels `subprocess`. Invoquer `doc-maintainer` après chaque changement d'archi pour
garder `docs/fr` et `docs/en` synchronisés. Invoquer `explorer` en amont de toute exploration
read-only du code pour préserver le contexte des autres agents.

## MCP

- **`chrome-devtools`** : données isolées dans `.mcp/chrome-devtools/` (gitignoré), utilisé pour
  tester l'extension dans un vrai Chrome (chargement, popup, sniffing réseau).
- **`context7`** : documentation à jour des librairies (FastAPI, SQLModel, WXT, yt-dlp...) — à
  préférer à la mémoire d'entraînement, potentiellement périmée.

## Beads

- `bd ready --json` en début de tâche pour lister le travail disponible.
- `bd update <id> --claim` avant de commencer à travailler sur une issue.
- `bd close <id> --reason "..."` à la fin, avec une raison explicite.
- **Commit après chaque issue fermée** : une issue beads = un commit. Fermer l'issue puis
  committer immédiatement le travail correspondant (lint + tests verts d'abord), en référençant
  l'identifiant dans le message (`fix(server): ... (ez-dl-xxx)`). Ne pas accumuler plusieurs
  issues dans un lot non commité. Le `git push` reste soumis à validation explicite.
- Remplace `TodoWrite` : ne pas créer de TODO markdown parallèle tant que beads est actif.

Issues existantes : `ez-dl-k4g` (config agent), `ez-dl-txh` (équipe agents), `ez-dl-rv2`
(OSS/licence), `ez-dl-f0d` (serveur), `ez-dl-oa1` (extension), `ez-dl-07z` (auth mot de passe),
`ez-dl-582` (auto-update yt-dlp), `ez-dl-20z` (docker), `ez-dl-2np` (tests), `ez-dl-ek5`
(apprentissage, epic).

## Pointeurs

- Règles agents détaillées (multi-outils) : `AGENTS.md`
- État de travail courant, décisions récentes, pièges : `MEMORY.md`
- Index de documentation (format llms.txt) : `llms.txt`
- Documentation canonique : `docs/fr/` — miroir anglais : `docs/en/`
- Configuration MCP : `.mcp.json`
