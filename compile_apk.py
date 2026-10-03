#!/usr/bin/env python3
import os
import sys
import re
import shutil
import urllib.request
import zipfile
import tarfile
import subprocess
import argparse

# Paths config
BASE_DIR = os.path.abspath(os.path.dirname(__file__))
BUILD_ENV = os.path.join(BASE_DIR, "build_env")
TOOLS_DIR = os.path.join(BUILD_ENV, "tools")
SDK_ROOT = os.path.join(BUILD_ENV, "android_sdk")
ANDROID_BUILD_GRADLE = os.path.join(BASE_DIR, "android", "app", "build.gradle")

# Download URLs
NODE_URL = "https://nodejs.org/dist/v20.11.1/node-v20.11.1-linux-x64.tar.xz"
JDK_URL = "https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.10%2B7/OpenJDK17U-jdk_x64_linux_hotspot_17.0.10_7.tar.gz"
SDK_TOOLS_URL = "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"

def log(msg):
    print(f"==> {msg}", flush=True)

def parse_version_code(version_name):
    parts = re.findall(r"\d+", version_name)
    if not parts:
        return 1
    major = int(parts[0]) if len(parts) > 0 else 0
    minor = int(parts[1]) if len(parts) > 1 else 0
    patch = int(parts[2]) if len(parts) > 2 else 0
    return major * 10000 + minor * 100 + patch

def update_android_version(version_name):
    if not os.path.exists(ANDROID_BUILD_GRADLE):
      raise FileNotFoundError(f"Android Gradle file not found: {ANDROID_BUILD_GRADLE}")

    with open(ANDROID_BUILD_GRADLE, "r", encoding="utf-8") as fh:
        content = fh.read()

    version_code = parse_version_code(version_name)
    content, code_count = re.subn(r'versionCode\s+\d+', f'versionCode {version_code}', content, count=1)
    content, name_count = re.subn(r'versionName\s+"[^"]*"', f'versionName "{version_name}"', content, count=1)

    if code_count != 1 or name_count != 1:
        raise RuntimeError("Could not update Android version fields in build.gradle.")

    with open(ANDROID_BUILD_GRADLE, "w", encoding="utf-8") as fh:
        fh.write(content)

    log(f"Updated Android version to {version_name} (versionCode {version_code}).")

