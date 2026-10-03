# CueMark

**CueMark** — bookmarking where you left off.

CueMark is a personal watchlist and media progress tracker for games, movies, TV series, anime, manga, and novels. The name combines a viewing or reading *cue* with a *mark* that remembers your place, so you can return to exactly where you left off. It is packaged as an Android app with [Capacitor](https://capacitorjs.com/).

## Features

- Track progress per category (episodes/seasons, chapters/volumes, playtime) with custom statuses per list
- Create your own tracking lists in addition to the built-in categories, and enable/disable or reorder them
- Dashboard, timeline (completion history), and stats views
- Optional online metadata lookup (TVmaze, Wikidata, Open Library) for thumbnails, runtimes, and episode counts
- Customizable bottom navigation icons
- Switchable app icon and app name (Android home screen), each with several presets
- Local JSON export/import plus passphrase-protected encrypted `.sqdbe` backups
- Optional encrypted cloud backup sync to a user-supplied HTTPS/WebDAV endpoint
- Light/dark themes with multiple accent colors

## Project structure

```
www/                 Web app source (HTML/CSS/JS) — loaded into the Capacitor WebView
  app.js             Core app logic (state, rendering, settings)
  app-navigation.js  Shared page stack and Android back-button handling
  app-backups.js     Backup, restore, and folder-sync operations
  metadata.js        Online metadata lookup (TVmaze, Wikidata, Open Library)
  cache-manager.js   Metadata, image, font, and WebView cache controls
  index.css          Styles
  *.html             Dashboard, timeline, stats, and settings pages
android/             Native Android project (Capacitor)
  app/src/main/java/com/cuemark/tracker/
    AppIconPlugin.java   Native plugin for switching the app icon/name at runtime
compile_apk.py       Local APK build helper script
.github/workflows/   CI build workflow
```

## Development

Requires Node.js and the Android SDK.

```
npm install
npx cap sync android
```

Edit files under `www/`, then re-run `npx cap sync android` to copy changes into the native project.

### Building the APK

Open `android/` in Android Studio, or build from the command line:

```
cd android
./gradlew assembleDebug
```

The debug APK is output to `android/app/build/outputs/apk/debug/`.

#### One-shot build with `compile_apk.py`

`compile_apk.py` is a self-contained build script that doesn't rely on any pre-installed Node, JDK, or Android SDK — it downloads and sets all of them up locally under `build_env/` (safe to delete afterward), then runs the full build.

```
python3 compile_apk.py --version 1.2.3
```

What it does, in order:

1. Downloads Node.js, a JDK, and the Android command-line tools into `build_env/` (skipped if already present)
2. Installs the required Android SDK platform and build-tools via `sdkmanager`
3. Updates `versionName` and `versionCode` in `android/app/build.gradle` from `--version` (e.g. `1.2.3` → versionCode `10203`)
4. Runs `npm install` and `npx cap sync`
5. Runs `./gradlew assembleDebug`
6. Copies the resulting APK to the project root as `CueMark-<version>.apk`

`--version` defaults to `1.0` if omitted.

## Tech stack

- Plain HTML/CSS/JavaScript (no framework, no bundler)
- [Capacitor](https://capacitorjs.com/) for the native Android wrapper
- [Lucide](https://lucide.dev/) icons
- Android Keystore-encrypted local state storage, with browser `localStorage` fallback

## License

Apache License 2.0 — see [LICENSE](LICENSE).
