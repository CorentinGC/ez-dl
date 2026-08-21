# ADR 0002 — PolyForm Noncommercial 1.0.0 License

- **Status**: accepted
- **Date**: 2026-08-21

## Context

ez-dl is a public, source-available repo. The business need is twofold:

- Make the source code **freely usable, modifiable, and redistributable for
  non-commercial use** (personal self-hosting, community contributions, non-commercial
  forks).
- Reserve the ability to offer a **paid commercial license** to any entity that
  would want to operate ez-dl (or a derivative) in a commercial setting — for example a
  billed hosted service, or an integration into a commercial product.

This need automatically excludes the classic OSI-approved open source licenses (MIT,
Apache 2.0, GPL...), all of which permit commercial use without distinction.

## Decision

Adopt **PolyForm Noncommercial 1.0.0**:

- Free use, modification, and distribution for any **non-commercial** use.
- Commercial use prohibited under this license; requires a separate commercial license
  agreement (contact via GitHub Issues or the placeholder address
  `<contact@example.com>` — see `README.md`).
- Short, standardized license (PolyForm family), widely recognized in the
  source-available ecosystem, which limits the need to draft custom terms of use.

## Alternatives considered

- **AGPL v3 + commercial dual license**: discarded — AGPL remains an open source
  license that permits commercial use (including via a network service, with the
  obligation to publish modifications), which does not match the need to strictly
  reserve commercial use for a paid license. The AGPL/commercial dual license is a
  common model, but it does not prevent commercial use of the code under AGPL itself
  (provided the source is published), which weakens the value of the commercial
  license.
- **BUSL (Business Source License)**: discarded — a more complex model (a license that
  switches to an open source license after a given period, with an "Additional Use
  Grant" to define precisely), better suited to products with an elaborate licensing
  roadmap. The complexity is not justified for a greenfield project.
- **Closed proprietary license (not source-available)**: discarded — contrary to the
  project's transparency objective (the README must in particular make explicit the
  absence of DRM circumvention and the extension's permissions) and to the interest of
  accepting community contributions.

## Consequences

- **Not OSI-approved**: ez-dl cannot present itself as "open source" in the strict
  (OSI-approved) sense, only as "source-available." This must be explicitly mentioned
  in `README.md` to avoid any ambiguity for users and contributors.
- External contributions implicitly accept the license terms for their contributed
  code; to be clarified in `CONTRIBUTING.md` if third-party contributions are expected.
- Any request for commercial use must be redirected to the contact channel indicated in
  `README.md` (GitHub issues or placeholder email — never a real personal email address
  in the repo, see `CLAUDE.md` § Public project).
- The `LICENSE` file at the root contains the PolyForm Noncommercial 1.0.0 text with
  the mention `Required Notice: Copyright ez-dl contributors` (no natural person's
  name).
