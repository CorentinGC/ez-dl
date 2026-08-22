# Architecture

## Overview

ez-dl is made up of two applications that communicate over HTTP/SSE on the local network:

- **`extension/`** — Chrome MV3 extension (WXT + React + TypeScript). Detects videos present
  on the active page, offers a selection interface (quality, folder, preset) and drives the
  server via its API.
- **`server/`** — FastAPI server (Python 3.13, SQLModel/SQLite) packaged in Docker. Receives
  download requests, orchestrates `yt-dlp` and `ffmpeg`, manages a job queue and
  exposes their progress in real time via SSE.

Both components are independent: the server has no dependency on Chrome, the extension has
no dependency on Docker. A single server can be shared by several extensions/browsers
on the local network.

## Flow diagram

```
┌─────────────────────┐        HTTP (Bearer)        ┌──────────────────────────────────────┐
│   Extension (MV3)    │ ───────────────────────────▶ │              FastAPI Server           │
│                       │                              │                                        │
│ - background.ts       │  POST /api/jobs               │  ┌──────────┐   ┌────────────────┐   │
│   (network sniffer,    │◀────────────────────────────  │  │  Queue   │──▶│  Worker (yt-dlp) │   │
│    correlation)        │  GET  /api/jobs/events (SSE)   │  │ (asyncio) │   │  downloads       │   │
│ - popup (React)        │                              │  └──────────┘   └────────┬────────┘   │
│ - content.ts           │                              │                            │            │
│   (DOM picker)         │                              │                            ▼            │
└──────────┬─────────────┘                              │                   ┌────────────────┐   │
           │ sniffing chrome.webRequest                  │                   │ ffmpeg (preset) │   │
           ▼                                              │                   └────────┬────────┘   │
   web pages (video)                                     │                            ▼            │
                                                            │                 final move            │
                                                            │           (EZDL_DOWNLOAD_ROOTS, NAS…)  │
                                                            └──────────────────────────────────────┘
```

Detailed flow for a download:

1. The user opens the popup; the extension calls `GET/POST /api/probe` with the URL of the
   active tab (and cookies if the option is enabled) and merges the result with the streams
   sniffed on the `background.ts` side.
2. The user chooses quality, destination folder, conversion preset, optionally a
   filename, then confirms → `POST /api/jobs`.
3. The server creates a job in the database (`status: queued`), places it in the asyncio queue.
4. A queue worker picks it up as soon as a slot is free
   (`EZDL_MAX_CONCURRENT_JOBS`): `status: probing` → `downloading` (yt-dlp, progress parsed and
   persisted) → `converting` (ffmpeg, if a preset other than `copy` is chosen) → `moving`
   (moving the temporary file to the final folder, verified against
   `EZDL_DOWNLOAD_ROOTS`) → `done`.
5. On every state change, the updated job is published on `GET /api/jobs/events` (SSE,
   `job` event); the popup or an open options page updates in real time.
6. If an error occurs at any step → `status: error`, message in `error`. The user
   can cancel a job in progress (`DELETE /api/jobs/{id}` → `status: canceled`) or delete it from
   the history once finished.
