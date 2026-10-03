# File / Directory Schema

Two separate things are covered here: (1) the app's own source tree, and (2) the on-device files the app creates for backups (which only exist if a backup folder has been chosen — see [storage.md](storage.md)).

## Source tree

```
CueMark/
├── android/                                Capacitor Android native shell
│   ├── app/src/main/
│   │   ├── java/com/cuemark/tracker/
│   │   │   ├── MainActivity.java           registers the two custom plugins
│   │   │   ├── AppIconPlugin.java          launcher icon/name switching (activity-alias)
│   │   │   └── BackupFolderPlugin.java     SAF folder picker, file I/O, tar writer/reader
│   │   ├── AndroidManifest.xml             192 pre-baked activity-alias combos (12 icon
│   │   │                                   variants × 16 names; icon + roundIcon are both
│   │   │                                   attributes on a single alias, not separate ones)
│   │   └── res/
│   │       ├── mipmap-*/                   icon PNGs per density, per icon variant
│   │       ├── mipmap-anydpi-v26/          adaptive-icon XML wrappers (API 26+)
│   │       ├── values/strings.xml          per-alias display-name strings (look_name_*)
│   │       └── values/ic_launcher_background.xml   adaptive-icon background color
│   ├── variables.gradle                    minSdkVersion 22, targetSdk/compileSdk 34
│   └── ...                                 standard Gradle/Capacitor scaffolding
├── www/                                    the actual app (Capacitor webDir)
│   ├── index.html                          boot/splash screen, ~1.5s minimum hold (scaled
│   │                                       by Animation Speed), redirects to dashboard.html
│   ├── dashboard.html                      main tracking list (default landing page)
│   ├── timeline.html                       completion history
│   ├── statistics.html                     aggregated stats
│   ├── settings.html                       central settings hub: Appearance / App Identity /
│   │                                       Tracking / Metadata / Backup & Sync / Security
│   ├── manage-app-icon.html                Android launcher icon picker
│   ├── manage-app-name.html                Android launcher name picker
│   ├── manage-app-lock.html                app password setup (PIN/pattern/alphanumeric +
│   │                                       security questions)
│   ├── manage-backups.html                 export/import/sync/wipe
│   ├── manage-category-order.html          drag-to-reorder categories
│   ├── manage-metadata-sources.html        built-in + custom metadata source config
│   ├── manage-nav-icons.html                bottom-nav icon picker (per tab)
│   ├── manage-tracking.html                enable/disable/create/delete tracking categories
│   ├── app.js                              state, rendering, CRUD, backup/import, lazy-load,
│   │                                       settings pickers, native-plugin bridging
│   ├── metadata.js                         online metadata lookup (built-in + custom sources),
│   │                                       JSON field-mapping tree picker
│   ├── applock.js                          app-lock runtime: hashing (PBKDF2), session gate
│   │                                       (guardAppLock()), lock overlay, PIN/pattern/
│   │                                       alphanumeric input UIs, forgot-password/reset flow
│   ├── manage-app-lock.js                  page logic for manage-app-lock.html (method
│   │                                       picker, secret setup, security-question form)
│   ├── index.css                           all styling; --anim-speed CSS variable drives
│   │                                       every transition/animation duration
│   ├── manifest.json                       web app manifest
│   ├── lucide.min.js                       icon font/library (bundled, not a CDN dependency)
│   ├── cuemark-logo.svg
│   └── icons/
│       ├── logo-*.svg                      alternate in-app logo variants (UI use, not
│       │                                   launcher icons)
│       ├── cuemark-apk-icon-*.svg,         source art for 7 of the 8 non-solid-color
│       │   cuemark-icon-*.svg,             launcher icon variants (Bento Grid, Play Stack,
│       │   cuemark-db-glass-impact-icon.svg  Progress Ring, Vault, Orbit Hub, Progress Vault,
│       │                                   Timeline Pulse, Glass Impact) — rasterized via
│       │                                   cairosvg into android/.../mipmap-*/ at build time,
│       │                                   not read directly by the running app
│       └── previews/ic_launcher_*.png      icon-picker preview thumbnails (one per variant,
│                                           www-side copies used only by the settings UI)
├── capacitor.config.json                   appId, appName, webDir
├── compile_apk.py                          build helper script
├── package.json / package-lock.json        @capacitor/core + @capacitor/android + CLI only
│                                           (no bundler, no framework — plain JS/HTML/CSS)
├── docs/                                   this documentation
├── CHANGELOG.md
└── README.md
```

Every `.html` page is a standalone document (no client-side router/SPA framework) that loads `applock.js`, then `metadata.js`, then `app.js`, in that order — the lock-gate code must be available before `app.js`'s own init runs. Each page calls `initializePage()` on `DOMContentLoaded`, which detects the current page by checking for known container IDs (`getCurrentPageTab()`) and re-renders only what that page needs; shared state is reloaded from the encrypted Android store or browser `localStorage` fresh on every navigation. If an app-lock method is set and the current session hasn't been unlocked, `guardAppLock()` intercepts before any of that runs and shows the lock overlay instead — see [app-lock.md](app-lock.md).

## Launcher icon variants

