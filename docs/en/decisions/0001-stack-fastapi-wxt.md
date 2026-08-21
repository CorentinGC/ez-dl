# ADR 0001 — FastAPI + WXT stack and hybrid detection

- **Status**: accepted
- **Date**: 2026-08-21

## Context

ez-dl needs two building blocks:

1. A server that drives `yt-dlp` and `ffmpeg` to download and convert videos, exposing an
   HTTP API consumed by a browser extension, and simple to deploy (Docker, personal
   NAS).
2. A Chrome extension able to detect videos present on a web page, including
   streamed feeds (HLS/DASH) loaded dynamically by the page's player.

Two structuring questions arise: which language/framework for the server, and how to
reliably detect videos on the extension side.

## Decision

### Server: Python 3.13 + FastAPI + SQLModel, managed with uv

`yt-dlp` is a Python tool. Running it as a subprocess from a Python server (instead
of a Node.js server that would invoke an external binary) allows:

- staying within a single ecosystem for the service that orchestrates yt-dlp/ffmpeg;
- using FastAPI for a typed API (pydantic), natively asynchronous (useful for the job
  queue and SSE via `sse-starlette`);
- SQLModel for a single data model serving both as a pydantic schema (API validation) and
  as a SQLite table (persistence), without duplicating definitions;
- `uv` as package/environment manager: fast, deterministic lockfile, a single tool
  for venv + dependencies + execution (`uv run`).

### Extension: WXT 0.21.4 + React + TypeScript, managed with npm

WXT provides a standard MV3 structure (`background`/`content`/`popup`/`options`
entrypoints), hot-reload in dev, and multi-browser builds with no manual webpack/Vite
configuration. React + TypeScript for the popup and options UI, consistent with the
usual front-end ecosystem. npm is used rather than pnpm because pnpm is not installed
on the reference development machine — no benefit in introducing an additional tool
for this project.

### Hybrid detection (yt-dlp probe + network sniffing + learned rules)

No single method covers all cases:

- **yt-dlp probe** (`GET /api/probe`) works very well for sites natively supported by
  yt-dlp (thousands of extractors), but fails on unrecognized sites or feeds generated
  dynamically without a stable URL.
- **Network sniffing** (`chrome.webRequest` on the extension side) detects requests to
  video streams (`.m3u8`, `.mpd`, `.mp4`, `.webm`, `.m4s`, video content-types) as the
  page loads them, which covers sites not supported by yt-dlp — but it can miss a video
  (late loading, obfuscated requests) or surface noise (preloads, ads).
- **Learned per-site rules** (`site_rule`, learning mode) capitalize on an
  assisted manual detection session to automatically recognize the same pattern on
  subsequent visits, without going back through raw sniffing every time.

The combination of the three gives broad coverage without depending on a single heuristic.

## Alternatives considered

- **Node.js server + yt-dlp CLI wrapper**: discarded — adds an extra language to
  orchestrate a tool that is already Python, with no net benefit (no need for heavy
  real-time WebSocket handling that Node would manage better than asyncio/SSE).
- **Extension based solely on yt-dlp probe** (no sniffing): discarded — too many sites
  outside the yt-dlp extractor catalog would remain undetected, which is the primary
  use case for learning mode.
- **Network sniffing only (without yt-dlp)**: discarded — would lose the richness of
  metadata (title, multiple formats, best format) that yt-dlp extracts for supported
  sites.
- **pnpm for the extension**: discarded for now, for lack of installation on the
  reference machine; re-evaluable if the project grows (multiple workspaces).

## Consequences

- Two dependency ecosystems to maintain (`uv`/Python, `npm`/Node), with two separate
  lint/test pipelines — documented in `CLAUDE.md` and `docs/fr/conventions.md`.
- Detection quality depends on how up to date the yt-dlp extractors are (hence the
  auto-update, see the [detection](../modules/detection.md) module) and on the accuracy
  of the sniffing patterns (`docs/fr/modules/detection.md`).
- Learning mode (implicit ADR in [modules/apprentissage.md](../modules/apprentissage.md))
  becomes a pillar of the product rather than a secondary feature, since it
  compensates for the structural limitations of the other two methods.
