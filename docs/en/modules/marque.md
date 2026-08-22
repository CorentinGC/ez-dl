# Module — Brand

ez-dl's visual identity is a single mark, declined from the 16 px Chrome toolbar icon up to the
repository's 1280×640 social preview. Vector sources live in `assets/`; the renders are generated
and then **committed** where they are consumed.

## The mark

A solid downward arrow diving into an open tray: "download to my storage". The symbol carries no
"video" cue — legibility at 16 px comes first, and the video angle is already carried by the name
and the context.

The drawing sits on a **24×24** grid, on a full-bleed tile with `rx=5` corners. Chrome does not
round extension icons: the rounding is part of the drawing.

Two construction choices are worth knowing before any retouch:

- **The arrow is filled, the tray is stroked.** A first drawing with a stroked arrow (chevron) read
  as a cross at 16 px: below 24 px, head and shaft merge. The tray stays stroked because it is a
  container, not a mass.
- **Two variants of the same shape**, not two drawings. `icon.svg` serves every render ≥ 48 px;
  `icon-small.svg` thickens the tray stroke (2.4u → 3u) and tightens the arrow for the 16 and 32 px
  renders, with shape edges snapped to whole pixels of the 16 px grid.

## Palette

The colours are the interface's, not a parallel palette: the mark and the popup share one accent.

| Role | Light theme | Dark theme | Interface variable |
|---|---|---|---|
| Tile | `#2563eb` | `#3b82f6` | `--ez-accent` |
| Glyph | `#ffffff` | `#0b1220` | `--ez-accent-contrast` |
| Wordmark | `#0f172a` | `#f8fafc` | — |
| Social preview background | `#0b1220` | same | — |

`favicon.svg` embeds a `prefers-color-scheme` media query that swaps the tile; the
`extension/src/components/BrandMark.tsx` component reads the popup's CSS variables directly.

## Files

Sources in `assets/` — see [`assets/README.md`](../../../assets/README.md) for the tooling:

| File | Role |
|---|---|
| `icon.svg` | **Geometric reference**, renders ≥ 48 px |
| `icon-small.svg` | Hinted variant, 16 and 32 px renders only |
| `favicon.svg` | Hinted geometry + light/dark switch |
| `logo-light.svg` / `logo-dark.svg` | Mark + wordmark lockup, for the READMEs |
| `social-preview.svg` | GitHub social preview, 1280×640 |

Generated and committed renders:

| File | Consumer |
|---|---|
| `extension/public/icon/{16,32,48,96,128}.png` | MV3 manifest (`icons`), emitted by WXT at build |
| `server/app/static/favicon.ico` | `GET /favicon.ico`, multi-resolution 16/32/48 fallback |
| `server/app/static/favicon.svg` | `GET /favicon.svg` |
| `server/app/static/apple-touch-icon.png` | `GET /apple-touch-icon.png`, iOS home screen |
| `assets/social-preview.png` | Repository OpenGraph preview (manual upload) |

`logo-*.svg` and `social-preview.svg` re-embed the shapes from `icon.svg`: an SVG must stay
self-contained to be served as-is by GitHub. **`icon.svg` is authoritative**; a geometry change has
to be propagated by hand into the other three.

## Server brand routes

The three static files are served by `server/app/api/brand.py`, **without authentication** and
outside the OpenAPI schema. The reason is mechanical: a browser attaches no `Authorization` header
to a favicon request, a protected route would answer 401 and the tab would keep the generic icon.
This is the same reasoning as the `/extension` routes
([ADR 0004](../decisions/0004-distribution-extension-crx.md)).

The served paths are package constants, never derived from an input: this module opens no path
traversal surface. Every response carries `Cache-Control: public, max-age=86400`.

## Regenerating

```bash
make assets
```

The target installs the `assets/` dependencies (isolated: neither the server CI nor the extension
CI sees them) and rewrites every render. The PNGs are versioned so that the Docker build and the CI
never need npm or the network to produce an image.

## Usage rules

- **Do not recolour the tile** outside the two accent shades: the mark and the interface must stay
  the same colour.
- **Never render `icon.svg` below 48 px** — that is `icon-small.svg`'s job.
- **Clear space**: at least half the tile's height, free of any element.
- **Do not hand-edit the PNGs**: the next `make assets` overwrites them.
- **Do not distort the lockup**: scaling is uniform, never single-axis stretching.

## GitHub social preview

`assets/social-preview.png` is generated, but its deployment is **manual**: no repository file
drives it. Upload it under *Settings → General → Social preview*. Redo it after every change to
`social-preview.svg`.