7. A download can be paused (`POST /api/jobs/{id}/pause` → `status: paused`) then resumed
   (`POST /api/jobs/{id}/resume`); a server shutdown pauses running jobs the same way. Resuming
   restarts from the partial file kept in `EZDL_TEMP_DIR/<job_id>` — see
   [Resume and retry](#resume-and-retry).

## Folder structure

### `server/`

```
server/
├── pyproject.toml         # dependencies (uv), Python >=3.13
├── app/
│   ├── main.py             # FastAPI app creation, router mounting, lifespan (startup/shutdown)
│   ├── config.py           # pydantic-settings Settings, EZDL_ prefix
│   ├── security.py          # FastAPI authentication dependency (Bearer, constant-time)
│   ├── models.py            # SQLModel models: Job, SiteRule
│   ├── schemas.py           # pydantic request/response schemas for the routes
│   ├── db.py                 # SQLite engine, session, table init
│   ├── api/
│   │   ├── health.py         # GET /api/health
│   │   ├── capabilities.py   # GET /api/capabilities
│   │   ├── probe.py          # GET/POST /api/probe
│   │   ├── folders.py        # GET/POST /api/folders (secure navigation + creation)
│   │   ├── jobs.py           # /api/jobs CRUD, pause/resume, GET /api/jobs/events (SSE)
│   │   ├── rules.py          # GET/POST/DELETE /api/rules
│   │   └── extension.py      # public /extension* routes (page, .crx, zip, version)
│   ├── templates/
│   │   └── extension.html    # install page served by GET /extension
│   └── core/
│       ├── ytdlp.py           # yt-dlp subprocess wrapper (probe, download, progress)
│       ├── ffmpeg.py          # ffmpeg subprocess wrapper, encoder detection, presets
│       ├── queue.py           # asyncio queue, workers, pipeline, SSE pub/sub
│       ├── workdir.py         # a job's work directory: produced file, free name, move
│       ├── paths.py           # path resolution/validation against EZDL_DOWNLOAD_ROOTS
│       ├── crx.py             # CRX3 packing: persisted RSA 2048 key, signature, cache
│       └── cookies.py         # writing the temporary cookies file (0600), cleanup
└── tests/                    # pytest: auth, config, cookies, ffmpeg, paths, queue, ytdlp, crx,
                              # jobs, folders and extension routes
```

### `extension/`

```
extension/
├── wxt.config.ts            # WXT config, modules (@wxt-dev/module-react)
├── entrypoints/
│   ├── background.ts         # MV3 service worker: network sniffer, per-tab state (storage.session)
│   ├── content.ts             # content script: DOM picker for learning mode
│   └── popup/
│       ├── App.tsx             # popup root component
│       ├── main.tsx
│       └── components/         # video list, quality/folder/preset selector, job tracking (SSE)
├── entrypoints/options/       # options page (registered servers, favorite folders…)
├── src/components/            # shared popup/options components, including the folder browser
│                              # (navigation, folder creation, remaining disk space)
├── src/hooks/                 # shared React hooks (server profiles, folder browser state…)
├── lib/
│   ├── api.ts                  # HTTP client (fetch + Bearer), typed against the API contract
│   ├── folders.ts              # pure navigation logic across the allowed roots
│   ├── profiles.ts             # server profiles: migration, CRUD, active profile
│   ├── storage.ts              # chrome.storage.local / chrome.storage.session wrappers
│   ├── sniffer.ts              # network detection patterns (extensions, content-types)
│   └── correlation.ts          # DOM picker ↔ network request correlation (learning mode)
└── tests/                     # Vitest: detection patterns, correlation
```

#### Server profiles

Several ez-dl servers can be registered (local machine, NAS, remote server), only one is
**active** at a time. Everything lives in the single `settings` key of `chrome.storage.local`:

```
{ version: 2, profiles: [{ id, name, serverUrl, password, favoriteFolders, … }], activeProfileId }
```

Each profile carries a complete configuration: favorite folders, default preset and cookie
sending follow the server, since they depend on its roots and its ffmpeg.

The former format — a flat object with no `version`, a single server — is migrated **lazily** on
the first read, then persisted once and for all. The migration is deterministic (fixed `default`
identifier, never a random UUID): popup, options page and service worker may migrate at the same
time, they all write exactly the same object.

The rest of the code only ever sees one server: `getSettings()`/`saveSettings()` are a **flattened
view** of the active profile, which leaves the API client, the sniffer and the popup views
unchanged. Two mechanisms complete that contract:

- `watchSettingsRoot()` (on `storage.local.onChanged`) resynchronises a popup and an options page
  that are open in parallel;
- the service worker clears its learned-rules cache when `hasActiveServerChanged()` is true — that
  is, when the **effective** URL or password changes, not on every profile rename or favorite
  addition.

In the popup, switching happens through a compact selector in the header (hidden while a single
profile exists); full management — creation by duplication, rename, deletion — lives in the
options page. That page edits the **selected** profile, which is not necessarily the active one:
a new server can be configured end to end without the popup switching over to it.

#### Picking the destination folder

`src/components/FolderBrowser.tsx` (state in `src/hooks/useFolderBrowser.ts`) is shared between the
popup and the options page; only its presentation differs. In the popup it is mounted inside a
**full-screen overlay** (`entrypoints/popup/components/FolderBrowserOverlay.tsx`): picking a
destination requires seeing many entries, which the width of a card did not allow. Since Chrome
sizes the popup window from the **document flow**, a `position: fixed` overlay does not grow it on
its own: `body:has(.folder-overlay-backdrop) { min-height: … }` takes care of that. In the options
page, the very same panel stays rendered inline.

Navigation goes through a clickable **breadcrumb** (`buildBreadcrumb`, `src/lib/folders.ts`), which
replaces the former "‹ Toutes les racines" and ".." entries buried in the list. It is built
client-side from `roots[]` and `current.path`, and its intermediate labels are derived from the
**path**: for a nested folder the server returns the *root*'s label in `current.label`, not the
open folder's. No segment ever points above an allowed root — the server would answer `400`.

Files are never shown: `/api/folders` returns the entries, `listSubfolders` keeps only `is_dir` —
a download destination is always a directory.

The server **hides hidden and system entries** from the listing (`.` prefix, and NAS/OS metadata
folders: `@eaDir`, `#recycle`, `#snapshot`, `@Recycle`, `$RECYCLE.BIN`,
`System Volume Information`, `lost+found`, `Thumbs.db` — `is_system_entry`, `core/paths.py`), and
**rejects any path traversing a system name** as a destination (`400`), including through a stale
client favorite or `POST /api/folders`. Real-world case: a Synology root whose only visible
subfolder was `@eaDir` — the user had nothing else to pick and the download landed in a folder DSM
hides. Dot-folders remain valid explicit destinations: they are hidden from the browser, not
forbidden.

#### Extension publishing by the server

The server distributes the packaged extension, so that installing ez-dl on a new machine needs
neither a clone of the repository nor Node: open `http://<server>:8000/extension`, download the zip,
unpack it, then "Load unpacked extension" in `chrome://extensions` (developer mode enabled). The
full chain:

```
Docker build (node:22-slim stage: npm ci && npm run zip)
   └─▶ /app/extension-dist/{ez-dl-extension.zip, extension-version.txt}   (EZDL_EXTENSION_DIST_DIR)
          └─▶ .crx signed at runtime (RSA 2048 key persisted in EZDL_DATA_DIR,
              .crx cached in EZDL_DATA_DIR/extension-cache/)
                 └─▶ GET /extension (page) · /extension/download (.crx) · /extension/zip · /extension/version
```

The zip is produced at build time by a dedicated Node stage, fed by the named BuildKit context
`extension` (`build.additional_contexts` in docker-compose); **no Node remains in the final image**.
An image built without that context stays valid: only distribution is unavailable (explanatory
page, `404` on the downloads). The version file (`extension-version.txt`) must contain a strictly
numeric version (`1`, `1.2`, `1.2.3`, or `1.2.3.4`); any other form is rejected, and the server
falls back to the generic name `ez-dl-extension.crx`.

Signing, on the other hand, happens at runtime: the `EZDL_DATA_DIR/extension-signing-key.pem` key
(0600) is generated on first need and **must be persisted** (`./data:/config` volume) — Chrome's
extension identifier derives from it, and a lost key produces a new identifier, hence a *different*
extension in Chrome's eyes rather than an update. The signed `.crx` is cached in
`EZDL_DATA_DIR/extension-cache/`, indexed on the zip's SHA-256 rather than on its timestamp:
a rebuild that changes the zip is republished even when its mtime has not moved (reproducible
build, restored backup). `GET /extension/version` returns two
additional fields: `extension_id` (expected Chrome identifier, 32 characters a-p) and `sha256`
(fingerprint of the served `.crx`); both are `null` on signature failure. The install page displays
the served zip's SHA-256 and the signed package's identifier, to let the user verify the file's
integrity.

The `.crx` **cannot be installed by drag and drop**: on that path Chrome requires a Chrome Web Store
publisher proof and rejects the package with `CRX_REQUIRED_PROOF_MISSING`. It stays published
because it is the artifact of a **system-policy** installation, the only path where Chrome verifies
an extension from outside the Web Store without that proof. That is also why the stable identifier
derived from the key still matters: it only applies to that path, an extension loaded unpacked
receiving an identifier derived from its folder path. See
[ADR 0004](decisions/0004-distribution-extension-crx.md).

The `EZDL_EXTENSION_DIST_DIR` folder (`/app/extension-dist` in the image) is owned by `root` so
that the server, running as a non-root user, can only read it. Rationale: the server signs the zip
it finds in that folder; rewriting that zip would produce a `.crx` carrying the same Chrome
identifier, hence a silent update of the installed extension that keeps already-granted permissions.
For the same reason the server refuses to start when an `EZDL_DOWNLOAD_ROOTS` root contains — or is
contained in — `EZDL_DATA_DIR` or `EZDL_EXTENSION_DIST_DIR`.

To republish after a client change: bump `version` in `extension/package.json`, then
`docker compose up -d --build` (or `make publish-extension`).

Known limitation: Chrome allows no "one-click" installation from a web page outside the Chrome Web
Store, so developer mode remains required. Silent installation and update through system policy
(`update.xml`, `ExtensionInstallSources`/`ExtensionInstallForcelist`) are planned for later, not
available yet.

#### Update banner

On open, the popup queries `GET /extension/version` on the active profile's server (public route,
outside `/api`) and compares the published version with the installed manifest's
(`isNewerVersion`, `src/lib/version.ts`: numeric segments, no full semver — Chrome only allows 1
to 4 integers). A banner appears only if the published version is **strictly** greater; it opens
the server's install page in a tab.

