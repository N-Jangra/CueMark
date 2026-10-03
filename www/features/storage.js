// Storage usage and cleanup controls for the Settings > Storage page.
(function () {
  "use strict";

  const bytesOf = value => new Blob([typeof value === "string" ? value : JSON.stringify(value ?? null)]).size;
  const formatBytes = bytes => {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  function row(label, bytes, total, tone = "primary") {
    const percent = total > 0 ? Math.max(1, Math.round((bytes / total) * 100)) : 0;
    return `<div class="storage-meter-row"><div class="storage-meter-label"><span>${label}</span><strong>${formatBytes(bytes)}</strong></div><div class="storage-meter-track"><span class="storage-meter-fill storage-meter-${tone}" style="width:${Math.min(100, percent)}%"></span></div></div>`;
  }

  async function backupBytes() {
    const plugin = window.Capacitor?.Plugins?.BackupFolder;
    const uri = localStorage.getItem("squashdb_backup_folder_uri");
    if (!plugin?.listFiles || !uri) return 0;
    try {
      const result = await plugin.listFiles({ uri });
      return (result?.files || []).filter(file => /^squashdb_/.test(file.name || "")).reduce((sum, file) => sum + (Number(file.size) || 0), 0);
    } catch (error) {
      console.warn("Could not measure backup storage", error);
      return 0;
    }
  }

  async function measure() {
    const categoryBytes = {};
    (state.items || []).forEach(item => {
      const category = item.category || "other";
      categoryBytes[category] = (categoryBytes[category] || 0) + bytesOf(item);
    });
    const library = bytesOf(state.items || []);
    const history = bytesOf(state.watchLog || []);
    const preferences = bytesOf(state.preferences || {});
    const cache = window.SquashDBCache?.stats ? await window.SquashDBCache.stats() : {};
    const metadata = Number(cache.metadataBytes) || 0;
    const thumbnails = Number(cache.imageBytes) || 0;
    const backups = await backupBytes();
    const total = library + history + preferences + metadata + thumbnails + backups;
    return { categoryBytes, library, history, preferences, metadata, thumbnails, backups, total };
  }

  function render(data) {
    const total = document.getElementById("storage-total");
    const updated = document.getElementById("storage-updated");
    const breakdown = document.getElementById("storage-breakdown");
    const categories = document.getElementById("storage-categories");
    if (total) total.textContent = formatBytes(data.total);
    const warningLimit = Number(state.preferences.storageWarningLimitMb) || 0;
    const warning = document.getElementById("storage-warning");
    if (warning) {
      warning.hidden = !warningLimit || data.total <= warningLimit * 1024 * 1024;
      warning.textContent = `Storage is above your ${warningLimit} MB warning limit.`;
    }
    if (updated) updated.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    if (breakdown) breakdown.innerHTML = [
      row("Library data", data.library, data.total, "primary"),
      row("Watch history", data.history, data.total, "blue"),
      row("Preferences", data.preferences, data.total, "purple"),
      row("Metadata cache", data.metadata, data.total, "orange"),
      row("Thumbnail cache", data.thumbnails, data.total, "green"),
      row("Backups", data.backups, data.total, "red")
    ].join("");
    if (categories) {
      const entries = Object.entries(data.categoryBytes).sort((a, b) => b[1] - a[1]);
      categories.innerHTML = entries.length
        ? entries.map(([category, bytes]) => row(CATEGORIES?.[category]?.label || category, bytes, data.library, "category")).join("")
        : `<p class="storage-empty">No tracked items yet.</p>`;
    }
  }

  async function refresh() {
    try { render(await measure()); }
    catch (error) { console.warn("Could not measure SquashDB storage", error); }
  }

  async function clearCache(type, message) {
    if (!window.SquashDBCache) return;
    if (type === "metadata") await window.SquashDBCache.clearMetadata();
    else if (type === "images") await window.SquashDBCache.clearImages();
    else await window.SquashDBCache.clearTemporary();
    if (typeof showToast === "function") showToast(message, "success");
    refresh();
  }

  function init() {
    if (!document.getElementById("storage-page")) return;
    document.getElementById("storage-clear-metadata")?.addEventListener("click", () => clearCache("metadata", "Metadata cache cleared."));
    document.getElementById("storage-clear-images")?.addEventListener("click", () => clearCache("images", "Thumbnail cache cleared."));
    document.getElementById("storage-clear-temporary")?.addEventListener("click", () => clearCache("temporary", "Temporary caches cleared."));
    document.getElementById("storage-clear-data")?.addEventListener("click", () => window.clearSquashDbData?.());
    document.getElementById("storage-factory-reset")?.addEventListener("click", () => window.clearSquashDbData?.({ factoryReset: true }));
    refresh();
    if (window.lucide) lucide.createIcons();
  }

  window.addEventListener("squashdb-app-ready", init, { once: true });
})();
