**English** | [Français](README.fr.md)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo-light.svg" alt="ez-dl" width="198">
  </picture>
</p>

# ez-dl

**Self-hosted video downloads, one click from your browser.**

![License: PolyForm Noncommercial](https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue)
![Python 3.13](https://img.shields.io/badge/python-3.13-blue)
![Manifest V3](https://img.shields.io/badge/chrome-manifest%20v3-yellow)

ez-dl pairs a Chrome extension that spots videos on the page you're looking at with a
self-hosted server that downloads them straight to your own storage (NAS, home server,
whatever you point it at). No third-party cloud, no upload of your links anywhere else.

---

## Table of contents

- [What it is](#what-it-is)
- [Legal & scope](#legal--scope)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Security](#security)
- [Development](#development)
- [FAQ](#faq)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Licensing](#licensing)

## What it is

- **Automatic detection** — the extension combines [yt-dlp](https://github.com/yt-dlp/yt-dlp)
  extraction with live network sniffing (`chrome.webRequest`) to find playable video streams on
  almost any page, not just the handful of sites yt-dlp lists explicitly.
- **Quality picker** — every detected format is listed with resolution, codec and size; the best
  available quality is preselected, but you can always pick something else.
- **Rename on the fly** — the filename field is prefilled from the video title (falling back to
  the page title) and sanitized automatically; edit it before the download starts.
- **Favorite destinations** — save your usual folders and jump straight to them, or browse the
  server's allowed roots from the popup.
- **Optional conversion** — remux with `copy` (no re-encode) by default, or transcode with
  hardware acceleration (NVIDIA NVENC, Intel QuickSync, VAAPI) or CPU encoders (x264/x265) when
  the server detects them.
- **Learning mode** — when nothing is auto-detected, a picker lets you click the video on the
  page; ez-dl correlates that with recent network traffic and can remember the pattern for that
  site next time.

## Legal & scope

ez-dl is a tool for downloading video content **you already have the right to download** — your
own uploads, content under a permissive license, material a site's terms of service allow you to
save, and so on.

- **No DRM circumvention.** ez-dl does not implement, bundle, or accept contributions that defeat
  Widevine, PlayReady, FairPlay, or any other content-protection scheme. DRM-protected streams are
  explicitly out of scope.
- **Your responsibility.** You are responsible for complying with the terms of service of any
  site you use ez-dl on, and with the copyright law that applies to you. This project does not
  grant you any rights to content you don't already have.
- ez-dl is infrastructure for downloading and organizing files — it has no opinion on what you
  download, but it will not help you break protection measures to get it.

## Architecture

```text
┌────────────────────────┐      HTTP(S) + Bearer token      ┌─────────────────────────────┐
│  Browser + Extension    │ ───────────────────────────────▶│            Server            │
│  (MV3, detect + sniff)  │◀─────────────────────────────── │  FastAPI + yt-dlp + ffmpeg   │
│                          │        SSE job progress          │  queue · convert · rename    │
└────────────────────────┘                                   └───────────────┬─────────────┘
                                                                               │ writes into
                                                                               ▼
                                                                 ┌───────────────────────────┐
                                                                 │   NAS / disk folders        │
                                                                 │  (EZDL_DOWNLOAD_ROOTS)       │
                                                                 └───────────────────────────┘
```

## Quick start

### 1. Run the server with Docker Compose

Create a `.env` file next to your `docker-compose.yml` (see [`.env.example`](.env.example) for the
full list of variables), then:

```yaml
# docker-compose.yml
services:
  ez-dl-server:
    build: ./server
    container_name: ez-dl-server
    restart: unless-stopped
    ports:
      - "8000:8000"
    environment:
      EZDL_PASSWORD: ${EZDL_PASSWORD}
      EZDL_DOWNLOAD_ROOTS: "Movies=/data/movies,Downloads=/data/downloads"
    volumes:
      - ./config:/config
      - /mnt/media/movies:/data/movies
      - /mnt/media/downloads:/data/downloads
    # Uncomment to enable NVIDIA GPU-accelerated encoding (NVENC presets):
    # deploy:
    #   resources:
    #     reservations:
    #       devices:
    #         - driver: nvidia
    #           count: 1
    #           capabilities: [gpu]
```

```bash
docker compose up -d
```

**NVIDIA NVENC:** GPU passthrough alone isn't enough — the default server image ships the
Debian-packaged ffmpeg, which doesn't include NVENC (Debian repos exclude the required non-free
dependencies). Use the bundled [`docker-compose.gpu.yml`](docker-compose.gpu.yml) override, which
also rebuilds the image with a static NVENC-enabled ffmpeg binary (amd64 only):

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
```

See [`docs/en/modules/conversion.md`](docs/en/modules/conversion.md#nvenc-support-in-the-docker-image)
for details.

### 2. Install the extension

The server publishes the packaged extension itself — no clone, no Node.js needed on the machine
you install it from.

1. Open `http://<server>:8000/extension` (e.g. `http://nas.local:8000/extension`) and download the
   `.zip`. That page is public, like the download routes it links to.
2. Unpack it into a folder **that will stay in place** — Chrome reads it again on every start.
3. Open `chrome://extensions` and enable **Developer mode**.
4. Click **Load unpacked** and pick the unpacked folder.

Chrome allows no one-click install from outside the Chrome Web Store, and refuses any signed
package that does not come from the Store — dropping a `.crx` onto `chrome://extensions` fails
with "Package is invalid: CRX_REQUIRED_PROOF_MISSING", Developer mode or not. The `.crx` served by
`/extension/download` is meant for a **system-policy** installation, the only path Chrome accepts
outside the Store.

For a fleet — or just to skip Developer mode and get automatic updates — force-install the `.crx`
through system policy: the server publishes the matching update manifest on
`/extension/update.xml`. Per-OS instructions in
[`docs/en/setup.md`](docs/en/setup.md#path-without-developer-mode--system-policy-installation).

To publish a new build after changing the extension, bump `version` in `extension/package.json`
and rerun `docker compose up -d --build` (or `make publish-extension`), then replace the unpacked
folder's contents and reload the extension. The `.crx` is signed at runtime with a key stored in
`EZDL_DATA_DIR/extension-signing-key.pem` — keep that directory on a volume, since Chrome derives
the extension ID from it for the policy path and a lost key means a new ID instead of an update.

**Developer alternative** — build it locally and load it unpacked:

```bash
cd extension
npm install
npm run build
```

Then in Chrome: open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**,
and select `extension/.output/chrome-mv3`.

### 3. Configure

Open the extension's **Options** page and set:

- **Server URL** — defaults to `http://localhost:8000`; change it only for a remote server
  (e.g. `http://nas.local:8000`)
- **Password** — the value you set for `EZDL_PASSWORD`

Use **Test connection** to confirm the extension can reach `/api/health`. You're ready — open any
page with a video and click the ez-dl icon.

## Configuration

All server settings are environment variables prefixed `EZDL_`. See [`.env.example`](.env.example)
for a ready-to-copy file.

| Variable                            | Default                  | Role                                                                                              |
| ------------------------------------ | ------------------------- | -------------------------------------------------------------------------------------------------- |
| `EZDL_PASSWORD`                      | *(recommended)* | API access password. If missing or empty, the server generates a strong password (32 URL-safe characters) each startup, displays it in the console with a 5-second pause, then starts. Set it in `.env` for a stable password. |
| `EZDL_HOST`                          | `0.0.0.0`                 | uvicorn bind address                                                                                |
| `EZDL_PORT`                          | `8000`                    | HTTP port                                                                                           |
| `EZDL_DOWNLOAD_ROOTS`                | `Downloads=/data/downloads` | Allowed destination roots, format `Label=/path` separated by `,`. Only these paths (and their subfolders) are writable. |
| `EZDL_DATA_DIR`                      | `/config`                 | SQLite database + app state                                                                        |
| `EZDL_TEMP_DIR`                      | `/tmp/ez-dl`               | Scratch space for partial files before the final move                                              |
| `EZDL_EXTENSION_DIST_DIR`            | `/app/extension-dist`     | Packaged extension artifacts served by `/extension`. Built into the image; if absent, the install page explains it and the download routes return `404`. |
| `EZDL_MAX_CONCURRENT_JOBS`           | `2`                       | Queue worker count                                                                                   |
| `EZDL_YTDLP_UPDATE_INTERVAL_HOURS`   | `24`                      | Period of the yt-dlp self-update task (`0` disables it)                                             |
| `EZDL_YTDLP_BINARY`                  | `yt-dlp`                  | Path to the yt-dlp binary                                                                            |
| `EZDL_FFMPEG_BINARY`                 | `ffmpeg`                  | Path to the ffmpeg binary                                                                            |
| `EZDL_CORS_ORIGINS`                  | `chrome-extension://*`    | Allowed CORS origins                                                                                 |
| `EZDL_LOG_LEVEL`                     | `info`                    | Log verbosity                                                                                        |

**`EZDL_DOWNLOAD_ROOTS` format:** a comma-separated list of `Label=/absolute/path` pairs. Each
label becomes a folder root the extension can browse and download into; any path outside these
roots (including via `..` traversal) is rejected. Example:

```
EZDL_DOWNLOAD_ROOTS=Movies=/mnt/media/movies,Shows=/mnt/media/shows,Downloads=/mnt/media/downloads
```

## Security

- **Authentication is always required.** If `EZDL_PASSWORD` is not set, the server generates a strong password (32 characters) each startup, displays it in an isolated console banner with a 5-second pause, then starts normally — retrieve this password from the startup logs. There is no "no auth" mode. For a stable password, set `EZDL_PASSWORD` in `.env`. The extension sends it as `Authorization: Bearer <EZDL_PASSWORD>` on every request except `/api/health`.
- **Don't expose the server directly to the internet.** If you need remote access, put a
  reverse proxy with TLS in front of it. Minimal examples:

  Caddy:

  ```caddyfile
  dl.example.com {
      reverse_proxy 127.0.0.1:8000
  }
  ```

  nginx:

  ```nginx
  server {
      listen 443 ssl;
      server_name dl.example.com;
      ssl_certificate     /etc/ssl/certs/dl.example.com.pem;
      ssl_certificate_key /etc/ssl/private/dl.example.com.key;
      location / { proxy_pass http://127.0.0.1:8000; }
  }
  ```

- **Destination paths are always resolved and validated** against `EZDL_DOWNLOAD_ROOTS` server-side;
  filenames are sanitized; cookies you opt to send are written to a `0600` temp file and deleted
  after the job completes.

### Extension permissions

| Permission                | Why it's needed                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| `webRequest`                | Sniff outgoing requests (`.m3u8`, `.mpd`, `.mp4`, …) to catch video streams yt-dlp alone would miss. |
| `storage`                   | Save the server URL, password, favorite folders and default preset locally in `chrome.storage.local`. |
| `tabs`                      | Know which tab is active, correlate sniffed requests with the right tab, update the per-tab badge. |
| `cookies`                   | Optionally read cookies for the current site to pass to yt-dlp for content behind a login — only when you enable it. |
| `activeTab`                 | Let the popup act on the tab you currently have open.                                          |
| `scripting`                 | Inject the "help detect" picker into the page on demand, for learning mode.                     |
| `host_permissions: <all_urls>` | Detection has to work on any site you visit — ez-dl doesn't hardcode a site list.            |

## Development

**Prerequisites:** [uv](https://docs.astral.sh/uv/), Node.js + npm, `ffmpeg`/`ffprobe`, `yt-dlp`
(all reachable on `PATH`, or pointed to via `EZDL_FFMPEG_BINARY` / `EZDL_YTDLP_BINARY`).

```bash
# Server, with auto-reload (from server/)
uv run uvicorn app.main:app --reload

# Extension, dev build with hot reload (from extension/)
npm run dev

# Server tests (from server/)
uv run pytest

# Server lint (from server/)
uv run ruff check .

# Extension production build (from extension/)
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow, code style, and how to add a
conversion preset or a site detection rule.

## FAQ

**Site X isn't detected?**
Open the popup, click "Help detect", and click the video on the page. ez-dl correlates your click
with recent network traffic and can save a reusable rule for that site.

**Does it work with x.com / Twitter?**
Yes, via yt-dlp — enable cookie forwarding in the options if the content requires a logged-in
session.

**What about DRM-protected services (Netflix, etc.)?**
No, and it never will — see [Legal & scope](#legal--scope). That's explicitly out of scope.

**Why does it need a password?**
The API drives downloads and writes files to your disk. Without authentication, anyone who can
reach the server on your network could trigger downloads or fill up your storage.

## Roadmap

- [ ] Firefox support
- [ ] Pause / resume and queue reordering
- [ ] Built-in HTTPS helper for the reverse-proxy setup
- [ ] Mobile-friendly companion UI
- [ ] Apple VideoToolbox hardware encoding

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow, code style,
and how to add a preset or a site rule. Please also read the
[Code of Conduct](CODE_OF_CONDUCT.md) and, for vulnerabilities, [SECURITY.md](SECURITY.md).

## Licensing

This project is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). Noncommercial
use is free. **Any commercial use requires a separate, paid commercial license.** To obtain one,
please open a GitHub Issue in this repository, or contact the maintainer at
`<contact@example.com>`.

Note: PolyForm Noncommercial is a source-available license, not an OSI-approved open source
license — you can read, use for noncommercial purposes, modify, and redistribute the code, but
commercial use is restricted unless separately licensed.
