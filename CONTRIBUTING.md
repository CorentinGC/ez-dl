**English** | [Français](CONTRIBUTING.fr.md)

# Contributing to ez-dl

Thanks for considering a contribution. This document covers the workflow, code style, testing
expectations, and a couple of hard rules the project can't bend on. Please also read the
[Code of Conduct](CODE_OF_CONDUCT.md) and, for vulnerabilities, [SECURITY.md](SECURITY.md).

## Workflow

1. **Fork** the repository and clone your fork.
2. Create a branch off `main`, named for what it does: `feat/site-rule-picker`,
   `fix/path-traversal-check`, `docs/fr-mirror-drift`.
3. Make your change, following the code style and testing rules below.
4. Commit using [Conventional Commits](https://www.conventionalcommits.org/) (see below).
5. Push your branch and open a pull request against `main`. Describe *why* the change is needed,
   not just what it does; link any related issue.
6. Respond to review feedback. A maintainer will merge once it's green and approved.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(server): add hevc_qsv preset detection
fix(extension): stop sniffing after tab navigation
docs: sync README.fr.md with the new roadmap
refactor(server): extract path validation into its own module
test(server): cover job cancellation race
chore: bump yt-dlp pin
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `style`. Scope
(`server`, `extension`, `docs`, …) is optional but encouraged.

## Code style

- **Python (`server/`):** formatted and linted with [ruff](https://docs.astral.sh/ruff/) —
  run `uv run ruff check .` (and `uv run ruff format .`) before pushing. Validate all external
  input with pydantic models. Never use `subprocess` with `shell=True`; always pass argument
  lists.
- **TypeScript / React (`extension/`):** follow the existing WXT/React conventions in the
  codebase. Run `npm run compile` to type-check before pushing.
- **Comments in French, identifiers in English.** Code comments (Python and TypeScript) are
  written in French; variable/function/class names, API fields, and log messages stay in English.
  This applies project-wide except inside this top-level `README`/`CONTRIBUTING` pair, which are
  bilingual documentation files, not code.
- **Keep files under ~400 lines.** Split a file that grows past that instead of letting it sprawl.
- General hygiene: DRY, single responsibility per module/function, early returns over nested
  conditionals, no dead code or commented-out blocks left behind.

## Tests

- **Server:** new endpoints, business logic, or bug fixes need a `pytest` (+ `pytest-asyncio` /
  `httpx`) test. Run the suite with `uv run pytest` from `server/` before opening a PR.
- **Extension:** logic that isn't trivial UI glue (sniffing rules, filename sanitization, format
  selection, etc.) should have a [Vitest](https://vitest.dev/) test. If Vitest isn't wired up yet
  for the area you're touching, add the minimal setup alongside your change rather than skipping
  tests.
- A PR that changes behavior without a test covering it will likely be asked to add one before
  merge.

## Documentation

This repository uses two different documentation conventions — please match the right one:

- **Top-level `README.md` / `CONTRIBUTING.md` (this file) and their `.fr.md` counterparts:**
  English is the primary version, French is the mirror. Update both when you change user-facing
  behavior, configuration, or the contribution workflow.
- **`docs/`:** French is the canonical version there, English is the mirror
  (`docs/fr/…` canonical, `docs/en/…` kept in sync). If your change affects documented behavior,
  update the French source first, then port the change to the English mirror in the same PR.

Don't let the two language versions drift — a PR that updates one without the other may be asked
to complete the mirror before merge.

## No personal information, no DRM bypass

Every PR is expected to respect two hard rules, checked in review:

- **No personal information** anywhere in code, tests, docs, commit messages, or example
  configuration: no real email addresses, real names, real NAS/server paths, real private IP
  addresses, or hardcoded tokens/passwords. Use generic placeholders
  (`/mnt/media/movies`, `http://nas.local:8000`, `<your-email>`, `change-me-please`, …).
- **No DRM circumvention.** Contributions that implement or facilitate defeating Widevine,
  PlayReady, FairPlay, or any other content-protection scheme will be rejected outright, no matter
  how well-tested or well-intentioned. This is not negotiable — see
  [README.md > Legal & scope](README.md#legal--scope).

## Sign-off / attribution

By opening a pull request, you certify that you wrote the contribution yourself (or otherwise have
the right to submit it) and that you're licensing it under the project's
[LICENSE](LICENSE) (PolyForm Noncommercial 1.0.0). Please add a sign-off line to your commits:

```bash
git commit -s -m "feat(server): add hevc_qsv preset detection"
```

This appends `Signed-off-by: Your Name <your@email>` to the commit message — a lightweight
[Developer Certificate of Origin](https://developercertificate.org/)-style attribution. Use
whatever name/email you're comfortable making public in the git history; a GitHub-provided noreply
address works fine.

## Adding a conversion preset

Presets are declared server-side and only exposed via `/api/capabilities` when their underlying
`ffmpeg` encoder is actually available (detected at startup via `ffmpeg -encoders`). To add one:

1. Add the preset definition (id, label, description, container, video codec, ffmpeg args) to the
   server's preset registry.
2. Gate it on the corresponding encoder being present — never assume an encoder exists just
   because the preset is defined.
3. Confirm it shows up in `GET /api/capabilities` once the encoder is available locally (or
   mocked in a test).
4. Add a test covering both "encoder present" and "encoder absent" cases.
5. If it's user-facing (e.g. a new hardware backend), mention it in `README.md` /
   `README.fr.md`.

## Adding a site detection rule

Site rules (`domain`, `url_pattern`, `label`, `notes`, `source`) tell the extension's sniffer how
to recognize a video stream on a given domain. They can be created two ways:

- **Learned at runtime** by a user, through the "help detect" picker → `POST /api/rules` with
  `source: "learned"`. No code change needed; this is the normal end-user path.
- **Shipped as a built-in default**, with `source: "manual"`, when a site is common enough to
  warrant detection out of the box without every user having to learn it individually.

If you're contributing a built-in rule: add it to the extension's default rule set, keep the
`url_pattern` as a simple glob/regex (no site-specific business logic bolted on), and include a
short note on how you verified it (which page(s), what stream URL pattern it matches).

## Versioning and releases

A single source of truth for the version number: `[project].version` in
`server/pyproject.toml`. `APP_VERSION` is derived from it (read with `tomllib`), and
`extension/package.json` must match it.

The format is **strictly numeric** (`X.Y.Z`, 1 to 4 numbers): Chrome rejects anything else in an
extension manifest, and a prerelease such as `0.2.0-rc1` makes `/extension/version` return
`version: null` with no visible error.

Releasing a version:

```bash
scripts/check-version.sh          # pyproject / APP_VERSION / package.json / uv.lock agree
scripts/release.sh 0.2.0          # rewrites versions, promotes the CHANGELOG, commits + tags
scripts/release.sh 0.2.0 --dry-run  # show what it would do, write nothing
```

`release.sh` **never** pushes: it prints the push command for you to run. Pushing the **tag** is
what triggers `.github/workflows/release.yml` (GHCR image `X.Y.Z`, `X.Y` and `latest` for amd64 +
arm64, then a GitHub Release).

Any user-visible change goes under `## [Unreleased]` in `CHANGELOG.md` **and**
`CHANGELOG.fr.md`, in the same commit — `release.sh` refuses to publish a version whose section
is empty.

Published image channels:

| Tag | Contents |
|---|---|
| `latest`, `X.Y.Z`, `X.Y` | tagged releases only |
| `edge`, `main-<sha>` | every green commit on `main` |

A published tag is never moved: a fix gets the next patch version.

## PR checklist

- [ ] Code follows the style rules above (ruff clean / `npm run compile` clean)
- [ ] Tests added/updated and passing (`uv run pytest`, and Vitest where applicable)
- [ ] `README`/`README.fr.md` and/or `docs/` updated if behavior or configuration changed
- [ ] User-visible changes added under `## [Unreleased]` in `CHANGELOG.md` **and** `CHANGELOG.fr.md`
- [ ] No personal information, no DRM-bypass code
- [ ] Commits follow Conventional Commits and are signed off (`-s`)
