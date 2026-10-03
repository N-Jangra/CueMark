// Persistent import queue status screen.
(function () {
  "use strict";

  function queue() { return state.preferences?.metadataQueue || []; }
  function label(value) { return String(value || "").replace(/-/g, " ").replace(/\b\w/g, character => character.toUpperCase()); }

  function render() {
    const list = document.getElementById("import-status-list");
    const summary = document.getElementById("import-status-summary");
    if (!list || !summary) return;
    const entries = queue();
    const counts = {
      total: entries.length,
      synced: entries.filter(entry => entry.state === "synced").length,
      pending: entries.filter(entry => ["pending", "processing"].includes(entry.state)).length,
      failed: entries.filter(entry => entry.state === "failed").length
    };
    summary.textContent = `Imported: ${counts.total} · Synced: ${counts.synced} · Pending: ${counts.pending} · Failed: ${counts.failed}`;
    list.innerHTML = "";
    if (!entries.length) {
      const empty = document.createElement("p"); empty.className = "settings-row-note"; empty.textContent = "No active import records. Completed records may have been cleared."; list.appendChild(empty); return;
    }
    entries.slice().reverse().forEach(entry => {
      const item = state.items.find(value => value.id === entry.itemId);
      const row = document.createElement("div"); row.className = "import-status-row";
      const body = document.createElement("div"); body.className = "import-status-row-body";
      const title = document.createElement("strong"); title.textContent = entry.title;
      const meta = document.createElement("span"); meta.textContent = `${item?.category || entry.category} · ${item?.status || "Saved"}`;
      body.append(title, meta);
      const stateEl = document.createElement("span"); stateEl.className = `import-status-badge import-status-${entry.state}`; stateEl.textContent = label(entry.state);
      row.append(body, stateEl);
      if (entry.lastError) { const error = document.createElement("small"); error.className = "import-status-error"; error.textContent = entry.lastError; row.appendChild(error); }
      list.appendChild(row);
    });
  }

  function saveAndRender() { saveData(); render(); }

  function init() {
    if (!document.getElementById("import-status-list")) return;
    document.getElementById("import-status-pause")?.addEventListener("click", event => {
      state.preferences.metadataQueuePaused = !state.preferences.metadataQueuePaused;
      event.currentTarget.textContent = state.preferences.metadataQueuePaused ? "Resume syncing" : "Pause syncing";
      saveAndRender();
      if (!state.preferences.metadataQueuePaused) window.dispatchEvent(new Event("online"));
    });
    document.getElementById("import-status-retry")?.addEventListener("click", () => {
      queue().filter(entry => entry.state === "failed").forEach(entry => { entry.state = "pending"; entry.attempts = 0; entry.lastError = ""; });
      saveAndRender(); window.dispatchEvent(new Event("online"));
    });
    document.getElementById("import-status-clear")?.addEventListener("click", () => {
      state.preferences.metadataQueue = queue().filter(entry => entry.state !== "synced");
      saveAndRender();
    });
    document.getElementById("import-status-clear-failed")?.addEventListener("click", () => {
      state.preferences.metadataQueue = queue().filter(entry => entry.state !== "failed");
      saveAndRender();
    });
    document.getElementById("import-status-clear-all")?.addEventListener("click", () => {
      state.preferences.metadataQueue = [];
      state.preferences.metadataQueuePaused = false;
      saveAndRender();
    });
    window.addEventListener("metadata-queue-updated", render);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) render(); });
    render();
  }

  window.addEventListener("squashdb-app-ready", init, { once: true });
})();
