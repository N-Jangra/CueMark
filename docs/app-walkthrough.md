# App Walkthrough: Every Page and Option

Multi-page app — each screen is its own `.html` file, no client-side router. Bottom nav (Dashboard / Timeline / Statistics / Settings) is shared across the four main tabs; every "manage" sub-page has its own Back button returning to Settings.

```
index.html (boot splash, ~1.5s min hold, auto-redirect)
  → dashboard.html (default landing page)
      ├─ tab: timeline.html
      ├─ tab: statistics.html
      └─ tab: settings.html
            ├─ App Identity section
            │     ├─ App Icon           → manage-app-icon.html
            │     ├─ App Name           → manage-app-name.html
            │     └─ Bottom Menu Icons  → manage-nav-icons.html
            ├─ Tracking section
            │     ├─ Tracking Choices   → manage-tracking.html
            │     └─ Category Order     → manage-category-order.html
            ├─ Metadata section
            │     └─ Metadata Sources   → manage-metadata-sources.html
            ├─ Backup & Sync section
            │     └─ Backups & Restore  → manage-backups.html
            └─ Security section
                  └─ App Password       → manage-app-lock.html
```

If an app-lock method is set (Settings → Security → App Password), **every page above** — not just dashboard.html — is preceded by a full-screen lock overlay on first load each session, before any of its own content renders. See [app-lock.md](app-lock.md).

## index.html — Boot Splash

