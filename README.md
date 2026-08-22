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

- [What it is](#what-it-is)
- [Legal & scope](#legal--scope)
- [Quick install](#quick-install)
- [Manual install](#manual-install)
- [Documentation](#documentation)

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

The server is a FastAPI application driving `yt-dlp` and `ffmpeg` through a job queue, writing
only into the folders you allow it to write into. Full picture:
[`docs/en/architecture.md`](docs/en/architecture.md).

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

## Quick install

You need Docker with the Compose plugin, and Chrome (or Chromium). Nothing else — no clone, no
Python, no Node.js.

### 1. Server — one command

```bash
curl -fsSL https://github.com/CorentinGC/ez-dl/releases/latest/download/install.sh | sh
```

The script downloads the standalone compose file from the latest release, **verifies its SHA-256**,
generates a strong password into a `0600` `.env`, starts the stack and waits for `/api/health` to
answer. It asks no questions and never uses `sudo`. It prints the URL and the password once at the
end — keep them.

Defaults: `~/ez-dl` as the install folder, port `8000`, downloads in `~/ez-dl/downloads`, automatic
updates on. Everything is overridable through environment variables, and `--dry-run` shows what
would happen without writing anything:

```bash
curl -fsSL https://github.com/CorentinGC/ez-dl/releases/latest/download/install.sh \
  | EZDL_PORT=9000 EZDL_DOWNLOADS_DIR=/mnt/media/downloads sh
```

The variables go **after** the pipe: set before `curl`, they would configure `curl`, not the
script.

Piping a script from the network into a shell deserves a read first: `curl -fsSL <url> | less`.
It is a frozen release asset, not a file from `main`. Variables, update mode and the manual
equivalent: [`docs/en/setup.md`](docs/en/setup.md#one-command-installation-easy-path).

### 2. Extension in Chrome

The server publishes the packaged extension itself.

1. Open `http://<server>:8000/extension` (e.g. `http://nas.local:8000/extension`) — that page is
   public — and download the `.zip`.
2. Unpack it into a folder **that will stay in place**: Chrome reads it again on every start.
3. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and pick that
   folder.

Chrome allows no one-click install from outside the Chrome Web Store (publication is on the
[roadmap](ROADMAP.md)). To skip Developer mode and get automatic updates, the server also
publishes a signed `.crx` and its update manifest for a **system-policy** install — per-OS
instructions in
[`docs/en/setup.md`](docs/en/setup.md#path-without-developer-mode--system-policy-installation).

### 3. Connect the two

Open the extension **Options** page, set the **server URL** (default `http://localhost:8000`) and
the **password** printed by the installer, then click **Test connection**. Open any page with a
video and click the ez-dl icon.

## Manual install

Same result as the one-liner, step by step — for anyone who would rather not pipe a script into a
shell.

```bash
mkdir -p ~/ez-dl && cd ~/ez-dl
curl -fsSLO https://github.com/CorentinGC/ez-dl/releases/latest/download/docker-compose.yml
curl -fsSLO https://github.com/CorentinGC/ez-dl/releases/latest/download/docker-compose.yml.sha256
sha256sum -c docker-compose.yml.sha256      # macOS: shasum -a 256 -c

mkdir -p downloads
umask 077 && cat > .env <<EOF
EZDL_PASSWORD=$(openssl rand -base64 24)
EZDL_PORT=8000
EZDL_DOWNLOADS_DIR=$PWD/downloads
PUID=$(id -u)
PGID=$(id -g)
COMPOSE_PROFILES=autoupdate
EOF

docker compose up -d
```

`PUID`/`PGID` are the identity the server runs as: set them to the owner of your media folders and
downloaded files land with the right owner, no rebuild involved.

To add destinations, mount them and list them in `EZDL_DOWNLOAD_ROOTS` — only those roots (and
their subfolders) are writable by the server:

```yaml
    environment:
      EZDL_DOWNLOAD_ROOTS: "Movies=/data/movies,Downloads=/data/downloads"
    volumes:
      - /mnt/media/movies:/data/movies
      - /mnt/media/downloads:/data/downloads
```

Then install the extension as in [step 2 above](#2-extension-in-chrome).

**Building from the repository** — for development, or for the NVENC image variant (GPU
passthrough alone is not enough: Debian's ffmpeg ships without NVENC):

```bash
git clone https://github.com/CorentinGC/ez-dl.git && cd ez-dl
cp .env.example .env      # set EZDL_PASSWORD
docker compose up -d --build
```

## Documentation

| | |
|---|---|
| [Setup](docs/en/setup.md) | Install, environment variables, `PUID`/`PGID`, reverse proxy, automatic updates |
| [FAQ](docs/en/faq.md) | Site not detected, wrong file owner, `latest` vs `edge`, NVENC |
| [Architecture](docs/en/architecture.md) | Components, API contract, data model, job lifecycle |
| [Modules](docs/en/modules/) | Detection, conversion, learning mode, branding |
| [Decisions (ADR)](docs/en/decisions/) | Why this stack, this license, this auth, these release channels |
| [Roadmap](ROADMAP.md) · [Changelog](CHANGELOG.md) | What is planned · what shipped |
| [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Code of conduct](CODE_OF_CONDUCT.md) | How to help, how to report a vulnerability |

French documentation: [`docs/fr/`](docs/fr/) — the canonical version, `docs/en/` mirrors it.

## License

[PolyForm Noncommercial License 1.0.0](LICENSE). Noncommercial use is free. **Any commercial use
requires a separate, paid commercial license** — open a GitHub Issue or contact the maintainer at
`<contact@example.com>`.

PolyForm Noncommercial is a source-available license, not an OSI-approved open source license: you
can read, use noncommercially, modify and redistribute the code, but commercial use is restricted
unless separately licensed.
