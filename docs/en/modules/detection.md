# Module — Detection

Detection combines three complementary sources: the server-side yt-dlp probe, extension-side
network sniffing, and per-site learned rules. See also
[ADR 0001](../decisions/0001-stack-fastapi-wxt.md) for the reasoning behind this hybrid approach.

## 1. yt-dlp probe (server)

`GET/POST /api/probe?url=...` (`server/app/routers/probe.py` → `server/app/services/ytdlp.py`)
calls yt-dlp in information-extraction-only mode (no download), and returns:

- metadata: `title`, `uploader`, `duration`, `thumbnail`, `extractor`;
- the list of available `formats` (resolution, codecs, bitrate, audio/video presence);
- `best_format_id`: the default recommended format (preselected on the popup side);
- `suggested_filename`: filename derived from the title, already sanitized.

`POST /api/probe` additionally accepts `{cookies, headers, referer}` for pages that require an
authenticated session (see cookie handling in [conventions.md](../conventions.md#security)).
Cookies are written to a temporary `0600` file passed to yt-dlp via `--cookies`, deleted after the
call.

This method works for any site covered by a yt-dlp extractor (a very large list, maintained
upstream); it fails silently (or returns an extraction error) for unsupported sites.

### Exposed formats and recommended format

`normalize_formats` (`server/app/core/ytdlp.py`) filters yt-dlp's raw list before exposing it:

- **storyboards** (`protocol: mhtml`, thumbnail sheets with no audio or video track) are dropped,
  along with **"Premium"** formats: those high-bitrate variants are inconsistently restricted to
  YouTube Premium accounts and may fail with "Requested format is not available" — the bitrate gain
  does not justify that risk for the default suggestion;
- sorting puts **video** formats first, by resolution then fps then bitrate. A video-only format is
  not penalized: the download selector automatically pairs it with the best audio track (see
  [architecture.md](../architecture.md#job-lifecycle));
- `best_format_id` is the first entry of that list. If filtering leaves nothing, `/api/probe`
  returns an explicit error rather than an empty list.

**YouTube requires a JavaScript runtime** (Deno, installed in the Docker image): without one,
yt-dlp cannot solve the player challenges, returns a truncated format list — sometimes no playable
format at all — and `-J` fails. `--ignore-no-formats-error` keeps that failure from surfacing as an
opaque 502.

## 2. Network sniffing (extension)

`extension/entrypoints/background.ts` listens to `chrome.webRequest.onBeforeRequest` and
`onHeadersReceived` to spot requests that look like video streams:

- URL extensions: `.m3u8`, `.mpd`, `.mp4`, `.webm`, `.m4s`;
- response content-types: `video/*`, `application/vnd.apple.mpegurl` (HLS),
  `application/dash+xml` (DASH).

Detected state is kept **per tab** (`chrome.storage.session` — never in a plain module variable,
since the MV3 service worker can be unloaded at any time) and **purged on every navigation** of
the tab to avoid mixing results from two different pages. The extension badge shows the number of
streams detected on the active tab.

`chrome.webRequest` in MV3 is **observational only**: it is impossible to block or modify the
request from this listener (unlike MV2). Sniffing is therefore used to *spot* candidates, not to
intercept traffic.

## 3. Per-site learned rules (`SiteRule`)

When neither the yt-dlp probe nor sniffing finds a video, the user can trigger learning mode
(detailed in [modules/apprentissage.md](apprentissage.md)), which results in a `SiteRule` being
saved via `POST /api/rules`:

```json
{"domain": "example.com", "url_pattern": "*/hls/*.m3u8", "label": "Main player", "source": "learned"}
```

On subsequent visits to that domain, the sniffer prioritizes applying known `url_pattern` values
to filter/prioritize detected requests, reducing noise and avoiding another pass through the DOM
picker. `GET /api/rules` lists existing rules (manual and learned), `DELETE /api/rules/{id}`
allows removing one that has become obsolete (e.g. a change in the site's video player
architecture).

The `url_pattern` accepted by `patternToRegExp` (`extension/src/lib/detection.ts`) is either a
simple glob (only `*` is a wildcard, everything else escaped literally — including `?`, treated as
a URL's query-string separator and never as a regex quantifier), or a raw regex if the pattern
contains other regex metacharacters (`^ $ + ( ) { } | [ ] \`). Rules learned via the picker are
saved as a glob automatically generalized beforehand (see
[modules/apprentissage.md](apprentissage.md#automatic-pattern-generalization)); manually added
rules can use either syntax.

## Merging results on the popup side

The popup (`extension/entrypoints/popup/`) merges, at open time:

1. the result of `GET/POST /api/probe` on the active tab's URL (if the yt-dlp extractor
   recognizes the site);
2. the streams sniffed on the `background.ts` side for that tab, filtered/prioritized by the
   `SiteRule` entries known for the domain.

If no source returns a result, the popup offers the **"Help detect"** button, which launches
learning mode.

## Page overlay download button (visited page)

The content script anchors a download button to the top-right corner of the page's video, removing
the round trip through the popup. It only shows up **when a source is confirmed** — never a dead
button.

**Display conditions**, all required:

1. the `showPageOverlay` preference is on (`uiPrefs` key in `storage.local`, "Interface" section of
   the options page — shared across all server profiles);
2. a server is configured (URL + password);
3. the page holds a `<video>` of at least **200 × 150 px** visible in the viewport (thresholds in
   `src/lib/overlayGeometry.ts`, which rule out ads, autoplay GIFs and tracking pixels);
4. the background confirms a source: sniffed streams exist for the tab, **or** the `/api/probe` call
   on the tab URL returns at least one format.

**Bounded server cost**: the probe is only a last resort (no sniffed stream), once per tab URL — the
result is cached in `TabState.quickProbe`, which navigation clears along with the rest of the tab
state. Iframes of the same page share the in-flight request. When a stream is sniffed later, the
background pushes `OVERLAY_AVAILABLE` to the tab, so the button appears without another round trip.

**On click**, the job is sent with the active profile's defaults: best quality (`best_format_id`,
otherwise the highest-resolution format), default favourite folder, default preset, cookies if the
option is on. The selection is done by `src/lib/quickSource.ts`, a pure module shared with the
popup's source card: both paths propose the exact same filename and quality for a given page.

**Separation of concerns** — the content script only touches the DOM and messaging:

| Context | Role |
|---|---|
| `src/content/videoOverlay.ts` | `<video>` tracking, positioning, Shadow DOM, toast |
| `entrypoints/background.ts` | `OVERLAY_CHECK` / `QUICK_DOWNLOAD` routing, `OVERLAY_AVAILABLE` push |
| `src/lib/quickDownload.ts` | probe + cache, cookies, `POST /api/jobs` |

Neither the server URL, nor the password, nor the cookies ever cross the page boundary: the content
script only receives an availability boolean, then a job id or an error message. The background
ignores any data sent by the page and trusts `sender.tab` only. The UI lives in a Shadow DOM (styles
isolated both ways) and steps aside while the picker mode is active.

## Extending detection

- **New network patterns**: add the extension/content-type in `extension/lib/sniffer.ts`, with an
  associated Vitest test (see [conventions.md](../conventions.md#tests)).
- **New yt-dlp extractors**: no project action needed — handled by yt-dlp auto-update
  (`EZDL_YTDLP_UPDATE_INTERVAL_HOURS`); yt-dlp must remain the **standalone binary** for `-U` to
  work (see `MEMORY.md`).
- **Recurring problematic site**: prefer adding a `SiteRule` (learning mode) over site-specific
  code in the extension, to keep the sniffer generic.
