# Setup

## Prerequisites

| Tool | Version | Role |
|---|---|---|
| Python | ≥ 3.13 | Server |
| [uv](https://docs.astral.sh/uv/) | latest stable | Python package/venv manager |
| Node.js | ≥ 20 (LTS) | Extension build (developer path only) |
| npm | bundled with Node.js | Extension package manager (developer path only) |
| Docker + Docker Compose | latest stable | Server deployment |
| `yt-dlp` | **standalone** binary (not the pip version) | Video download — see [MEMORY.md](../../MEMORY.md) for why |
| `ffmpeg` / `ffprobe` | latest stable | Stream conversion and probing |
| `deno` | latest stable | JS runtime required by yt-dlp for YouTube (shipped in the Docker image) |
| Google Chrome or Chromium | latest stable | Loading the MV3 extension |

## Local dev installation

### Server

```bash
cd server
uv sync                 # installs dependencies (including the dev group: pytest, ruff, httpx)
cp ../.env.example .env # (optional) set EZDL_PASSWORD for a stable password
uv run uvicorn app.main:app --reload --port 8000
```

### Extension

```bash
cd extension
npm install
npm run dev              # opens Chrome with the extension loaded in watch mode (WXT)
```

## Environment variables

All prefixed `EZDL_`. To be set in `server/.env` (never committed — see `.env.example` at the
root for the template with generic values).

| Variable | Default | Role |
|---|---|---|
| `EZDL_PASSWORD` | *(recommended)* | API access password. If missing or empty, the server generates a strong password (32 URL-safe characters) each startup, displays it in the console with a 5-second pause, then starts. Set it in `.env` for a stable password. |
| `EZDL_HOST` | `0.0.0.0` | uvicorn bind |
| `EZDL_PORT` | `8000` | HTTP port |
| `EZDL_DOWNLOAD_ROOTS` | `Downloads=/data/downloads` | Allowed roots, format `Label=/path` separated by `,`. Only these paths (and their subfolders) are writable. **Important**: no root may contain (or be contained in) `EZDL_DATA_DIR` or `EZDL_EXTENSION_DIST_DIR`. The server refuses to start if this is violated. |
| `EZDL_DATA_DIR` | `/config` | SQLite + persistent state (including the `.crx` signing key — see [Republishing the extension](#republishing-the-extension)) |
| `EZDL_EXTENSION_DIST_DIR` | `/app/extension-dist` | Folder holding the packaged extension published by the server (zip + `extension-version.txt`, whose contents must be a strictly numeric version — `1`, `1.2`, `1.2.3` or `1.2.3.4` —, any other value being ignored), produced when the Docker image is built. If the folder is empty, the `/extension/*` routes stay reachable but no download is available. The folder is owned by `root` in the image: the server, running non-root, only reads from it. |
| `EZDL_TEMP_DIR` | `/tmp/ez-dl` | Partial files before the final move. Must **persist** for resuming an interrupted download to be worth anything (see below) |
| `EZDL_MAX_CONCURRENT_JOBS` | `2` | Number of queue workers |
| `EZDL_YTDLP_UPDATE_INTERVAL_HOURS` | `24` | yt-dlp auto-update period (`0` = disabled) |
| `EZDL_YTDLP_BINARY` | `yt-dlp` | Path to the yt-dlp binary |
| `EZDL_FFMPEG_BINARY` | `ffmpeg` | Path to the ffmpeg binary |
| `EZDL_CORS_ORIGINS` | `chrome-extension://*` | Allowed origins |
| `EZDL_LOG_LEVEL` | `info` | Log level |

Generic example of `EZDL_DOWNLOAD_ROOTS` for a NAS: `Movies=/mnt/media/movies,Series=/mnt/media/tv`.

## Docker Compose

```bash
docker compose up -d --build
```

Points of attention in `docker-compose.yml` (see [GPU modules](decisions/0001-stack-fastapi-wxt.md)
for context):

- Mount the `EZDL_DOWNLOAD_ROOTS` roots as volumes, with the **same paths on the container
  side as in the environment variable**. A root that is declared but not mounted (or not writable
  by the container user) raises a `WARNING` at startup, and any job targeting it is rejected with
  a `400` before the download starts.
- Mount a persistent volume on `EZDL_DATA_DIR` (SQLite + state).
- `EZDL_TEMP_DIR` is mounted on the **named volume `ezdl-temp`**, not on a tmpfs: a download cut
  short by a restart then picks up from its partial file instead of being redone from scratch. On
  every startup the server purges the work directories of jobs that are no longer resumable. To
  go back to RAM (no disk writes, but no resume and a size capped by RAM), replace the
  `- ezdl-temp:/tmp/ez-dl` line with a `tmpfs: [ "/tmp/ez-dl" ]` section.
- The `/tmp/ez-dl/cookies` subdirectory stays mounted as a **tmpfs on top of** that volume: the
  cookies sent by the extension never touch the disk, unlike partial files. Do not remove that
  mount.
- Optional GPU block (NVIDIA/QuickSync/VAAPI) only if hardware presets are used —
  see [modules/conversion.md](modules/conversion.md).
- Load `EZDL_PASSWORD` and the other variables via an `.env` file (never committed) or
  Docker secrets, never hardcoded in `docker-compose.yml`.

## Loading the extension in Chrome

The server publishes the packaged extension itself: installing ez-dl on a new machine requires
neither cloning the repository nor installing Node.

### Recommended path — `.crx` published by the server

1. Open `http://<server>:8000/extension` (e.g. `http://nas.local:8000/extension`). The page is
   **public** (no password required, unlike the rest of the API) and displays the extension
   version and the server version. It also displays the **expected Chrome ID** and the **SHA-256
   fingerprint** of the file.
2. Download the `.crx` file with the download button.
3. Open `chrome://extensions` and enable **Developer mode** (top right corner).
4. **Drag and drop** the downloaded `.crx` onto the `chrome://extensions` page.
5. **Verification [recommended on untrusted networks]** — once the extension is installed, open
   `chrome://extensions` and verify that the **ID displayed** under the extension name matches the
   expected ID shown in step 1. Chrome allows no automatic cryptographic validation for sideloaded
   extensions: this is the only way to detect artifact substitution in transit (attacker in
   interceptor position on an untrusted network).
6. Open the extension's options page to configure the server URL and password
   (next step).

> **Security recommendation.** On an untrusted network (Internet, public WiFi), prefer accessing
> the server via **HTTPS** (reverse proxy in front of the server, cloudflared tunnel, etc.)
> rather than HTTP. An attacker in interceptor position can substitute the `.crx` archive and
> cause the installation of an extension with broad permissions (`<all_urls>`, `cookies`,
> `webRequest`). Verifying the ID shown in `chrome://extensions` makes it possible to detect
> this substitution.

Public routes exposed by the server:

| Route | Content |
|---|---|
| `GET /extension` | HTML installation page (versions, download button, install steps, expected identifier and SHA-256 fingerprint, secondary link to the zip) |
| `GET /extension/download` | Signed `.crx` archive (`ez-dl-extension-<version>.crx`, media type `application/x-chrome-extension`) |
| `GET /extension/zip` | Raw zip, for the "Load unpacked" path |
| `GET /extension/version` | JSON `{available, version, filename, size, extension_id, sha256}`, consumed by the extension to signal that a new version is available. `extension_id` and `sha256` are `null` when signing failed |

> **Known limitation.** Chrome allows no "one-click" install from a web page outside the Chrome
> Web Store: Developer mode remains mandatory. Silent installation and update through system
> policy (`update.xml` + `ExtensionInstallSources` / `ExtensionInstallForcelist`) are planned for
> later (issue `ez-dl-upc`) and are not available yet.

If the server image was built **without** the `extension` context (for example a `docker build` run
by hand inside `server/`), the build still succeeds but distribution is unavailable: the page
explains it, both download routes return `404`, and `GET /extension/version` returns `200` with
`{"available": false, "version": null, ...}` (never `404`).

### Developer path — unpacked extension

To work on the extension itself:

1. `cd extension && npm run build` (or leave `npm run dev` running).
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top right corner).
4. **Load unpacked** → select `extension/.output/chrome-mv3` (build) or
   the folder generated by `npm run dev`.
5. Open the extension's options page to configure the server URL and password
   (next step).

The zip published by the server (`GET /extension/zip`) serves the same path: unzip it, then load
the resulting folder the same way.

## Republishing the extension

After a change to the client:

1. Bump the `version` field in `extension/package.json`.
2. Rebuild and restart:

```bash
docker compose up -d --build   # or: make publish-extension
```

The server image receives the extension through the **BuildKit named context `extension`**,
declared in `docker-compose.yml` (`build.additional_contexts: { extension: ./extension }`): a
`node:22-slim` stage runs `npm ci` then `npm run zip`, and the resulting zip is copied into
`EZDL_EXTENSION_DIST_DIR` of the final image. No Node remains in the final image.

Two Makefile targets frame the operation: `make zip-extension` (produce the zip alone) and
`make publish-extension` (rebuild + restart the server).

> **`./data` must be persistent.** The `.crx` is signed at runtime by the server with an RSA 2048
> key generated on first need in `EZDL_DATA_DIR/extension-signing-key.pem` (permissions `0600`),
> the result being cached in `EZDL_DATA_DIR/extension-cache/`. The extension's Chrome ID **derives
> from that key**: losing it changes the ID, and Chrome then sees a different extension instead of
> an update. Keep the `./data:/config` volume persistent and back it up.

## Server + password configuration

1. (Optional) Set `EZDL_PASSWORD` on the server side (`.env` file or the container's environment
   variable) for a stable password. If you don't set it, the server will generate a password
   each startup — see [ADR 0003](decisions/0003-auth-mot-de-passe.md).
2. Start the server. If no password is set, it displays an isolated banner in the console with
   a generated password (32 URL-safe characters) and pauses for 5 seconds to allow you to copy
   it. You can retrieve this password from the startup logs.
3. On the extension's options page: the server URL defaults to `http://localhost:8000` — nothing
   to type if the server runs on the same machine, otherwise replace it (e.g.
   `http://nas.local:8000`). Enter the password (either the one you set in `.env` or the one
   generated and displayed at startup), then use the **Test connection** button.
4. The password is stored on the extension side in `chrome.storage.local` and sent as
   `Authorization: Bearer <password>` with every request.

## Verification

```bash
curl http://localhost:8000/api/health
# {"status":"ok","version":"0.1.0","ytdlp_version":"2026.xx.xx","ffmpeg_available":true}
```

A `status: "ok"` with `ffmpeg_available: true` confirms that the server, yt-dlp, and ffmpeg are
correctly installed and accessible. This route is public (no `Authorization` header
required), which is convenient for a Docker healthcheck.
