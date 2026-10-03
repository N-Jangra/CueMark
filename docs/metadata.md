# Metadata Lookup

Online metadata lookup (thumbnails, season/episode counts, runtime, etc.) is opt-in via **Settings → Metadata Mode → Online** (default is Offline — manual entry only, no network calls). Everything lives in `www/metadata.js`.

## Entry point

`fetchAndApplyMetadataFromTitle()` runs whenever the title field changes in the Add/Edit Item modal (if online mode is on and the category is one of the lookup-eligible ones: series/kdrama/cdrama/anime/movie/game/manga/novel — not custom categories). It:

1. Checks `builtinSourceEnabled(key)` for the relevant built-in source before calling it.
2. Calls `fetchAllCustomMetadataSources(category, title)` to run every enabled custom source configured for that category, in parallel.
3. Merges built-in results + custom results into one list.
4. If more than one result total, shows a picker (`showMetadataResults()`); if exactly one, applies it directly.

## Built-in sources (fixed parsing, toggle/reorder only)

These are hardcoded — the settings UI can enable/disable and reorder them, but their request/response parsing is not user-editable (see "Why custom sources are separate" below).

| Source | Categories | Search endpoint | Detail/follow-up |
|---|---|---|---|
| **TVmaze** | series, kdrama, cdrama, anime | `GET api.tvmaze.com/search/shows?q=<title>` | `applySelectedSeriesMetadata()` does a second request `GET api.tvmaze.com/shows/<id>?embed=episodes` to compute season/episode counts from the embedded episode list |
| **Wikidata** | movie, game | `GET wikidata.org/w/api.php?action=wbsearchentities&search=<title>&type=item` | `applySelectedMovieMetadata()`/`applySelectedGameMetadata()` fetch `action=wbgetentities` and read specific claim IDs: `P2047` (duration, movies), `P18` (image → rendered via `commons.wikimedia.org/wiki/Special:FilePath/<file>`), `P577` (release date, games) |
| **Open Library** | manga, novel | `GET openlibrary.org/search.json?title=<title>` | No follow-up request — cover thumbnail built directly from `doc.cover_i` (`covers.openlibrary.org/b/id/<id>-M.jpg`), edition count pre-fills a "total volumes" guess |

Toggling a built-in source off in **Settings → Metadata Sources** simply skips calling it in `fetchAndApplyMetadataFromTitle()`; reordering (`builtinOrder`) currently only affects list display order, not fetch priority — all enabled sources fire and their results are concatenated (built-ins first, then custom).

## Custom sources (generic, user-configured)

Added/edited/deleted via **Settings → Metadata Sources → Add custom source**, in `manage-metadata-sources.html`. Each one is a plain object (see the `custom` array in [db-schema.md](db-schema.md)) with:

- `categories` — which tracking categories this source applies to.
- `searchUrlTemplate` — a URL containing `{query}` (URL-encoded search title) and optionally `{apiKey}`.
- `apiKey` — substituted into the template; stored locally, redacted to `"***REDACTED***"` whenever the config is mirrored to `cuemark-db/settings/metadata-sources.json`.
- `resultsPath`, `titlePath`, `thumbnailPath`, `subtitlePath` — dot-notation JSON paths (e.g. `"data.results"`, `"image.medium"`) used to pull fields out of the live response.

At fetch time, `fetchCustomMetadataSource()`:
1. Builds the URL from the template.
2. Fetches and parses JSON.
3. Resolves `resultsPath` against the response via `resolveJsonPath()` (a simple `.`-split reduce — no array-index or wildcard syntax, just plain key traversal).
4. Maps each entry in that array through `titlePath`/`thumbnailPath`/`subtitlePath` (each resolved *relative to* one result item).
5. Returns up to 8 normalized `{id, title, subtitle, thumbnail, kind, customSourceId}` objects.

Custom-source results carry no follow-up detail endpoint — unlike TVmaze/Wikidata, selecting one just applies whatever the mapped fields already gave you (`applyCustomMetadataResult()`). No season/episode counts, no runtime, no auto-fill beyond title/subtitle/thumbnail.

### Field mapping without typing paths

Rather than asking the user to hand-write `resultsPath`/`titlePath` strings, **manage-metadata-sources.html**'s "Fetch Sample & Map Fields" button:

1. Calls the configured URL once with `"cue"` as a test query.
2. Renders the JSON response as an indented, clickable tree (`renderJsonNode()` in `metadata.js`) — arrays are labeled `<key> [array]`, objects recurse, leaves show `key: value`.
3. Walks the user through 4 clicks in order: click the results array → click the title field (inside the first sample item) → optionally click a thumbnail field → optionally click a subtitle field.
4. Each click computes a path relative to the previously-picked array (`advance()` in `openJsonFieldMapperModal()`), and stores it into the draft source config.

This only samples the *first* array element from the test query — if a real API's fields vary between results (e.g. some entries lack a thumbnail key), the picker won't reveal that; the field mapping is a best-effort based on one sample.

## Why custom sources are a separate, simpler path

TVmaze/Wikidata/Open Library each need parsing logic that doesn't fit a generic "JSON path per field" contract — Wikidata's data lives inside a `claims` object keyed by property ID (`P18`, `P2047`, `P577`), and TVmaze needs a second request to get episode counts. Rather than force those into the generic system (which would mean dropping season/episode enrichment, runtime, etc.), built-ins stay hardcoded and custom sources get the simpler, less-capable generic path. This was a deliberate scope decision, not an oversight.

## Thumbnails are always remote URLs

Everything above only ever produces a `thumbnail` **URL** (TVmaze CDN, Wikimedia Commons, Open Library covers, or whatever a custom source's `thumbnailPath` resolves to). No image bytes are downloaded or embedded into `state.items` — see [storage.md](storage.md) for what that means for offline access, and [file-schema.md](file-schema.md) for the one place actual thumbnail bytes *are* saved (the `cuemark-db/` folder-tree mirror, which fetches the URL and re-encodes to WebP at sync time only).
