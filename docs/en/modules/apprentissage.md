# Module — Learning

Learning mode ("assisted detection") kicks in when neither the yt-dlp probe nor automatic network
sniffing has found a video on the active page (see [modules/detection.md](detection.md)). It
turns a one-off manual intervention into a reusable rule for subsequent visits to the same
domain.

Tracked by beads epic `ez-dl-ek5`.

## Trigger

In the popup, if the `/api/probe` + sniffing merge returns no result, a **"Help detect"** button
appears. Clicking it triggers the DOM picker in the active tab.

## 1. DOM picker (`content.ts`)

The content script (`extension/entrypoints/content.ts`) activates an interactive selection mode
on the page:

- **Hover**: the element under the cursor is highlighted (an injected visual outline, without
  persistently modifying the page's DOM).
- **Click**: selects the element — typically a `<video>` tag, or a container enclosing the player
  (iframe, player div) if no native `<video>` tag is found directly.
- The selected element (tag, relevant attributes such as `src`/`currentSrc`, position in the DOM)
  is sent back to `background.ts` via a runtime message.

## 2. Network correlation (`background.ts` + `extension/src/lib/detection.ts`)

Correlation links the element picked through the DOM picker to a usable media URL. It receives the
tab's recent candidates, coming from the same sniffer as automatic detection (see
[modules/detection.md](detection.md#2-network-sniffing-extension)).

`correlatePickedElement` (`extension/src/lib/detection.ts`) applies, in this order:

- if the element itself carries a recognised media URL (`currentSrc`, falling back to `src`), it is
  kept (source `picked`);
- otherwise, the candidate most recently detected by the sniffer is kept: the best available
  approximation, since the user has just clicked the player;
- without an element or a candidate, there is no proposal.

There is no time window and no silent choice among several candidates: the single result is shown to
the user, who confirms or not (see section 3).

## 3. Proposal and confirmation

The popup displays the candidate URL resulting from the correlation. The user can:

- accept it as-is and start a job normally (like an automatically detected video);
- if the URL format is reusable for other videos on the same site (a generic pattern identified,
  e.g. a `/hls/{id}/index.m3u8` path), save a **site rule**.

### Automatic pattern generalization

Memorizing the exact URL would be useless as soon as the next video loads: CDNs almost always
encode a variable identifier (numeric id, hash, UUID, token) in the path or query string. Before
saving, `generalizeUrlPattern` (`extension/src/lib/detection.ts`) reduces these variable
identifiers to `*` wildcards, while keeping the scheme, host, and stable path structure:

- a **fully variable path segment** (numeric id ≥ 2 digits, hexadecimal hash ≥ 8 characters, UUID,
  random token ≥ 16 characters) becomes `*`;
- a **mixed segment** (literal prefix/suffix around an identifier, e.g. `video-12345.mp4`) only
  generalizes the variable part and keeps the rest, including the file extension
  (`video-*.mp4`);
- in the **query string**, keys are kept and every value is replaced with `*`
  (`?id=12345&token=abc…` → `?id=*&token=*`);
- the **fragment** (`#...`) is dropped: it is never sent by the browser to the server, so it is
  meaningless in a network-matching pattern;
- an invalid URL is returned unchanged, with no generalization attempted.

The generalized pattern is what's shown in the picker banner (not the raw URL): the user sees
exactly what will be saved before confirming. It always matches the source URL it was derived
from via `patternToRegExp` (see [modules/detection.md](detection.md)).

## 4. Saving the rule (`POST /api/rules`)

```json
{"domain": "example.com", "url_pattern": "*/hls/*/index.m3u8", "label": "Main player", "notes": "Detected via DOM picker on 2026-08-21", "source": "learned"}
```

`url_pattern` is a **simple glob/regex** (see
[architecture.md](../architecture.md#data-model)) applied by the sniffer to future network
requests detected on `domain` — it is the pattern already generalized by `generalizeUrlPattern`
above, not the raw observed URL. `source: "learned"` distinguishes these rules from manually added
rules (`source: "manual"`, e.g. via a future advanced options page) in `GET /api/rules`.

## 5. Reuse

On subsequent visits to the same domain, `background.ts` loads the relevant `SiteRule` entries
(`GET /api/rules`, filtered by `domain`, cached on the extension side) and applies them with
priority in the sniffer: any network request whose URL matches a known `url_pattern` is
immediately proposed in the popup, without going through the DOM picker again. The user can
delete a rule that has become obsolete (`DELETE /api/rules/{id}`) if the site's structure changes
and the rule produces false positives/negatives.

## Implementation caveats

- The DOM picker must be **non-intrusive**: do not persistently modify the page's final DOM
  (clean up highlight styles when the mode is deactivated).
- Correlation must handle the absence of a clear result without crashing: offer "no candidate
  found" rather than an incorrect URL.
- Every saved rule goes through `POST /api/rules`'s standard pydantic validation on the server
  side (see [conventions.md](../conventions.md#security)) — no bypassing input validation just
  because the data comes from a "trusted" correlation.
