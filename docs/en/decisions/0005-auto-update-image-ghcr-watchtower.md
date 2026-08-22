# ADR 0005 — Server auto-update through a GHCR image + watchtower

- **Status**: accepted, amended
- **Date**: 2026-08-22
- **Amended on 2026-08-22** by
  [ADR 0006 — Versioning and release channels](0006-versionnement-et-canaux-de-publication.md),
  on three points: `latest` no longer follows every green commit on `main` but only semver git
  tags (`main` now feeds `edge` and `main-<sha>`); the image is published for amd64 **and**
  arm64; `PUID`/`PGID` became runtime settings, so hosts with a uid other than 1000 no longer
  need the local-build path. The rest of this decision stands.

## Context

The server runs self-hosted via `docker compose` on a personal host (NAS, home-lab). Keeping the
deployment current required manual steps (`git pull` + `docker compose up -d --build`) or a
host-side cron (`deploy/auto-update.sh`, ez-dl-z4q). The stated need: updates **integrated into
the Docker stack**, with nothing to install or schedule on the host.

A container cannot rebuild itself from the inside: "in-image" auto-update necessarily goes either
through a sidecar rebuilding from sources (Docker socket access **and** the git clone, costly
builds on the host), or through an image registry and a standard update agent.

## Decision

**CI publishes the image, watchtower pulls it**:

- The CI `publish` job builds the production image (extension embedded, same path as the `docker`
  validation job) and pushes it to **`ghcr.io/corentingc/ez-dl`** (`latest` + sha) on every push
  to `main` **whose lint, test and build jobs are green**. No secrets to manage: `GITHUB_TOKEN`
  is enough for GHCR.
- `docker-compose.yml` references `image: ghcr.io/corentingc/ez-dl:latest` (overridable through
  `EZDL_IMAGE`) while keeping `build:` — local dev and hosts with `PUID`/`PGID` ≠ 1000 keep
  building with `--build`, the published image being built with the defaults.
- A **watchtower** service (image pinned to `1.7.1`) lives in the compose file under the
  **`autoupdate` profile**: opt-in through `COMPOSE_PROFILES=autoupdate` in `.env`, in line with
  the "a flag in .env" rule. It is confined by `WATCHTOWER_LABEL_ENABLE` +
  `WATCHTOWER_SCOPE=ez-dl` (labels set on `server` and on watchtower itself): the host's other
  stacks are never touched. `WATCHTOWER_CLEANUP` prunes replaced images;
  `EZDL_AUTO_UPDATE_INTERVAL_SECONDS` sets the poll period (default 300 s).

`deploy/auto-update.sh` remains the **alternative** for hosts building locally (different UID,
GPU variant, no registry access) — the two paths are mutually exclusive: watchtower would
downgrade a local build to the registry image.

## Consequences

- A green push to `main` deploys itself in ~5 min on any host with the `autoupdate` profile
  active — no host-side action left.
- The Docker socket is mounted into watchtower (root-equivalent on the host): accepted because
  the service exposes no port, only watches the `ez-dl` scope, and its image is pinned.
- The published image bakes `PUID=1000`: hosts with a different UID keep the local build + cron
  path.
- The GPU variant (`FFMPEG_VARIANT=nvenc`) is not published to GHCR — local build only.
