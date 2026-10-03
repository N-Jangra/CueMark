# Changelog

All notable changes to SquashDB are documented in this file.

## [0.0.7]

### UI and navigation
- Refreshed the Dashboard layout with improved collection cards, category controls, search, filters, insights, loading states, and empty states.
- Renewed the top and bottom navigation bars with improved spacing, active-state styling, solid/translucent backgrounds, and better mobile behavior.
- Added draggable mobile ordering for bottom navigation items and navigation settings improvements; Dashboard and Settings remain available.
- Improved page headers, back navigation, popup behavior, alignment, responsive layouts, and theme-aware styling across the app.
- Added pull-to-refresh feedback on the Dashboard and ensured Android Back closes an open popup before navigating away.

### Settings and personalization
- Expanded Appearance settings with accessibility presets, reduced motion, text size, font, theme, main color, animation speed, bottom-bar styling, transparency, and scrollbar visibility controls.
- Refined Settings subpages and moved network behavior controls into Privacy & Network.
- Added or improved controls for Dashboard & Navigation, Metadata, Backup & Sync, Data, Notifications, Security, and About.
- Removed obsolete Advanced and Information settings pages and consolidated their useful destinations into the main Settings page.
- Improved theme consistency, contrast, modal surfaces, switches, icons, and mobile drag-and-drop interactions.

### Detail pages and metadata
- Improved show-detail artwork backgrounds using thumbnail colors and refined episode presentation, rating controls, and circular episode checkboxes.
- Fixed saved show metadata so all seasons, episodes, and thumbnails are retained instead of only Season 1.
- Improved metadata source and Explore page title alignment and source navigation.

### Icons and Android resources
- Removed obsolete alternate app icons and their unused Android resources.
- Improved the remaining app icon/name configuration and related settings presentation.

### Import and export
- Added dedicated Settings pages for importing and exporting lists instead of using a popup workflow.
- Added CSV, TSV, and TXT import support with category-aware status handling, duplicate policies, previews, and configurable metadata sources.
- Added background metadata syncing with a persistent queue, retry and pause/resume controls, import status tracking, and a beta worker-count setting.
- Added category-specific export with CSV, TSV, and TXT output and timestamped filenames such as `squashdb-anime-YYYYMMDD-HHmmss.csv`.

### Storage and data management
- Added a Settings → Storage page with total usage, library category usage, metadata cache, thumbnail cache, preferences, watch history, and backup size breakdowns.
- Added controls to clear metadata cache, thumbnail cache, all temporary caches, tracked data, and perform a factory reset with in-app confirmation.
- Added local example and planning-note patterns to `.gitignore`.

### Dashboard and progress
- Added complete Dashboard sections for On hold, Dropped, and other statuses without limiting each section to four items.
- Added Statistics totals for all tracked status groups, including On Hold and Dropped.
- Movies and games now show ratings and status pills instead of misleading percentage progress indicators.
- Fixed completion handling so episodes, seasons, chapters, and volumes are marked complete when an item is completed.
- Improved manga and novel progress calculation using chapter or volume totals.
- Improved Statistics time-left estimates using cached episode runtimes and watched episode data.
- Fixed Statistics activity charts to use real watch history and provide useful fallback activity for imported items.
- Updated show-detail completion handling to keep completed item progress consistent.

### Settings and detail presentation
- Reordered Settings sections and options alphabetically, moved Information to the bottom, and grouped Metadata & Storage together.
- Added clearer spacing between Settings groups and the new Storage entry.
- Improved show-detail navigation and completion behavior.
- Added configurable dashboard defaults, recently-added limits, card corner styles, progress increments, automatic completion behavior, rating reminders, and notes templates.
- Added metadata refresh/retry controls, offline fallback behavior, scheduled thumbnail cleanup, and configurable import/export defaults.
- Added backup safety, notification, security, data maintenance, and advanced preference controls, including storage limits, cache cleanup, retry policies, auto-lock options, duplicate detection, and network tuning.
- Added Settings → Storage usage warnings and expanded storage breakdown and cleanup controls.

## [0.0.6]

