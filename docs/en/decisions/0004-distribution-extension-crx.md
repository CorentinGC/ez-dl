# ADR 0004 — Distributing the extension as a `.crx` signed by the server

- **Status**: accepted, **amended on 2026-08-22** (see "Amendment" below)
- **Date**: 2026-08-22

## Amendment — the `.crx` cannot be installed by drag and drop

The original decision rested on a **false** premise: that dropping a self-signed `.crx` onto
`chrome://extensions`, with developer mode enabled, would install the extension. Chrome refuses
that gesture with "Package is invalid: CRX_REQUIRED_PROOF_MISSING": on that path `VerifyCrx3`
requires a publisher proof that only the Chrome Web Store can produce, and developer mode changes
nothing. Verified in real conditions against the deployed server.

What changes: the **documented path is the zip** (`/extension/zip`) + "Load unpacked". What
stays: the whole signing chain. The `.crx` produced is valid and is precisely the artifact a
**system-policy** installation consumes — the only path where Chrome verifies an extension from
outside the Web Store without a publisher proof. Runtime signing, the persisted key and the
stable identifier therefore keep their purpose, and `ez-dl-upc` becomes the natural sequel rather
than a mere convenience.

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

- `GET /extension` — HTML installation page: extension and server versions, zip download button,
  installation steps, the archive's SHA-256, and a secondary block about the signed package.
- `GET /extension/zip` — the extension zip, artifact of the recommended route ("Load unpacked
  extension"). Explicit `404` if the image does not contain the artifact.
- `GET /extension/download` — signed `.crx` archive (`application/x-chrome-extension`, named
  `ez-dl-extension-<version>.crx`), meant for system-policy installation. `404` under the same
  conditions, `503` if signing fails.
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

- **Distributing the zip alone**: discarded as the primary route at decision time — it requires
  unzipping the archive and **keeping** the extracted folder (Chrome loads an unpacked extension
  from its source folder; deleting it breaks the extension). *The amendment above reverses that
  choice: this friction is the price to pay, since the `.crx` cannot be installed manually.*
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
  (data directory not writable). The `/extension` page itself displays the SHA-256 of the archive
  actually served and the signed package's identifier — the first to detect artifact substitution in
  transit, the second because an extension installed through system policy carries that identifier in
  `chrome://extensions`. (An extension loaded unpacked receives an identifier derived from its folder
  path, not from the key: the published identifier does not apply to that route.)
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

Outside the Chrome Web Store, Chrome allows **no "one-click" installation** from a web page, and
refuses any signed package that does not come from the Store (`CRX_REQUIRED_PROOF_MISSING`).
Developer mode and loading unpacked therefore remain mandatory for a manual installation.

Only installation through **system policy** escapes that constraint: a policy-installed extension
is verified with `VerifierFormat::CRX3`, without a publisher proof, and updates itself from a
self-hosted `update.xml`. Its cost is real — administrator rights on every machine, and the
policy must be *mandatory* level (on macOS, a plist in `/Library/Managed Preferences/`, out of
reach of a user-level `defaults write`). Tracked by issue `ez-dl-upc` — **not implemented to
date**.
