# "Database" Schema

There is no SQL database in this app. On Android, the main state is stored as an encrypted JSON blob using an Android Keystore AES-GCM key; browser builds and auxiliary UI values use the browser/WebView's `localStorage` fallback (see [storage.md](storage.md)).

`state` (defined in `www/app.js`) is the in-memory object serialized into the encrypted Android store on native builds, or `localStorage` on web, and reloaded on every page load via `loadData()`.

## `cuemark_items` → `state.items: Item[]`

```
Item {
  id: string                    // crypto.randomUUID()
  title: string
  category: string              // "game" | "movie" | "series" | "kdrama" | "cdrama"
                                 // | "anime" | "manga" | "novel" | <custom category key>
  status: string                // one of CATEGORIES[category].statuses
  rating: number                // internal scale 0-5, regardless of display ratingFormat
  completionDate: string | null // "YYYY-MM-DD"
  notes: string
  created: number               // Date.now() at creation
  thumbnail: string             // remote image URL, or "" — never stored image bytes

  // --- category-specific fields, merged in via spread (...extraData) ---

  // series | kdrama | cdrama | anime:
  totalSeasons?: number
  episodesDone?: number
  totalEpisodes?: number
  seasonEpisodes?: {
    [seasonKey: string]: {      // e.g. "season1", "season2", ...
      total: number
      watched: number
      completed: boolean
    }
  }

  // manga | novel:
  volumesRead?: number
  totalVolumes?: number | ""

  // novel only:
  totalChapters?: number | ""
  chaptersRead?: number

  // movie:
  playtime?: number | ""         // total minutes (combined from hours+minutes fields)
}
```

Notes:
- `thumbnail` is always a URL string (from TVmaze/Wikidata/Wikimedia Commons/Open Library, or a custom metadata source), never embedded image data. See [storage.md](storage.md) for what this means for offline/persistence.
- Games and custom categories carry no extra fields beyond the universal set.
- `rating` is always stored 0–5 internally; `ratingFormat` in preferences only controls *display* conversion (`formatRatingValue()`/`ratingToStoredValue()` in `app.js`).

## `cuemark_prefs` → `state.preferences`

```
preferences {
  // Category enable/disable toggles (built-in categories only; custom categories
  // get their own boolean key here too, added dynamically by key)
  game: boolean
  movie: boolean
  series: boolean
  kdrama: boolean
  cdrama: boolean
  manga: boolean
  anime: boolean
  novel: boolean

  customCategories: {
    [key: string]: {
      label: string
      color: string            // hex, cycled from CUSTOM_CATEGORY_COLORS
      icon: string              // lucide icon name
      statuses: string[]
      custom: true
    }
  }

  categoryOrder: string[]        // category keys, display order

  defaultStartPage: string       // "remember-last" | "tab-dashboard" | "tab-timeline" | ...
  ratingFormat: string           // "5-stars" | "10-points" | "10-decimal" | "100-points"
  uiTheme: string                // "dark" | "light" | "grey" | "amoled" | "flashbang" | "material-you"
  mainColor: string              // accent theme key (17 choices, see app-walkthrough.md)
  dashboardRowActions: string    // "menu" | "tap-hold" | "swipe"

  metadataMode: string           // "offline" | "online"
  metadataThumbnails: boolean
  folderSyncDelay: string        // "0" | "5000" | "10000" | "30000" | "60000" (ms, as string)
  animationSpeed: string         // "off" | "fast" | "normal" | "slow"

  metadataSources: {
    builtinOrder: string[]       // ["tvmaze", "wikidata", "openlibrary"], reorderable
    builtinEnabled: {
      tvmaze: boolean
      wikidata: boolean
      openlibrary: boolean
    }
    custom: Array<{
      id: string                 // crypto.randomUUID()
      name: string
      categories: string[]       // which category keys this source applies to
      enabled: boolean
      searchUrlTemplate: string  // contains {query} and optionally {apiKey}
      apiKey: string             // stored plaintext locally; redacted when mirrored to disk
      resultsPath: string        // dot-path to the results array in the JSON response
      titlePath: string          // dot-path relative to one result item
      thumbnailPath: string
      subtitlePath: string
    }>
  }

  navIcons: {
    dashboard: string            // lucide icon name
    timeline: string
    stats: string
    settings: string
  }

  appIconVariant: string         // "classic" | "turquoise" | "orange" | "pink" | "bentogrid"
                                 // | "glassimpact" | "playstack" | "progressring" | "vault"
                                 // | "orbithub" | "progressvault" | "timelinepulse"
  appNameIndex: number           // 0-15, index into APP_NAME_CHOICES

  appLock: {
    method: string                // "none" | "pin" | "pattern" | "alphanumeric"
    passwordHash: string          // hex PBKDF2-SHA256 hash, empty if method is "none"
    passwordSalt: string          // hex random salt used for passwordHash
    securityQuestions: Array<{
      question: string
      answerHash: string          // hex PBKDF2-SHA256 hash of the normalized answer
      answerSalt: string
    }>                             // empty until a lock method is first set; 3 once set
  }
}
```