Animated logo + "Loading your dashboard" + pulsing dots. Holds for a **minimum 1.5 seconds** (scaled by the Animation Speed preference, read directly from `localStorage` since `app.js` hasn't loaded yet at this point) before redirecting to `dashboard.html`. No interactive elements.

## dashboard.html — Main Dashboard

- **Global Search** (`#global-search`) — filters the visible list by title/notes as you type (`state.searchQuery`).
- **Category Chips** — one per enabled category; tapping one sets `state.activeCategoryChip` and re-renders Dashboard/Timeline/Statistics to that category.
- **Item cards** — lazy-rendered in batches of 30 via `IntersectionObserver` (not all at once), each showing a completion checkbox, thumbnail (if enabled), title, status/progress/rating subtitle, and a category tag. The action affordance depends on **Dashboard Row Actions** (Settings):
  - **3-dot menu** (default) — tap the button for an Edit/Delete popup.
  - **Tap to edit, long-press to delete** — tap the card to edit, hold ~500ms to confirm delete.
  - **Swipe to edit/delete** — swipe the row to reveal Edit/Delete buttons.
- **Completion checkbox** — checking sets status to "Completed" and stamps today's date; unchecking reverts to the category's in-progress status.
- **FAB (+)** — opens the Add/Edit Item modal (see below).
- **Empty state** — shown when no items match the current filters.

## timeline.html — Completion History

- **Quick filters** — All Time / This Week / This Month (`state.timelineFilter`).
- **Advanced filter** (sliders icon) — modal with a title search, month dropdown, and a year dropdown populated from actual completion dates in your data.
- **Timeline list** — completed items only, grouped by month, lazy-rendered in batches of 30 the same way as Dashboard. Read-only (no per-item actions).

## statistics.html — Statistics

Five read-only stat cards, scoped to the active category chip: Completion Rate, In Progress count, Watchlist/Queue count, Completed count, Total Tracked count.

## settings.html — Settings Hub

Six sections, in order:

### Appearance
| Control | Options | Effect |
|---|---|---|
| Dashboard Row Actions | 3-dot menu / Tap-hold / Swipe | Changes how Dashboard cards are edited/deleted |
| Main Color | Normal + 16 named accent themes (Carnation Pink, Dark Green, Maroon, Navy Blue, Grey, White, Brown, Cool, Fire, Burple, Gren, Apple, Banan, Party, Pink Pain, Material You) | Accent color via `data-accent` attribute |
| Rating Format | 5 stars / 10 points / 10 points (decimal) / 100 points | How ratings are entered and displayed everywhere |
| Theme | Light / Dark / Grey / Amoled / Flashbang / Material You | Overall color scheme |
| **Animation Speed** | Off / Fast / Normal / Slow | Scales every CSS transition/animation duration app-wide via the `--anim-speed` variable (0.001x / 0.5x / 1x / 1.75x) |

### App Identity
- **App Icon** → `manage-app-icon.html`
- **App Name** → `manage-app-name.html`
- **Bottom Menu Icons** → `manage-nav-icons.html`

### Tracking
- **Tracking Choices** → `manage-tracking.html`
- **Category Order** → `manage-category-order.html`

### Metadata
| Control | Options | Effect |
|---|---|---|
| Metadata Mode | Offline / Online | Whether the Add/Edit modal calls out to metadata sources at all |
| Metadata Thumbnails | On / Off | Whether fetched thumbnails are shown/stored on items |
| Metadata Sources | — (link) | `manage-metadata-sources.html` |

### Backup & Sync
| Control | Options | Effect |
|---|---|---|
| **Folder Sync Delay** | Immediately / 5s / 10s / 30s / 1 minute | How long after an edit the app waits before auto-syncing to the backup folder |
| Backups & Restore | — (link) | `manage-backups.html` |

### Security
| Control | Effect |
|---|---|
| App Password | Link to `manage-app-lock.html`; the row's subtitle shows the current method (Off / PIN / Pattern / Password) |

## manage-app-icon.html

Grid of 12 launcher icon choices: **Classic**, **Turquoise** (**default**), **Orange**, **Pink** (flat solid-color icons), plus 8 illustrated variants — **Bento Grid**, **Glass Impact**, **Play Stack**, **Progress Ring**, **Vault**, **Orbit Hub**, **Progress Vault**, **Timeline Pulse**. Selecting one calls the native `AppIcon.setLook()` plugin, which flips exactly one pre-baked `activity-alias` on and all others off. A note explains icon switching only works in the installed Android app, not a browser preview.

(A **Purple** solid-color icon and an "invisible"/blank-white icon existed at one point and were both removed — Android substitutes a solid black fallback tile for genuinely transparent icons on many launchers, which made the invisible option not actually work as intended.)

## manage-app-name.html

List of 16 launcher name presets (Backlog, Binge Log, Checklist, ListKeeper, My Files, My Lists, My Watchlist, Notes, Reminders, Splash, CueMark, Squid, ToWatch, Tracker, Vault, Watchlist), crossed with all 12 icon variants.

## manage-app-lock.html — App Password

- **Method picker**: None / PIN / Pattern / Alphanumeric Password (radio rows).
- Choosing **None** applies immediately, no further steps.
- Choosing any other method reveals a secret-setup area (PIN: 4+ digit text field; Pattern: a drawable 3×3 dot grid, 2+ dots; Alphanumeric: a 4+ character text field), then — once a valid secret is entered — a **3 security questions** form (each with a question text field and an answer field, all required).
- **Save** hashes and stores everything, then returns to Settings.

See [app-lock.md](app-lock.md) for the full lock/rate-limit/recovery mechanics.

## manage-backups.html — Backups & Restore

- **Folder status notice** — shown if the saved backup folder is missing/invalid; startup also asks the user to select a replacement folder.
- **Export Data** — syncs the folder tree, then writes a full `.tar` backup (native) or falls back to a `.json` download (browser/non-native).
- **Import Data** — accepts `.json` or `.tar`; always merges by item ID, never overwrites existing items.
- **Change Backup Folder** — opens the native SAF folder picker. If the app currently has no tracked items and the picked folder already contains a `cuemark-db/` tree or a dated backup file, a follow-up confirm dialog offers to auto-restore from the newest one found (see [storage.md](storage.md)).
- **Sync to Folder Tree** — manually triggers a sync pass now, with a result alert (synced/skipped/error counts).
- **Wipe All Data** — confirms, then clears all items (preferences are untouched).

See [storage.md](storage.md) for the full sync/backup mechanics.

## manage-category-order.html

Drag-and-drop reorder of currently-enabled categories (`state.preferences.categoryOrder`). Disabled categories don't appear here.

## manage-metadata-sources.html

- **Built-in sources** (TVmaze, Wikidata, Open Library) — toggle on/off and drag-reorder. Parsing logic for these is fixed/uneditable.
- **Custom sources** — add/edit/delete/toggle. Each has a name, target categories, a search URL template (`{query}`/`{apiKey}` placeholders), an optional API key, and field mappings (results/title/thumbnail/subtitle paths) captured via a "Fetch Sample & Map Fields" clickable-JSON-tree picker rather than hand-typed paths.

See [metadata.md](metadata.md) for full mechanics.

## manage-nav-icons.html

Four icon-grid pickers, one per bottom-nav tab (Dashboard/Timeline/Statistics/Settings), 16 choices each. Selecting one updates `state.preferences.navIcons` and the live bottom nav immediately.

## manage-tracking.html

- One row per category (built-in + custom): enable/disable toggle; custom categories additionally get a delete button (blocked if the category still has tracked items).
- **Create new list** — modal with name, icon (20 choices), and a comma-separated statuses list; assigns a color automatically from a fixed palette.

## Add/Edit Item Modal

Opened via the Dashboard FAB (add) or an Edit action (edit). Fields:

**Always present**: Title, Category (dropdown, enabled categories only), Status (options depend on the selected category), Notes, Rating (star picker or numeric input depending on Rating Format), Completion Date (only shown once Status = "Completed", auto-filled with today).

**Category-specific**, rendered dynamically by `renderDynamicFormFields()`:
| Category | Extra fields |
|---|---|
| Series / K-Drama / C-Drama / Anime | Total seasons, per-season episode rows (total/watched/mark-season-complete checkboxes) |
| Manga | Total volumes, volumes read |
| Novel | Total volumes, volumes read, total chapters, chapters read |
| Movie | Playtime (hours + minutes, combined into one stored value) |
| Game / custom | No extra fields |

**Metadata** (Online mode only, non-custom categories): a "Fetch metadata" flow runs automatically as you type the title, showing either a single-result preview (thumbnail/title/meta) or a multi-result picker list to choose from. See [metadata.md](metadata.md).

## Category reference

| Key | Label | Statuses |
|---|---|---|
| `game` | Game | Backlog, Playing, On Hold, Dropped, Completed |
| `movie` | Movie | Watchlist, In Progress, On Hold, Dropped, Completed |
| `series` | TV Series | Watchlist, In Progress, On Hold, Dropped, Completed |
| `kdrama` | K-Drama | Watchlist, In Progress, On Hold, Dropped, Completed |
| `cdrama` | C-Drama | Watchlist, In Progress, On Hold, Dropped, Completed |
| `anime` | Anime | Watchlist, In Progress, On Hold, Dropped, Completed |
| `manga` | Manga | Reading, On Hold, Dropped, Completed, Plan to Read |
| `novel` | Novel | Reading, On Hold, Dropped, Completed, Plan to Read |
| *(custom)* | user-defined | user-defined (default: Backlog, In Progress, On Hold, Dropped, Completed) |
