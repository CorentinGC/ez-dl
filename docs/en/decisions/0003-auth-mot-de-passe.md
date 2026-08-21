# ADR 0003 — Authentication via shared password (Bearer)

- **Status**: accepted
- **Date**: 2026-08-21

## Context

The ez-dl server is typically deployed on a local network (home NAS, home-lab server)
and consumed by a Chrome extension. It must reject any unauthorized access, in
particular because its routes allow writing files to the host system (within the
limits of `EZDL_DOWNLOAD_ROOTS`) and forwarding the user's session cookies. The
deployment context (personal LAN, a single user or a small trusted group, no existing
identity infrastructure) points toward a simple authentication mechanism that can be
operated without a third-party service.

## Decision

Authentication via a **shared password sent as a Bearer token**:

- The extension sends `Authorization: Bearer <EZDL_PASSWORD>` on every request.
- A single FastAPI dependency validates this header on all routes except
  `GET /api/health` (needed for a Docker healthcheck with no configuration).
- **Constant-time** comparison (`secrets.compare_digest`) to avoid timing-based attacks
  on the string comparison.
- If `EZDL_PASSWORD` is not set or empty, the server automatically generates a strong
  password (`secrets.token_urlsafe(24)`, ~192 bits of entropy) at startup, displays it
  in an isolated console banner (5 s pause before log resumption), then starts normally.
  No "passwordless" mode exists — authentication remains mandatory, whether generated or
  provided.
- The password is never logged, nor are the cookies forwarded by the extension.
- On the extension side, the password is stored in `chrome.storage.local` (persistent,
  specific to the Chrome profile).

## Alternatives considered

- **Per-client API token, individually revocable**: discarded for V1 — adds token
  lifecycle management (issuance, revocation, secure server-side storage) that is
  disproportionate for a single-user or small-group deployment. Re-evaluable if ez-dl
  ever needs to manage several distinct accounts.
- **mTLS (client certificates)**: discarded — complexity of generating/distributing
  certificates on the Chrome extension side (no standard API to manage a client
  certificate from an MV3 extension as simply as a stored password), unsuited to the
  target user (personal self-hosting, not necessarily a PKI expert).
- **OAuth / OpenID Connect**: discarded — assumes an identity provider, largely
  disproportionate for a personal server on a LAN with no user directory.
- **No authentication (implicit trusted network)**: discarded — even on a LAN, the
  server writes files and handles session cookies; a total absence of auth is judged
  unacceptable. No "passwordless" mode should be possible.

## Consequences

- Simple solution to operate: a single secret to configure on both the server and the
  extension side, no additional infrastructure.
- **Sufficient on a trusted local network**, but **TLS strongly recommended if the
  server is exposed beyond the LAN** (reverse proxy with HTTPS, e.g. Caddy/Traefik) —
  a Bearer token sent in the clear over unencrypted HTTP is interceptable. To be
  documented in `docs/fr/setup.md` and `README.md`.
- No per-user granularity: any holder of the password has full access to the API
  (downloading, writing files within the allowed roots, managing site rules).
  Acceptable for the target use case (single user or small trusted group).
- If the need for multiple accounts or differentiated permissions emerges, this ADR
  will need to be revised (migration to at least per-client tokens).

## Amendment (2026-08-21, issue ez-dl-5jw)

**Improvement of first startup and onboarding**: the original decision mandated refusing to start
if `EZDL_PASSWORD` was absent or empty. While secure, this strictness made onboarding verbose
(obligation to copy-paste an example value or generate a password *beforehand*).

**Actual behavior since 2026-08-21**: if `EZDL_PASSWORD` is not set or empty, the server
automatically generates a strong password at startup, displays it in an isolated console banner
(with 5 s pause to ensure visibility), then starts normally. This approach improves first-startup
UX without degrading security (each startup gets a different key if not defined, and auth remains
mandatory on all routes — there is still no passwordless mode). The user can then retrieve this
generated password, store it in the `EZDL_PASSWORD` environment variable, and recreate the
container for a silent startup. As long as `EZDL_PASSWORD` is not set, the password remains
visible in `docker logs` (a simple `docker restart` does not purge it; recreating the container
is the only way).
