# Security Policy

ez-dl runs a server that executes external binaries (`yt-dlp`, `ffmpeg`), accepts URLs and cookies
from the extension, and writes files to disk based on user-provided paths and filenames. Security
issues in that path — authentication bypass, path traversal outside `EZDL_DOWNLOAD_ROOTS`, command
injection, arbitrary file write/read, or anything that lets an unauthenticated request act on the
server — are treated as high priority.

## Supported versions

This project does not yet have a formal release/support matrix. Until it does, the only supported
version is the latest commit on the `main` branch. Please make sure you can reproduce an issue
against `main` before reporting it.

## Reporting a vulnerability

**Please do not open a public GitHub Issue for a vulnerability that could be actively
exploited.** Instead, use GitHub's private vulnerability reporting for this repository
(the **Security** tab → **Report a vulnerability**), which lets you share full details, including
proof-of-concept code, without disclosing them publicly.

If you're not able to use that flow, opening a GitHub Issue with a **minimal, non-exploitable**
description (just enough to identify the class of issue, no working exploit) and a request for a
private follow-up channel is an acceptable fallback.

When reporting, please include as much of the following as you can:

- The affected component (server endpoint, extension permission/flow, Docker setup, etc.)
- Steps to reproduce, or a proof of concept
- The potential impact as you understand it
- Any suggested fix or mitigation, if you have one

## Container privilege model

The published Docker image starts its entrypoint as `root` and immediately drops to the
application user with `gosu` before executing anything else. Nothing in the application — the
FastAPI server, and the `yt-dlp` and `ffmpeg` subprocesses it spawns — ever runs as `root`; you can
confirm this with `grep Uid /proc/1/status` inside a running container.

The root window exists for one reason: `PUID`/`PGID` are runtime settings, so the entrypoint has to
make `EZDL_DATA_DIR`, `EZDL_TEMP_DIR` and the `EZDL_DOWNLOAD_ROOTS` directories writable by the
uid/gid that owns your volumes. Only `root` can do that, and without it the published image would
only work on hosts whose user happens to be uid 1000. `PUID=0` is refused outright.

Two consequences worth knowing:

- The `HEALTHCHECK` and a `docker exec` without `--user` run as `root`. The healthcheck only
  performs a local HTTP request and writes nothing.
- Setting `user:` in Compose (or `docker run --user`) makes the entrypoint detect that it is not
  `root`, skip every ownership change, and exec the command directly. That gives you a container
  that is non-root end to end, at the cost of having to provide already-writable volumes yourself.

Ownership changes are deliberately narrow: `EZDL_DATA_DIR`, `EZDL_TEMP_DIR` and the Deno cache are
adjusted recursively because ez-dl owns them entirely, while each download root is only adjusted at
its top level, and only when it is not already writable — a media library shared with other
applications is never rewritten.

## What's out of scope

- **DRM circumvention.** Reports asking for, or demonstrating, bypasses of Widevine, PlayReady,
  FairPlay, or similar content-protection systems are out of scope and will not be treated as
  security issues to fix — see [README.md > Legal & scope](README.md#legal--scope). ez-dl does
  not implement or accept this functionality under any circumstances.
- Vulnerabilities that require an attacker to already know your `EZDL_PASSWORD` and have direct
  network access to a server you've chosen to expose without following the
  [Security recommendations](README.md#security) (e.g. no reverse proxy/TLS on a
  publicly-reachable host) are lower priority, but still worth reporting if there's a way to
  reduce the blast radius.

## Response

There's no formal SLA at this stage of the project, but reports are read and triaged as soon as
possible, and credit will be given (if you want it) once a fix ships. Coordinated disclosure is
appreciated: please give us a reasonable window to ship a fix before disclosing publicly.