### Performance and persistence
- Improved startup performance with immediate loading guards, cached progress values, dashboard result caching, batched dashboard rendering, and consistent search debouncing.
- Scoped icon rendering and reduced unnecessary work during page updates.
- Replaced list-view insight progress rings with compact horizontal progress bars, including green completed-state bars.
- Fixed TV-series progress percentages to count watched and total episodes across all seasons instead of using only completed-season ratios.
- Bounded dashboard DOM rendering with a sliding window of batches so large libraries do not keep every card mounted at once.
- Android encrypted persistence now stores individual encrypted item records plus separate encrypted metadata instead of rewriting one complete encrypted state blob.
- Added automatic migration from legacy encrypted state and removal of the old snapshot after successful migration.

### Android and biometric unlock
- Added Android biometric and device-credential availability handling for API 22+.
- Added `USE_BIOMETRIC` and legacy `USE_FINGERPRINT` permissions.
- Improved biometric setup and error messages when the device has no enrolled credential or the native plugin is unavailable.
- Added a visible Enable Biometric Unlock action that checks availability before saving the biometric lock method.
- Verified the Android debug build with the updated native plugins.

### Settings and navigation polish
- Redesigned Settings with a compact grouped layout, theme-aware colors, accent-aware controls, and clearer section organization.
- Changed on/off settings to inline switches instead of opening selection popups.
- Removed the Navigation Style setting; app navigation is now direct everywhere.
- Added direct navigation from Timeline and Statistics without the navigation-sheet overlay, while preserving back navigation.
- Added dedicated headers and simplified the Timeline and Statistics page actions.
- Added touch-friendly drag handles for reordering metadata sources and bottom navigation items in Android WebView.
- Shortened Dashboard Row Actions labels and changed boolean settings to compact inline controls where appropriate.
- Added a guided multi-step App Lock setup flow with secret confirmation, optional recovery questions, and a direct biometric path.
- Refreshed Backup management with separate Backup, Status, and Cloud & Recovery tabs while keeping all backup controls available.
- Improved notification time and quiet-hours dialogs with clear full-width Save buttons.
- Refined Settings subpage headers, descriptions, and mobile spacing for Category Order and Tracking Choices.
- Added consistent deferred asset loading across pages and improved back-navigation enter/exit transitions.

### Dashboard and show details
- Added dedicated Dashboard sections for On hold and Dropped items without duplicating them in other insight sections.
- The Show Detail Next Episode action now switches season, expands the episode synopsis, and scrolls the episode into view.

### Explore and changelog
- Redesigned Explore insights and metadata-source sections as grouped list rows with clearer icons and navigation chevrons.
- Changed the in-app changelog to collapsible version sections, with the newest version expanded by default.
- Applied consistent mobile edge-to-edge spacing to Explore, Statistics, Dashboard, information pages, and Settings subpages.
- Improved Android toast layout so long messages wrap inside a compact rounded notification without clipping.

### SteamDB and Steam details
- Added SteamDB source search and detail-page support, including Steam descriptions, thumbnails, screenshots, prices, Steam links, and price-history links.
- Added an in-app screenshot gallery with horizontal scrolling and previous/next navigation instead of opening screenshots in an external browser.
- Improved Steam purchase-card layout for mobile screens.

### Web structure and navigation
- Reorganized HTML pages, styles, and JavaScript into `www/static/`, `www/core/`, and `www/features/` directories.
- Added route normalization and compatibility handling for old page URLs, query parameters, Android back navigation, and direct navigation.
- Fixed startup routing, missing-page redirects, WebView asset paths, and the initial loading/theme/navigation transition.
- Updated the development server and Android build configuration for desktop, LAN, and Capacitor use.

### Documentation
- Added Android build and project requirements notes.
- Added a performance review with completed improvements and remaining work.

## [0.0.5]

### Android and security
- Added encrypted Android local state storage backed by an Android Keystore AES-GCM key, with browser `localStorage` retained as the web fallback.
- Added encrypted `.sqdbe` backups using PBKDF2-SHA256 and AES-256-GCM.
- Added optional cloud sync for encrypted backups through a user-supplied HTTPS/WebDAV endpoint.
- Added Android biometric unlock support.
- Added Android WorkManager background snapshots and cleanup of older snapshots.
- Added Android notification support, notification receivers, share intents, and a progress widget.

