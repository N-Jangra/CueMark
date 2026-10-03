# App Storage: What Persists, Where, and For How Long

This is the question that comes up most, so it's answered directly here rather than only implied by the schema docs.

## The three storage layers

| Layer | What lives here | Persistence | Cleared by |
|---|---|---|---|
| **Android Keystore encrypted state** | Main `state.items`, `state.watchLog`, and `state.preferences` | Indefinite inside the app's private storage; encrypted with an Android Keystore AES-GCM key. | Clearing app data or uninstalling the app also removes the Keystore key. Device-bound `.sqdb` snapshots cannot be restored on another device. |
| **`localStorage`** | Browser fallback plus small auxiliary settings such as filters, cache timestamps, and lock-attempt counters | Indefinite in the browser/WebView unless manually cleared. | Clearing app storage, uninstalling the app, or browser storage eviction. |
| **WebView HTTP cache** | Thumbnail image *bytes*, transiently, whenever an `<img>` tag actually renders a `thumbnail` URL | Ephemeral — follows normal HTTP cache-control rules from whichever CDN served the image (TVmaze/Wikimedia/Open Library/custom source). Typically hours to a few days, but not guaranteed. | Any time, silently, once the WebView's cache size limit is hit — this is a real browser cache, unlike `localStorage`. |
| **`cuemark-db/` SAF folder** (Android only, opt-in) | `index.json` + `thumbnail.webp` per item, mirrored from `localStorage`; full `.tar` or encrypted `.sqdbe` backups | Indefinite, real files on the filesystem/SD card/cloud-synced folder the user picked. | Only if the user (or another app) deletes the folder/files directly. The app itself never deletes from here — sync is additive-only. |
| **`sessionStorage`** | Just one key: whether the app-lock has been unlocked this session (`cuemark_lock_unlocked`) | Cleared automatically whenever the app process is killed — by design, so the lock re-triggers on every real reopen, not just page navigation. | Killing/restarting the app (normal), or the OS reclaiming background process memory. |

**The practical consequence**: item data (title, status, rating, notes, etc.) is durable from the moment it's saved. Thumbnails are not — `item.thumbnail` only ever stores a URL, so if that URL goes offline, the CDN evicts the cached bytes, or you're offline, the thumbnail image will fail to load even though the item itself is completely intact. This is why a thumbnail can "disappear" while everything else about the item stays correct.

## Why there's no popup asking for a folder on startup

This is intentional. Nothing in the startup path (`DOMContentLoaded` → `initializePage()`) calls the native folder picker. The picker is only invoked by:
- Tapping **Export** (Backups & Restore)
- Tapping **Sync to Folder Tree** (Backups & Restore)
- An auto-sync firing (see below)
- Tapping **Change Backup Folder** explicitly

On startup, `checkBackupFolderOnStartup()` checks (`hasPersistedFolder()`) the previously saved SAF URI. If the folder is missing, revoked, or inaccessible, the app immediately asks the user to select a replacement folder and also marks the status for the Backups & Restore page.

## Auto-sync to `cuemark-db/`

`scheduleFolderTreeAutoSync()` is called from `saveData()` — i.e., after every item add/edit/delete/status-toggle — and debounced by the **Animation Speed**-unrelated **Folder Sync Delay** setting (Settings → Folder Sync Delay): Immediately / 5s / 10s / 30s / 1 minute (default 30s). "Immediately" still respects `saveData()`'s own 120ms internal debounce; it just skips the extra idle wait on top of that.

Each sync pass (`syncFolderTreeMirror()`):
1. Resolves (or silently reuses) the backup folder URI.
2. For each item, compares a JSON hash against `cuemark_synced_item_hashes` (in `localStorage`) — unchanged items are skipped, so a sync pass only writes what actually changed.
3. Writes `index.json`, fetches the thumbnail URL and re-encodes it to WebP (`thumbnailUrlToWebpBase64()`), writes `thumbnail.webp` if that succeeded.
4. Writes a redacted copy of the metadata-source config to `cuemark-db/settings/metadata-sources.json`.
5. Never deletes anything — items removed from the app leave their old folder behind on disk.

The manual **"Sync to Folder Tree"** button surfaces a summary (`syncedCount`/`skippedUnchangedCount`/per-item errors) via an alert, since there's no other easy way to see sync failures without a device log.

## Backup/export pipeline

