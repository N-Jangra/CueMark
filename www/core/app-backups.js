// SquashDB backup and Storage Access Framework integration.
// Loaded as a feature module before app.js; functions remain global for the
// existing settings and backup page event handlers.

const ENCRYPTED_BACKUP_FORMAT = "SQDB-ENCRYPTED-1";
const ENCRYPTED_BACKUP_ITERATIONS = 210000;

function formatBackupBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function setBackupProgress(label, value = 0, visible = true) {
  const root = document.getElementById("backup-progress");
  if (!root) return;
  root.style.display = visible ? "block" : "none";
  const clamped = Math.max(0, Math.min(100, Number(value) || 0));
  const labelEl = document.getElementById("backup-progress-label");
  const valueEl = document.getElementById("backup-progress-value");
  const bar = document.getElementById("backup-progress-bar");
  if (labelEl) labelEl.textContent = label;
  if (valueEl) valueEl.textContent = `${Math.round(clamped)}%`;
  if (bar) bar.style.width = `${clamped}%`;
}

function finishBackupProgress(label = "Backup complete") {
  setBackupProgress(label, 100, true);
  setTimeout(() => setBackupProgress("", 0, false), 1800);
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function deriveBackupKey(passphrase, salt) {
  const material = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ENCRYPTED_BACKUP_ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptBackupText(plainText, passphrase) {
  if (!passphrase || passphrase.length < 8) throw new Error("Backup passphrase must be at least 8 characters.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveBackupKey(passphrase, salt);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, new TextEncoder().encode(plainText)
  );
  return JSON.stringify({
    format: ENCRYPTED_BACKUP_FORMAT,
    kdf: "PBKDF2-SHA256",
    iterations: ENCRYPTED_BACKUP_ITERATIONS,
    cipher: "AES-256-GCM",
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(encrypted))
  });
}

async function decryptBackupText(encryptedText, passphrase) {
  if (!passphrase || passphrase.length < 8) throw new Error("Backup passphrase must be at least 8 characters.");
  const envelope = JSON.parse(encryptedText);
  if (envelope.format !== ENCRYPTED_BACKUP_FORMAT || envelope.kdf !== "PBKDF2-SHA256" || envelope.cipher !== "AES-256-GCM") {
    throw new Error("Unsupported encrypted backup format.");
  }
  const salt = base64ToBytes(envelope.salt);
  const iv = base64ToBytes(envelope.iv);
  const key = await deriveBackupKey(passphrase, salt);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv }, key, base64ToBytes(envelope.ciphertext)
  );
  return new TextDecoder().decode(plain);
}

function cloudSyncConfig() {
  return {
    endpoint: localStorage.getItem("squashdb_cloud_endpoint") || "",
    username: localStorage.getItem("squashdb_cloud_username") || ""
  };
}

function cloudSyncHeaders(username, password) {
  const headers = { "Content-Type": "application/json" };
  if (username || password) headers.Authorization = `Basic ${btoa(`${username}:${password}`)}`;
  return headers;
}

function validateCloudEndpoint(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("Cloud sync requires an HTTPS endpoint.");
  }
  return url.toString();
}

