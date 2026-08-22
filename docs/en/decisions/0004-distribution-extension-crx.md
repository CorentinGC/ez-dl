# ADR 0004 — Distributing the extension as a `.crx` signed by the server

- **Status**: accepted
- **Date**: 2026-08-22

## Context

Until now, installing the ez-dl client on a new machine required redoing the entire development
chain: clone the repository, install Node, run `npm install`, build the extension, then load it as
an "unpacked extension" in `chrome://extensions`. This friction is disproportionate for a user who
already has a running ez-dl server and simply wants to add a workstation or a Chrome profile. It
also makes client updates manual and easy to forget: nothing signals that a newer version exists.

The server, on the other hand, is already the user's natural point of contact: it is the address
they know, enter in the extension and open in their browser. It is therefore well placed to
distribute the matching client.

## Decision

The server **publishes the packaged extension** on four **public** routes (no password):

- `GET /extension` — HTML installation page: extension and server versions, download button, three
  installation steps, secondary link to the zip.
- `GET /extension/download` — signed `.crx` archive (`application/x-chrome-extension`, named
  `ez-dl-extension-<version>.crx`). Explicit `404` if the image does not contain the artifact.
- `GET /extension/zip` — the raw zip, for the "Load unpacked extension" route (development). `404`
  under the same conditions.
- `GET /extension/version` — JSON `{available, version, filename, size}`. Returns
  `200 {"available": false, "version": null, ...}` when no artifact is present — **never `404`** on
  this route, which is consumed by the popup to signal that an update is available.

The `.crx` is **signed at runtime by the server**, with an RSA 2048 key generated on first need in
`EZDL_DATA_DIR/extension-signing-key.pem` (permissions `0600`). The signed `.crx` is cached in
`EZDL_DATA_DIR/extension-cache/`. The artifact itself (zip + version number) is produced when the
Docker image is built, by a dedicated `node:22-slim` stage, then copied into `/app/extension-dist`
(`EZDL_EXTENSION_DIST_DIR`): the final image contains no Node.

### Rationale for the authentication exception

ADR 0003 mandates Bearer authentication on **all** routes except `GET /api/health`. The
`/extension*` routes constitute a second exception, accepted for three reasons:

- **The artifact contains only already-public code.** The repository is source-available; the `.crx`
  and the zip carry no secret, no user data, no server configuration. Protecting them would protect
  nothing.
- **A browser link cannot carry an `Authorization` header.** The use case is precisely "open a URL
  and click a button": requiring a header makes it impossible.
- **A token in a URL parameter would be worse than no token.** It would leak into the server logs,
  into those of any reverse proxy and into the browser history — to protect an artifact that has
  nothing to protect.

## Alternatives considered

- **Distributing the zip alone**: discarded as the primary route — it requires unzipping the archive
  and **keeping** the extracted folder (Chrome loads an unpacked extension from its source folder;
  deleting it breaks the extension). The zip is nonetheless still published on `/extension/zip`, as
  a secondary route for development.
- **Chrome Web Store**: discarded — paid developer account, review on every published version, and
  dependency on a third party to distribute the client of a self-hosted server, which contradicts
  the project's logic.
- **Protecting the `/extension*` routes with the password**: discarded — breaks the direct link (see
  above) and requires entering a password **before even having installed the client**, whereas the
  artifact contains nothing confidential.
- **Signing the `.crx` when building the Docker image**: discarded — would require embedding the
  private key in the image, and therefore distributing it along with it. Signing at runtime keeps
  the key in the deployment's data volume.

## Consequences

- **The signing key becomes state to preserve.** `EZDL_DATA_DIR` must be mounted on a persistent
  volume (`./data:/config`) and **backed up** just like the SQLite database.
- **The extension's Chrome identifier derives from that key.** A lost or regenerated key produces a
  new identifier: Chrome then sees a **different** extension rather than an update of the one
  already installed (the old one survives alongside it, with its configuration).
- **Anyone who can reach the server can download the extension.** Judged acceptable: the distributed
  code is already public, and the API itself remains protected by the password.
- **The `/extension` page reveals the existence of an ez-dl server and its version** to an
  unauthenticated visitor. Of no consequence on a LAN, but worth keeping in mind for exposure on the
  Internet: it is one more information surface than a plain `GET /api/health`.
- **Published fingerprints for validation.** `GET /extension/version` returns two additional fields:
  `extension_id` (Chrome identifier, 32 characters a-p, derived from the signing key) and `sha256`
  (SHA-256 fingerprint of the served `.crx`). Both are `null` when the `.crx` cannot be prepared
  (data directory not writable). The `/extension` page displays both values; the user can verify the identifier by
  opening `chrome://extensions` after installation to detect artifact substitution in transit.
- **Published version validation.** The contents of `extension-version.txt` must be a strictly
  numeric version (`1`, `1.2`, `1.2.3`, or `1.2.3.4`); any other form rejects the file, and the
  server falls back to the generic name `ez-dl-extension.crx` while announcing `version: null`.
- **The artifact folder is read-only.** `EZDL_EXTENSION_DIST_DIR` (`/app/extension-dist` in the
  image) is owned by `root:root`; the server, running as a non-root user, can only read it. Rationale:
  the server signs the zip it finds there with its persisted key; any rewrite of the zip would
  produce a `.crx` with the same Chrome identifier, hence a silent update of the installed
  extension, preserving the already-granted permissions (broad permissions: `<all_urls>`, `cookies`,
  `webRequest`).
- **Download roots isolated.** The server refuses to start if any `EZDL_DOWNLOAD_ROOTS` root contains
  (or is contained in) `EZDL_DATA_DIR` or `EZDL_EXTENSION_DIST_DIR`. Rationale: prevent a downloaded
  file from overwriting an extension distribution artifact or the database. Explicit error message
  on startup.
- **`.crx` cache indexed on fingerprint.** The signed `.crx` is cached in
  `EZDL_DATA_DIR/extension-cache/`, but indexed on the SHA-256 of the source zip, not its timestamp.
  A rebuild that changes the zip is therefore republished even when its mtime has not moved
  (reproducible build, restored backup) — a timestamp-based cache served the stale artifact forever.
- Republishing the client after a change consists of bumping `version` in `extension/package.json`
  then rebuilding the image (`docker compose up -d --build`, or `make publish-extension`).
- An image built **without** the `extension` BuildKit context (for example a `docker build` run by
  hand in `server/`) remains valid: only distribution is unavailable — the page explains it and the
  download routes answer `404`.

## Known limitation

Chrome allows **no "one-click" installation** from a web page outside the Chrome Web Store:
Developer mode remains required, and the user must drag the `.crx` onto `chrome://extensions`.
Silent installation and update via system policy (`update.xml` + `ExtensionInstallSources` /
`ExtensionInstallForcelist`) are a possible evolution of this decision (issue `ez-dl-upc`) — **not
implemented to date**.
