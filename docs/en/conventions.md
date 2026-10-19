# Conventions

## Code style

- **Server (Python)**: follow the project's `ruff` rules (`server/pyproject.toml`). Systematic
  typing of function signatures. Data models via SQLModel (persistence) and
  pydantic (API input/output validation).
- **Extension (TypeScript)**: strict `tsc --noEmit` (no implicit `any`). Functional React
  components with hooks, no classes. Explicitly typed props.
- **DRY / SRP**: one file = one responsibility. Extract as soon as a function or component
  handles more than one concern (e.g. separating yt-dlp progress parsing from database writes).
- **Early returns**: prefer early returns over nesting, maximum 3 levels
  of indentation in a function.
- **No dead code**: remove commented-out code, unused imports, dead branches.
- **No `TODO` without a beads issue**: `TODO(ez-dl-xxx): description` only, never a standalone
  `TODO` without a reference.

## Naming

- Identifiers and API in **English**, code comments in **French**.
- Booleans prefixed with `is`/`has`/`can`/`should` (`is_downloading`, `hasCookies`, `canRetry`,
  `shouldConvert`).
- Python files: `snake_case.py`. TypeScript/React files: `PascalCase.tsx` for
  components, `camelCase.ts` for everything else.
- API routes: HTTP verbs + plural resource names (`/api/jobs`, `/api/rules`), never a
  verb in the path.

## File size

- **Warning at 400 lines**: a signal that splitting should be considered.
- **Mandatory split beyond 500 lines**: extract into modules/subcomponents before
  continuing to add code to a file that exceeds this threshold.
- Colocation: a React component lives with its styles and tests in the same folder; a
  server service (`core/ytdlp.py`) lives with its test (`tests/test_ytdlp.py` or equivalent).

## Tests

- **Server**: `pytest` + `pytest-asyncio` + `httpx` (FastAPI test client). Expected
  coverage:
  - **Formats**: parsing formats returned by yt-dlp, best format selection.
  - **Capabilities**: detection of available ffmpeg encoders, preset filtering.
  - **Queue**: scheduling, concurrency limit (`EZDL_MAX_CONCURRENT_JOBS`), state
    transitions.
  - **Auth**: rejection without `Authorization`, rejection with wrong password, constant-time
    comparison, public access to `/api/health`.
  - **Paths**: rejection of paths outside `EZDL_DOWNLOAD_ROOTS`, `..` resolution, filename
    sanitization.
- **Extension**: `Vitest`. Expected coverage:
  - **Detection patterns**: recognition of `.m3u8`, `.mpd`, `.mp4`, `.webm`, `.m4s` URLs and
    video content-types.
  - **Learning correlation**: associating a selected DOM element with the tab's recent
    network requests.
- Run the tests before considering a task done: `uv run pytest` /
  `npm run test`.

## Commits

- **Conventional Commits** mandatory: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`,
  `perf:`, `style:`, `ci:`.
- Optional scope in parentheses when useful: `feat(server): add /api/rules route`.
- One commit = one coherent logical change. Do not mix a change to `docs/fr/` and
  `docs/en/` with unrelated code.
- **Never commit or push without explicit user approval.**

## Bilingual docs

- `docs/fr/` is **canonical**: it is the reference version, written first.
- `docs/en/` is a faithful **mirror**: same file structure, same level of detail, content
  translated (not summarized).
- Any change to `docs/fr/` must be reflected in `docs/en/` **in the same commit**.
- `README.md` (root) follows the same FR/EN rule if the project has two variants.
- The `doc-maintainer` agent (see `CLAUDE.md`) is responsible for FR↔EN synchronization.

## Security

See the dedicated block in `CLAUDE.md` for the full list. Reminder of the points checked in
code review (`security-reviewer`):

- No `subprocess.run(..., shell=True)`: argument list only, including for yt-dlp and
  ffmpeg.
- Any destination path supplied by the user is resolved (`Path.resolve()`) and verified
  to be a descendant of an `EZDL_DOWNLOAD_ROOTS` root before any write or listing
  operation (`/api/folders`).
- Filenames sanitized: removal of `/`, `\`, `..`, control characters, length
  limited.
- Cookies written to a temporary file with `0600` permissions, deleted after the job, never
  logged.
- Password comparison done in **constant-time** (`secrets.compare_digest`).
- Every API input validated by a pydantic model — no raw dict manipulated without validation.
- No real personal information in the repo (see `CLAUDE.md` § Public project).