async function exportEncryptedBackup() {
  const passphrase = prompt("Create an encryption passphrase (8+ characters). You will need it to restore this backup:");
  if (passphrase === null) return;
  const encrypted = await encryptBackupText(JSON.stringify(buildBackupPayload(true), null, 2), passphrase);
  const dateStr = new Date().toISOString().split("T")[0];
  const fileName = `squashdb_backup_${dateStr}.sqdbe`;

  if (backupFolderPluginAvailable()) {
    const folderUri = await getOrPickBackupFolderUri();
    await window.Capacitor.Plugins.BackupFolder.writeFile({ uri: folderUri, fileName, content: encrypted });
    alert("Encrypted backup saved to the selected folder.");
    return;
  }

  const url = URL.createObjectURL(new Blob([encrypted], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

async function importEncryptedBackupText(encryptedText) {
  const passphrase = prompt("Enter the encryption passphrase for this backup:");
  if (passphrase === null) return;
  try {
    const plainText = await decryptBackupText(encryptedText, passphrase);
    applyImportedBackupJson(JSON.parse(plainText));
  } catch (err) {
    console.warn("Encrypted backup restore failed", err);
    alert("Could not decrypt this backup. Check the passphrase and file.");
  }
}

async function syncEncryptedBackupToCloud() {
  const endpoint = validateCloudEndpoint(document.getElementById("cloud-endpoint")?.value.trim() || "");
  const username = document.getElementById("cloud-username")?.value.trim() || "";
  const password = document.getElementById("cloud-password")?.value || "";
  const passphrase = prompt("Enter the encryption passphrase for this cloud backup:");
  if (passphrase === null) return;

  localStorage.setItem("squashdb_cloud_endpoint", endpoint);
  localStorage.setItem("squashdb_cloud_username", username);
  const encrypted = await encryptBackupText(JSON.stringify(buildBackupPayload(true), null, 2), passphrase);
  const response = await fetch(endpoint, { method: "PUT", headers: cloudSyncHeaders(username, password), body: encrypted });
  if (!response.ok) throw new Error(`Cloud upload failed: HTTP ${response.status}`);
  localStorage.setItem("squashdb_cloud_last_sync", `Synced ${new Date().toLocaleString()}`);
  alert("Encrypted backup uploaded successfully.");
}

async function restoreEncryptedBackupFromCloud() {
  const config = cloudSyncConfig();
  const endpoint = validateCloudEndpoint(document.getElementById("cloud-endpoint")?.value.trim() || config.endpoint);
  const username = document.getElementById("cloud-username")?.value.trim() || config.username;
  const password = document.getElementById("cloud-password")?.value || "";
  const response = await fetch(endpoint, { headers: cloudSyncHeaders(username, password) });
  if (!response.ok) throw new Error(`Cloud download failed: HTTP ${response.status}`);
  const encryptedText = await response.text();
  const passphrase = prompt("Enter the encryption passphrase for this cloud backup:");
  if (passphrase === null) return;
  try {
    const parsed = JSON.parse(await decryptBackupText(encryptedText, passphrase));
    const localIds = new Set(state.items.map(item => item.id));
    const incoming = parsed.items || [];
    const additions = incoming.filter(item => !localIds.has(item.id)).length;
    const conflicts = incoming.length - additions;
    if (!confirm(`Cloud backup comparison:\n\n${additions} new item(s)\n${conflicts} existing item(s)\n\nRestore and merge the cloud backup? Existing local items will be kept.`)) return;
    applyImportedBackupJson(parsed, { skipConfirm: true });
    localStorage.setItem("squashdb_cloud_last_sync", `Restored ${new Date().toLocaleString()}`);
  } catch (err) {
    console.warn("Cloud conflict resolution failed", err);
    alert("Could not decrypt or compare the cloud backup. Check the passphrase and file.");
  }
}

async function refreshBackupRecoveryCenter() {
  const status = document.getElementById("backup-recovery-status");
  const list = document.getElementById("backup-recovery-list");
  if (!status || !list) return;
  if (!backupFolderPluginAvailable()) {
    status.textContent = "Backup recovery details are available in the Android app.";
    return;
  }
  const uri = localStorage.getItem("squashdb_backup_folder_uri");
  if (!uri) {
    updateBackupStatusCard([], "");
    status.textContent = "Select a backup folder to see recovery files.";
    list.innerHTML = "";
    return;
  }
  try {
    const result = await window.Capacitor.Plugins.BackupFolder.listFiles({ uri });
    const files = (result?.files || []).filter(file => /^squashdb_(backup|background)_.*\.(tar|json|sqdbe|sqdb)$/.test(file.name));
    files.sort((a, b) => b.name.localeCompare(a.name));
    updateBackupStatusCard(files, uri);
    status.textContent = files.length ? `${files.length} backup file(s) available.` : "No dated backups found in this folder.";
    list.innerHTML = files.map(file => `<button type="button" class="settings-row settings-row-picker backup-recovery-file" data-uri="${encodeURIComponent(file.uri)}" data-name="${encodeURIComponent(file.name)}"><div class="settings-row-icon"><i data-lucide="archive-restore"></i></div><div class="settings-row-body"><label>${escapeBackupHtml(file.name)}</label><span>${formatBackupBytes(file.size)} · Preview before restoring</span></div><i data-lucide="chevron-right" class="settings-row-chevron"></i></button>`).join("");
    list.querySelectorAll(".backup-recovery-file").forEach(button => button.addEventListener("click", () => restoreNativeBackupFile(decodeURIComponent(button.dataset.uri), decodeURIComponent(button.dataset.name))));
    lucide.createIcons();
  } catch (err) {
    console.warn("Could not load backup recovery list", err);
    status.textContent = "Could not read the backup folder. Select it again if needed.";
  }
}

function updateBackupStatusCard(files, uri) {
  const last = files[0];
  const size = files.reduce((total, file) => total + (Number(file.size) || 0), 0);
  const lastDate = document.getElementById("backup-last-date");
  const totalSize = document.getElementById("backup-total-size");
  const location = document.getElementById("backup-storage-location");
  const cloud = document.getElementById("backup-cloud-status");
  if (lastDate) lastDate.textContent = last ? (last.lastModified ? new Date(last.lastModified).toLocaleString() : last.name.replace(/^squashdb_(backup|background)_/, "").replace(/\.(tar|json|sqdbe|sqdb)$/, "")) : "Never";
  if (totalSize) totalSize.textContent = files.length ? formatBackupBytes(size) : "—";
  if (location) location.textContent = uri ? friendlyFolderPathFromUri(uri) : "Not selected";
  if (cloud) cloud.textContent = cloudSyncConfig().endpoint ? (localStorage.getItem("squashdb_cloud_last_sync") || "Configured") : "Not configured";
}

async function updateBackupStorageUsage() {
  const database = document.getElementById("storage-database-size");
  const images = document.getElementById("storage-image-cache-size");
  const metadata = document.getElementById("storage-metadata-cache-size");
  if (!database || !images || !metadata) return;
  database.textContent = formatBackupBytes(new Blob([JSON.stringify({ items: state.items, watchLog: state.watchLog || [], preferences: state.preferences })]).size);
  try {
    const stats = await window.SquashDBCache?.stats?.();
    images.textContent = formatBackupBytes(stats?.imageBytes || 0);
    metadata.textContent = formatBackupBytes(stats?.metadataBytes || 0);
  } catch (err) {
    images.textContent = "Unavailable";
    metadata.textContent = "Unavailable";
  }
}

async function runBackupHealthCheck() {
  const output = document.getElementById("backup-health-status");
  if (!output) return;
  output.textContent = "Checking storage permission and latest backup…";
  const uri = localStorage.getItem("squashdb_backup_folder_uri");
  if (!backupFolderPluginAvailable() || !uri) {
    output.textContent = "Select an Android backup folder to run a health check.";
    return;
  }
  try {
    const valid = await window.Capacitor.Plugins.BackupFolder.hasPersistedFolder({ uri });
    if (!valid?.valid) throw new Error("Android storage permission is missing or revoked.");
    const result = await window.Capacitor.Plugins.BackupFolder.listFiles({ uri });
    const latest = (result?.files || []).filter(file => /^squashdb_(backup|background)_.*\.(tar|json|sqdbe|sqdb)$/.test(file.name)).sort((a, b) => b.name.localeCompare(a.name))[0];
    if (!latest) throw new Error("No backup snapshot was found.");
    if (latest.name.endsWith(".tar")) await window.Capacitor.Plugins.BackupFolder.readBinaryFile({ uri: latest.uri });
    else await window.Capacitor.Plugins.BackupFolder.readFile({ uri: latest.uri });
    output.textContent = `Healthy · ${latest.name} is readable.`;
    output.style.color = "var(--primary)";
  } catch (err) {
    output.textContent = `Needs attention · ${err.message || "Backup could not be read."}`;
    output.style.color = "var(--danger)";
  }
}

function escapeBackupHtml(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function restoreNativeBackupFile(uri, name) {
  let preview = `${name}\n\nExisting items will be kept and incoming items will be merged.`;
  try {
    const plugin = window.Capacitor.Plugins.BackupFolder;
    const fileInfo = (await plugin.listFiles({ uri: localStorage.getItem("squashdb_backup_folder_uri") })).files?.find(file => file.uri === uri);
    if (fileInfo?.size) preview += `\nSize: ${formatBackupBytes(fileInfo.size)}`;
    if (name.endsWith(".json")) {
      const parsed = JSON.parse((await plugin.readFile({ uri })).content);
      preview += `\nItems: ${Array.isArray(parsed.items) ? parsed.items.length : "unknown"}`;
    } else if (name.endsWith(".tar")) {
      const { base64Content } = await plugin.readBinaryFile({ uri });
      const entries = parseTarArchive(base64ToArrayBuffer(base64Content));
      const jsonEntry = entries.find(entry => !entry.name.includes("/") && entry.name.endsWith(".json"));
      if (jsonEntry) {
        const parsed = JSON.parse(new TextDecoder("utf-8").decode(jsonEntry.content));
        preview += `\nItems: ${Array.isArray(parsed.items) ? parsed.items.length : "unknown"}`;
      }
      preview += `\nArchive entries: ${entries.length}`;
    } else if (name.endsWith(".sqdbe")) {
      preview += "\nEncrypted backup — passphrase required before reading its contents.";
    } else {
      preview += "\nEncrypted local database snapshot.";
    }
  } catch (err) {
    preview += "\nPreview unavailable; the backup may still be restorable.";
  }
  if (!confirm(`Restore this backup?\n\n${preview}`)) return;
  try {
    const plugin = window.Capacitor.Plugins.BackupFolder;
    if (name.endsWith(".sqdb")) {
      const result = await plugin.readFile({ uri });
      const encryptedStore = window.Capacitor?.Plugins?.EncryptedStore;
      if (!encryptedStore?.importPackedState) throw new Error("Encrypted local database restore is unavailable.");
      await encryptedStore.importPackedState({ packed: result.content });
      alert("Encrypted local database restored. The app will reload now.");
      window.location.reload();
    } else if (name.endsWith(".sqdbe")) {
      const result = await plugin.readFile({ uri });
      await importEncryptedBackupText(result.content);
    } else if (name.endsWith(".tar")) {
      const result = await plugin.readBinaryFile({ uri });
      const jsonEntry = parseTarArchive(base64ToArrayBuffer(result.base64Content)).find(entry => !entry.name.includes("/") && entry.name.endsWith(".json"));
      if (!jsonEntry) throw new Error("Backup JSON was not found in the archive.");
      applyImportedBackupJson(JSON.parse(new TextDecoder("utf-8").decode(jsonEntry.content)));
    } else {
      const result = await plugin.readFile({ uri });
      applyImportedBackupJson(JSON.parse(result.content));
    }
  } catch (err) {
    console.warn("Backup recovery failed", err);
    alert("Could not restore this backup file.");
  }
}

function buildBackupPayload(includePreferences = true) {
  const payload = {
    version: "1.0",
    appName: "SquashDB",
    exportDate: new Date().toISOString(),
    items: state.items
  };

  if (includePreferences) {
    payload.preferences = state.preferences;
    payload.lastEntryCategory = state.lastEntryCategory;
    payload.activeCategoryChip = state.activeCategoryChip || "";
  }

  return payload;
}

function restoreBackupData(parsedData, includePreferences = true) {
  if (!parsedData || parsedData.appName !== "SquashDB" || !Array.isArray(parsedData.items)) {
    alert("Invalid file format. Please select a valid SquashDB JSON backup file.");
    return false;
  }

  const currentIds = new Set(state.items.map(item => item.id));
  parsedData.items.forEach(item => {
    if (!currentIds.has(item.id)) {
      state.items.push(item);
    }
  });

  if (includePreferences && parsedData.preferences) {
    state.preferences = { ...state.preferences, ...parsedData.preferences };
  }

  if (includePreferences && parsedData.lastEntryCategory) {
    state.lastEntryCategory = parsedData.lastEntryCategory;
  }

  if (includePreferences && typeof parsedData.activeCategoryChip === "string") {
    state.activeCategoryChip = parsedData.activeCategoryChip;
  }

  saveData();
  renderCategoryChips();
  renderCategorySelectOptions();
  renderDashboard();
  renderTimeline();
  renderStats();
  updateSettingsUI();
  return true;
}

// Turns a title/key into a filesystem-safe folder name (lowercase, underscores,
// no characters illegal in FAT/SAF paths).
function slugifyForFolder(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/[/\\:*?"<>|]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 80) || "untitled";
}

// Appends a short id suffix if another item already claimed this slug within the category.
function uniqueItemSlug(item, usedSlugs) {
  const base = slugifyForFolder(item.title);
  if (!usedSlugs.has(base)) {
    usedSlugs.add(base);
    return base;
  }
  const suffixed = `${base}_${item.id.slice(0, 8)}`;
  usedSlugs.add(suffixed);
  return suffixed;
}

async function decodeThumbnailBlob(blob) {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(blob);
  }

  // Older Android WebViews do not expose createImageBitmap. Decode through an
  // object URL instead, then revoke it so repeated backups do not leak memory.
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Thumbnail image could not be decoded"));
      image.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function base64FromDataUrl(url) {
  const match = String(url || "").match(/^data:[^;]+;base64,(.*)$/s);
  return match ? match[1] : null;
}

// Fetches a thumbnail URL and re-encodes it as WebP, returning base64
// (without the data-URL prefix) ready for writeNestedBinaryFile. If WebP
// conversion is unavailable, the original image bytes are retained so an
// Android WebView still gets a usable offline thumbnail.
async function thumbnailUrlToWebpBase64(url) {
  if (typeof url !== "string" || !url) return null;

  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();

    const bitmap = await decodeThumbnailBlob(blob);
    const canvas = document.createElement("canvas");
    const sourceWidth = bitmap.width || bitmap.naturalWidth || 1;
    const sourceHeight = bitmap.height || bitmap.naturalHeight || 1;
    const maxWidth = 500;
    const scale = Math.min(1, maxWidth / sourceWidth);
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (typeof bitmap.close === "function") bitmap.close();

    const webpBlob = await new Promise(resolve => canvas.toBlob(resolve, "image/webp", 0.9));
    const outputBlob = webpBlob || blob;

    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(outputBlob);
    });

    const match = dataUrl.match(/^data:.*;base64,(.*)$/s);
    return match ? match[1] : null;
  } catch (err) {
    // A data URL may already be a complete offline image. Preserve it even
    // when this WebView cannot decode/re-encode that particular format.
    const original = base64FromDataUrl(url);
    if (original) return original;
    console.warn("Could not prepare thumbnail for backup", url, err);
    return null;
  }
}

// Mirrors state.items into squash-db/<category>/<item_slug>/index.json (+ .thumbnail)
// on the chosen backup folder. Additive only: never deletes or moves existing folders,
// so items removed/recategorized in-app leave their old folder behind.
async function syncFolderTreeMirror() {
  if (!backupFolderPluginAvailable()) return;

  const plugin = window.Capacitor.Plugins.BackupFolder;
  let folderUri;
  try {
    folderUri = await getOrPickBackupFolderUri();
  } catch (err) {
    console.warn("Folder tree sync skipped: no backup folder selected", err);
    return;
  }

  // Drop a .nomedia marker in squash-db/ so Android's media scanner skips every
  // .thumbnail under it — otherwise each show/movie poster shows up in the
  // device's photo gallery, which nobody wants for app-internal cache images.
  if (!localStorage.getItem("squashdb_nomedia_written")) {
    try {
      await plugin.writeNestedFile({
        uri: folderUri,
        dirPath: ["squash-db"],
        fileName: ".nomedia",
        content: ""
      });
      localStorage.setItem("squashdb_nomedia_written", "true");
    } catch (err) {
      console.warn("Could not write .nomedia marker", err);
    }
  }

  const syncedHashes = JSON.parse(localStorage.getItem("squashdb_synced_item_hashes") || "{}");
  const usedSlugsByCategory = {};
  const syncErrors = [];
  let syncedCount = 0;
  let skippedUnchangedCount = 0;
  const totalItems = state.items.length;
  setBackupProgress("Syncing backup items…", 0);

  for (const [itemIndex, item] of state.items.entries()) {
    const categorySlug = slugifyForFolder(item.category);
    if (!usedSlugsByCategory[categorySlug]) usedSlugsByCategory[categorySlug] = new Set();

    const itemHash = JSON.stringify(item);
    if (syncedHashes[item.id] === itemHash) {
      skippedUnchangedCount++;
      setBackupProgress(`Checking item ${itemIndex + 1} of ${totalItems}…`, totalItems ? ((itemIndex + 1) / totalItems) * 75 : 75);
      continue;
    }

    const itemSlug = uniqueItemSlug(item, usedSlugsByCategory[categorySlug]);
    const dirPath = ["squash-db", categorySlug, itemSlug];

    try {
      await plugin.writeNestedFile({
        uri: folderUri,
        dirPath,
        fileName: "index.json",
        content: JSON.stringify(item, null, 2)
      });

      const base64Thumb = await thumbnailUrlToWebpBase64(item.thumbnail);
      if (base64Thumb) {
        await plugin.writeNestedBinaryFile({
          uri: folderUri,
          dirPath,
          // Dot-prefixed app-private filename: Android gallery/indexers do not
          // treat it as a user photo, while the backup plugin can still read it.
          fileName: ".thumbnail",
          base64Content: base64Thumb
        });
      }

      syncedHashes[item.id] = itemHash;
      syncedCount++;
    } catch (err) {
      console.error(`Folder tree sync failed for item "${item.title}" (${item.id})`, err);
      syncErrors.push(`${item.title || item.id}: ${err?.message || err}`);
    }
    setBackupProgress(`Syncing item ${itemIndex + 1} of ${totalItems}…`, totalItems ? ((itemIndex + 1) / totalItems) * 75 : 75);
  }

  localStorage.setItem("squashdb_synced_item_hashes", JSON.stringify(syncedHashes));

  console.log(`Folder tree sync: ${syncedCount} written, ${skippedUnchangedCount} unchanged/skipped, ${syncErrors.length} failed (of ${state.items.length} total items)`);
  if (syncErrors.length > 0) {
    console.error("Folder tree sync errors:", syncErrors);
  }

  try {
    normalizeMetadataSources();
    const redactedSources = {
      ...state.preferences.metadataSources,
      custom: state.preferences.metadataSources.custom.map(src => ({
        ...src,
        apiKey: src.apiKey ? "***REDACTED***" : ""
      }))
    };
    await plugin.writeNestedFile({
      uri: folderUri,
      dirPath: ["squash-db", "settings"],
      fileName: "metadata-sources.json",
      content: JSON.stringify(redactedSources, null, 2)
    });
  } catch (err) {
    console.warn("Failed to sync metadata source settings to folder tree", err);
  }

  setBackupProgress("Finalizing backup…", 82);
  return { syncedCount, skippedUnchangedCount, syncErrors, totalItems: state.items.length };
}

// Removes a deleted item from the folder-tree mirror on Android. The mirror is
// keyed by category/item slug, so we have to scan category folders and match the
// stored index.json by item.id before deleting the row's folder contents.
async function pruneDeletedItemFromFolderTree(item) {
  if (!item || !backupFolderPluginAvailable()) return;
  if (!localStorage.getItem("squashdb_backup_folder_uri")) return;

  const plugin = window.Capacitor.Plugins.BackupFolder;
  let folderUri;
  try {
    folderUri = await getOrPickBackupFolderUri();
  } catch (err) {
    return;
  }

  try {
    const root = await plugin.listFiles({ uri: folderUri });
    const squashDbFolder = (root?.files || []).find(f => f.name === "squash-db");
    if (!squashDbFolder) return;

    const categories = await plugin.listFiles({ uri: squashDbFolder.uri });
    for (const categoryFolder of categories?.files || []) {
      if (categoryFolder.name === "settings") continue;

      const items = await plugin.listFiles({ uri: categoryFolder.uri });
      for (const itemFolder of items?.files || []) {
        try {
          const files = await plugin.listFiles({ uri: itemFolder.uri });
          const indexJson = (files?.files || []).find(f => f.name === "index.json");
          if (!indexJson) continue;
          const { content } = await plugin.readFile({ uri: indexJson.uri });
          const storedItem = JSON.parse(content);
          if (!storedItem || storedItem.id !== item.id) continue;

          for (const file of files?.files || []) {
            try {
              await plugin.deleteFile({ uri: file.uri });
            } catch (err) {
              console.warn(`Could not delete mirror file "${file.name}" for item "${item.title}"`, err);
            }
          }

          try {
            await plugin.deleteFile({ uri: itemFolder.uri });
          } catch (err) {
            console.warn(`Could not delete mirror folder for item "${item.title}"`, err);
          }

          const syncedHashes = JSON.parse(localStorage.getItem("squashdb_synced_item_hashes") || "{}");
          delete syncedHashes[item.id];
          localStorage.setItem("squashdb_synced_item_hashes", JSON.stringify(syncedHashes));
          return;
        } catch (err) {
          console.warn(`Could not inspect folder-tree mirror for item "${item.title}"`, err);
        }
      }
    }
  } catch (err) {
    console.warn("Folder-tree prune skipped", err);
  }
}

let folderSyncIdleTimer = null;
function scheduleFolderTreeAutoSync() {
  if (!backupFolderPluginAvailable()) return;
  if (!localStorage.getItem("squashdb_backup_folder_uri")) return;
  if (folderSyncIdleTimer) clearTimeout(folderSyncIdleTimer);

  const delay = parseInt(state.preferences.folderSyncDelay, 10) || 0;
  if (delay === 0) {
    syncFolderTreeMirror();
    return;
  }
  folderSyncIdleTimer = setTimeout(syncFolderTreeMirror, delay);
}

function backupFolderPluginAvailable() {
  return isNativeApp() && window.Capacitor.Plugins && window.Capacitor.Plugins.BackupFolder;
}

function rememberNativeBackupFolder(uri) {
  const plugin = window.Capacitor?.Plugins?.BackupFolder;
  if (plugin?.rememberFolder && uri) {
    plugin.rememberFolder({ uri }).catch(err => console.warn("Could not remember native backup location", err));
  }
}

// Silently checks the saved backup folder URI at app startup — never opens the
// native picker. If it's missing or no longer valid (e.g. the folder was moved,
// deleted, or its SAF grant was revoked), records that so Settings can show a
// "Backup folder needs to be re-selected" notice without an intrusive popup.
async function checkBackupFolderOnStartup() {
  if (!backupFolderPluginAvailable()) return;

  const savedUri = localStorage.getItem("squashdb_backup_folder_uri");
  if (!savedUri) {
    localStorage.setItem("squashdb_backup_folder_invalid", "true");
    updateBackupFolderStatusUI();
    await promptForBackupFolderOnStartup("No backup storage folder is configured. Select a folder to store your SquashDB data and backups.");
    return;
  }

  let valid = false;
  try {
    const check = await window.Capacitor.Plugins.BackupFolder.hasPersistedFolder({ uri: savedUri });
    valid = Boolean(check?.valid);
    localStorage.setItem("squashdb_backup_folder_invalid", valid ? "false" : "true");
  } catch (err) {
    console.warn("Could not validate saved backup folder on startup", err);
    localStorage.setItem("squashdb_backup_folder_invalid", "true");
  }

  updateBackupFolderStatusUI();

  if (valid) {
    rememberNativeBackupFolder(savedUri);
    runAutoBackupIfDue(savedUri);
  } else {
    await promptForBackupFolderOnStartup("SquashDB cannot access its storage folder. Select the folder again to keep local storage and backups available.");
  }
}

let backupFolderStartupPromptInFlight = false;

async function promptForBackupFolderOnStartup(message) {
  if (backupFolderStartupPromptInFlight) return;
  backupFolderStartupPromptInFlight = true;
  try {
    alert(message);
    await chooseBackupFolder();
  } finally {
    backupFolderStartupPromptInFlight = false;
  }
}

const AUTO_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const AUTO_BACKUP_KEEP_COUNT = 3;

// Runs on every app launch (see checkBackupFolderOnStartup). There is no background
// process while the app is closed, so "every 24 hours" means "on the next app open
// that happens 24h+ after the last auto-backup" rather than a literal daily timer.
async function runAutoBackupIfDue(folderUri) {
  const lastRun = parseInt(localStorage.getItem("squashdb_last_auto_backup_at") || "0", 10);
  if (Date.now() - lastRun < AUTO_BACKUP_INTERVAL_MS) return;
  if (state.items.length === 0) return; // nothing worth backing up yet

  try {
    const dateStr = new Date().toISOString().split("T")[0];
    await writeTarBackup(folderUri, dateStr);
    localStorage.setItem("squashdb_last_auto_backup_at", String(Date.now()));
    await pruneOldAutoBackups(folderUri);
    await pruneOldBackgroundSnapshots(folderUri);
    console.log("Auto-backup completed:", dateStr);
  } catch (err) {
    console.warn("Auto-backup failed", err);
  }
}

// Keeps only the newest AUTO_BACKUP_KEEP_COUNT squashdb_backup_*.tar files at the
// folder root (plus their same-dated .json sibling, written alongside each tar),
// deleting older ones. Only touches dated backup archives — never squash-db/
// itself or anything else in the folder.
async function pruneOldAutoBackups(folderUri) {
  const plugin = window.Capacitor.Plugins.BackupFolder;
  const { files } = await plugin.listFiles({ uri: folderUri });

  const backupFileRe = /^squashdb_backup_(\d{4}-\d{2}-\d{2})\.(tar|json)$/;
  const matched = (files || [])
    .map(f => ({ ...f, match: f.name.match(backupFileRe) }))
    .filter(f => f.match);

  const distinctDates = [...new Set(matched.map(f => f.match[1]))].sort((a, b) => b.localeCompare(a));
  const datesToDelete = new Set(distinctDates.slice(AUTO_BACKUP_KEEP_COUNT));

  const toDelete = matched.filter(f => datesToDelete.has(f.match[1]));
  for (const file of toDelete) {
    try {
      await plugin.deleteFile({ uri: file.uri });
    } catch (err) {
      console.warn(`Could not delete old auto-backup "${file.name}"`, err);
    }
  }
}

async function pruneOldBackgroundSnapshots(folderUri) {
  const plugin = window.Capacitor.Plugins.BackupFolder;
  const result = await plugin.listFiles({ uri: folderUri });
  const snapshots = (result?.files || []).filter(file => /^squashdb_background_.*\.sqdb$/.test(file.name)).sort((a, b) => b.name.localeCompare(a.name));
  for (const file of snapshots.slice(3)) {
    try { await plugin.deleteFile({ uri: file.uri }); }
    catch (err) { console.warn(`Could not delete old background snapshot "${file.name}"`, err); }
  }
}

function updateBackupFolderStatusUI() {
  const notice = document.getElementById("backup-folder-status-notice");
  if (notice) {
    const invalid = localStorage.getItem("squashdb_backup_folder_invalid") === "true";
    notice.style.display = invalid ? "block" : "none";
  }

  const pathEl = document.getElementById("backup-folder-path-display");
  if (pathEl) {
    const uri = localStorage.getItem("squashdb_backup_folder_uri");
    const label = pathEl.querySelector("[data-backup-folder-label]") || pathEl;
    label.textContent = uri ? `Current folder: ${friendlyFolderPathFromUri(uri)}` : "No backup folder selected yet.";
  }
}

// Best-effort human-readable path from a SAF tree content:// URI, so the user can
// visually confirm Sync/Export/Import are targeting the folder they expect —
// e.g. "content://...tree/primary%3ADocuments%2FSquashBackups" -> "/Documents/SquashBackups".
function friendlyFolderPathFromUri(uri) {
  try {
    const decoded = decodeURIComponent(uri);
    const match = decoded.match(/\/tree\/(.+)$/);
    if (!match) return uri;
    return "/" + match[1].replace(/^primary:/, "").replace(/^[^:]+:/, "");
  } catch (err) {
    return uri;
  }
}

// Resolves the SAF folder URI to store backups in, prompting the native folder
// picker only if none is saved yet or the previously saved one is no longer valid.
async function getOrPickBackupFolderUri() {
  const plugin = window.Capacitor.Plugins.BackupFolder;
  const savedUri = localStorage.getItem("squashdb_backup_folder_uri");

  if (savedUri) {
    try {
      const check = await plugin.hasPersistedFolder({ uri: savedUri });
      if (check && check.valid) return savedUri;
    } catch (err) {
      console.warn("Could not validate saved backup folder", err);
    }
  }

  const picked = await plugin.pickFolder();
  if (!picked || !picked.uri) throw new Error("No folder selected");
  localStorage.setItem("squashdb_backup_folder_uri", picked.uri);
  rememberNativeBackupFolder(picked.uri);
  localStorage.setItem("squashdb_backup_folder_invalid", "false");
  updateBackupFolderStatusUI();
  await checkForExistingBackupToRestore(picked.uri);
  return picked.uri;
}

// Writes a full tar snapshot (squash-db/ tree + the current state JSON) into
// folderUri, named squashdb_backup_<YYYY-MM-DD>.tar / .json. Shared by the manual
// Export button and the daily auto-backup, so both produce identical archives.
async function writeTarBackup(folderUri, dateStr) {
  const dataStr = JSON.stringify(buildBackupPayload(true), null, 2);
  const jsonName = `squashdb_backup_${dateStr}.json`;
  const tarName = `squashdb_backup_${dateStr}.tar`;

  setBackupProgress("Preparing backup…", 2);
  await syncFolderTreeMirror();
  setBackupProgress("Creating backup archive…", 88);
  await window.Capacitor.Plugins.BackupFolder.exportTarArchive({
    uri: folderUri,
    sourceDirPath: ["squash-db"],
    tarFileName: tarName,
    extraJsonFileName: jsonName,
    extraJsonContent: dataStr
  });
  finishBackupProgress("Backup complete");
  return tarName;
}

async function exportData() {
  const dateStr = new Date().toISOString().split("T")[0];

  if (backupFolderPluginAvailable()) {
    try {
      const folderUri = await getOrPickBackupFolderUri();
      await writeTarBackup(folderUri, dateStr);
      alert("Backup saved successfully!");
    } catch (err) {
      console.warn("Backup export failed", err);
      alert("Could not save backup. Please choose a folder and try again.");
    }
    return;
  }

  const dataStr = JSON.stringify(buildBackupPayload(true), null, 2);
  const exportFileDefaultName = `squashdb_backup_${dateStr}.json`;

  if (window.showSaveFilePicker) {
    try {
      const fileHandle = await window.showSaveFilePicker({
        suggestedName: exportFileDefaultName,
        types: [
          {
            description: "JSON Backup",
            accept: { "application/json": [".json"] }
          }
        ]
      });
      const writable = await fileHandle.createWritable();
      await writable.write(dataStr);
      await writable.close();
      alert("Backup saved successfully!");
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }
  }

  const blob = new Blob([dataStr], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const linkElement = document.createElement("a");
  linkElement.href = url;
  linkElement.download = exportFileDefaultName;
  linkElement.click();
  URL.revokeObjectURL(url);
}

// Lets the user pick (or re-pick) the folder backups are saved to on native platforms.
async function chooseBackupFolder() {
  if (!backupFolderPluginAvailable()) return;
  try {
    const picked = await window.Capacitor.Plugins.BackupFolder.pickFolder();
    if (picked && picked.uri) {
      localStorage.setItem("squashdb_backup_folder_uri", picked.uri);
      rememberNativeBackupFolder(picked.uri);
      localStorage.setItem("squashdb_backup_folder_invalid", "false");
      updateBackupFolderStatusUI();
      await checkForExistingBackupToRestore(picked.uri);
      await refreshBackupRecoveryCenter();
      alert("Backup folder updated.");
    }
  } catch (err) {
    console.warn("Could not change backup folder", err);
  }
}

// Backup Import Database (JSON file upload)
// Parses a minimal POSIX (ustar) tar buffer and returns its top-level entries
// as { name, content: Uint8Array }[]. Mirrors the layout written natively by
// BackupFolderPlugin.TarWriter: 512-byte header, size as octal ASCII at offset
// 124/12 bytes, content padded to a 512-byte boundary, trailing zero blocks.
function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// If the app has no items yet (fresh install, or a chosen folder was never used
// before) and the just-picked SAF folder already contains backup files — from a
// previous install that used this same folder — offer to restore from the newest
// one instead of silently starting empty. Prefers a .tar (full snapshot) over a
// bare .json export if both exist, since the tar is the more complete source.
async function checkForExistingBackupToRestore(folderUri) {
  if (state.items.length > 0) return;
  if (!backupFolderPluginAvailable()) return;

  const plugin = window.Capacitor.Plugins.BackupFolder;
  let files;
  try {
    const result = await plugin.listFiles({ uri: folderUri });
    files = result?.files || [];
  } catch (err) {
    console.warn("Could not list backup folder contents for auto-restore check", err);
    return;
  }

  const backupFileRe = /^squashdb_backup_(\d{4}-\d{2}-\d{2})\.(tar|json|sqdbe)$/;
  const candidates = files
    .map(f => ({ ...f, match: f.name.match(backupFileRe) }))
    .filter(f => f.match)
    .sort((a, b) => {
      // Newest date first; prefer .tar, then encrypted, then plain JSON.
      if (a.match[1] !== b.match[1]) return b.match[1].localeCompare(a.match[1]);
      const rank = { tar: 0, sqdbe: 1, json: 2 };
      return rank[a.match[2]] - rank[b.match[2]];
    });

  if (candidates.length > 0) {
    const newest = candidates[0];

    if (!confirm(
      `Found an existing backup in this folder: "${newest.name}".\n\n` +
      `Your app has no items yet — restore from this backup now?`
    )) {
      return;
    }

    try {
      if (newest.match[2] === "tar") {
        const { base64Content } = await plugin.readBinaryFile({ uri: newest.uri });
        const entries = parseTarArchive(base64ToArrayBuffer(base64Content));
        const jsonEntry = entries.find(entry => !entry.name.includes("/") && entry.name.endsWith(".json"));
        if (!jsonEntry) {
          alert("Could not find backup data inside that tar file.");
          return;
        }
        applyImportedBackupJson(JSON.parse(new TextDecoder("utf-8").decode(jsonEntry.content)));
      } else if (newest.match[2] === "sqdbe") {
        const { content } = await plugin.readFile({ uri: newest.uri });
        await importEncryptedBackupText(content);
      } else {
        const { content } = await plugin.readFile({ uri: newest.uri });
        applyImportedBackupJson(JSON.parse(content));
      }
    } catch (err) {
      console.warn("Auto-restore from existing backup failed", err);
      alert("Could not restore from the existing backup. You can try importing it manually from Backups & Restore.");
    }
    return;
  }

  // No dated backup archive at the folder root — fall back to reconstructing
  // items directly from an existing squash-db/<category>/<item>/index.json tree
  // (e.g. left behind by a previous install that only ever auto-synced, and
  // never had a manual Export produce a .tar/.json file).
  const squashDbFolder = files.find(f => f.name === "squash-db");
  if (!squashDbFolder) return;

  let reconstructedItems;
  try {
    reconstructedItems = await reconstructItemsFromFolderTree(squashDbFolder.uri);
  } catch (err) {
    console.warn("Could not read squash-db/ tree for auto-restore check", err);
    return;
  }

  if (reconstructedItems.length === 0) return;

  if (!confirm(
    `Found ${reconstructedItems.length} item(s) synced from a previous install in this folder's squash-db/ tree.\n\n` +
    `Your app has no items yet — restore them now?`
  )) {
    return;
  }

  applyImportedBackupJson({ appName: "SquashDB", items: reconstructedItems });
}

// Walks squash-db/<category>/<item>/index.json (2 levels deep under the given
// squash-db/ folder URI) and returns every parsed Item found. Best-effort: a
// single unreadable/corrupt index.json is skipped, not fatal to the whole scan.
async function reconstructItemsFromFolderTree(squashDbUri) {
  const plugin = window.Capacitor.Plugins.BackupFolder;
  const items = [];

  const { files: categoryFolders } = await plugin.listFiles({ uri: squashDbUri });
  for (const categoryFolder of categoryFolders || []) {
    if (categoryFolder.name === "settings") continue; // metadata-sources.json lives here, not items

    let itemFolders;
    try {
      const result = await plugin.listFiles({ uri: categoryFolder.uri });
      itemFolders = result?.files || [];
    } catch (err) {
      continue;
    }

    for (const itemFolder of itemFolders) {
      try {
        const { files: itemFiles } = await plugin.listFiles({ uri: itemFolder.uri });
        const indexJsonFile = (itemFiles || []).find(f => f.name === "index.json");
        if (!indexJsonFile) continue;
        const { content } = await plugin.readFile({ uri: indexJsonFile.uri });
        const item = JSON.parse(content);
        if (item && item.id && item.title) items.push(item);
      } catch (err) {
        console.warn(`Skipping unreadable item folder during auto-restore: ${itemFolder.name}`, err);
      }
    }
  }

  return items;
}

function parseTarArchive(buffer) {
  const bytes = new Uint8Array(buffer);
  const entries = [];
  let offset = 0;

  const readString = (start, length) => {
    let end = start;
    while (end < start + length && bytes[end] !== 0) end++;
    return new TextDecoder("utf-8").decode(bytes.subarray(start, end));
  };
  const readOctal = (start, length) => {
    const str = readString(start, length).trim();
    return str ? parseInt(str, 8) : 0;
  };

  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(b => b === 0)) break; // zero block: end of archive

    const name = readString(offset, 100);
    const size = readOctal(offset + 124, 12);
    offset += 512;

    if (name) {
      entries.push({ name, content: bytes.slice(offset, offset + size) });
    }

    offset += Math.ceil(size / 512) * 512;
  }

  return entries;
}

function applyImportedBackupJson(parsedData, options = {}) {
  if (!parsedData || parsedData.appName !== "SquashDB" || !Array.isArray(parsedData.items)) {
    alert("Invalid file format. Please select a valid SquashDB backup file.");
    return;
  }

  if (options.skipConfirm || confirm(`Do you want to restore ${parsedData.items.length} items? This will merge with your current watchlist.`)) {
    const includePreferences = parsedData.preferences ? window.confirm(
      "This backup also contains system settings.\n\nChoose OK to restore settings too.\nChoose Cancel to restore app data only."
    ) : false;

    if (restoreBackupData(parsedData, includePreferences)) {
      alert("Backup restored successfully!");
    }
  }
}

function importData(e) {
  const file = e.target.files[0];
  if (!file) return;

  const lowerName = file.name.toLowerCase();
  const isEncrypted = lowerName.endsWith(".sqdbe") || lowerName.endsWith(".enc.json");
  if (isEncrypted) {
    const fileReader = new FileReader();
    fileReader.onload = event => importEncryptedBackupText(event.target.result);
    fileReader.readAsText(file);
    e.target.value = "";
    return;
  }

  const isTar = lowerName.endsWith(".tar");

  if (isTar) {
    const fileReader = new FileReader();
    fileReader.onload = function (event) {
      try {
        const entries = parseTarArchive(event.target.result);
        // The writer places the state JSON at the tar root (e.g. squashdb_backup_2026-07-09.json),
        // separate from the squash-db/ folder tree entries.
        const jsonEntry = entries.find(entry => !entry.name.includes("/") && entry.name.endsWith(".json"));
        if (!jsonEntry) {
          alert("Could not find a SquashDB backup JSON inside this tar file.");
          return;
        }
        const jsonText = new TextDecoder("utf-8").decode(jsonEntry.content);
        applyImportedBackupJson(JSON.parse(jsonText));
      } catch (err) {
        console.warn("Failed to read tar backup", err);
        alert("Error reading tar file. Make sure it's not corrupted.");
      }
    };
    fileReader.readAsArrayBuffer(file);
    return;
  }

  const fileReader = new FileReader();
  fileReader.onload = function (event) {
    try {
      applyImportedBackupJson(JSON.parse(event.target.result));
    } catch (err) {
      alert("Error reading JSON file. Make sure it's not corrupted.");
    }
  };
  fileReader.readAsText(file);
}
