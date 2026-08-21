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

## Folder structure

### `server/`

```
server/
├── pyproject.toml         # dependencies (uv), Python >=3.13
├── app/
│   ├── main.py             # FastAPI app creation, router mounting, lifespan (startup/shutdown)
│   ├── config.py           # pydantic-settings Settings, EZDL_ prefix
│   ├── auth.py              # FastAPI authentication dependency (Bearer, constant-time)
│   ├── models.py            # SQLModel models: Job, SiteRule
│   ├── db.py                 # SQLite engine, session, table init
│   ├── routers/
│   │   ├── health.py         # GET /api/health
│   │   ├── capabilities.py   # GET /api/capabilities
│   │   ├── probe.py          # GET/POST /api/probe
│   │   ├── folders.py        # GET/POST /api/folders (secure navigation + creation)
│   │   ├── jobs.py           # POST/GET/DELETE /api/jobs, GET /api/jobs/events (SSE)
│   │   └── rules.py          # GET/POST/DELETE /api/rules
│   ├── services/
│   │   ├── ytdlp.py           # yt-dlp subprocess wrapper (probe, download, progress)
│   │   ├── ffmpeg.py          # ffmpeg subprocess wrapper, encoder detection, presets
│   │   ├── queue.py           # asyncio queue, concurrent workers
│   │   ├── paths.py           # path resolution/validation against EZDL_DOWNLOAD_ROOTS
│   │   └── cookies.py         # writing the temporary cookies file (0600), cleanup
│   └── events.py             # event bus for SSE (job pub/sub)
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
├── wxt.config.ts            # WXT config, modules (@wxt-dev/module-react)
├── entrypoints/
│   ├── background.ts         # MV3 service worker: network sniffer, per-tab state (storage.session)
│   ├── content.ts             # content script: DOM picker for learning mode
│   └── popup/
│       ├── App.tsx             # popup root component
│       ├── main.tsx
│       └── components/         # video list, quality/folder/preset selector, job tracking (SSE)
├── entrypoints/options/       # options page (server URL, password, favorite folders…)
├── src/components/            # shared popup/options components, including the folder browser
│                              # (navigation, folder creation, remaining disk space)
├── src/hooks/                 # shared React hooks (folder browser state…)
├── lib/
│   ├── api.ts                  # HTTP client (fetch + Bearer), typed against the API contract
│   ├── folders.ts              # pure navigation logic across the allowed roots
│   ├── storage.ts              # chrome.storage.local / chrome.storage.session wrappers
│   ├── sniffer.ts              # network detection patterns (extensions, content-types)
│   └── correlation.ts          # DOM picker ↔ network request correlation (learning mode)
└── tests/                     # Vitest: detection patterns, correlation
```

## API contract

All routes are prefixed with `/api`. Authentication required (`Authorization: Bearer
<EZDL_PASSWORD>`) on all routes except `GET /api/health`. See
[conventions.md](conventions.md#security) for the constant-time comparison and
[ADR 0003](decisions/0003-auth-mot-de-passe.md) for the choice of this auth scheme.

```
GET    /api/health          -> {status:"ok", version, ytdlp_version, ffmpeg_available}  [public]
GET    /api/capabilities    -> {encoders:[{id,name,hwaccel,codec}], presets:[{id,label,description,container,video_codec,args_preview}]}
GET    /api/probe?url=...   -> {url,title,uploader,duration,thumbnail,extractor,
                                formats:[{format_id,ext,height,width,fps,vcodec,acodec,filesize,tbr,label,has_audio,has_video}],
                                best_format_id, suggested_filename}
       (POST /api/probe additionally accepts {cookies, headers, referer} for authenticated pages)
GET    /api/folders?path=   -> {roots:[{label,path,is_available,free_bytes,total_bytes}],
                                current:{path,label,free_bytes,total_bytes}, entries:[{name,path,is_dir}], parent}
POST   /api/folders         -> body {parent, name} -> 201 {name,path,is_dir}  (409 if already there)
POST   /api/jobs            -> body {url, format_id?, folder, filename?, preset_id?, cookies?, headers?, referer?, title?}
                            -> {job_id, status}
GET    /api/jobs            -> [job]
GET    /api/jobs/{id}       -> job
DELETE /api/jobs/{id}       -> cancels / deletes from history
GET    /api/jobs/events     -> SSE, event `job` with the job serialized on every update
GET    /api/rules           -> [site_rule]
POST   /api/rules           -> body {domain, url_pattern, label?, notes?, source:"manual"|"learned"} -> site_rule
DELETE /api/rules/{id}      -> deletes
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
| `error` | str? | Error message if `status == error` |
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
- **`error`**: failure at any step, `error` populated, temporary resources cleaned up.
- **`canceled`**: cancellation requested by the user (`DELETE /api/jobs/{id}`) while the job
  was still active.

Every state transition triggers an SSE publication on `/api/jobs/events`.
