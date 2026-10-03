# CueMark requirements

This document describes the minimum requirements for developing, building, and running CueMark.

## Application specifications

| Specification | Current value |
|---|---|
| Application ID | `com.cuemark.tracker` |
| Application type | Capacitor web application with a native Android shell |
| Web directory | `www/` |
| Android minimum SDK | API 22 / Android 5.1 Lollipop |
| Android compile SDK | API 34 |
| Android target SDK | API 34 |
| Android version name | `0.0.1` in the current Android module configuration |
| Android build plugin | Android Gradle Plugin 8.2.1 |
| Gradle wrapper | Gradle 8.2.1 |
| Capacitor | 6.x |
| Java | JDK 17 recommended |
| License | Apache-2.0 |

## Minimum end-user requirements

### Android

- Android 5.1 or newer, API 22+.
- Approximately 100 MB free space for the installed application and initial runtime files.
- Additional storage for tracked metadata, cached thumbnails, fonts, encrypted backups, and exported files.
- At least 2 GB RAM is recommended for normal use. More memory is recommended for large libraries and many cached images.
- WebView enabled and up to date through Google Play system updates or the device manufacturer.
- The app can work offline for locally saved data. Internet access is needed for online metadata, thumbnails, fonts, optional cloud sync, and online recommendations.

### Browser preview

The static web app can be opened in a modern browser with support for:

- JavaScript modules and modern ECMAScript syntax
- `localStorage`
- Cache Storage API
- `fetch`
- Web Crypto API for encrypted backups
- `URLSearchParams`
- `FileReader`, Blob, and download APIs

Native Android features such as biometric unlock, WorkManager backups, notification permissions, widgets, share intents, launcher icon switching, and Android storage-folder selection require the installed Android APK.

## Development requirements

- Node.js with npm. Use a current LTS release.
- Java JDK 17, or the JDK bundled with Android Studio.
- Android SDK Platform 34.
- Android SDK Build-Tools 34.x.
- Android SDK Platform-Tools, including `adb`.
- Android SDK Command-Line Tools if building without Android Studio.
- A writable Gradle user cache and writable project directory.
- A connected Android device or emulator for APK testing.

Install the exact SDK and ADB setup using [ANDROID-ADB-GRADLE.md](ANDROID-ADB-GRADLE.md).

## Android SDK packages

The minimum packages needed to build this project are:

```text
platform-tools
platforms;android-34
build-tools;34.0.0
```

The SDK location must be available to Gradle through either `android/local.properties` or the environment:

```text
sdk.dir=/home/YOUR_USERNAME/Android/Sdk
```

Do not commit `android/local.properties`; it contains a machine-specific path.

## Build requirements

From the project root:

```bash
npm install
npx cap sync android
cd android
./gradlew assembleDebug
```

To install on an authorized phone:

```bash
./gradlew installDebug
```

The debug APK is generated at:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

## Runtime permissions and optional capabilities

The app may request or use the following capabilities depending on the feature and user choice:

- Internet access for metadata and image requests.
- Android notification permission for reminders and test notifications.
- Biometric authentication for app unlock.
- Android storage-folder access for backup and sync files.
- Android share-intent access for importing shared text.
- WorkManager background execution for scheduled encrypted backups.
- Home-screen widget support for progress information.
- Launcher activity-alias changes for selectable app icons and names.

The app should remain usable for local tracking when optional online services, notifications, cloud sync, or background work are not enabled.

## Storage expectations

CueMark stores or may create:

- Local tracked-item data and watch progress.
- Encrypted Android local state when running in the APK.
- Browser `localStorage` fallback data in browser mode.
- Metadata and image cache entries.
- Cached fonts.
- Encrypted backup snapshots.
- Optional folder-sync files and thumbnail files.
- Daily local Logcat files.

Large libraries, offline metadata, poster downloads, and retained backups can use substantially more storage than the base application. Users should keep free space available before enabling full offline downloads or frequent background snapshots.

## Recommended test matrix

At minimum, test the APK on:

- One Android 5.1/API 22-or-newer device or emulator for minimum compatibility.
- One recent Android device using API 34 behavior.
- A small library and a large library with many thumbnails.
- Offline startup and online metadata mode.
- Android back button and swipe-back navigation.
- Notification permission allowed and denied.
- Backup-folder permission granted, revoked, and reselected.
- Encrypted local storage enabled and browser fallback mode.
