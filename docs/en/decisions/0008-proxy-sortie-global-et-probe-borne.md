# ADR 0008 — Global outbound proxy and bounded probe

- **Status**: accepted
- **Date**: 2026-10-19
- **Complements**: [ADR 0001 — Hybrid detection](0001-stack-fastapi-wxt.md) (yt-dlp probe side)

## Context

Three concrete problems on the deployed server, plus one functional need:

- **Memory saturation.** A listing page (search results, channel, playlist, feed) sent to
  `/api/probe` made yt-dlp extract *every* entry in RAM (`-J` without `--flat-playlist`). A few
  simultaneous probes were enough to bring the container down through OOM. Probes piled up because
  the client gave up long before the server did (popup reopened, button clicked again).
- **Orphaned processes.** The standalone yt-dlp binary is a PyInstaller executable: a parent
  bootloader and a child interpreter. Killing only the bootloader leaves the child extracting,
  holding its memory, then blocking on a pipe nobody reads any more.
- **Geo-restricted content.** Users need yt-dlp to exit through a VPN, without giving network
  access to the rest of the server.

## Decision

### Bounded probe through a single playlist rule

The probe and the download carry `--no-playlist --playlist-items N` (`N` = 1 by default);
`update()` and `version()` extract no content and do not need it. Without an explicit rank, the
probe adds `--flat-playlist`: a listing page is then recognised without extracting its entries,
and answers **422** ("open a video"). With a `playlist_items` rank
(integer 1–50), entry `N` is extracted in full, formats included.

`playlist_items` is accepted by `GET /api/probe` (query), `POST /api/probe` (body) and
`POST /api/jobs`. It lets the probe target the right video of a multi-video tweet.

### Probe coordination

`server/app/core/probe_cache.py`: at most 2 probes run at the same time (semaphore), identical
in-flight calls are coalesced (key = URL + rank + SHA-256 digest of the authentication context, so
no secret stays in clear text), successful results are cached for 60 s, the task is cancelled when
its last requester leaves (a client that disconnects gets `499`), and the process group is killed
beyond `EZDL_PROBE_TIMEOUT_SECONDS` (25 s by default).

### Killing the process group

`server/app/core/process.py`: yt-dlp and ffmpeg are started with `start_new_session=True`. Stopping
signals the **group** (`os.killpg`) with a guard `pgid == pid`, so the server's own group is never
signalled: SIGTERM, then SIGKILL after 5 s, then the process is reaped.

### Global outbound proxy

`EZDL_PROXY` (`http`, `https`, `socks5`, `socks5h`) is passed to yt-dlp as `--proxy`, for the probe,
the download and the auto-update. The setting is global to the instance, not per job:

- an invalid value prevents startup, without copying the value into the error; validation is
  strict (no whitespace or control character, valid port if present);
- the URL is never logged in full (scheme and host only);
- URL credentials (`user:pass@`) are masked (`***`) in error messages reported from yt-dlp and
  ffmpeg (`redact_credentials` in `server/app/core/process.py`);
- `GET /api/capabilities` only exposes `proxy_enabled`, never the URL.

ffmpeg is not concerned by the proxy: it makes no network request.

### Container guard rails

`docker-compose.yml`: `init: true` (tini as PID 1, reaps orphans), `pids_limit: 512`,
`mem_limit: ${EZDL_MEM_LIMIT:-4g}`.

## Consequences

- A listing page no longer costs a full extraction: it answers 422 straight away.
- Only yt-dlp traffic leaves through the proxy. The API, SSE and file writes stay direct.
- A VPN IP is often a hosting-provider IP, which YouTube more often subjects to its anti-bot check.
  The proxy therefore does not guarantee access to every piece of content.
- The proxy is unique per instance: every job leaves through the same address. A multi-user
  deployment cannot pick an exit per user.
- The 60 s cache is keyed on the URL. It can serve a stale result, within the lifetime of CDN
  signed URLs.
- The coordinator constants (2 probes, 60 s, 64 entries) and the SIGTERM→SIGKILL grace period (5 s)
  are code constants, **not** `EZDL_*` variables.
- `EZDL_PROXY` may contain credentials: it is treated as a secret (never logged in full, never
  exposed by the API).

## Alternatives rejected

- **Per-job proxy**: needs an API field and credentials that travel through the client (the
  extension). Too much exposure for the current need; remains a possible evolution.
- **Container network inside the VPN** (`network_mode: service:<vpn>`): sends the whole server out
  through the tunnel, API included, and forces the VPN container to publish the API port. Two
  coupled lifecycles and a wider surface. Rejected.
- **Bounding the probe on the extension side only**: necessary but not sufficient. The popup, the
  overlay button and API clients all trigger the same probes; the bound must live on the server.