### Backups and cache management
- Added backup recovery/status handling, storage-location checks, recovery previews, backup health information, and progress feedback for large backups.
- Added metadata-cache, image-cache, font-cache, WebView-cache, and cache-limit controls.
- Added automatic image-cache limiting and safer temporary-cache cleanup without removing tracked data or backups.
- Moved backup, cache, navigation, and search behavior into separate JavaScript feature modules.

### Dashboard and navigation
- Added Continue Watching, Recently Added, and Completed dashboard sections without repeating the same item across sections.
- Added a Not started yet section for saved items with no progress, marked as Ready to start without duplicating them in the main list.
- Added list and poster-grid dashboard layouts with progress rings, progress strips, quick actions, and improved empty/loading states.
- Added improved Android back-button handling, swipe-back behavior, direct bottom-bar navigation, and persistent navigation settings.
- Added responsive mobile and tablet layout improvements, floating add actions, and cleaner bottom-sheet interactions.

### Search and item details
- Added search across titles, notes, genres, statuses, tags, and providers with filters, sorting, and search history.
- Added improved item-detail headers, progress display, episode filters, next-episode actions, notes, related provider results, and offline metadata indicators.
- Added faster item entry with remembered choices, duplicate warnings, drafts, undo-after-delete, share-intent support, and barcode/QR scanning hooks.
- Fixed related-title suggestions using provider results instead of unrelated saved database items.
- Fixed Shikimori and MangaDex manga/manhwa/manhua searches: manga mode is selected correctly, API responses are parsed robustly, requests retry, and real API errors are shown instead of being reported as empty results.

### Notifications and visual polish
- Added separate notification controls for episode reminders, backups, sync failures, and unfinished items, including quiet hours and snooze options.
- Added toast feedback, animated success/error states, skeleton loading, pressed states, haptic-action hooks, reduced-motion support, and accessible contrast improvements.
- Added configurable weekly/monthly statistics graphs and improved chart rendering.

### App identity
- Added Controller and Gear app icon/name choices in App Icons and Names.
- Added Android launcher aliases and native icon resources so both choices can be applied from the installed app.

## [0.0.4]

### Show detail page (redesign)
- New native-app-style layout: poster/title header, a grouped "Tracking" card (Add to list, Status, Completion Date) reusing the app's bottom-sheet picker, and a pill-style season selector opening the same sheet.
- Episode rows now show a circular checkmark toggle, expand in place to reveal the synopsis when one exists, and open a full-image popup when the thumbnail is tapped — the show poster is tappable the same way.
- Star rating widget enlarged with a gold glow to match the active state.
- Topbar simplified to flat text links (`‹ Back` / category label); a delete icon replaces the old 3-dot menu, shown only while a title is still in Watchlist or In Progress.
- Fixed a bug where re-opening an already-tracked show from Discover created a duplicate entry instead of reusing the existing one — every metadata provider now carries a `providerId` used to detect this.
- Saved games now open the shared detail page too, instead of the legacy dashboard edit modal.

### Discover
- Added a per-category source filter (sliders icon next to the search bar): pick exactly which enabled sources a search should run against, down to just one. The choice is saved per category and persists across app restarts.
- Removed the separate Kdrama/Cdrama category chips — TVmaze has no first-class distinction for them, so searching "Series" now also surfaces Korean/Chinese dramas (still tagged with their real category once opened).
- Added browser-safe metadata fetching through the built-in local proxy/server so CORS-blocked sources can still load in desktop browser mode and in APK/WebView builds.
- Added or improved anime episode metadata handling across AniList, Jikan, and Kitsu, including runtime and synopsis fallbacks where the source does not provide full episode data.

### Explore
- Now lists only currently-enabled metadata sources (previously showed every source, dimmed if disabled).
- Added a toolbox icon linking straight to Settings → Metadata Sources; Timeline/Statistics quick links moved below the sources grid, separated by a divider.

### Settings
- New **App Data** section: App Info (what the app does and how), Usage Guide (a walkthrough of every tab and setting, including a full per-page breakdown of Settings itself), Logcat (captured console/error logs with All/Info/Warnings/Errors filters and a clear button), Changelog (renders this file in-app), and a GitHub link.
- New **Font** setting: change the whole app's font. Six system stacks work fully offline; six Google Fonts download once, cache on-device via the Cache Storage API, and mirror to the backup folder (if one's configured) so they keep working offline afterward.
- Reordered the Appearance section: Theme, Font, Main Color, and Animation Speed (visual theming) now precede Dashboard View, Dashboard Row Actions, and Rating Format (dashboard-specific behavior).
- Icon pickers with long option lists (Bottom Menu Icons, Create New List) now scroll as a snapping horizontal carousel instead of wrapping into a tall grid.
- Every settings subpage's back button restyled to match the flat text-link topbar introduced on the show detail page.
- Saved manga/game entries now keep the delete action visible when they are in a removable status.