12 total, all crossed with the same 16 app-name choices (192 `activity-alias` entries): **Classic** (default base `<application>` icon, plain flat art — no source SVG, just the original mipmap set), **Turquoise** (current default-enabled alias), **Orange**, **Pink** (flat solid-color recolors of Classic), and 8 illustrated variants generated from the SVGs in `www/icons/`: **Bento Grid**, **Glass Impact**, **Play Stack**, **Progress Ring**, **Vault**, **Orbit Hub**, **Progress Vault**, **Timeline Pulse**.

A **Purple** variant and an "invisible"/blank-icon option existed at one point (the invisible one used a plain opaque white fill, since fully-transparent icons render as a solid black fallback tile on many launchers) — both were removed; if you see references to them in old notes/commits, they no longer exist in the manifest, string resources, or icon picker.

## Native plugin surface

`AppIconPlugin` (`@CapacitorPlugin(name = "AppIcon")`):
| Method | Purpose |
|---|---|
| `setLook({icon, nameIndex})` | Enables exactly one `Look_<icon>_<nameIndex>` activity-alias, disables all others |
| `getLook()` | Reports which alias is currently enabled |

`BackupFolderPlugin` (`@CapacitorPlugin(name = "BackupFolder")`):
| Method | Purpose |
|---|---|
| `pickFolder()` | Launches the SAF `ACTION_OPEN_DOCUMENT_TREE` picker, persists write access |
| `hasPersistedFolder({uri})` | Checks whether a previously granted URI is still valid |
| `writeFile({uri, fileName, content})` | Writes a flat text file directly under the tree root |
| `readFile({uri})` | Reads a file's text content (UTF-8 decoded) by its own document URI |
| `readBinaryFile({uri})` | Reads a file's raw bytes as base64 — safe for binary formats (e.g. `.tar`), unlike `readFile`'s UTF-8 decoding |
| `listFiles({uri})` | Lists immediate children of a folder as `{name, uri}` pairs |
| `deleteFile({uri})` | Deletes a single file by its own document URI (used only for rotating old auto-backups — never called on a folder) |
| `writeNestedFile({uri, dirPath, fileName, content})` | Get-or-create every folder in `dirPath`, then write a text file |
| `writeNestedBinaryFile({uri, dirPath, fileName, base64Content})` | Same, but decodes base64 and writes raw bytes (used for thumbnails) |
| `exportTarArchive({uri, sourceDirPath, tarFileName, extraJsonFileName?, extraJsonContent?})` | Recursively walks `sourceDirPath`, writes a POSIX (ustar) tar to a sibling file, optionally injecting one extra top-level JSON entry |

Both are Java, registered in `MainActivity.onCreate()` via `registerPlugin(...)`, and called from JS as `window.Capacitor.Plugins.<Name>.<method>(...)`.

## On-device backup files (Android, real filesystem)

These only exist once a backup folder has been picked (via Backups & Restore → Change Backup Folder, or on first Export/Sync). Nothing is created automatically before that.

```
<chosen SAF folder>/
├── cuemark-db/
│   ├── <category_key>/                 e.g. series/, movie/, or a custom category key
│   │   └── <title_slug>/               sanitized title, lowercase, spaces→_, +short-id
│   │       │                           suffix appended only on a name collision
│   │       ├── index.json              full Item object, pretty-printed
│   │       └── thumbnail.webp          thumbnail re-encoded to WebP (only if item.thumbnail
│   │                                   resolved and the fetch/convert succeeded)
│   └── settings/
│       └── metadata-sources.json       state.preferences.metadataSources, with every
│                                       custom source's apiKey replaced by "***REDACTED***"
├── cuemark_backup_<YYYY-MM-DD>.tar    full snapshot: cuemark-db/ tree + one extra root-level
                                        entry cuemark_backup_<YYYY-MM-DD>.json (the same
                                        payload buildBackupPayload() produces for a plain
                                        JSON export)
└── cuemark_backup_<YYYY-MM-DD>.sqdbe  passphrase-protected AES-256-GCM backup envelope
```

Notes:
- The mirror under `cuemark-db/` is **additive-only** — items deleted or recategorized in-app leave their old folder behind; nothing here is ever auto-deleted.
- `.tar` uses no compression (plain POSIX ustar) — written and read by hand-rolled code in `BackupFolderPlugin.java`/`app.js` (`parseTarArchive()`), not a library.
- `.sqdbe` contains encrypted JSON metadata plus ciphertext; it does not contain the passphrase, and it can also be uploaded by the optional Cloud Sync controls.
- `.sqdb` is an Android-only, device-bound encrypted snapshot produced by WorkManager; it uses the same Keystore key and is available in the Backup Recovery Center.
- On non-native platforms (plain desktop browser), Export instead uses `showSaveFilePicker()` if available, or falls back to a plain `<a download>` link — no `cuemark-db/` tree is ever created outside the native Android path.
- On a **fresh install** with an empty item list, picking a backup folder that already has a `cuemark-db/` tree or a `cuemark_backup_*.tar`/`.json`/`.sqdbe` file in it triggers an offer to auto-restore from the newest one found — see [storage.md](storage.md). `.sqdb` snapshots are restored explicitly from the Recovery Center on the same device.

See [storage.md](storage.md) for how/when these files actually get written (sync triggers, delay setting, what's cache vs. persistent), and [metadata.md](metadata.md) for what populates `thumbnail`/the metadata-sources file. Note that `appLock` is included in the encrypted Android state and full `.tar`/`.json` backup export, but is not included in the additive `cuemark-db/` mirror.