Every other case is **silent**: missing route (`404` on an older server), image built without the
artifact (`available: false`), unreachable server, unparseable version. The extension works in all
of them, so there is nothing to report to the user.

## API contract

The control routes are prefixed with `/api`. Authentication required (`Authorization: Bearer
<EZDL_PASSWORD>`) on all of them except `GET /api/health`. See
[conventions.md](conventions.md#security) for the constant-time comparison and
[ADR 0003](decisions/0003-auth-mot-de-passe.md) for the choice of this auth scheme.

The four extension-distribution routes live **outside `/api`** and are **public**: they are opened
from a browser's address bar, which cannot attach an `Authorization` header to a link or to a
download.

```
GET    /api/health          -> {status:"ok", version, ytdlp_version, ffmpeg_available}  [public]
GET    /api/capabilities    -> {encoders:[{id,name,hwaccel,codec}], presets:[{id,label,description,container,video_codec,args_preview}]}
GET    /api/probe?url=...   -> {url,title,uploader,duration,thumbnail,extractor,
                                formats:[{format_id,ext,height,width,fps,vcodec,acodec,filesize,tbr,label,has_audio,has_video}],
                                best_format_id, suggested_filename}
       (POST /api/probe additionally accepts {cookies, headers, referer} for authenticated pages)
GET    /api/folders?path=   -> {roots:[{label,path,is_available,free_bytes,total_bytes}],
                                current:{path,label,free_bytes,total_bytes}, entries:[{name,path,is_dir}], parent}
       (entries excludes hidden `.` and system entries — @eaDir, #recycle…; browsing into one -> 400)
POST   /api/folders         -> body {parent, name} -> 201 {name,path,is_dir}  (409 if already there)
POST   /api/jobs            -> body {url, format_id?, folder, filename?, preset_id?, cookies?, headers?, referer?, title?}
                            -> {job_id, status}
GET    /api/jobs            -> [job]
GET    /api/jobs/{id}       -> job
POST   /api/jobs/{id}/pause  -> job (409 outside `queued`/`downloading`); keeps the partial file
POST   /api/jobs/{id}/resume -> optional body {cookies?, headers?, referer?} -> `queued` job
                                (409 outside `paused`/`error`/`canceled`, 400 if root unavailable)
DELETE /api/jobs/{id}       -> cancels / deletes from history (+ discards the partial file)
GET    /api/jobs/events     -> SSE, event `job` with the job serialized on every update
GET    /api/rules           -> [site_rule]
POST   /api/rules           -> body {domain, url_pattern, label?, notes?, source:"manual"|"learned"} -> site_rule
DELETE /api/rules/{id}      -> deletes

GET    /extension           -> HTML install page: extension + server versions, zip download
                               button, 4 steps, archive SHA-256, secondary block about the
                               signed package                                                 [public]
GET    /extension/zip       -> extension zip, artifact of the recommended route ("Load unpacked
                               extension"); explicit 404 if the image does not contain the
                               artifact                                                       [public]
GET    /extension/download  -> signed .crx, media type application/x-chrome-extension, named
                               ez-dl-extension-<version>.crx, meant for system-policy
                               installation — NOT installable by drag and drop; explicit 404
                               if missing, 503 if signing fails                                [public]
GET    /extension/version   -> {available, version, filename, size, extension_id, sha256}; 200
                               {"available": false, "version": null, "extension_id": null,
                               "sha256": null, …} if no artifact or signature failure
                               (never 404) — consumed by the popup                            [public]
```

## Data model

### `Job`

| Field | Type | Description |
|---|---|---|
| `id` | str (uuid) | Unique job identifier |
| `url` | str | Source URL (page or direct stream) |
| `title` | str? | Title retrieved by probe or provided by the user |
| `filename` | str | Final filename, sanitized |
| `folder` | str | Destination path, resolved under an `EZDL_DOWNLOAD_ROOTS` root |
| `status` | enum | See lifecycle below |
| `progress` | float | 0.0–100.0 |
| `speed` | float? | Current download speed, in bytes/s |
| `eta` | int? | Estimated time remaining, in seconds |
| `size` | int? | Size in bytes; total size known once the download has started, actual file size once `done` |
| `error` | str? | Error message if `status == error`; reason for the interruption when a job was `paused` by a server restart |
| `preset_id` | str? | Chosen ffmpeg conversion preset (`copy` by default) |
| `format_id` | str? | Chosen yt-dlp format |
| `created_at` / `updated_at` | datetime | Timestamps |

### `SiteRule`

| Field | Type | Description |
|---|---|---|
| `id` | str (uuid) | Unique identifier |
| `domain` | str | Target domain (e.g. `example.com`) |
| `url_pattern` | str | Simple glob/regex applied to sniffed network URLs |
| `label` | str? | Human-readable label |
| `notes` | str? | Free-form notes |
| `source` | enum | `manual` \| `learned` |
| `created_at` | datetime | Timestamp |

`SiteRule` entries let the extension's sniffer recognize a video stream on a domain where
automatic detection fails, without requiring a new learning session on every visit (see
[modules/apprentissage.md](modules/apprentissage.md)).

## Job lifecycle

```
queued ──▶ probing ──▶ downloading ──▶ converting ──▶ moving ──▶ done
   │           │             │              │            │
   └───────────┴─────────────┴──────────────┴────────────┴──▶ error
                                                          
   (queued | probing | downloading | converting | moving) ──▶ canceled

   (queued | downloading) ──▶ paused        (pause, or server restart)
   (paused | error | canceled) ──▶ queued   (resume / retry)
```

- **`queued`**: job created, waiting for a free worker slot.
- **`probing`**: yt-dlp queries the source to confirm available formats.
- **`downloading`**: download in progress, `progress`/`speed`/`eta` updated periodically.
  Each job works inside its own `EZDL_TEMP_DIR/<job_id>` directory: yt-dlp's output name is not
  predictable (it enforces the extension of the container actually produced, which a merge/remux
  can change), so the server picks up whichever file was actually written.
- **`converting`**: ffmpeg re-encodes according to the chosen `preset_id` (step skipped if
  `preset_id == "copy"` or absent).
- **`moving`**: atomic move of the temporary file (`EZDL_TEMP_DIR`) to `folder`, after
  path revalidation.
- **`done`**: completed successfully.
- **`error`**: failure at any step, `error` populated.
- **`canceled`**: cancellation requested by the user (`DELETE /api/jobs/{id}`) while the job
  was still active.
- **`paused`**: deliberately suspended (`POST /api/jobs/{id}/pause`, SIGTERM on yt-dlp) or stopped
  by a server shutdown — in that case `error` carries the reason for the interruption without the
  job being a failure. A paused job is always resumable.

### Resume and retry

`POST /api/jobs/{id}/resume` puts the job back to `queued`. The `EZDL_TEMP_DIR/<job_id>` work
directory is **kept** as long as the job stays resumable (`paused`, `error`) and is only discarded
on `done`, `canceled` or job deletion: the `.part` file it holds is what lets `yt-dlp --continue`
restart from the byte it reached instead of from the beginning. An already complete file is skipped
by yt-dlp, so a failure during conversion or the move does not trigger a second download.

Two operational consequences:

- resuming after a server restart only saves bandwidth if `EZDL_TEMP_DIR` **survives** the restart
  (named volume, not tmpfs — see [setup.md](setup.md));
- the server **never** persists a job's cookies. To resume a download on an authenticated page
  after a restart, the client re-supplies them in the resume request body.

On the extension side, the popup's Jobs view exposes those transitions: **Pause** on a `queued` or
`downloading` job, **Resume** on a `paused` one, **Retry** on an `error` or `canceled` one. When the
"send cookies" option is on, resuming re-reads the browser cookies for `job.url` and attaches them
to the request — without that re-read, yt-dlp would start over anonymously.

### Cancelling and deleting

`DELETE /api/jobs/{id}` carries **two** actions depending on the job's state:

- still-active job (`queued`, `probing`, `downloading`, `converting`, `moving`) → the download is
  **stopped** and the job moves to `canceled`, staying in the history (it can be retried). The
  signal goes to the **process group**, not just the spawned process: the standalone yt-dlp binary
  is a PyInstaller executable (bootloader + child), and killing the bootloader alone left the child
  downloading to completion;
- finished job (`done`, `error`, `canceled`, `paused`) → it is **removed** from the history and its
  work directory purged.

The popup mirrors that switch exactly: a single button reads "Cancel" while the job is active and
"Delete" afterwards (`src/lib/jobStatus.ts`, mirroring the server's status sets). It therefore
does not drop the row on cancellation — the SSE update is what flips it to "Canceled".

**The downloaded file is never deleted by default**: `DELETE` only touches the history row and the
temporary work directory. To also delete the file dropped at the destination, the client passes
`?delete_file=true`.

That parameter is only accepted **on a `done` job** (`409` otherwise): it is the only status for
which the server itself wrote that exact path. On the others, `folder`/`filename` is merely an
*intended* destination — a failed job can carry the same name as a neighbouring successful one, and
deleting it would destroy that job's file. The targeted path goes back through
`resolve_destination` before the `unlink` (allowed root, mounted root, symlinks resolved), and only
an `is_file()` is removed: never a directory. An already-missing file is not an error — deletion is
idempotent. Conversely, a failed deletion (`400` unavailable root, `500` permissions) **keeps the
job in the list**, so the only reference to the file left on disk is not lost.

In the popup, "Delete" on a finished job opens a confirmation dialog
(`components/ConfirmDialog.tsx`) that separates the two gestures explicitly: "Remove from list"
and "Remove and delete the file". The other statuses have no file on disk, so they are removed
without confirmation.

Every state transition triggers an SSE publication on `/api/jobs/events`.