### Backups
- Poster thumbnails synced to a backup folder are now accompanied by a `.nomedia` marker in `squash-db/`, so Android's media scanner stops surfacing them in the device photo gallery.

## [0.0.3]

### Discover (new search experience)
- New category-first Discover tab: pick a tracking category chip (same set as the Dashboard), see up to 15 top-rated suggestions immediately, then search scoped to just that category across every enabled metadata source in parallel — results merged and deduped by title.
- Each result card shows a badge naming the metadata source it came from.
- The selected category and typed query survive opening a result and coming back, instead of resetting to the first tab.
- Manga, novels, and games are now searchable online (previously only reachable through the old edit-modal's fetch button).

### Metadata sources (3 → 10 built-in)
- Added AniList, Jikan (MyAnimeList), and Kitsu for anime/manga, Google Books for novels/manga, OMDb and TMDB for movies/series, and RAWG for games — alongside the existing TVmaze, Wikidata, and Open Library.
- Sources that need a free API key (RAWG, OMDb, TMDB) ship disabled with a key field and sign-up link in Settings → Metadata Sources.
- Wikidata movie/game results now backfill poster images in one batched request (its search API returns no images).

### Show detail page (new)
- Full-page detail view for search results and tracked items: cover with wrap-around summary, release year/genres/runtime, network (Netflix, HBO...), a production-status badge (Running/Ended), and the item's metadata source.
- Season dropdown with a per-episode list (thumbnail, air date, runtime, rating, per-episode synopsis) — ticking an episode auto-marks all earlier ones watched, and the page opens on the first season that still has unwatched episodes.
- Status follows progress: ticking the final episode marks the item Completed with today's date; unticking below full (or starting from the watchlist) moves it to In Progress.
- "Add to list" picker (choose or correct the category), status, completion date, rating in your chosen format, and notes — all editable in place; volume/chapter progress fields for manga/novels.
- 3-dot menu with a delete action; opening a tracked TVmaze item online re-syncs its episodes and show metadata from the source.
- Movies, manga, and novels open this page from the Dashboard too (games keep the classic modal).

### Dashboard
- New **Dashboard View** setting: keep the list, or switch to a 3-column poster grid where each tile carries a progress strip — full purple for completed, green sized to progress for started items, none for untouched queue entries.
- List cards show a second meta line: genres, network, production status, and source.
- New status filter button in the search bar (filter by Watchlist / In Progress / Dropped / Completed etc. for the active category).

### Statistics
- Top Genres and Top Networks leaderboards, a local ratings summary with a top-rated list, weekly Time-Spent-Watching and Episodes-Watched column charts, and a Biggest Marathons board (most episodes of one show in a day) — powered by a new watch-event log recorded as you tick episodes.
- Durations escalate past hours into days, months, and years (e.g. "1d 4h", "2mo 15d").

### Navigation
- New **Explore** tab: quick links to Timeline and Statistics up top, then every metadata source as an icon tile grid; the standalone Sources page uses the same grid, and each source page offers search plus top-rated picks scoped to that source alone.
- New Settings → **Bottom Bar Layout** page: drag to reorder the bottom tabs and toggle which ones show. Explore stands in for Timeline/Sources/Statistics by default (bar becomes Dashboard · Discover · Explore · Settings); Timeline and Statistics share one slot outside Explore; Settings can never be hidden.
- Timeline and Statistics cross-link via floating buttons on each other's pages; Discover, Sources, and Explore all join the bottom-menu icon customization.
- Every settings subpage gets a compact circular back button at the top, matching the detail pages.

### Fixes
- Fixed in-app navigation silently stripping URL query strings (history.replaceState), which broke any page that relied on query parameters after the first render.
- Fixed the Android hardware back button and back-swipe gesture closing the app instead of navigating back (Capacitor never fires the legacy Cordova event the app was listening for).
- Fixed the metadata picker always showing a blank thumbnail for Wikidata game/movie matches even when an image existed.
- Fixed star-rating clicks being silently lost after the episode list rendered (icon re-processing detached the click handlers).

## [0.0.2]

### File-based backups (Android)
- New native plugin (`BackupFolderPlugin`) for Storage Access Framework (SAF) folder picking, plain/nested/binary file I/O, and a from-scratch POSIX (ustar) tar writer/reader — no third-party library.
- **Folder-tree mirror**: enabling a backup folder mirrors every tracked item into `squash-db/<category>/<item-slug>/index.json` + `.thumbnail` (thumbnail resized to max 500px and re-encoded to WebP), additive-only — items removed in-app are never deleted from the mirror.
- **Full tar backups**: Export now writes a single `squashdb_backup_<date>.tar` containing the entire `squash-db/` tree plus the state JSON, as a sibling of `squash-db/` in the chosen folder. Falls back to a plain `.json` download on non-native/desktop.
- **Import** accepts both `.json` and `.tar` (previously JSON-only); always merges by item ID, never overwrites existing items.
- **Daily auto-backup**: on app launch, if 24+ hours have passed since the last auto-backup and there are tracked items, writes a new tar snapshot automatically and prunes old ones, keeping only the newest 3 backup dates.
- **Auto-restore**: on a fresh install (or whenever the app has zero items), picking a folder that already contains a dated backup file or a raw `squash-db/` tree from a previous install offers to restore from it.
- Settings → Backup & Sync now shows the resolved folder path (e.g. `/Documents/SquashBackups`) so you can confirm sync/export/import are targeting the folder you expect, plus a **Folder Sync Delay** picker (Immediately / 5s / 10s / 30s / 1 minute) controlling how long after an edit the app waits before auto-syncing.
- A silent startup check flags (without an intrusive popup) if the saved backup folder has become invalid/inaccessible.

### Custom metadata sources
- Built-in sources (TVmaze, Wikidata, Open Library) can now be individually enabled/disabled and drag-reordered from Settings → Metadata Sources.
- Add your own metadata source: a search URL template (`{query}`/`{apiKey}` placeholders), an optional API key, and field mappings captured visually — paste a sample response and click through its JSON tree to mark the results array, title, thumbnail, and subtitle fields, instead of hand-typing paths.

### App lock (App Password)
- New Settings → Security section with an app-wide lock: PIN (4+ digits), pattern (3×3 grid, 2+ dots — no stock-Android 4-dot minimum), alphanumeric password, or none.
- Secrets are hashed (PBKDF2-SHA256, salted, never stored in plain text) and gate every page behind a full-screen lock screen shown once per app session.
- Rate limiting: after 5 wrong attempts, a "Forgot password?" option appears, backed by 3 required security questions (also hashed) that let you set a new password without a hard lockout.
- This deters casual snooping only — the underlying data is not encrypted, only gated behind the lock screen.

### Performance
- Dashboard and Timeline now render items in batches of 30 via `IntersectionObserver`, loading more as you scroll, instead of building every card up front — keeps large libraries responsive.

### Appearance
- New **Animation Speed** setting (Off / Fast / Normal / Slow) scales every CSS transition and animation app-wide via a shared `--anim-speed` variable, including the boot splash.
- The boot splash now holds for a minimum ~1.5 seconds (scaled by Animation Speed) instead of redirecting immediately, so it's actually visible on fast devices.
- Settings reorganized from 4 sections into 6 focused ones: **Appearance**, **App Identity**, **Tracking**, **Metadata**, **Backup & Sync**, **Security**.

### App icon (Android)
- Added 8 new illustrated launcher icon choices: Bento Grid, Glass Impact, Play Stack, Progress Ring, Vault, Orbit Hub, Progress Vault, Timeline Pulse — each crossed with all 16 app-name presets, same as the existing icons.
- Removed the Purple icon and the "invisible" icon experiment (fully-transparent icons render as a solid black fallback tile on many Android launchers, so it never actually looked invisible).
- Fixed the Classic icon and its base app icon still being the generic placeholder art from Capacitor's project scaffolding — now uses the real SquashDB logo.
- Turquoise remains the default-enabled icon.

### Fixes
- Fixed backup export/import silently failing or producing unreadable files on native Android (previously relied on browser-only file APIs that don't work reliably inside the Capacitor WebView).
- Fixed auto-restore never finding existing data when a previous install had only auto-synced (no dated backup file at the folder root) — it now also detects and offers to restore from a raw `squash-db/` tree.

## [0.0.1]

### Tracking & categories
- Track progress across 8 built-in categories: Game, Movie, TV Series, K-Drama, C-Drama, Manga, Anime, Novel — each with its own status list.
- Create custom tracking lists (name, icon, and status set) from Settings → Tracking Choices, in addition to the built-in categories.
- Delete custom lists (blocked if the list still has tracked items, to prevent accidental data loss).
- Enable/disable individual lists, and drag-to-reorder enabled lists from Settings → Category Order (only shows currently-enabled lists).
- Default install ships with TV Series, Movies, Anime, and Novel enabled; Game, K-Drama, C-Drama, and Manga are available but off by default.

### Item details
- Per-season episode tracking for Series/K-Drama/C-Drama/Anime: total/watched episodes per season, a checkbox in front of each season name that strikes through the season and auto-fills watched = total, and a "Seasons Watched" field that auto-ticks that many seasons at once.
- Volume/chapter tracking for Manga and Novel.
- Movie/game runtime entered as separate **Hours** and **Minutes** fields (instead of a single minutes field), stored internally as total minutes.
- Ratings, notes, completion dates, and category-specific status lists.

### Metadata lookup (optional, online mode)
- Fetch metadata from TVmaze (TV/anime), Wikidata (movies/games), and Open Library (manga/novels) to auto-fill thumbnails, season/episode counts, and runtime.
- Metadata lookup logic lives in its own module (`www/metadata.js`), separate from the main app logic.

### Dashboard & timeline
- List-only dashboard view (grid mode removed) with checkbox, thumbnail, title, category tag, and a 3-dot action menu per item.
- Timeline view now shows item thumbnails (when Metadata Thumbnails is on) alongside completion history.
- Removed the colored accent strip from the left edge of dashboard item cards.

### Appearance & navigation
- Customizable bottom navigation bar icons (16 choices each for Dashboard, Timeline, Stats, and Settings tabs).
- Bottom nav no longer shows a background "pill" behind the active tab — only the icon color changes.
- Settings reorganized into **Appearance** (renamed from "App Appearance"), a new **App** section (App Icon, App Name, Bottom Menu Icons), and **General**.

### Custom app icon & name (Android)
- Switch the home screen app icon between 5 presets: Classic, Turquoise, Purple, Orange, Pink (Settings → App Icon).
- Switch the home screen app name between 16 presets, sorted alphabetically: Backlog, Binge Log, Checklist, ListKeeper, My Files, My Lists, My Watchlist, Notes, Reminders, Splash, SquashDB, Squid, ToWatch, Tracker, Vault, Watchlist (Settings → App Name).
- Icon and name can be changed independently without resetting each other; applying a change briefly restarts the app.
- Implemented via a native Capacitor plugin (`AppIconPlugin`) and pre-baked Android `activity-alias` entries (no effect outside the installed Android app).

### Backups
- Export all tracked data to a JSON file and re-import it later (Settings → Backups & Restore).
- Wipe all data option.

### Fixes
- Fixed several broken bottom-nav icon names that didn't exist in the bundled icon set.
- Fixed number inputs not filling their container width, which could cause fields (e.g. "Watched" episode count) to visually overflow outside their card on narrow screens.
- Fixed the Episodes-per-Season form collapsing awkwardly on small screens.
- Fixed spacing between the fetched-metadata preview and the fields below it (Total Seasons, Runtime, etc.).
- Fixed adaptive icon artwork being cropped too tightly on some Android launchers with aggressive icon shaping, exposing white background around colored icon variants.
- Fixed GitHub Actions CI workflow failing on `npx cap add android` when the Android platform is already committed to the repo.
- Removed the non-functional "App Language" setting (previously did not translate any UI text).

### Build & tooling
- `compile_apk.py`: self-contained local build script that downloads its own Node/JDK/Android SDK and builds a versioned debug APK (`python3 compile_apk.py --version x.y.z`).
- GitHub Actions workflow to build a debug APK on push to `main`/`master` or on manual trigger, uploaded as a build artifact.
