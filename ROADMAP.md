**English** | [Français](ROADMAP.fr.md)

# Roadmap

What's planned, roughly in the order it's likely to land. Nothing here is a commitment or a date —
ez-dl is a self-hosted side project, and priorities move with actual use.

Already shipped is not listed here: see [CHANGELOG.md](CHANGELOG.md).

## Next

- [ ] **Chrome Web Store publication** — one-click install instead of *Load unpacked*. The
  self-hosted path (`/extension/zip`, system policy) stays available whatever the outcome of the
  review.
- [ ] **English UI** — the popup and options page are French-only today. `_locales` with English
  as the default, French as a translation.
- [ ] **Queue reordering** — pause/resume and retry already exist; moving a job up or down does not.

## Later

- [ ] **Firefox support** — MV3 in Firefox differs on `webRequest` and on the service worker
  lifetime; the detection layer has to be ported, not just repackaged.
- [ ] **Apple VideoToolbox encoding** — hardware presets exist for NVENC, QuickSync and VAAPI.
- [ ] **Mobile-friendly companion UI** — a small web UI served by the server, for queueing a URL
  without the extension.
- [ ] **HTTPS helper for the reverse-proxy setup** — today the reverse proxy is documented, not
  assisted.

## Explicitly out of scope

- **Any DRM circumvention** (Widevine, PlayReady, FairPlay). Not a matter of priority: it will not
  be implemented, and such contributions are not accepted. See *Legal & scope* in the
  [README](README.md#legal--scope).
- **A hosted service.** ez-dl is self-hosted by design; there is no server run by the authors, and
  there won't be one.

Have an idea, or need something in "Later" sooner? Open an issue — see
[CONTRIBUTING.md](CONTRIBUTING.md).