`exportData()` (Export button):
1. Runs `syncFolderTreeMirror()` first, so the folder tree is current.
2. Calls the native `exportTarArchive()`, which walks `cuemark-db/` and writes an uncompressed POSIX tar as a **sibling** of `cuemark-db/` (same chosen folder, not nested inside it) — `cuemark_backup_<date>.tar`, containing the whole `cuemark-db/` tree plus one extra root-level JSON entry with the same payload a plain export produces.
3. On non-native platforms (desktop browser), this path is skipped entirely — export falls back to `showSaveFilePicker()` or a plain `<a download>` link, producing just a `.json` file, no `cuemark-db/` tree, no tar.

`importData()` accepts either `.json` or `.tar`. For `.tar`, `parseTarArchive()` (hand-rolled, mirrors the native writer's layout) extracts the root-level `.json` entry and feeds it through the same `applyImportedBackupJson()` path as a plain JSON import. Import always **merges** by item ID — it never overwrites/replaces existing items, only adds ones not already present (see `restoreBackupData()`).

The separate **Export Encrypted Backup** action writes a `.sqdbe` JSON envelope containing a PBKDF2-SHA256-derived AES-256-GCM ciphertext. The passphrase is never stored. Encrypted imports decrypt and then use the same merge path. Optional Cloud Sync uses the same encrypted payload with a user-supplied HTTPS/WebDAV file URL; the password is used for that request only, while the endpoint and username may be remembered locally.

## Daily auto-backup (last 3 kept)

The regular app-open auto-backup is a launch-time check in `checkBackupFolderOnStartup()` → `runAutoBackupIfDue()`. Android users can additionally enable an approximately daily WorkManager snapshot from Settings:

1. The launch-time path compares `Date.now()` against `cuemark_last_auto_backup_at`. If less than 24 hours have passed, or the folder is invalid/unset, or `state.items` is empty, nothing happens.
2. Otherwise, writes a full tar snapshot via the same `writeTarBackup()` helper the manual Export button uses — same naming (`cuemark_backup_<YYYY-MM-DD>.tar` + `.json` sibling), same location (a sibling of `cuemark-db/` in the chosen SAF folder).
3. Updates `cuemark_last_auto_backup_at`, then calls `pruneOldAutoBackups()`: lists the folder root, groups matching `cuemark_backup_<date>.(tar|json)` files by date, keeps the **3 newest dates**, and deletes every file (both `.tar` and its `.json` sibling) for any older date via the native `deleteFile()` method.
4. The optional WorkManager path writes the already encrypted Keystore state as `cuemark_background_<timestamp>.sqdb` to the selected folder while the app is closed.

This only ever deletes dated backup archive files it recognizes by name — it never touches `cuemark-db/` itself, unrelated files, or anything not matching the `cuemark_backup_<date>.(tar|json)` pattern. Since it's tied to app launches rather than a real clock, opening the app less than once a day means backups happen less often than every 24 hours (there's no missed-backup catch-up beyond "the next time you open it").

## Auto-restore on a fresh install (or any time items are empty)

Uninstalling the app wipes `localStorage` (see the table above) and Android revokes the app's SAF folder permission — so a reinstall always starts with **zero memory of the old folder**, and the user must re-pick it manually. There is no way around that first manual step.

Once a backup folder is picked (whether via the implicit pick inside `getOrPickBackupFolderUri()` — triggered by Export/Sync — or the explicit **Change Backup Folder** button) **and** `state.items` is currently empty, `checkForExistingBackupToRestore()` runs automatically:
1. Lists the folder's root contents via the native `listFiles()`.
2. Filters for `cuemark_backup_<YYYY-MM-DD>.tar`/`.json`/`.sqdbe` files and picks the newest by date (preferring `.tar`, then encrypted `.sqdbe`, then `.json` on the same date).
3. Shows a confirm dialog naming the file found.
4. If confirmed, reads it (native `readBinaryFile()` for tar bytes, `readFile()` for text/encrypted files) and feeds it through the same merge-based `applyImportedBackupJson()` path Import already uses.

This only fires when items are empty — it will not silently overwrite existing data, and it never runs without the user's explicit confirmation in the dialog.

## Animation Speed vs. storage

Unrelated to persistence, but frequently asked in the same breath: **Animation Speed** (Settings → Appearance) only scales CSS transition/animation durations via a `--anim-speed` custom property — it has no effect on storage, sync timing, or the Folder Sync Delay setting (now under Settings → Backup & Sync). They're independent controls that happen to both be time-based.

## App Lock vs. storage

Also unrelated to the mechanics above, but worth cross-referencing: the app-lock feature (Settings → Security → App Password) uses its own dedicated `localStorage`/`sessionStorage` keys (`cuemark_lock_failed_attempts`, `cuemark_lock_unlocked`) and does **not** encrypt anything described in this document — it only gates the UI. See [app-lock.md](app-lock.md) for the full mechanics and its threat model.
