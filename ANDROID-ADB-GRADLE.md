# Android, ADB, and Gradle setup

This guide explains how to build and install SquashDB on a connected Android phone from the project root.

## Official downloads

- [Android Studio](https://developer.android.com/studio) — easiest option; its setup wizard can install the SDK.
- [Android SDK command-line tools](https://developer.android.com/tools) — use this if you do not want the full IDE.
- [Android SDK Platform-Tools](https://developer.android.com/tools/releases/platform-tools) — contains `adb`.
- [ADB documentation](https://developer.android.com/tools/adb)
- [Android `sdkmanager` documentation](https://developer.android.com/tools/sdkmanager)

## Requirements for this project

The project currently uses:

- Android SDK Platform 34
- Android Build Tools 34.x
- Android SDK Platform-Tools
- Java 17 or the JDK bundled with Android Studio
- Node.js/npm for Capacitor

## Option 1: Install with Android Studio

1. Download and install [Android Studio](https://developer.android.com/studio).
2. Open **SDK Manager** from Android Studio.
3. Install **Android SDK Platform 34**, **Android SDK Build-Tools**, and **Android SDK Platform-Tools**.
4. Note the SDK location. On Linux it is commonly:

   ```text
   /home/YOUR_USERNAME/Android/Sdk
   ```

5. Enable **Developer options** and **USB debugging** on the phone.

## Option 2: Install the SDK from the terminal on Linux

Install basic tools:

```bash
sudo apt update
sudo apt install adb unzip openjdk-17-jdk
```

Download the Linux command-line tools from the official [Android tools page](https://developer.android.com/tools), then place the extracted folder at `cmdline-tools/latest`:

```bash
mkdir -p "$HOME/Android/Sdk/cmdline-tools"
unzip commandlinetools-linux-*_latest.zip -d "$HOME/Android/Sdk/cmdline-tools"
mv "$HOME/Android/Sdk/cmdline-tools/cmdline-tools" "$HOME/Android/Sdk/cmdline-tools/latest"
```

Add the SDK tools to the current shell:

```bash
export ANDROID_SDK_ROOT="$HOME/Android/Sdk"
export ANDROID_HOME="$ANDROID_SDK_ROOT"
export PATH="$ANDROID_SDK_ROOT/platform-tools:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/emulator:$PATH"
```

To make those variables permanent, add the same three lines to `~/.bashrc`, then open a new terminal.

Install the packages required by this project:

```bash
sdkmanager --sdk_root="$ANDROID_SDK_ROOT" \
  "platform-tools" \
  "platforms;android-34" \
  "build-tools;34.0.0"

yes | sdkmanager --sdk_root="$ANDROID_SDK_ROOT" --licenses
```

Check the installation:

```bash
adb version
sdkmanager --list | head
java -version
```

## Tell Gradle where the SDK is

Run this from the SquashDB project root. Do not use `sudo` for the redirect; the project directory should be writable by your user:

```bash
printf 'sdk.dir=%s\n' "$ANDROID_SDK_ROOT" > android/local.properties
```

If `ANDROID_SDK_ROOT` is not set, use the full path instead:

```bash
printf 'sdk.dir=/home/YOUR_USERNAME/Android/Sdk\n' > android/local.properties
```

`android/local.properties` is machine-specific and should not be committed.

## Connect and authorize a phone

1. On the phone, enable **Developer options** and **USB debugging**.
2. Connect the phone with a data-capable USB cable.
3. Run:

```bash
adb kill-server
adb start-server
adb devices
```

The phone should show an authorization dialog. Accept it and select **Always allow from this computer**. Run `adb devices` again; the device should say `device`, not `unauthorized`.

On Ubuntu, if the device is not visible without `sudo`, install the USB rules and add your user to `plugdev`:

```bash
sudo apt install android-sdk-platform-tools-common
sudo usermod -aG plugdev "$USER"
```

Log out and back in after changing the group. Prefer running `adb` as your normal user rather than with `sudo`.

## Build and install the debug APK

From the project root:

```bash
cd ..
npm install
npx cap sync android
cd android
./gradlew assembleDebug
./gradlew installDebug
```

`installDebug` builds the APK and installs it on the authorized device. The APK is also written to:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

You can install that file directly with ADB:

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

For a clean build:

```bash
cd android
./gradlew clean assembleDebug
```

## Useful ADB commands

```bash
# List connected devices
adb devices -l

# Install or replace the debug APK
adb install -r android/app/build/outputs/apk/debug/app-debug.apk

# Open SquashDB
adb shell monkey -p com.squashdb.tracker 1

# Stream Android logs
adb logcat

# Show only SquashDB-related Android logs
adb logcat | grep -i squash

# Capture logs to a file
adb logcat -d > squashdb-logcat.txt

# Clear the Android log buffer
adb logcat -c

# Check the installed package
adb shell pm path com.squashdb.tracker
```

The following removes the app and its app-private data. Use it only when you intentionally want a clean install:

```bash
adb uninstall com.squashdb.tracker
```

## Common errors

### `SDK location not found`

Check that `android/local.properties` exists and contains the real SDK path:

```bash
cat android/local.properties
```

It should look like:

```text
sdk.dir=/home/YOUR_USERNAME/Android/Sdk
```

### Device says `unauthorized`

Unlock the phone, accept the USB debugging prompt, then run:

```bash
adb kill-server
adb start-server
adb devices
```

### Device does not appear

Try another USB cable/port, confirm USB debugging is enabled, and check Linux USB permissions. Do not use `sudo adb` as a permanent solution because it creates a separate root-owned ADB server and can cause confusing authorization states.

### Gradle cannot write to `.gradle`

Ensure the Gradle cache and project are writable by your user. If a previous command was run with `sudo`, repair ownership of your user Gradle cache before retrying. Avoid running Gradle with `sudo`.

### Web changes are missing from the APK

Run the Capacitor sync before building:

```bash
npx cap sync android
cd android
./gradlew installDebug
```
