# Changelog

All notable changes to ez-dl are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) and is still in `0.x`, so a minor bump
may carry a breaking change.

French version: [CHANGELOG.fr.md](CHANGELOG.fr.md).

Published artifacts for a version `X.Y.Z`:

- Docker image `ghcr.io/corentingc/ez-dl:X.Y.Z`, `:X.Y` and `:latest` (linux/amd64 + linux/arm64)
- the extension zip served by that image on `/extension`

The `main` branch publishes `:edge` and `:main-<short-sha>` instead — untested by any release
process, use it only if you follow the repository.

## [Unreleased]

## [0.1.0] - 2026-08-22

First tagged release. Everything below already existed on `main`; this version is the point where
the project starts being published as versioned artifacts.

### Added

- FastAPI server: video probing through yt-dlp, format selection, download queue, optional ffmpeg
  conversion, SSE progress, folder browsing restricted to `EZDL_DOWNLOAD_ROOTS`.
- Chrome MV3 extension (WXT + React): hybrid detection (yt-dlp probe + network sniffing + DOM
  picker), popup, options page, per-site learned rules.
- Password authentication on every route except `GET /api/health`, generated at startup when
  `EZDL_PASSWORD` is unset.
- Docker image published on GHCR for **linux/amd64 and linux/arm64**, with the extension built
  into it and served on `/extension`.
- Runtime `PUID`/`PGID`: the entrypoint aligns the application user with the owner of your volumes
  at container start, so the published image works on a host whose user is not uid 1000.
- Opt-in auto-update inside the Docker stack (watchtower, `autoupdate` compose profile) and a host
  cron alternative for locally-built images.

[Unreleased]: https://github.com/CorentinGC/ez-dl/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/CorentinGC/ez-dl/releases/tag/v0.1.0
