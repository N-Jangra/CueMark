# CueMark Documentation

**CueMark** means “bookmarking where you left off.” It is a Capacitor-based watchlist and media-progress tracker that runs as an Android app and can also be opened as a plain web page. The app is a static multi-page site (`www/*.html` + `app.js` + `metadata.js` + `applock.js`) backed by an Android Keystore-encrypted state store on native Android, with browser `localStorage` as the web fallback and an optional file-based mirror via a custom native plugin.

## Contents

- [db-schema.md](db-schema.md) — the state schema: `state.items`, `state.preferences`, watch history, and the remaining browser-only keys.
- [file-schema.md](file-schema.md) — the app's source directory layout, plus the on-device `cuemark-db/` folder tree and backup `.tar`/`.json`/`.sqdbe`/`.sqdb` formats.
- [metadata.md](metadata.md) — how online metadata lookup works: built-in sources (TVmaze/Wikidata/Open Library) and the custom-source JSON-path mapping system.
- [storage.md](storage.md) — where data actually lives (localStorage vs. SAF folder vs. WebView HTTP cache vs. sessionStorage), persistence/eviction behavior, the backup/export/import/sync pipeline, and fresh-install auto-restore.
- [app-lock.md](app-lock.md) — the App Password feature: PIN/pattern/alphanumeric methods, PBKDF2 hashing, rate limiting, and the security-question recovery flow (with an explicit threat-model caveat).
- [app-walkthrough.md](app-walkthrough.md) — every page, every button/toggle/picker, and what it does.

## Quick orientation

- **No backend.** Everything runs client-side in the Android WebView (or a desktop browser for quick testing).
- **No SQL database.** The live state is `state.items`, `state.preferences`, and watch history. On Android the main state is JSON-serialized and encrypted with an Android Keystore AES-GCM key; browser-only builds use `localStorage`.
- **Native additions are two small custom Capacitor plugins**, not a full native rewrite:
  - `AppIconPlugin` — switches the Android launcher icon/name by enabling one pre-baked `activity-alias` out of a fixed grid (12 icon variants × 16 names).
  - `BackupFolderPlugin` — Storage Access Framework (SAF) folder picking, plain/nested/binary file I/O, and a from-scratch POSIX tar writer/reader for backups.
- **Multi-page, not a single-page app.** Every screen is its own `.html` file; `applock.js`, then `metadata.js`, then `app.js` are loaded on each page and re-derive UI state from `localStorage` on every load.
- `app.js` loads navigation and backup behavior as separate feature modules (`app-navigation.js` and `app-backups.js`) before initialization, while preserving the existing global APIs used by the multi-page screens.
- **App lock and storage encryption are separate.** The lock gates the UI; Android also encrypts the main local state with the Keystore, while browser-only auxiliary keys remain in `localStorage` — see [app-lock.md](app-lock.md) for the threat model.
- **Encrypted backups are opt-in.** Settings → Backups can export/import `.sqdbe` files using PBKDF2-SHA256 and AES-256-GCM. Optional cloud sync uploads only that encrypted file to a user-supplied HTTPS/WebDAV URL; the cloud password is not persisted.