See [metadata.md](metadata.md) for how `metadataSources` is actually used at lookup time, [app-lock.md](app-lock.md) for how `appLock` secrets are hashed/verified/reset, and [app-walkthrough.md](app-walkthrough.md) for what each preference's settings-page control looks like.

## Other individual `localStorage` keys

Not nested under items/prefs — small standalone values, mostly UI/session state or things read before `app.js` has fully initialized:

| Key | Purpose |
|---|---|
| `cuemark_theme` | Legacy/duplicate theme value (superseded by `preferences.uiTheme`, kept for back-compat) |
| `cuemark_ui_theme` | Same, written/read alongside `preferences.uiTheme` |
| `cuemark_main_color` | Same pattern for accent color |
| `cuemark_rating_format` | Same pattern for rating format |
| `cuemark_sort` | Current dashboard sort order |
| `cuemark_category_chip` | Last-active category chip (fallback source used by Timeline/Statistics) |
| `cuemark_timeline_filter` | Quick filter: `"all"` \| `"week"` \| `"month"` |
| `cuemark_last_entry_category` | Category pre-selected next time the Add modal opens |
| `cuemark_last_tab` | Last visited bottom-nav tab, used to restore on relaunch if `defaultStartPage` is `"remember-last"` |
| `cuemark_backup_folder_uri` | SAF `content://` tree URI for the chosen backup folder (Android only) |
| `cuemark_backup_folder_invalid` | `"true"`/`"false"` flag set by the startup storage check; drives the notice on the Backups & Restore page |
| `cuemark_synced_item_hashes` | `{ [itemId]: JSON.stringify(item) }` — per-item hash cache so `cuemark-db/` folder-tree sync only rewrites items that actually changed |
| `cuemark_lock_failed_attempts` | Count of consecutive wrong app-lock attempts (persists across restarts — this is what makes rate limiting/the "Forgot password" reveal survive an app kill) |

## `sessionStorage` keys (cleared when the app process is killed, not just on navigation)

| Key | Purpose |
|---|---|
| `cuemark_lock_unlocked` | `"true"` once the correct app-lock secret has been entered this session. Intentionally *not* `localStorage` — the lock must re-trigger every time the app is actually reopened, not just on page navigation within one session. See [app-lock.md](app-lock.md). |

## Schema evolution / defaults

`loadData()` runs a normalization pass on every load: any preference missing from a saved (older) blob is filled in with its current default. This means the schema above is always backfilled — there is no explicit migration/version field, just "fill in what's missing, drop nothing." `normalizeMetadataSources()` does the same for the nested `metadataSources` object specifically, and `normalizeAppLock()` for the nested `appLock` object.