def download_file(url, dest):
    if os.path.exists(dest):
        log(f"File {os.path.basename(dest)} already exists, skipping download.")
        return
    log(f"Downloading {url} to {dest}...")
    
    # Simple downloader with progress reporting
    def progress_callback(block_num, block_size, total_size):
        read_so_far = block_num * block_size
        if total_size > 0:
            percent = min(100, read_so_far * 100 // total_size)
            sys.stdout.write(f"\rDownload progress: {percent}% ({read_so_far // (1024*1024)}MB / {total_size // (1024*1024)}MB)")
        else:
            sys.stdout.write(f"\rDownloaded: {read_so_far // (1024*1024)}MB")
        sys.stdout.flush()

    urllib.request.urlretrieve(url, dest, progress_callback)
    sys.stdout.write("\n")
    log("Download completed.")

def extract_file(filepath, dest_dir):
    log(f"Extracting {filepath} to {dest_dir}...")
    os.makedirs(dest_dir, exist_ok=True)
    
    if filepath.endswith(".zip"):
        with zipfile.ZipFile(filepath, "r") as zip_ref:
            zip_ref.extractall(dest_dir)
    elif filepath.endswith(".tar.gz") or filepath.endswith(".tgz"):
        with tarfile.open(filepath, "r:gz") as tar_ref:
            tar_ref.extractall(dest_dir)
    elif filepath.endswith(".tar.xz"):
        with tarfile.open(filepath, "r:xz") as tar_ref:
            tar_ref.extractall(dest_dir)
    log("Extraction completed.")

def make_binaries_executable(dir_path):
    bin_dir = os.path.join(dir_path, "bin")
    if os.path.exists(bin_dir):
        log(f"Making binaries in {bin_dir} executable...")
        for f in os.listdir(bin_dir):
            fpath = os.path.join(bin_dir, f)
            if os.path.isfile(fpath):
                try:
                    os.chmod(fpath, 0o755)
                except Exception as e:
                    log(f"Warning: could not chmod {fpath}: {e}")

def setup_environment():
    log("Setting up build directories...")
    os.makedirs(TOOLS_DIR, exist_ok=True)
    os.makedirs(SDK_ROOT, exist_ok=True)

    # 1. Download tools
    node_archive = os.path.join(TOOLS_DIR, "node.tar.xz")
    jdk_archive = os.path.join(TOOLS_DIR, "jdk.tar.gz")
    sdk_tools_archive = os.path.join(TOOLS_DIR, "sdk_tools.zip")

    download_file(NODE_URL, node_archive)
    download_file(JDK_URL, jdk_archive)
    download_file(SDK_TOOLS_URL, sdk_tools_archive)

    # 2. Extract tools if not already extracted
    has_node = any(d.startswith("node-") and os.path.isdir(os.path.join(TOOLS_DIR, d)) for d in os.listdir(TOOLS_DIR))
    has_jdk = any((d.startswith("jdk-") or d.startswith("jdk17")) and os.path.isdir(os.path.join(TOOLS_DIR, d)) for d in os.listdir(TOOLS_DIR))
    has_sdk_latest = os.path.exists(os.path.join(SDK_ROOT, "cmdline-tools", "latest", "bin", "sdkmanager"))

    if not has_node:
        extract_file(node_archive, TOOLS_DIR)
    else:
        log("Node already extracted, skipping.")

    if not has_jdk:
        extract_file(jdk_archive, TOOLS_DIR)
    else:
        log("JDK already extracted, skipping.")
    
    if not has_sdk_latest:
        # Android sdk tools needs specific latest structure
        temp_sdk_dir = os.path.join(TOOLS_DIR, "temp_sdk_tools")
        extract_file(sdk_tools_archive, temp_sdk_dir)

        # Move to latest
        dest_cmdline_latest = os.path.join(SDK_ROOT, "cmdline-tools", "latest")
        if not os.path.exists(dest_cmdline_latest):
            os.makedirs(os.path.dirname(dest_cmdline_latest), exist_ok=True)
            src_dir = os.path.join(temp_sdk_dir, "cmdline-tools")
            shutil.move(src_dir, dest_cmdline_latest)
            log("Arranged Android Command Line Tools in correct layout.")
        
        # Cleanup temp
        if os.path.exists(temp_sdk_dir):
            try:
                shutil.rmtree(temp_sdk_dir)
            except Exception:
                pass
    else:
        log("Android command-line tools already configured, skipping.")

    # Find Node and Java paths
    node_extracted = [d for d in os.listdir(TOOLS_DIR) if d.startswith("node-") and os.path.isdir(os.path.join(TOOLS_DIR, d))][0]
    jdk_extracted = [d for d in os.listdir(TOOLS_DIR) if (d.startswith("jdk-") or d.startswith("jdk17")) and os.path.isdir(os.path.join(TOOLS_DIR, d))][0]

    node_bin = os.path.join(TOOLS_DIR, node_extracted, "bin")
    java_home = os.path.join(TOOLS_DIR, jdk_extracted)

    # Make sure all binaries are executable
    make_binaries_executable(os.path.join(TOOLS_DIR, node_extracted))
    make_binaries_executable(java_home)
    make_binaries_executable(os.path.join(SDK_ROOT, "cmdline-tools", "latest"))

    # Define execution env
    env = os.environ.copy()
    env["PATH"] = f"{node_bin}:{os.path.join(java_home, 'bin')}:{os.path.join(SDK_ROOT, 'cmdline-tools', 'latest', 'bin')}:{env['PATH']}"
    env["JAVA_HOME"] = java_home
    env["ANDROID_HOME"] = SDK_ROOT
    env["CAPACITOR_TELEMETRY_DISABLED"] = "1"
    
    return env

def install_android_sdk(env):
    log("Installing Android SDK platforms and build tools...")
    sdkmanager = shutil.which("sdkmanager", path=env["PATH"])
    if not sdkmanager:
        sdkmanager = os.path.join(SDK_ROOT, "cmdline-tools", "latest", "bin", "sdkmanager")
        if not os.path.exists(sdkmanager):
            raise FileNotFoundError(f"sdkmanager not found at {sdkmanager}")

    # Set execute permission on sdkmanager just in case
    try:
        os.chmod(sdkmanager, 0o755)
    except Exception:
        pass

    # Accept licenses
    log("Accepting Android SDK licenses...")
    p = subprocess.Popen(
        [sdkmanager, f"--sdk_root={SDK_ROOT}", "--licenses"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, env=env
    )
    stdout, stderr = p.communicate(input="y\ny\ny\ny\ny\ny\ny\ny\n")
    log("Licenses accepted.")

    # Install tools
    cmd = [
        sdkmanager, f"--sdk_root={SDK_ROOT}",
        "platform-tools", "platforms;android-34", "build-tools;34.0.0"
    ]
    log(f"Running: {' '.join(cmd)}")
    subprocess.run(cmd, check=True, env=env)
    log("SDK packages installed.")

def build_app(env, version_name="1.0"):
    log("Installing Capacitor and setting up wrapper...")

    # www/ is the only thing Capacitor packages into the app — CHANGELOG.md
    # lives at repo root for GitHub/README visibility, so it must be mirrored
    # in here on every build or the in-app Changelog page silently goes stale.
    changelog_src = os.path.join(BASE_DIR, "CHANGELOG.md")
    changelog_dest = os.path.join(BASE_DIR, "www", "CHANGELOG.md")
    if os.path.exists(changelog_src):
        log("Copying CHANGELOG.md into www/...")
        shutil.copyfile(changelog_src, changelog_dest)

    # Run npm install
    log("Running npm install...")
    subprocess.run(["npm", "install"], check=True, env=env, cwd=BASE_DIR)

    # Disable telemetry explicitly to prevent prompts
    log("Disabling Capacitor telemetry...")
    subprocess.run(["npx", "cap", "telemetry", "off"], check=True, env=env, cwd=BASE_DIR)

    # Check if android platform folder already exists, if not create it
    android_dir = os.path.join(BASE_DIR, "android")
    if not os.path.exists(android_dir):
        log("Adding Capacitor Android platform...")
        subprocess.run(["npx", "cap", "add", "android"], check=True, env=env, cwd=BASE_DIR)
    else:
        log("Capacitor Android platform exists, syncing web assets...")
        subprocess.run(["npx", "cap", "sync"], check=True, env=env, cwd=BASE_DIR)

    # Compile the android application
    log("Compiling Gradle project...")
    gradlew_path = os.path.join(android_dir, "gradlew")
    try:
        os.chmod(gradlew_path, 0o755)
    except Exception:
        pass
    
    # A previous interrupted build can leave Gradle's project execution-history
    # cache locked by a daemon. Stop old daemons and use a one-shot build so the
    # compiler never reuses that stale lock.
    subprocess.run(["./gradlew", "--stop"], check=False, env=env, cwd=android_dir)
    subprocess.run(["./gradlew", "--no-daemon", "assembleDebug"], check=True, env=env, cwd=android_dir)
    log("Gradle compilation completed successfully.")

    # Locate APK
    apk_src = os.path.join(android_dir, "app", "build", "outputs", "apk", "debug", "app-debug.apk")
    safe_version = re.sub(r"[^0-9A-Za-z._-]+", "-", version_name).strip("-") or "1.0"
    apk_dest = os.path.join(BASE_DIR, f"CueMark-{safe_version}.apk")
    
    if os.path.exists(apk_src):
        shutil.copyfile(apk_src, apk_dest)
        log(f"SUCCESS! The compiled APK has been copied to: {apk_dest}")
    else:
        raise FileNotFoundError("Could not locate compiled APK output file.")

def main():
    try:
        parser = argparse.ArgumentParser(description="Build CueMark APK")
        parser.add_argument("--version", default="1.0", help="APK version name, e.g. 1.2.3")
        args = parser.parse_args()

        update_android_version(args.version)
        env = setup_environment()
        install_android_sdk(env)
        build_app(env, args.version)
        log("Android compilation task finished successfully!")
    except Exception as e:
        log(f"FATAL ERROR during compilation: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
