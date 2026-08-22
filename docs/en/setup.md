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
| `EZDL_PUBLIC_URL` | *(empty)* | Public base URL of the server, as a browser sees it (`https://ez-dl.example.com`). Needed **only behind a reverse proxy**: `/extension/update.xml` must publish an absolute `.crx` download URL there, and the address uvicorn sees is not the client's. Empty = derived from the request. Must start with `http://` or `https://`, otherwise the server refuses to start |
| `EZDL_TEMP_DIR` | `/tmp/ez-dl` | Partial files before the final move. Must **persist** for resuming an interrupted download to be worth anything (see below) |
| `EZDL_MAX_CONCURRENT_JOBS` | `2` | Number of queue workers |
| `EZDL_YTDLP_UPDATE_INTERVAL_HOURS` | `24` | yt-dlp auto-update period (`0` = disabled) |
| `EZDL_YTDLP_BINARY` | `yt-dlp` | Path to the yt-dlp binary |
| `EZDL_FFMPEG_BINARY` | `ffmpeg` | Path to the ffmpeg binary |
| `EZDL_CORS_ORIGINS` | `chrome-extension://*` | Allowed origins |
| `EZDL_LOG_LEVEL` | `info` | Log level |
| `EZDL_AUTO_UPDATE` | `false` | Read by `deploy/auto-update.sh` **on the host** (local-build path) — see [Automatic server updates](#automatic-server-updates) |
| `EZDL_AUTO_UPDATE_INTERVAL_SECONDS` | `300` | Registry poll period for the `watchtower` service (`autoupdate` profile) |
| `EZDL_IMAGE` | `ghcr.io/corentingc/ez-dl:latest` | Image run by the compose file — override to pin a sha or use a fork |

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

### Recommended path — archive published by the server

1. Open `http://<server>:8000/extension` (e.g. `http://nas.local:8000/extension`). The page is
   **public** (no password required, unlike the rest of the API) and displays the extension
   version, the server version, and the archive's **SHA-256 fingerprint**.
2. Download the zip with the download button.
3. Extract the archive into a folder that **will stay in place**: Chrome reads it again on every
   start, and deleting the folder disables the extension.
4. Open `chrome://extensions` and enable **Developer mode** (top right corner).
5. **Load unpacked** → select the extracted folder.
6. Open the extension's options page to configure the server URL and password
   (next step).

To update later: replace the folder's contents with those of the new archive, then reload the
extension from `chrome://extensions`.

> **Drag-and-dropping the `.crx` does not work.** Chrome rejects any `.crx` dropped onto
> `chrome://extensions` that is not signed by the Chrome Web Store, with "Package is invalid:
> CRX_REQUIRED_PROOF_MISSING" — Developer mode changes nothing. No self-hosted server can produce
> that signature. The `.crx` served by `/extension/download` remains useful for one thing only:
> installation driven by **system policy**, the only path where Chrome verifies an extension from
> outside the Web Store without requiring a publisher proof — see
> [Path without Developer mode](#path-without-developer-mode--system-policy-installation).

> **Security recommendation.** On an untrusted network (Internet, public WiFi), prefer accessing
> the server via **HTTPS** (reverse proxy in front of the server, cloudflared tunnel, etc.)
> rather than HTTP. An attacker in interceptor position can substitute the archive and cause the
> installation of an extension with broad permissions (`<all_urls>`, `cookies`, `webRequest`).
> Comparing the downloaded file's SHA-256 with the one shown on the page detects that
> substitution — provided the page itself is served over HTTPS.

Public routes exposed by the server:

| Route | Content |
|---|---|
| `GET /extension` | HTML installation page (versions, zip download button, steps, SHA-256 fingerprint, secondary block about the signed package) |
| `GET /extension/zip` | Extension zip, the artifact of the recommended path ("Load unpacked") |
| `GET /extension/download` | Signed `.crx` archive (`ez-dl-extension-<version>.crx`, media type `application/x-chrome-extension`), meant for system-policy installation — **not installable by drag and drop** |
| `GET /extension/update.xml` | Chrome update manifest (Omaha protocol): signed package identifier, published version, absolute `.crx` URL. Target of the system policy. `503` when the published version is unknown |
| `GET /extension/version` | JSON `{available, version, filename, size, extension_id, sha256}`, consumed by the extension to signal that a new version is available. `extension_id` and `sha256` are `null` when signing failed |

> **Known limitation.** Outside the Chrome Web Store, Chrome offers no "one-click" install from a
> web page. The path above therefore requires Developer mode and loading unpacked; the only other
> option is the system policy described just below.

If the server image was built **without** the `extension` context (for example a `docker build` run
by hand inside `server/`), the build still succeeds but distribution is unavailable: the page
explains it, both download routes return `404`, and `GET /extension/version` returns `200` with
`{"available": false, "version": null, ...}` (never `404`).

### Path without Developer mode — system-policy installation

This is the **only** way to install the extension without Developer mode, and the only one that
brings automatic updates. An extension deployed by policy is verified by Chrome with
`VerifierFormat::CRX3`, without a publisher proof: the `.crx` signed by the server is accepted. In
exchange, it needs administrator rights on every machine, and the policy must be at **mandatory**
level — a "recommended" policy, or one written in the user domain, brings the
`CRX_REQUIRED_PROOF_MISSING` error back.

Two values to collect first, from `http://<server>:8000/extension` or via `GET /extension/version`:

- the signed package's **identifier** (32 characters `a`-`p`, derived from the server's key);
- the **update manifest** URL: `https://<server>/extension/update.xml`.

The install page shows the concatenated value to paste into the policy directly, in the form
`<identifier>;<manifest url>`. The policy points at the **manifest**, never at the `.crx`.

> **HTTPS required.** Chrome requires an `https` URL for the `.crx` download on this path. Behind a
> reverse proxy, set `EZDL_PUBLIC_URL` (see the variables table): without it the server derives the
> URL from the request and publishes the internal address, which the client machine cannot reach.

**Windows** — registry, `HKEY_LOCAL_MACHINE` hive (a GPO produces the same thing):

```
HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist
  "1" = "<identifier>;https://ez-dl.example.com/extension/update.xml"
```

**Linux** — a JSON file in `/etc/opt/chrome/policies/managed/` (`/etc/chromium/policies/managed/`
for Chromium), owned by `root` and not writable by others:

```json
{
  "ExtensionInstallForcelist": [
    "<identifier>;https://ez-dl.example.com/extension/update.xml"
  ]
}
```

**macOS** — a configuration profile deployed by MDM, writing to
`/Library/Managed Preferences/com.google.Chrome.plist`:

```xml
<key>ExtensionInstallForcelist</key>
<array>
  <string>&lt;identifier&gt;;https://ez-dl.example.com/extension/update.xml</string>
</array>
```

> A `defaults write com.google.Chrome …` run from the user account is **not enough**: it writes a
> user-domain preference, which Chrome treats as "recommended". Only a managed (MDM) profile
> produces a *mandatory* policy.

Then check in `chrome://policy` that the policy is loaded and in the **OK** state, and force a check
from `chrome://extensions`. Chrome re-reads the manifest periodically (a few hours): after a
`docker compose up -d --build` with a bumped version, the update lands on its own.

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

## Automatic server updates

Two paths, mutually exclusive
(see [ADR 0005](decisions/0005-auto-update-image-ghcr-watchtower.md)).

### Recommended path — integrated into the Docker stack (GHCR image + watchtower)

CI publishes the production image to `ghcr.io/corentingc/ez-dl:latest` on every green push to
`main`. The compose file ships a **watchtower** service (profile `autoupdate`) that polls the
registry (default: every 5 min, `EZDL_AUTO_UPDATE_INTERVAL_SECONDS`) and recreates the `server`
container identically when a new image exists. Nothing to install on the host:

```bash
# In the .env next to docker-compose.yml:
echo 'COMPOSE_PROFILES=autoupdate' >> .env      # append to already-active profiles if any
docker compose up -d
```

Watchtower is confined to the stack (`WATCHTOWER_LABEL_ENABLE` + `ez-dl` scope): the host's other
containers are never touched. Only for deployments running the **published image**
(`docker compose up -d`, no `--build`) — it is built with `PUID`/`PGID` 1000; a host with a
different UID or the GPU variant stays on the path below.

### Alternative path — local build + host cron

For hosts building the image locally, `deploy/auto-update.sh` (run from cron or a systemd timer)
fetches the tracked branch and, when origin has moved, does `git pull --ff-only` then rebuilds
**only the `server` service**, before checking `/api/health`. Safeguards: inactive without
`EZDL_AUTO_UPDATE=true` in the clone's `.env`, refuses a clone with local changes, never merges
or resets, holds an anti-overlap lock.

```bash
# 1. Enable the flag in the deployed clone's .env
echo 'EZDL_AUTO_UPDATE=true' >> .env

# 2. Schedule the check (here: every 15 minutes)
crontab -e
# */15 * * * * /path/to/clone/deploy/auto-update.sh >> ~/.local/state/ez-dl-update.log 2>&1
```

The script is silent when there is nothing to do: the log only contains updates and errors.

## Verification

```bash
curl http://localhost:8000/api/health
# {"status":"ok","version":"0.1.0","ytdlp_version":"2026.xx.xx","ffmpeg_available":true}
```

A `status: "ok"` with `ffmpeg_available: true` confirms that the server, yt-dlp, and ffmpeg are
correctly installed and accessible. This route is public (no `Authorization` header
required), which is convenient for a Docker healthcheck.
