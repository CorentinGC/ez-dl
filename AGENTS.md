# Agent Instructions — ez-dl

Projet **ez-dl** : téléchargeur vidéo self-hosted. Extension Chrome (MV3) détecte les vidéos d'une
page, serveur FastAPI dans Docker télécharge via yt-dlp, convertit optionnellement via ffmpeg,
range dans des dossiers montés. Repo public source-available, licence PolyForm Noncommercial 1.0.0.

## Avant de coder

- **Lire la doc officielle à jour, pas la mémoire d'entraînement** : les données d'entraînement
  peuvent être périmées (versions, APIs dépréciées). Utiliser le MCP `context7`
  (`resolve-library-id` puis `query-docs`) ou, à défaut, les sources locales (`node_modules/*/README`,
  `.venv/lib/python*/site-packages/*/dist-info`) avant d'écrire du code utilisant une librairie.
- **Installateurs officiels et dernière version stable** : avant d'ajouter une dépendance, vérifier
  la version courante (`npm view <pkg> version`, `uv add <pkg>` sans épingler sauf raison précise) —
  ne pas recopier une version connue depuis la mémoire d'entraînement.
- Lire `CLAUDE.md`, `MEMORY.md` et `llms.txt` à la racine du repo : ils contiennent le contrat de
  stack, l'état courant du projet et l'index de documentation.

## Conventions non négociables du projet

- **Auth sur toutes les routes** sauf `GET /api/health` : header `Authorization: Bearer <EZDL_PASSWORD>`,
  comparaison constant-time côté serveur.
- **`subprocess` en liste d'arguments uniquement**, jamais `shell=True` (yt-dlp, ffmpeg).
- **Validation systématique des chemins de destination** : résolus (`Path.resolve()`) et vérifiés
  comme descendants d'une racine `EZDL_DOWNLOAD_ROOTS`.
- **Aucun code de contournement de DRM** (Widevine/PlayReady/FairPlay), ni suggestion allant dans ce
  sens — même si demandé.
- **Aucune information personnelle** dans un fichier commité : pas d'email réel, nom réel, chemin
  NAS réel, IP privée réelle, secret en dur. Exemples génériques uniquement.
- Commentaires de code en **FR**, identifiants et API en **EN**.
- Fichiers < 400 LOC (warning), découpage obligatoire au-delà de 500 LOC.

## Workflow

- Lire `MEMORY.md` avant de commencer, le mettre à jour après chaque edit significatif.
- Paralléliser le travail décomposable : plusieurs subagents en une seule réponse plutôt que
  séquentiel, sauf dépendance réelle entre les tâches.
- **Jamais de `git commit` ou `git push` sans validation explicite de l'utilisateur.**
- Respecter le lint (`ruff check --fix` côté serveur, `tsc --noEmit` côté extension) et les tests
  (`pytest`, `npm run test`) avant de considérer une tâche terminée.
- `docs/fr/` est canonique, `docs/en/` est un miroir : toute modification de `docs/fr/` doit être
  répercutée dans `docs/en/` dans le même commit.

## Beads

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work atomically
bd close <id>         # Complete work
bd sync               # Sync with git
```

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts.

Shell commands like `cp`, `mv`, and `rm` may be aliased to include `-i` (interactive) mode on some systems, causing the agent to hang indefinitely waiting for y/n input.

**Use these forms instead:**
```bash
# Force overwrite without prompting
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file

# For recursive operations
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

**Other commands that may prompt:**
- `scp` - use `-o BatchMode=yes` for non-interactive
- `ssh` - use `-o BatchMode=yes` to fail instead of prompting
- `apt-get` - use `-y` flag
- `brew` - use `HOMEBREW_NO_AUTO_UPDATE=1` env var

<!-- BEGIN BEADS INTEGRATION -->
## Issue Tracking with bd (beads)

**IMPORTANT**: This project uses **bd (beads)** for ALL issue tracking. Do NOT use markdown TODOs, task lists, or other tracking methods.

### Why bd?

- Dependency-aware: Track blockers and relationships between issues
- Version-controlled: Built on Dolt with cell-level merge
- Agent-optimized: JSON output, ready work detection, discovered-from links
- Prevents duplicate tracking systems and confusion

### Quick Start

**Check for ready work:**

```bash
bd ready --json
```

**Create new issues:**

```bash
bd create "Issue title" --description="Detailed context" -t bug|feature|task -p 0-4 --json
bd create "Issue title" --description="What this issue is about" -p 1 --deps discovered-from:bd-123 --json
```

**Claim and update:**

```bash
bd update <id> --claim --json
bd update bd-42 --priority 1 --json
```

**Complete work:**

```bash
bd close bd-42 --reason "Completed" --json
```

### Issue Types

- `bug` - Something broken
- `feature` - New functionality
- `task` - Work item (tests, docs, refactoring)
- `epic` - Large feature with subtasks
- `chore` - Maintenance (dependencies, tooling)

### Priorities

- `0` - Critical (security, data loss, broken builds)
- `1` - High (major features, important bugs)
- `2` - Medium (default, nice-to-have)
- `3` - Low (polish, optimization)
- `4` - Backlog (future ideas)

### Workflow for AI Agents

1. **Check ready work**: `bd ready` shows unblocked issues
2. **Claim your task atomically**: `bd update <id> --claim`
3. **Work on it**: Implement, test, document
4. **Discover new work?** Create linked issue:
   - `bd create "Found bug" --description="Details about what was found" -p 1 --deps discovered-from:<parent-id>`
5. **Complete**: `bd close <id> --reason "Done"`

### Auto-Sync

bd automatically syncs with git:

- Exports to `.beads/issues.jsonl` after changes (5s debounce)
- Imports from JSONL when newer (e.g., after `git pull`)
- No manual export/import needed!

### Important Rules

- ✅ Use bd for ALL task tracking
- ✅ Always use `--json` flag for programmatic use
- ✅ Link discovered work with `discovered-from` dependencies
- ✅ Check `bd ready` before asking "what should I work on?"
- ❌ Do NOT create markdown TODO lists
- ❌ Do NOT use external issue trackers
- ❌ Do NOT duplicate tracking systems

For more details, see README.md and docs/QUICKSTART.md.

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

<!-- END BEADS INTEGRATION -->
