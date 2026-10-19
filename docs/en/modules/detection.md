# Module — Detection

Detection combines three complementary sources: the server-side yt-dlp probe, extension-side
network sniffing, and per-site learned rules. See also
[ADR 0001](../decisions/0001-stack-fastapi-wxt.md) for the reasoning behind this hybrid approach,
and [ADR 0008](../decisions/0008-proxy-sortie-global-et-probe-borne.md) for the framing of the probe.

## 1. yt-dlp probe (server)

`GET/POST /api/probe` (`server/app/api/probe.py` → `server/app/core/ytdlp.py`) calls yt-dlp in
information-extraction-only mode (no download), and returns:

- metadata: `title`, `uploader`, `duration`, `thumbnail`, `extractor`;
- the list of available `formats` (resolution, codecs, bitrate, audio/video presence);
- `best_format_id`: the default recommended format (preselected on the popup side);
- `suggested_filename`: filename derived from the title, already sanitized.

`POST /api/probe` additionally accepts `{cookies, headers, referer}` for pages that require an
authenticated session (see cookie handling in [conventions.md](../conventions.md#security)).
Cookies are written to a temporary `0600` file passed to yt-dlp via `--cookies`, deleted after the
call.

This method works for any site covered by a yt-dlp extractor (a very large list, maintained
upstream); it fails (extraction error, `502`) for unsupported sites.

### Playlist rule: never a whole list

The probe and the download go through `_playlist_args` (`server/app/core/ytdlp.py`); `update()` and
`version()` extract no content and are not concerned:

- **probe without a rank** (`playlist_items` absent): `--no-playlist --playlist-items 1 --flat-playlist`.
  A listing page (search, channel, playlist, feed) is recognised without extracting each entry into
  memory, and `/api/probe` answers **`422`** with "open a video";
- **probe with a rank** `playlist_items=N` (integer 1–50, in the query for `GET`, in the body for `POST`,
  or on `POST /api/jobs`): `--no-playlist --playlist-items N`, without `--flat-playlist`. Entry `N`
  is extracted in full, formats included;
- **download**: `--no-playlist --playlist-items N` (`N` = 1 without a rank), without `--flat-playlist`.

This rank is what lets the probe target the **right** video of a multi-video tweet (see "On X /
Twitter" below).

### Probe coordination

`server/app/core/probe_cache.py` keeps a single instance for the whole process:

- at most **2 probes** run yt-dlp at the same time;
- **identical in-flight calls** (same URL, same rank, same authentication context) share a single
  extraction. The key only contains a SHA-256 digest of the context, never a cookie in clear text;
- a success is cached for **60 s** (64 entries at most);
- when the **last** requester leaves (client disconnected, `499` response), the task is cancelled and
  its process group killed;
- beyond `EZDL_PROBE_TIMEOUT_SECONDS` (25 s by default), the yt-dlp group is killed and the response
  is `502`.

The constants above (2, 60 s, 64) are code constants, not `EZDL_*` variables.

When `EZDL_PROXY` is set, the probe, the download and the auto-update go through that proxy
(`--proxy`). See [setup.md](../setup.md#going-through-a-vpn-or-proxy).

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

The popup (`extension/entrypoints/popup/hooks/useSources.ts`) queries the server **when it opens**
(or on "Retry"), never in the background:

1. the result of `GET/POST /api/probe` on the active tab's URL, if the yt-dlp extractor recognizes
   the site. A probe already made for this URL by the overlay button (`TabState.quickProbe`) is
   reused without a new call;
2. the streams sniffed on the `background.ts` side for that tab, added only when the probe does not
   cover the page (or, on X, to label the tweet's videos).

A **listing page** (`isListingUrl`, `extension/src/lib/listingUrl.ts`) triggers no probe: the popup
shows "open a video". Streams sniffed while the popup is open are re-read without a new probe.

If no source returns a result, the popup offers the **"Help detect"** button, which launches
learning mode.

## Page overlay download button (visited page)

The content script (`extension/src/content/videoOverlay.ts`) anchors a button on **every** eligible
video of the page, removing the round trip through the popup. One button per video, 12 at most (the
largest visible videos).

**No server request when displayed.** The button appears as soon as a `<video>` is eligible; it calls
neither the probe nor the server. The server is only contacted **on click**: no request is made in the
background for a page that is merely visited.

**Display conditions**, both required:

1. the `showPageOverlay` preference is on (`uiPrefs` key in `storage.local`, "Interface" section of
   the options page — shared across all server profiles);
2. the `<video>` is at least **200 × 150 px** and visible in the viewport (thresholds in
   `src/lib/overlayGeometry.ts`, which rule out ads, autoplay GIFs and tracking pixels).

**On click** (`QUICK_DOWNLOAD`), the service worker (`src/lib/quickDownload.ts`) checks the
configuration (server configured, default favourite folder set), then chooses the source. The job is
sent with the active profile's defaults: favourite folder, default preset, cookies if the option is
on.

- **Tweet video** (X): see the "On X / Twitter" section;
- **generic page**: a probe runs on click, once per tab URL (result kept in `TabState.quickProbe`,
  cleared on navigation). Iframes of the same page share the in-flight request. The media is then
  chosen by this priority order (`pickQuickSource`, `src/lib/quickSource.ts`):
  1. **several videos on the page** → the clicked video's media URL: the probe only describes the
     main video and would download the wrong one;
  2. **single video** → the yt-dlp probe (best quality, video and audio tracks remuxed);
  3. no extractor → the clicked video's media URL;
  4. otherwise → the best sniffed stream (manifest before progressive file).

If the click leads to no source, the button enters its error state and the message is shown in a
toast.

**Hardening** (commit `004153d`, `ez-dl-68t`):

- the overlay ignores synthetic clicks: an event whose `isTrusted` is false (page script) triggers
  nothing (`src/content/videoOverlay.ts`);
- a media URL pointing to a private or loopback host (loopback, RFC 1918, link-local, ULA) is refused
  as a source: `isPrivateHostUrl` (`src/lib/privateHost.ts`), used by `src/lib/quickSource.ts`.

The **title** comes from the DOM around the clicked video, not from the page title:
`aria-label`/`title`/`data-title` attributes, then `h1`–`h4`, `[role="heading"]` and `figcaption`,
walking up at most 8 ancestors. The closest plausible candidate wins (`chooseVideoTitle`,
`src/lib/videoTitle.ts`), player control labels ("Play", "Pause", "0:42"…) are discarded, and the
fallback is `og:title` then the tab title — read from `sender.tab.title`, always fresh, where the
stored page snapshot may predate an SPA navigation.

Shared defaults (format choice, filename, folder) are the same ones the popup's source card uses:
both paths propose exactly the same thing for a given video.

**Positioning.** Outside full screen, the overlay host is `position:absolute` at the document origin,
and each button is placed in document coordinates: scrolling is handled by the compositor, with no
recalculation and no visible lag as long as the video stays entirely visible. In full screen (top
layer), the host switches to `position:fixed` on the full-screen element.

**Separation of concerns** — the content script only touches the DOM and messaging:

| Context | Role |
|---|---|
| `src/content/videoOverlay.ts` | `<video>` tracking, one badge per video, document-anchored positioning, toast |
| `src/content/tweetContext.ts` | "tweet" context of an X video (media id, permalink, rank, title) |
| `src/content/videoTitleDom.ts` | collecting candidate texts around a video |
| `src/lib/videoTitle.ts` | pure title choice (proximity, reliability, UI-noise filtering) |
| `entrypoints/background.ts` | routing of `QUICK_DOWNLOAD` to the service worker |
| `src/lib/quickDownload.ts` | source selection, probe on click + cache, cookies, lookup, `POST /api/jobs` |
| `src/lib/tweetSource.ts` | source selection for a tweet video (pure) |

Neither the server URL, nor the password, nor the cookies ever cross the page boundary: the content
script only receives a result — a job id or an error message. The tab and its URL always come from
`sender.tab`, never from the message. The only data accepted from the page — the clicked video's
media URL and title, plus the tweet context — goes through `sanitizeClickedVideo`: `http(s)` scheme
required, bounded lengths, title flattened to a single line before reaching `sanitizeFilename`. The
UI lives in a Shadow DOM (styles isolated both ways) and steps aside while the picker mode is active.

## On X / Twitter

On X, a tweet's video cannot be identified by its URL: `<video>.src` is a `blob:` (MSE player). Three
elements link the DOM element to the right tweet:

- **the media identifier**, present both in the poster URL (`pbs.twimg.com/…/<id>/…`) and in the
  sniffed stream URL (`video.twimg.com/…/<id>/…`): `mediaIdFromPoster` and `mediaIdFromMediaUrl`
  (`src/lib/twitterMedia.ts`);
- **the permalink** of the tweet, `/<user>/status/<id>`;
- **the rank** (1-based) of the video in the tweet. The content script reads it; it is
  `sanitizeClickedVideo` (`src/lib/quickSource.ts`), on the service worker side, that rejects any rank
  above **4** (`MAX_PLAYLIST_INDEX`). The server accepts up to **50** (`playlist_items`).

The context is read by `readTweetContext` (`src/content/tweetContext.ts`). The title takes the form
`@handle - text`. A **quoted tweet**'s video has no permalink of its own: only its media id is kept.
The `data-testid` selectors used (`User-Name`, `tweetText`) were checked live; X may change them, hence
fallbacks: a missing field does not prevent the others.

On click, `planTweetSource` (`src/lib/tweetSource.ts`) picks a source, in this order:

1. the **best sniffed stream of the same media** (same media id);
2. otherwise, a **probe of the permalink** with `playlist_items` = the video's rank;
3. otherwise, the error "Vidéo introuvable : ouvrez le tweet puis réessayez." (video not found: open the
   tweet and try again).

Golden rule: with a tweet context, the code **never** falls back on "the oldest stream of the tab" — on
a timeline, that is almost always another video. The permalink probe does not use the cache keyed on the
tab URL, which describes another video.

`isListingUrl` (`src/lib/listingUrl.ts`) applies the same logic to X pages: only a tweet's page
(`/<user>/status/<id>`) carries a video of its own; timeline, search and profile are listing pages.

## Duplicate detection

Before every submission — from the popup **and** from the overlay button — the extension asks the
server whether this video has already been downloaded:
`GET /api/jobs/lookup?url=…&folder=…&filename=…`.

Two signals, from the most explicit to the most factual:

| Signal | `reason` | What it catches |
|---|---|---|
| A job already exists for this address | `url` | the same link submitted a second time |
| The destination file exists on disk | `file` | a video reached through a different URL, or a purged history |

URL comparison **drops the query string** (`scheme://host/path`, lowercased host): CDN links carry
signature tokens, so two links to the same video differ on every page load. `canceled` and `error`
jobs do not count — nothing was delivered. A `done` job wins over a more recent, still-running one,
so the message names the file that is actually there.

**A warning, never a block**: the route only reports, the caller decides.

- **Popup**: the card shows a warning banner and the button becomes “Retélécharger” (re-download); the
  next click forces the submission.
- **Overlay button**: the badge turns amber (“already downloaded”) for 8 s; a second click within
  that window re-runs the job (`force: true` in `QUICK_DOWNLOAD`).

A server predating this route (404) or an unreachable one blocks nothing: the failed lookup is
swallowed and the download proceeds.

## Extending detection

- **New network patterns**: add the extension/content-type in
  `extension/entrypoints/background.ts`, with an associated Vitest test (see
  [conventions.md](../conventions.md#tests)).
- **New yt-dlp extractors**: no project action needed — handled by yt-dlp auto-update
  (`EZDL_YTDLP_UPDATE_INTERVAL_HOURS`); yt-dlp must remain the **standalone binary** for `-U` to
  work (see `MEMORY.md`).
- **Recurring problematic site**: prefer adding a `SiteRule` (learning mode) over site-specific
  code in the extension, to keep the sniffer generic.
