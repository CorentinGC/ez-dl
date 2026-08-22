# ADR 0006 — Semantic versioning and release channels

- **Status**: accepted
- **Date**: 2026-08-22
- **Amends**: [ADR 0005 — Auto-update via GHCR image + watchtower](0005-auto-update-image-ghcr-watchtower.md)

## Context

The project targets two audiences: people who clone the repository and build, and people who want
a command to copy and paste. Nothing in the tooling served the second one yet.

Three concrete obstacles:

- **No version existed.** `latest` followed every green commit on `main` (ADR 0005). Anyone
  deploying "the published image" was therefore doing continuous deployment without knowing it:
  no number to quote in a bug report, no rollback, no release notes. Four version carriers also
  coexisted in the repository (`server/pyproject.toml`, a hand-copied `APP_VERSION`,
  `extension/package.json`, `server/uv.lock`) with nothing keeping them in sync.
- **The image was published for amd64 only.** The hosts the easy path targets — ARM NAS boxes,
  Raspberry Pi — could not pull it.
- **`PUID`/`PGID` were build ARGs**, so frozen at 1000 in the published image: a host whose user
  is not 1000 had to rebuild, which defeats the point of a published image.

## Decision

### One source of truth for the version

`[project].version` in `server/pyproject.toml`. It is the only version file present in the image
build context (`context: ./server`). `APP_VERSION` reads it through `tomllib`, falling back to
`0.0.0`: a server displaying a wrong version beats a server refusing to start because a packaging
file is missing. `extension/package.json` is aligned by `scripts/release.sh` and checked by
`scripts/check-version.sh`.

The format is **strictly numeric** (`X.Y.Z`): Chrome only accepts 1 to 4 numbers in an extension
manifest, and a prerelease (`0.2.0-rc1`) is copied as-is into `extension-version.txt` by the
Dockerfile, which makes `/extension/version` return `version: null` — silently. The project stays
in `0.x`: a minor bump may carry a breaking change.

### The git tag is what publishes

`scripts/release.sh X.Y.Z` prepares everything locally (versions, `uv lock`, CHANGELOG promotion,
lint, tests, commit, annotated tag) and **never pushes**. Pushing the tag triggers
`.github/workflows/release.yml`. A published tag is never moved: a fix gets the next patch.

### Image channels

| Tag | Contents | Audience |
|---|---|---|
| `latest`, `X.Y.Z`, `X.Y` | tagged releases only | deployments, easy path |
| `edge`, `main-<sha>` | every green commit on `main` | people following the repository |

**`latest` therefore changes meaning** compared to ADR 0005: it no longer follows `main`, only
published releases. A watchtower deployment on the `autoupdate` profile now moves only on
releases. Anyone wanting the previous behaviour sets
`EZDL_IMAGE=ghcr.io/corentingc/ez-dl:edge`.

### Multi-arch on native runners

`linux/amd64` + `linux/arm64`, built on `ubuntu-latest` and `ubuntu-24.04-arm` (ARM runners, free
on public repositories), each pushing its manifest by digest, with a `merge` job assembling the
index using `docker buildx imagetools create`. No QEMU: an emulated `npm ci` and system dependency
install cost several minutes per run for a bit-identical result.

The GPU variant (`FFMPEG_VARIANT=nvenc`) stays **amd64 and local-build only**: the `ffmpeg-nvenc`
stage deliberately fails off amd64, and BuildKit prunes it when `FFMPEG_VARIANT=debian` — the
published variant.

### `PUID`/`PGID` become runtime settings

The entrypoint starts as root, aligns the application user with `PUID`/`PGID`, makes
`EZDL_DATA_DIR`, `EZDL_TEMP_DIR`, the Deno cache and the download roots writable, then
`exec gosu` to that uid. No application code ever runs as root; `PUID=0` is refused; a container
already started non-root (`user:` in Compose) skips the whole phase.

## Consequences

- The easy path becomes viable: a versioned image, anonymously pullable, that works on an ARM NAS
  with any uid.
- **A deployment following `latest` no longer updates on every commit.** That is the point, but it
  is a behaviour change for existing installs: with no semver tag published, they freeze.
- Publishing now takes an explicit action (`release.sh`, then pushing the tag) and a CHANGELOG
  entry in both languages — `release.sh` refuses an empty `[Unreleased]` section.
- The entrypoint's root window is a real posture change for a project that was non-root end to
  end. Accepted and documented in `SECURITY.md`.
- CI builds two images per run instead of one. Absorbed by the per-arch `type=gha` cache and by
  merging the former `docker` and `publish` jobs, which already built the same image twice.

## Alternatives rejected

- **Tagging `latest` on `main` and also publishing versions**: both channels cannot share one tag;
  that ambiguity is exactly what made deployments unpredictable.
- **QEMU for arm64**: simple to write, but an emulated `npm ci` makes every run interminable.
- **Publishing the GPU variant**: it depends on host hardware and cannot be validated in CI.
- **Keeping `PUID` as an ARG and documenting the rebuild**: the easy path disappears for every
  host that is not uid 1000 — that is, most NAS boxes.
