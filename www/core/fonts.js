// CueMark - Custom fonts: lets the user change the whole app's font, either
// from system-safe stacks that need no network, or from a small set of
// Google Fonts fetched once and cached via the Cache Storage API so later
// launches (including fully offline ones) don't need to hit the network
// again. If a backup folder is configured (Settings → Backups), the font
// file is also mirrored there as cuemark-db/fonts/<file>.woff2, matching how
// poster thumbnails are mirrored — a plain file the user can back up.
// Depends on globals from app.js: state, saveData(), backupFolderPluginAvailable(),
// getOrPickBackupFolderUri().

const FONT_CACHE_NAME = "cuemark-fonts-v1";

// System stacks need no download and always render immediately. Google Fonts
// entries are fetched on first use (or read from the fonts cache after that);
// `cssFamily` is what actually gets applied via --font-body/--font-heading —
// for Google Fonts this is the family name registered by the injected
// @font-face, for system stacks it's the fallback stack itself.
const FONT_CHOICES = {
  system: { label: "System Default", cssFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", kind: "system" },
  inter: { label: "Inter (default)", cssFamily: "'Inter', sans-serif", kind: "system" },
  outfit: { label: "Outfit", cssFamily: "'Outfit', sans-serif", kind: "system" },
  serif: { label: "Serif", cssFamily: "Georgia, 'Times New Roman', serif", kind: "system" },
  monospace: { label: "Monospace", cssFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", kind: "system" },
  rounded: { label: "Rounded", cssFamily: "'SF Pro Rounded', 'Segoe UI Rounded', ui-rounded, sans-serif", kind: "system" },
  poppins: { label: "Poppins", cssFamily: "'Poppins', sans-serif", kind: "google", googleFamily: "Poppins", weights: "400;500;600;700;800" },
  roboto: { label: "Roboto", cssFamily: "'Roboto', sans-serif", kind: "google", googleFamily: "Roboto", weights: "400;500;700" },
  nunito: { label: "Nunito", cssFamily: "'Nunito', sans-serif", kind: "google", googleFamily: "Nunito", weights: "400;600;700;800" },
  lato: { label: "Lato", cssFamily: "'Lato', sans-serif", kind: "google", googleFamily: "Lato", weights: "400;700;900" },
  merriweather: { label: "Merriweather", cssFamily: "'Merriweather', serif", kind: "google", googleFamily: "Merriweather", weights: "400;700" },
  "jetbrains-mono": { label: "JetBrains Mono", cssFamily: "'JetBrains Mono', monospace", kind: "google", googleFamily: "JetBrains+Mono", weights: "400;500;700" }
};

function fontIsOnline() {
  return typeof cueMarkIsOffline !== "function" || !cueMarkIsOffline();
}

// Applies the currently saved font immediately for system fonts, or
// asynchronously once a Google Font's stylesheet + woff2 are ready. Safe to
// call on every page load — cached fonts resolve instantly from Cache Storage,
// so there's no visible flash back to the previous font on repeat visits.
async function applyUiFont() {
  const key = state.preferences.uiFont || "inter";
  const choice = FONT_CHOICES[key] || FONT_CHOICES.inter;
  const root = document.documentElement;

  if (choice.kind === "system") {
    root.style.setProperty("--font-body", choice.cssFamily);
    root.style.setProperty("--font-heading", choice.cssFamily);
    return;
  }

  try {
    await ensureGoogleFontLoaded(key, choice);
    root.style.setProperty("--font-body", choice.cssFamily);
    root.style.setProperty("--font-heading", choice.cssFamily);
  } catch (err) {
    console.warn(`Could not load font "${choice.label}", falling back to Inter`, err);
    root.style.setProperty("--font-body", FONT_CHOICES.inter.cssFamily);
    root.style.setProperty("--font-heading", FONT_CHOICES.inter.cssFamily);
  }
}

// Registers a @font-face for `choice` using a blob URL, sourced from (in
// priority order): a previously-fetched Cache Storage entry, or a fresh
// network fetch of Google's CSS2 API + the woff2 file it points to. Each
// font is only ever injected into the document once per page load.
async function ensureGoogleFontLoaded(key, choice) {
  const styleId = `cuemark-font-face-${key}`;
  if (document.getElementById(styleId)) return; // already injected this page load

  const cache = await caches.open(FONT_CACHE_NAME);
  const woffCacheUrl = `https://cuemark-fonts.local/${key}.woff2`;

  let woffBlob = await (await cache.match(woffCacheUrl))?.blob();

  if (!woffBlob) {
    if (!fontIsOnline()) throw new Error("Font not cached and device is offline");

    const cssUrl = `https://fonts.googleapis.com/css2?family=${choice.googleFamily}:wght@${choice.weights}&display=swap`;
    const cssRes = await fetch(cssUrl);
    if (!cssRes.ok) throw new Error(`Google Fonts CSS fetch failed: ${cssRes.status}`);
    const cssText = await cssRes.text();

    // Prefer a woff2 URL from the returned CSS (take the first — Google
    // returns one @font-face per supported unicode-range/weight, but a single
    // file already covers Latin text which is all this app displays).
    const match = cssText.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/);
    if (!match) throw new Error("No woff2 URL found in Google Fonts CSS response");

    const woffRes = await fetch(match[1]);
    if (!woffRes.ok) throw new Error(`Font file fetch failed: ${woffRes.status}`);
    await cache.put(woffCacheUrl, woffRes.clone());
    woffBlob = await woffRes.blob();

    mirrorFontToBackupFolder(key, woffBlob).catch(err => console.warn("Could not mirror font to backup folder", err));
  }

  const blobUrl = URL.createObjectURL(woffBlob);
  const style = document.createElement("style");
  style.id = styleId;
  style.textContent = `@font-face { font-family: '${choice.googleFamily.replace(/\+/g, " ")}'; src: url('${blobUrl}') format('woff2'); font-display: swap; }`;
  document.head.appendChild(style);
}

// Mirrors a downloaded font file into cuemark-db/fonts/<key>.woff2 on the
// user's chosen backup folder, same as poster thumbnails — best-effort only,
// never blocks font loading itself if no folder is configured or the write fails.
// Only runs if a folder is ALREADY configured — picking a font must never
// itself trigger the native folder-picker prompt out of nowhere.
async function mirrorFontToBackupFolder(key, blob) {
  if (typeof backupFolderPluginAvailable !== "function" || !backupFolderPluginAvailable()) return;

  const folderUri = localStorage.getItem("cuemark_backup_folder_uri");
  if (!folderUri) return;

  const plugin = window.Capacitor.Plugins.BackupFolder;
  try {
    const check = await plugin.hasPersistedFolder({ uri: folderUri });
    if (!check || !check.valid) return;
  } catch (err) {
    return;
  }

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
  const base64 = dataUrl.split(",")[1];
  if (!base64) return;

  await plugin.writeNestedBinaryFile({
    uri: folderUri,
    dirPath: ["cuemark-db", "fonts"],
    fileName: `${key}.woff2`,
    base64Content: base64
  });
}
