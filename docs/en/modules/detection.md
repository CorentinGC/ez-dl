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

## Merging results on the popup side

The popup (`extension/entrypoints/popup/`) merges, at open time:

1. the result of `GET/POST /api/probe` on the active tab's URL (if the yt-dlp extractor
   recognizes the site);
2. the streams sniffed on the `background.ts` side for that tab, filtered/prioritized by the
   `SiteRule` entries known for the domain.

If no source returns a result, the popup offers the **"Help detect"** button, which launches
learning mode.

## Extending detection

- **New network patterns**: add the extension/content-type in `extension/lib/sniffer.ts`, with an
  associated Vitest test (see [conventions.md](../conventions.md#tests)).
- **New yt-dlp extractors**: no project action needed — handled by yt-dlp auto-update
  (`EZDL_YTDLP_UPDATE_INTERVAL_HOURS`); yt-dlp must remain the **standalone binary** for `-U` to
  work (see `MEMORY.md`).
- **Recurring problematic site**: prefer adding a `SiteRule` (learning mode) over site-specific
  code in the extension, to keep the sniffer generic.
