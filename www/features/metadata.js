// SquashDB - Online metadata lookup (TVmaze, Wikidata, Open Library)
// Fetches and applies metadata (thumbnails, seasons/episodes, runtime, etc.) for tracked items.
// Depends on globals from app.js: state, CATEGORIES, thumbnailsEnabled(), applySeriesMetadata(),
// renderSeasonEpisodeFields() (season fields are generic form logic, kept in app.js).

let fetchedMetadataDraft = null;
let metadataSourcesFilter = "all";
let metadataSearchState = {
  kind: null,
  items: []
};

const SQUASHDB_METADATA_QUEUE_KEY = "squashdb_metadata_update_queue";

function readMetadataUpdateQueue() {
  try {
    const queue = JSON.parse(localStorage.getItem(SQUASHDB_METADATA_QUEUE_KEY) || "[]");
    return Array.isArray(queue) ? queue : [];
  } catch (err) {
    return [];
  }
}

function queueMetadataUpdate(category, title, itemId = "") {
  if (!category || !title) return;
  const queue = readMetadataUpdateQueue().filter(entry => !(entry.category === category && entry.title.toLowerCase() === title.toLowerCase()));
  queue.push({ category, title, itemId, queuedAt: Date.now() });
  localStorage.setItem(SQUASHDB_METADATA_QUEUE_KEY, JSON.stringify(queue.slice(-25)));
  window.dispatchEvent(new CustomEvent("metadata-queue-updated", { detail: { count: queue.length } }));
}

function removeQueuedMetadataUpdate(category, title, itemId = "") {
  const normalizedTitle = String(title || "").toLowerCase();
  const next = readMetadataUpdateQueue().filter(entry => {
    const sameItem = itemId && entry.itemId && String(entry.itemId) === String(itemId);
    const sameTitle = entry.category === category && String(entry.title || "").toLowerCase() === normalizedTitle;
    return !(sameItem || sameTitle);
  });
  localStorage.setItem(SQUASHDB_METADATA_QUEUE_KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent("metadata-queue-updated", { detail: { count: next.length } }));
}

function metadataQueueCount() {
  return readMetadataUpdateQueue().length;
}

window.addEventListener("online", () => {
  window.dispatchEvent(new CustomEvent("metadata-queue-updated", { detail: { count: metadataQueueCount() } }));
  retryVisibleMetadataUpdate();
});

async function retryVisibleMetadataUpdate() {
  if ((typeof squashDbIsOffline === "function" && squashDbIsOffline()) || typeof fetchAndApplyMetadataFromTitle !== "function") return;
  const category = document.getElementById("entry-category")?.value || state.activeCategoryChip;
  const title = document.getElementById("entry-title")?.value.trim() || "";
  const queued = readMetadataUpdateQueue().find(entry => entry.category === category && String(entry.title).toLowerCase() === title.toLowerCase());
  if (!queued || !title || state.preferences.metadataMode !== "online") return;
  await fetchAndApplyMetadataFromTitle();
}

const BUILTIN_METADATA_SOURCES = {
  tvmaze: { name: "TVmaze", icon: "tv", categories: ["series", "kdrama", "cdrama", "anime"] },
  wikidata: { name: "Wikidata", icon: "globe", categories: ["movie", "game"] },
  openlibrary: { name: "Open Library", icon: "book-open", categories: ["manga", "novel"] },
  rawg: { name: "RAWG", icon: "gamepad-2", categories: ["game"], needsApiKey: true, apiKeyUrl: "https://rawg.io/apidocs" },
  freetogame: { name: "FreeToGame", icon: "swords", categories: ["game"] },
  anilist: { name: "AniList", icon: "clapperboard", categories: ["anime", "manga", "series", "kdrama", "cdrama"] },
  jikan: { name: "MyAnimeList (Jikan)", icon: "list-video", categories: ["anime", "manga"] },
  kitsu: { name: "Kitsu", icon: "cat", categories: ["anime", "manga"] },
  mangadex: { name: "MangaDex", icon: "book-open-check", categories: ["manga"] },
  shikimori: { name: "Shikimori", icon: "sparkles", categories: ["anime", "manga"] },
  googlebooks: { name: "Google Books", icon: "book", categories: ["novel", "manga"] },
  omdb: { name: "OMDb", icon: "film", categories: ["movie", "series", "kdrama", "cdrama", "anime"], needsApiKey: true, apiKeyUrl: "https://www.omdbapi.com/apikey.aspx" },
  tmdb: { name: "TMDB", icon: "video", categories: ["movie", "series", "kdrama", "cdrama", "anime"], needsApiKey: true, apiKeyUrl: "https://www.themoviedb.org/settings/api" }
  ,steamdb: { name: "Steam + SteamDB", icon: "gamepad-2", categories: ["game"] }
};

// Ensures state.preferences.metadataSources has the expected shape, filling in
// defaults for fields missing from an older saved prefs blob.
function metadataSourcesWithKeyProvidersLast(order) {
  const validOrder = order.filter(key => BUILTIN_METADATA_SOURCES[key]);
  return [
    ...validOrder.filter(key => !BUILTIN_METADATA_SOURCES[key].needsApiKey),
    ...validOrder.filter(key => BUILTIN_METADATA_SOURCES[key].needsApiKey)
  ];
}

function normalizeMetadataSources() {
  const defaults = {
    builtinOrder: ["tvmaze", "wikidata", "openlibrary", "freetogame", "steamdb", "anilist", "jikan", "kitsu", "mangadex", "shikimori", "googlebooks", "rawg", "omdb", "tmdb"],
    builtinEnabled: {
      tvmaze: true, wikidata: true, openlibrary: true, rawg: false,
      freetogame: true, steamdb: true, anilist: true, jikan: true, kitsu: true, mangadex: true, shikimori: true, googlebooks: true, omdb: false, tmdb: false
    },
    builtinApiKeys: {},
    custom: [],
    discoverSourceFilter: {}
  };

  const current = state.preferences.metadataSources;
  if (!current || typeof current !== "object") {
    state.preferences.metadataSources = defaults;
    return;
  }

  if (!Array.isArray(current.builtinOrder) || current.builtinOrder.length === 0) {
    current.builtinOrder = defaults.builtinOrder;
  }
  current.builtinOrder = current.builtinOrder.filter(key => BUILTIN_METADATA_SOURCES[key]);
  Object.keys(BUILTIN_METADATA_SOURCES).forEach(key => {
    if (!current.builtinOrder.includes(key)) current.builtinOrder.push(key);
  });
  current.builtinOrder = metadataSourcesWithKeyProvidersLast(current.builtinOrder);

  if (!current.builtinEnabled || typeof current.builtinEnabled !== "object") {
    current.builtinEnabled = { ...defaults.builtinEnabled };
  }
  Object.keys(BUILTIN_METADATA_SOURCES).forEach(key => {
    if (typeof current.builtinEnabled[key] !== "boolean") {
      current.builtinEnabled[key] = !BUILTIN_METADATA_SOURCES[key].needsApiKey;
    }
  });

  if (!current.builtinApiKeys || typeof current.builtinApiKeys !== "object") {
    current.builtinApiKeys = {};
  }
  Object.keys(BUILTIN_METADATA_SOURCES).forEach(key => {
    if (typeof current.builtinApiKeys[key] !== "string") current.builtinApiKeys[key] = "";
  });

  if (!current.discoverSourceFilter || typeof current.discoverSourceFilter !== "object") {
    current.discoverSourceFilter = {};
  }

  if (!Array.isArray(current.custom)) current.custom = [];
  current.custom = current.custom.filter(src => src && typeof src === "object" && src.id);
  current.custom.forEach(src => {
    if (typeof src.enabled !== "boolean") src.enabled = true;
    if (!Array.isArray(src.categories)) src.categories = [];
    if (typeof src.name !== "string") src.name = "Untitled Source";
    if (typeof src.searchUrlTemplate !== "string") src.searchUrlTemplate = "";
    if (typeof src.apiKey !== "string") src.apiKey = "";
    if (typeof src.resultsPath !== "string") src.resultsPath = "";
    if (typeof src.titlePath !== "string") src.titlePath = "";
    if (typeof src.thumbnailPath !== "string") src.thumbnailPath = "";
    if (typeof src.subtitlePath !== "string") src.subtitlePath = "";
  });

  state.preferences.metadataSources = current;
}

function createCustomMetadataSource({ name, categories }) {
  normalizeMetadataSources();
  const source = {
    id: crypto.randomUUID(),
    name: (name || "Untitled Source").trim() || "Untitled Source",
    categories: Array.isArray(categories) ? categories : [],
    enabled: true,
    searchUrlTemplate: "",
    apiKey: "",
    resultsPath: "",
    titlePath: "",
    thumbnailPath: "",
    subtitlePath: ""
  };
  state.preferences.metadataSources.custom.push(source);
  saveData();
  return source;
}

function updateCustomMetadataSource(id, patch) {
  normalizeMetadataSources();
  const source = state.preferences.metadataSources.custom.find(src => src.id === id);
  if (!source) return null;
  Object.assign(source, patch);
  saveData();
  return source;
}

function deleteCustomMetadataSource(id) {
  normalizeMetadataSources();
  state.preferences.metadataSources.custom = state.preferences.metadataSources.custom.filter(src => src.id !== id);
  saveData();
}

function renderMetadataSourcesSettings() {
  renderBuiltinMetadataSourcesList();
  renderCustomMetadataSourcesList();

  document.querySelectorAll("[data-source-filter]").forEach(button => {
    if (button.dataset.bound) return;
    button.dataset.bound = "true";
    button.addEventListener("click", () => {
      metadataSourcesFilter = button.dataset.sourceFilter;
      document.querySelectorAll("[data-source-filter]").forEach(filterButton => {
        const active = filterButton === button;
        filterButton.classList.toggle("active", active);
        filterButton.setAttribute("aria-pressed", String(active));
      });
      applyBuiltinMetadataSourceFilter();
    });
  });

  const createBtn = document.getElementById("create-metadata-source-btn");
  if (createBtn && !createBtn.dataset.bound) {
    createBtn.dataset.bound = "true";
    createBtn.addEventListener("click", openCreateMetadataSourceModal);
  }
}

// HTML5 drag events are not consistently emitted by Android WebView. Keep
// those events for desktop browsers, but also support pointer dragging from
// the grip handle so source ordering works with touch and mouse input.
function bindMetadataSourceSorting(list, getKey, onSave) {
  const items = () => Array.from(list.querySelectorAll(".sortable-item"));
  let dragged = null;
  let pointerId = null;
  let captureTarget = null;
  let moved = false;

  const saveOrder = () => onSave(metadataSourcesWithKeyProvidersLast(items().map(item => getKey(item))));
  const isKeyProvider = item => item?.dataset.requiresApiKey === "true";
  const finishPointerDrag = event => {
    if (!dragged || (event?.pointerId !== undefined && event.pointerId !== pointerId)) return;
    const finishedItem = dragged;
    finishedItem.classList.remove("dragging");
    if (moved) saveOrder();
    if (pointerId !== null && captureTarget?.hasPointerCapture?.(pointerId)) {
      captureTarget.releasePointerCapture(pointerId);
    }
    dragged = null;
    pointerId = null;
    captureTarget = null;
    moved = false;
  };
  if (list._metadataPointerFinish) {
    document.removeEventListener("pointerup", list._metadataPointerFinish, true);
    document.removeEventListener("pointercancel", list._metadataPointerFinish, true);
  }
  list._metadataPointerFinish = finishPointerDrag;
  document.addEventListener("pointerup", finishPointerDrag, true);
  document.addEventListener("pointercancel", finishPointerDrag, true);

  items().forEach(item => {
    item.draggable = !window.matchMedia("(pointer: coarse)").matches;

    // Desktop HTML5 dragging.
    item.addEventListener("dragstart", () => {
      dragged = item;
      item.classList.add("dragging");
    });
    item.addEventListener("dragend", () => {
      item.classList.remove("dragging");
      dragged = null;
      saveOrder();
    });
    item.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (!dragged || dragged === item || isKeyProvider(dragged) !== isKeyProvider(item)) return;
      const rect = item.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      list.insertBefore(dragged, after ? item.nextSibling : item);
    });

    // Touch/pointer dragging from the grip avoids stealing taps from toggles.
    const handle = item.querySelector(".drag-handle");
    if (!handle) return;
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      dragged = item;
      pointerId = event.pointerId;
      captureTarget = handle;
      moved = false;
      item.classList.add("dragging");
      handle.setPointerCapture?.(pointerId);
      event.preventDefault();
    });
    handle.addEventListener("pointermove", (event) => {
      if (!dragged || event.pointerId !== pointerId) return;
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".sortable-item");
      if (!target || target.parentElement !== list || target === dragged || isKeyProvider(target) !== isKeyProvider(dragged)) return;
      moved = true;
      const rect = target.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      list.insertBefore(dragged, after ? target.nextSibling : target);
      event.preventDefault();
    });
    handle.addEventListener("pointerup", finishPointerDrag);
    handle.addEventListener("pointercancel", finishPointerDrag);
  });
}

function applyBuiltinMetadataSourceFilter() {
  const list = document.getElementById("builtin-metadata-sources-list");
  if (!list) return;
  let visibleCount = 0;
  list.querySelectorAll(".metadata-source-row[data-source]").forEach(item => {
    const enabled = state.preferences.metadataSources.builtinEnabled[item.dataset.source];
    const visible = metadataSourcesFilter === "all" || (metadataSourcesFilter === "enabled" ? enabled : !enabled);
    item.hidden = !visible;
    if (visible) visibleCount++;
  });
  let empty = list.querySelector(".metadata-source-filter-empty");
  if (visibleCount === 0) {
    if (!empty) {
      empty = document.createElement("p");
      empty.className = "metadata-source-filter-empty";
      list.appendChild(empty);
    }
    empty.textContent = metadataSourcesFilter === "enabled" ? "No enabled sources." : "No disabled sources.";
  } else if (empty) {
    empty.remove();
  }
}

function renderBuiltinMetadataSourcesList() {
  const list = document.getElementById("builtin-metadata-sources-list");
  if (!list) return;
  normalizeMetadataSources();

  list.innerHTML = "";
  state.preferences.metadataSources.builtinOrder.forEach(key => {
    const info = BUILTIN_METADATA_SOURCES[key];
    if (!info) return;
    const item = document.createElement("div");
    item.className = "sortable-item metadata-source-row";
    item.dataset.source = key;
    item.dataset.requiresApiKey = String(Boolean(info.needsApiKey));
    const apiKeyRowHTML = info.needsApiKey ? `
      <div class="form-group metadata-source-apikey-row">
        <label for="builtin-apikey-${key}">${info.name} API Key</label>
        <input type="text" id="builtin-apikey-${key}" class="form-control" placeholder="Paste your API key" value="${state.preferences.metadataSources.builtinApiKeys[key] || ""}">
        <span class="setting-desc">Get a free key at <a href="${info.apiKeyUrl}" target="_blank" rel="noopener">${info.apiKeyUrl}</a></span>
      </div>
    ` : "";
    item.innerHTML = `
      <span class="drag-handle" aria-hidden="true">⋮⋮</span>
      <span class="sortable-label">
        ${info.name}
        <span class="setting-desc">${info.categories.map(c => CATEGORIES[c]?.label || c).join(", ")}</span>
      </span>
      <label class="switch">
        <input type="checkbox" data-builtin-source="${key}" ${state.preferences.metadataSources.builtinEnabled[key] ? "checked" : ""}>
        <span class="slider"></span>
      </label>
      ${apiKeyRowHTML}
    `;
    const apiKeyRow = item.querySelector(".metadata-source-apikey-row");
    if (apiKeyRow && !state.preferences.metadataSources.builtinEnabled[key]) apiKeyRow.hidden = true;
    list.appendChild(item);
  });

  bindMetadataSourceSorting(
    list,
    item => item.dataset.source,
    newOrder => {
      state.preferences.metadataSources.builtinOrder = metadataSourcesWithKeyProvidersLast(newOrder);
      saveData();
    }
  );
  applyBuiltinMetadataSourceFilter();

  list.querySelectorAll("input[data-builtin-source]").forEach(checkbox => {
    checkbox.addEventListener("change", (e) => {
      const key = e.target.dataset.builtinSource;
      state.preferences.metadataSources.builtinEnabled[key] = e.target.checked;
      const apiKeyRow = e.target.closest(".metadata-source-row")?.querySelector(".metadata-source-apikey-row");
      if (apiKeyRow) apiKeyRow.hidden = !e.target.checked;
      applyBuiltinMetadataSourceFilter();
      saveData();
    });
  });

  Object.keys(BUILTIN_METADATA_SOURCES).forEach(key => {
    const input = document.getElementById(`builtin-apikey-${key}`);
    if (!input) return;
    input.addEventListener("change", () => {
      state.preferences.metadataSources.builtinApiKeys[key] = input.value.trim();
      saveData();
    });
  });

  if (window.lucide) lucide.createIcons();
}

function renderCustomMetadataSourcesList() {
  const list = document.getElementById("custom-metadata-sources-list");
  if (!list) return;
  normalizeMetadataSources();

  list.innerHTML = "";
  const customSources = state.preferences.metadataSources.custom;

  if (customSources.length === 0) {
    const empty = document.createElement("p");
    empty.className = "setting-desc";
    empty.textContent = "No custom sources yet. Add one to look up metadata from another API.";
    list.appendChild(empty);
  }

  customSources.forEach(source => {
    const row = document.createElement("div");
    row.className = "setting-row metadata-source-row";
    row.innerHTML = `
      <div class="setting-info">
        <span class="setting-label">${source.name}</span>
        <span class="setting-desc">${source.categories.map(c => CATEGORIES[c]?.label || c).join(", ") || "No categories selected"}</span>
      </div>
      <button type="button" class="note-action-btn edit-source-btn" data-id="${source.id}" title="Edit source"><i data-lucide="pencil"></i></button>
      <button type="button" class="note-action-btn delete-source-btn" data-id="${source.id}" title="Delete source"><i data-lucide="trash-2"></i></button>
      <label class="switch">
        <input type="checkbox" data-custom-source="${source.id}" ${source.enabled ? "checked" : ""}>
        <span class="slider"></span>
      </label>
    `;
    list.appendChild(row);
  });

  list.querySelectorAll("input[data-custom-source]").forEach(checkbox => {
    checkbox.addEventListener("change", (e) => {
      updateCustomMetadataSource(e.target.dataset.customSource, { enabled: e.target.checked });
    });
  });

  list.querySelectorAll(".delete-source-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const source = customSources.find(src => src.id === btn.dataset.id);
      if (!source) return;
      if (!confirm(`Delete the "${source.name}" metadata source? This cannot be undone.`)) return;
      deleteCustomMetadataSource(btn.dataset.id);
      renderCustomMetadataSourcesList();
    });
  });

  list.querySelectorAll(".edit-source-btn").forEach(btn => {
    btn.addEventListener("click", () => openEditMetadataSourceModal(btn.dataset.id));
  });

  if (window.lucide) lucide.createIcons();
}

// Basic add/edit modal for stage 1: name + which categories it applies to.
// URL template, API key, and JSON-path field mapping are wired in a later stage.
function openCreateMetadataSourceModal() {
  openMetadataSourceModal(null);
}

function openEditMetadataSourceModal(id) {
  openMetadataSourceModal(id);
}

function openMetadataSourceModal(editId) {
  const existing = editId
    ? state.preferences.metadataSources.custom.find(src => src.id === editId)
    : null;

  let modal = document.getElementById("metadata-source-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "metadata-source-modal";
    modal.className = "modal-overlay";
    document.body.appendChild(modal);
  }

  const categoryCheckboxes = Object.keys(CATEGORIES).map(key => `
    <label class="checkbox-row">
      <input type="checkbox" value="${key}" ${existing?.categories?.includes(key) ? "checked" : ""}>
      ${CATEGORIES[key].label}
    </label>
  `).join("");

  // Working copy of path mappings, edited via the JSON tree picker before Save persists them.
  const draftPaths = {
    resultsPath: existing?.resultsPath || "",
    titlePath: existing?.titlePath || "",
    thumbnailPath: existing?.thumbnailPath || "",
    subtitlePath: existing?.subtitlePath || ""
  };

  modal.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h3>${existing ? "Edit" : "Add"} Metadata Source</h3>
        <button type="button" class="modal-close-btn" id="metadata-source-close"><i data-lucide="x"></i></button>
      </div>
      <div class="form-group">
        <label for="metadata-source-name">Source Name</label>
        <input type="text" id="metadata-source-name" class="form-control" placeholder="e.g. My API" value="${existing ? existing.name : ""}" maxlength="40">
      </div>
      <div class="form-group">
        <label>Applies to</label>
        <div id="metadata-source-categories" class="checkbox-grid">${categoryCheckboxes}</div>
      </div>
      <div class="form-group">
        <label for="metadata-source-url">Search URL Template</label>
        <input type="text" id="metadata-source-url" class="form-control" placeholder="https://api.example.com/search?q={query}&api_key={apiKey}" value="${existing ? existing.searchUrlTemplate : ""}">
        <span class="setting-desc">Use {query} for the search title and {apiKey} for the API key below.</span>
      </div>
      <div class="form-group">
        <label for="metadata-source-apikey">API Key (optional)</label>
        <input type="text" id="metadata-source-apikey" class="form-control" placeholder="Leave blank if not needed" value="${existing ? existing.apiKey : ""}">
      </div>
      <div class="form-group">
        <label>Field Mapping</label>
        <div class="metadata-path-summary" id="metadata-path-summary"></div>
        <button type="button" class="btn btn-secondary" id="metadata-source-map-fields" style="width:100%;">
          <i data-lucide="git-branch"></i> Fetch Sample &amp; Map Fields
        </button>
      </div>
      <button type="button" class="btn btn-primary" id="metadata-source-save" style="width:100%;">Save</button>
    </div>
  `;

  modal.classList.add("active");
  if (window.lucide) lucide.createIcons();
  renderMetadataPathSummary(draftPaths);

  document.getElementById("metadata-source-close").addEventListener("click", () => {
    modal.classList.remove("active");
  });

  document.getElementById("metadata-source-map-fields").addEventListener("click", () => {
    const urlTemplate = document.getElementById("metadata-source-url").value.trim();
    const apiKey = document.getElementById("metadata-source-apikey").value.trim();
    if (!urlTemplate) {
      alert("Please enter a search URL template first.");
      return;
    }
    openJsonFieldMapperModal(urlTemplate, apiKey, draftPaths, () => renderMetadataPathSummary(draftPaths));
  });

  document.getElementById("metadata-source-save").addEventListener("click", () => {
    const name = document.getElementById("metadata-source-name").value.trim();
    if (!name) {
      alert("Please enter a source name.");
      return;
    }
    const categories = Array.from(document.querySelectorAll("#metadata-source-categories input:checked")).map(el => el.value);
    const searchUrlTemplate = document.getElementById("metadata-source-url").value.trim();
    const apiKey = document.getElementById("metadata-source-apikey").value.trim();

    const patch = { name, categories, searchUrlTemplate, apiKey, ...draftPaths };

    if (existing) {
      updateCustomMetadataSource(existing.id, patch);
    } else {
      createCustomMetadataSource(patch);
    }

    modal.classList.remove("active");
    renderCustomMetadataSourcesList();
  });
}

// Renders a fetched JSON sample as a clickable tree so the user can pick which
// node is the results array and which sub-fields map to title/thumbnail/subtitle,
// without needing to type dot/bracket path syntax by hand.
async function openJsonFieldMapperModal(urlTemplate, apiKey, draftPaths, onSaved) {
  let modal = document.getElementById("json-field-mapper-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "json-field-mapper-modal";
    modal.className = "modal-overlay";
    document.body.appendChild(modal);
  }

  modal.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h3>Map Fields</h3>
        <button type="button" class="modal-close-btn" id="json-mapper-close"><i data-lucide="x"></i></button>
      </div>
      <p class="setting-desc" id="json-mapper-status">Fetching a sample response using "squash" as the test query...</p>
      <div id="json-mapper-tree" class="json-mapper-tree"></div>
    </div>
  `;
  modal.classList.add("active");
  if (window.lucide) lucide.createIcons();
  document.getElementById("json-mapper-close").addEventListener("click", () => modal.classList.remove("active"));

  const status = document.getElementById("json-mapper-status");
  const treeEl = document.getElementById("json-mapper-tree");

  let sample;
  try {
    const url = urlTemplate.replace("{query}", encodeURIComponent("squash")).replace("{apiKey}", encodeURIComponent(apiKey));
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    sample = await res.json();
  } catch (err) {
    status.textContent = `Could not fetch a sample: ${err.message}. Check the URL template and try again.`;
    return;
  }

  let pickMode = "results"; // results -> title -> thumbnail -> subtitle -> done
  const pickLabels = { results: "Click the array that holds each search result", title: "Now click the title field inside one result", thumbnail: "Now click the thumbnail/image field (optional — close to skip)", subtitle: "Now click a subtitle/description field (optional — close to skip)" };
  status.textContent = pickLabels.results;

  let resultsArrayPath = null;

  function advance(pathAfterResults, isArrayClick) {
    if (pickMode === "results") {
      if (!isArrayClick) return;
      resultsArrayPath = pathAfterResults;
      draftPaths.resultsPath = pathAfterResults.join(".");
      pickMode = "title";
      status.textContent = pickLabels.title;
      return;
    }

    if (!resultsArrayPath) return;
    // pathAfterResults includes the sample item's "0" index right after the array
    // path (e.g. resultsPath=["data","results"], leaf path=["data","results","0","name"]),
    // so the relative field path strips both.
    const relativePath = pathAfterResults.slice(resultsArrayPath.length + 1).join(".");
    if (!relativePath) return;

    if (pickMode === "title") {
      draftPaths.titlePath = relativePath;
      pickMode = "thumbnail";
      status.textContent = pickLabels.thumbnail;
    } else if (pickMode === "thumbnail") {
      draftPaths.thumbnailPath = relativePath;
      pickMode = "subtitle";
      status.textContent = pickLabels.subtitle;
    } else if (pickMode === "subtitle") {
      draftPaths.subtitlePath = relativePath;
      status.textContent = "Field mapping complete. Close this window to continue.";
      onSaved();
    }
  }

  treeEl.innerHTML = "";
  treeEl.appendChild(renderJsonNode(sample, [], advance));
}

// Recursively builds clickable DOM nodes for a JSON value. Each key/array node
// is a <span> that calls onPick(fullPathArray, isArray) when clicked.
function renderJsonNode(value, path, onPick) {
  const wrapper = document.createElement("div");
  wrapper.className = "json-node";

  if (Array.isArray(value)) {
    const label = document.createElement("span");
    label.className = "json-key json-array-key";
    label.textContent = `${path[path.length - 1] ?? "root"} [array]`;
    label.addEventListener("click", (e) => {
      e.stopPropagation();
      onPick(path, true);
    });
    wrapper.appendChild(label);

    const sampleItem = value[0];
    if (sampleItem !== undefined) {
      const child = document.createElement("div");
      child.className = "json-indent";
      child.appendChild(renderJsonNode(sampleItem, [...path, "0"], onPick));
      wrapper.appendChild(child);
    }
    return wrapper;
  }

  if (value && typeof value === "object") {
    Object.keys(value).forEach(key => {
      const child = document.createElement("div");
      child.className = "json-indent";
      child.appendChild(renderJsonNode(value[key], [...path, key], onPick));
      wrapper.appendChild(child);
    });
    return wrapper;
  }

  const leaf = document.createElement("span");
  leaf.className = "json-key json-leaf-key";
  leaf.textContent = `${path[path.length - 1]}: ${JSON.stringify(value)}`;
  leaf.addEventListener("click", (e) => {
    e.stopPropagation();
    onPick(path, false);
  });
  wrapper.appendChild(leaf);
  return wrapper;
}

// Walks a dot-path like "data.results" or "image.medium" against a live object.
function resolveJsonPath(obj, path) {
  if (!path) return undefined;
  return path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

// Runs a single custom source's search request and normalizes results into
// the same {id, title, subtitle, thumbnail, kind} shape the built-in sources use.
async function fetchCustomMetadataSource(source, query, category) {
  if (!source.searchUrlTemplate || !source.resultsPath || !source.titlePath) return [];

  const url = source.searchUrlTemplate
    .replace("{query}", encodeURIComponent(query))
    .replace("{apiKey}", encodeURIComponent(source.apiKey || ""));

  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    const results = resolveJsonPath(data, source.resultsPath);
    if (!Array.isArray(results)) return [];

    return results.map((entry, index) => ({
      id: `${source.id}:${index}`,
      title: resolveJsonPath(entry, source.titlePath) || query,
      subtitle: source.subtitlePath ? (resolveJsonPath(entry, source.subtitlePath) || "") : "",
      thumbnail: source.thumbnailPath ? (resolveJsonPath(entry, source.thumbnailPath) || "") : "",
      kind: category,
      customSourceId: source.id
    })).slice(0, 8);
  } catch (err) {
    console.warn(`Custom metadata source "${source.name}" failed`, err);
    return [];
  }
}

// Runs every enabled custom source configured for this category and returns
// their combined, normalized results.
async function fetchAllCustomMetadataSources(category, query) {
  normalizeMetadataSources();
  const sources = state.preferences.metadataSources.custom.filter(
    src => src.enabled && src.categories.includes(category)
  );
  const resultsPerSource = await Promise.all(sources.map(src => fetchCustomMetadataSource(src, query, category)));
  return resultsPerSource.flat();
}

function builtinSourceEnabled(key) {
  normalizeMetadataSources();
  return Boolean(state.preferences.metadataSources.builtinEnabled[key]);
}

function renderMetadataPathSummary(draftPaths) {
  const el = document.getElementById("metadata-path-summary");
  if (!el) return;
  const hasMapping = draftPaths.resultsPath && draftPaths.titlePath;
  el.textContent = hasMapping
    ? `Results: ${draftPaths.resultsPath} · Title: ${draftPaths.titlePath}${draftPaths.thumbnailPath ? ` · Thumbnail: ${draftPaths.thumbnailPath}` : ""}${draftPaths.subtitlePath ? ` · Subtitle: ${draftPaths.subtitlePath}` : ""}`
    : "No field mapping yet.";
}

async function fetchAndApplyMetadataFromTitle() {
  const category = document.getElementById("entry-category")?.value;
  const title = document.getElementById("entry-title")?.value.trim();
  if (!title || !category || state.preferences.metadataMode !== "online") return;
  if (!["series", "kdrama", "cdrama", "anime", "movie", "game", "manga", "novel"].includes(category)) return;
  if (typeof squashDbIsOffline === "function" ? squashDbIsOffline() : navigator.onLine === false) {
    queueMetadataUpdate(category, title);
    return;
  }

  const normalized = encodeURIComponent(title);

  try {
    if (category === "series" || category === "kdrama" || category === "cdrama" || category === "anime") {
      let items = [];
      if (builtinSourceEnabled("tvmaze")) {
        const searchRes = await fetch(`https://api.tvmaze.com/search/shows?q=${normalized}`);
        if (searchRes.ok) {
          const searchJson = await searchRes.json();
          items = Array.isArray(searchJson) ? searchJson.slice(0, 8).map(entry => ({
            id: entry.show?.id,
            title: entry.show?.name || title,
            subtitle: [entry.show?.premiered || "", entry.show?.language || ""].filter(Boolean).join(" · "),
            thumbnail: entry.show?.image?.medium || entry.show?.image?.original || "",
            kind: category
          })).filter(item => item.id) : [];
        }
      }
      items = items.concat(await fetchAllCustomMetadataSources(category, title));
      if (items.length > 1) {
        showMetadataResults(category, items, title);
        return;
      }
      if (!items[0]) return;
      if (items[0].customSourceId) {
        applyCustomMetadataResult(items[0]);
      } else {
        await applySelectedSeriesMetadata(items[0].id, items[0].title);
      }
      return;
    }

    if (category === "movie") {
      let items = [];
      if (builtinSourceEnabled("wikidata")) {
        const searchRes = await fetch(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${normalized}&language=en&type=item&limit=8&format=json&origin=*`);
        if (searchRes.ok) {
          const data = await searchRes.json();
          items = Array.isArray(data.search) ? data.search.map(entry => ({
            id: entry.id,
            title: entry.label || title,
            subtitle: entry.description || "Movie",
            thumbnail: "",
            kind: "movie"
          })) : [];
        }
      }
      items = items.concat(await fetchAllCustomMetadataSources("movie", title));
      if (items.length > 1) {
        showMetadataResults("movie", items, title);
        return;
      }
      if (!items[0]) return;
      if (items[0].customSourceId) {
        applyCustomMetadataResult(items[0]);
      } else {
        await applySelectedMovieMetadata(items[0].id, items[0].title);
      }
      return;
    }

    if (category === "game") {
      let items = [];
      const rawgKey = state.preferences.metadataSources.builtinApiKeys?.rawg;
      if (builtinSourceEnabled("rawg") && rawgKey) {
        try {
          const searchRes = await fetch(`https://api.rawg.io/api/games?key=${encodeURIComponent(rawgKey)}&search=${normalized}&page_size=8`);
          if (searchRes.ok) {
            const data = await searchRes.json();
            items = (Array.isArray(data.results) ? data.results : []).map(entry => ({
              id: entry.id,
              title: entry.name || title,
              subtitle: [entry.released ? entry.released.slice(0, 4) : "", entry.rating ? `★ ${entry.rating}` : ""].filter(Boolean).join(" · "),
              thumbnail: entry.background_image || "",
              kind: "game",
              rawg: true
            }));
          }
        } catch (err) {
          console.warn("RAWG search failed", err);
        }
      }
      if (items.length === 0 && builtinSourceEnabled("wikidata")) {
        const searchRes = await fetch(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${normalized}&language=en&type=item&limit=8&format=json&origin=*`);
        if (searchRes.ok) {
          const data = await searchRes.json();
          items = Array.isArray(data.search) ? data.search.map(entry => ({
            id: entry.id,
            title: entry.label || title,
            subtitle: entry.description || "Game",
            thumbnail: "",
            kind: "game"
          })) : [];
        }
      }
      items = items.concat(await fetchAllCustomMetadataSources("game", title));
      if (items.length > 1) {
        showMetadataResults("game", items, title);
        return;
      }
      if (!items[0]) return;
      if (items[0].customSourceId) {
        applyCustomMetadataResult(items[0]);
      } else if (items[0].rawg) {
        applyMetadataPreview({
          title: items[0].title,
          meta: items[0].subtitle,
          image: thumbnailsEnabled() ? items[0].thumbnail : ""
        });
        fetchedMetadataDraft = { thumbnail: thumbnailsEnabled() ? items[0].thumbnail : "" };
      } else {
        await applySelectedGameMetadata(items[0].id, items[0].title);
      }
      return;
    }

    if (category === "manga" || category === "novel") {
      let items = [];
      if (builtinSourceEnabled("openlibrary")) {
        const searchRes = await fetch(`https://openlibrary.org/search.json?title=${normalized}`);
        if (searchRes.ok) {
          const data = await searchRes.json();
          items = Array.isArray(data.docs) ? data.docs.slice(0, 8).map(doc => ({
            key: doc.key,
            title: doc.title || title,
            subtitle: [doc.author_name?.[0], doc.first_publish_year ? `First published ${doc.first_publish_year}` : "", doc.edition_count ? `${doc.edition_count} volumes` : ""].filter(Boolean).join(" · "),
            thumbnail: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : "",
            editionCount: doc.edition_count || 0,
            kind: category
          })).filter(item => item.key) : [];
        }
      }
      items = items.concat(await fetchAllCustomMetadataSources(category, title));
      if (items.length > 1) {
        showMetadataResults(category, items, title);
        return;
      }
      if (!items[0]) return;
      if (items[0].customSourceId) {
        applyCustomMetadataResult(items[0]);
        return;
      }
      applyMetadataPreview({
        title: items[0].title,
        meta: items[0].subtitle,
        image: thumbnailsEnabled() ? items[0].thumbnail : ""
      });
      fetchedMetadataDraft = {
        thumbnail: thumbnailsEnabled() ? items[0].thumbnail : ""
      };
      const totalVolumesInput = document.getElementById("field-total-volumes");
      if (totalVolumesInput && !totalVolumesInput.value && items[0].editionCount) {
        totalVolumesInput.value = items[0].editionCount;
      }
      return;
    }
    removeQueuedMetadataUpdate(category, title);
  } catch (err) {
    console.warn("Metadata lookup failed", err);
    queueMetadataUpdate(category, title);
  }
}

function applyMetadataPreview({ title, meta, image }) {
  const preview = document.getElementById("metadata-preview");
  const thumb = document.getElementById("metadata-preview-thumb");
  const titleEl = document.getElementById("metadata-preview-title");
  const metaEl = document.getElementById("metadata-preview-meta");
  if (!preview || !thumb || !titleEl || !metaEl) return;

  titleEl.textContent = title || "";
  metaEl.textContent = meta || "";

  if (image && thumbnailsEnabled()) {
    thumb.src = image;
    thumb.alt = title || "Metadata thumbnail";
    thumb.style.display = "block";
  } else {
    thumb.removeAttribute("src");
    thumb.alt = "";
    thumb.style.display = "none";
  }

  preview.style.display = "flex";
}

function showMetadataResults(kind, items, queryTitle) {
  metadataSearchState = { kind, items };
  const box = document.getElementById("metadata-results");
  const list = document.getElementById("metadata-results-list");
  const preview = document.getElementById("metadata-preview");
  const titleEl = document.getElementById("metadata-preview-title");
  const metaEl = document.getElementById("metadata-preview-meta");
  const thumb = document.getElementById("metadata-preview-thumb");
  if (!box || !list) return;

  if (preview) preview.style.display = "none";
  if (titleEl) titleEl.textContent = queryTitle || "";
  if (metaEl) {
    const label = kind === "series" ? "TV Series" : kind === "kdrama" ? "K-Drama" : kind === "cdrama" ? "C-Drama" : kind === "movie" ? "Movie" : kind === "game" ? "Game" : kind === "anime" ? "Anime" : kind === "manga" ? "Manga" : kind === "novel" ? "Novel" : "Metadata";
    metaEl.textContent = items.length ? `${items.length} ${label} matches found` : "";
  }
  if (thumb) {
    thumb.removeAttribute("src");
    thumb.style.display = "none";
  }

  list.innerHTML = "";
  items.forEach((item, index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "metadata-result-item";
    btn.dataset.metadataIndex = String(index);
    btn.innerHTML = `
      ${item.thumbnail ? `<img src="${item.thumbnail}" alt="" class="metadata-result-thumb">` : `<span class="metadata-result-thumb metadata-result-thumb-placeholder"></span>`}
      <span class="metadata-result-copy">
        <span class="metadata-result-title">${item.title}</span>
        <span class="metadata-result-subtitle">${item.subtitle || ""}</span>
      </span>
    `;
    list.appendChild(btn);
  });

  box.style.display = "block";
}

function hideMetadataResults() {
  const box = document.getElementById("metadata-results");
  const list = document.getElementById("metadata-results-list");
  if (box) box.style.display = "none";
  if (list) list.innerHTML = "";
  metadataSearchState = { kind: null, items: [] };
}

async function selectMetadataResult(index) {
  const kind = metadataSearchState.kind;
  const result = metadataSearchState.items[index];
  if (!result) return;
  const selectedThumbnail = result.thumbnail || "";
  hideMetadataResults();
  const category = document.getElementById("entry-category")?.value;
  const titleInput = document.getElementById("entry-title");
  if (titleInput && result.title) {
    titleInput.value = result.title;
  }
  if (result.customSourceId) {
    applyCustomMetadataResult(result);
  } else if (kind === "movie") {
    await applySelectedMovieMetadata(result.id, result.title, selectedThumbnail);
  } else if (kind === "series" || kind === "kdrama" || kind === "cdrama") {
    await applySelectedSeriesMetadata(result.id, result.title, selectedThumbnail);
  } else if (kind === "anime") {
    await applySelectedAnimeMetadata(result, selectedThumbnail);
  } else if (kind === "game" && result.rawg) {
    applyMetadataPreview({
      title: result.title,
      meta: result.subtitle || "",
      image: thumbnailsEnabled() ? selectedThumbnail : ""
    });
    fetchedMetadataDraft = { thumbnail: thumbnailsEnabled() ? selectedThumbnail : "" };
  } else if (kind === "game") {
    await applySelectedGameMetadata(result.id, result.title);
  } else if (category === "manga" || category === "novel") {
    applyMetadataPreview({ title: result.title, meta: result.subtitle || "", image: thumbnailsEnabled() ? selectedThumbnail : "" });
    fetchedMetadataDraft = { thumbnail: thumbnailsEnabled() ? selectedThumbnail : "" };
    const totalVolumesInput = document.getElementById("field-total-volumes");
    if (totalVolumesInput && !totalVolumesInput.value && result.editionCount) {
      totalVolumesInput.value = result.editionCount;
    }
  }
}

async function applySelectedAnimeMetadata(result, fallbackThumbnail = "") {
  if (!result) return;

  if (result.source === "tvmaze") {
    await applySelectedSeriesMetadata(result.id, result.title, fallbackThumbnail);
    return;
  }

  if (result.source === "anilist") {
    const query = `query($id:Int){Media(id:$id,type:ANIME){title{romaji english} coverImage{large medium} episodes duration startDate{year}}}`;
    const data = await anilistQuery(query, { id: result.id });
    const media = data?.data?.Media;
    if (!media) return;
    const totalEpisodes = parseInt(media.episodes) || 0;
    const runtime = Math.round(media.duration || 0);
    const thumbnail = media.coverImage?.large || media.coverImage?.medium || fallbackThumbnail || "";
    applyMetadataPreview({
      title: media.title?.english || media.title?.romaji || result.title,
      meta: [media.startDate?.year || "", totalEpisodes ? `${totalEpisodes} episodes` : "", runtime ? `~${runtime} min/ep` : ""].filter(Boolean).join(" · "),
      image: thumbnailsEnabled() ? thumbnail : ""
    });
    fetchedMetadataDraft = { thumbnail: thumbnailsEnabled() ? thumbnail : "" };
    applySeriesMetadata({ totalSeasons: totalEpisodes > 0 ? 1 : 0, totalEpisodes, seasons: totalEpisodes > 0 ? [totalEpisodes] : [] });
    const episodeRuntimeInput = document.getElementById("field-episode-runtime");
    if (episodeRuntimeInput && !episodeRuntimeInput.value && runtime) {
      episodeRuntimeInput.value = runtime;
    }
    return;
  }

  if (result.source === "jikan") {
    const res = await fetch(`https://api.jikan.moe/v4/anime/${result.id}/full`);
    if (!res.ok) return;
    const json = await res.json();
    const entry = json?.data;
    if (!entry) return;
    const totalEpisodes = parseInt(entry.episodes) || 0;
    const runtime = parseInt(String(entry.duration || "").match(/\d+/)?.[0] || "") || 0;
    const thumbnail = entry.images?.jpg?.large_image_url || entry.images?.jpg?.image_url || fallbackThumbnail || "";
    applyMetadataPreview({
      title: entry.title || result.title,
      meta: [entry.aired?.from ? String(entry.aired.from).slice(0, 4) : "", totalEpisodes ? `${totalEpisodes} episodes` : "", runtime ? `~${runtime} min/ep` : ""].filter(Boolean).join(" · "),
      image: thumbnailsEnabled() ? thumbnail : ""
    });
    fetchedMetadataDraft = { thumbnail: thumbnailsEnabled() ? thumbnail : "" };
    applySeriesMetadata({ totalSeasons: totalEpisodes > 0 ? 1 : 0, totalEpisodes, seasons: totalEpisodes > 0 ? [totalEpisodes] : [] });
    const episodeRuntimeInput = document.getElementById("field-episode-runtime");
    if (episodeRuntimeInput && !episodeRuntimeInput.value && runtime) {
      episodeRuntimeInput.value = runtime;
    }
    return;
  }

  if (result.source === "kitsu") {
    const res = await fetch(`https://kitsu.io/api/edge/anime/${result.id}`, { headers: { Accept: "application/vnd.api+json" } });
    if (!res.ok) return;
    const json = await res.json();
    const entry = json?.data;
    const attrs = entry?.attributes || {};
    if (!entry) return;
    const totalEpisodes = parseInt(attrs.episodeCount) || 0;
    const runtime = parseInt(attrs.episodeLength) || 0;
    const thumbnail = attrs.posterImage?.large || attrs.posterImage?.medium || attrs.posterImage?.small || fallbackThumbnail || "";
    applyMetadataPreview({
      title: attrs.canonicalTitle || attrs.titles?.en || result.title,
      meta: [attrs.startDate ? attrs.startDate.slice(0, 4) : "", totalEpisodes ? `${totalEpisodes} episodes` : "", runtime ? `~${runtime} min/ep` : ""].filter(Boolean).join(" · "),
      image: thumbnailsEnabled() ? thumbnail : ""
    });
    fetchedMetadataDraft = { thumbnail: thumbnailsEnabled() ? thumbnail : "" };
    applySeriesMetadata({ totalSeasons: totalEpisodes > 0 ? 1 : 0, totalEpisodes, seasons: totalEpisodes > 0 ? [totalEpisodes] : [] });
    const episodeRuntimeInput = document.getElementById("field-episode-runtime");
    if (episodeRuntimeInput && !episodeRuntimeInput.value && runtime) {
      episodeRuntimeInput.value = runtime;
    }
  }
}

// Custom sources only expose the fields mapped in the search-result JSON path
// (title/subtitle/thumbnail) — unlike the built-ins there's no follow-up detail
// endpoint, so this just applies whatever the mapped fields gave us.
function applyCustomMetadataResult(result) {
  applyMetadataPreview({
    title: result.title,
    meta: result.subtitle || "",
    image: thumbnailsEnabled() ? result.thumbnail : ""
  });
  fetchedMetadataDraft = { thumbnail: thumbnailsEnabled() ? (result.thumbnail || "") : "" };
}

async function applySelectedSeriesMetadata(showId, title, fallbackThumbnail = "") {
  const showRes = await fetch(`https://api.tvmaze.com/shows/${showId}?embed=episodes`);
  if (!showRes.ok) return;
  const data = await showRes.json();
  const seasons = new Map();
  (data._embedded?.episodes || []).forEach(ep => {
    const seasonNum = parseInt(ep.season) || 0;
    if (!seasonNum) return;
    const current = seasons.get(seasonNum) || { total: 0 };
    current.total += 1;
    seasons.set(seasonNum, current);
  });
  const sortedSeasons = Array.from(seasons.entries()).sort((a, b) => a[0] - b[0]);
  const totalSeasons = sortedSeasons.length;
  const totalEpisodes = sortedSeasons.reduce((sum, [, season]) => sum + season.total, 0);
  const thumbnail = data.image?.medium || data.image?.original || fallbackThumbnail || "";
  const runtime = Math.round(data.averageRuntime || data.runtime || 0);
  applyMetadataPreview({
    title: data.name || title,
    meta: [`${totalSeasons} seasons, ${totalEpisodes} episodes`, runtime ? `~${runtime} min/ep` : ""].filter(Boolean).join(" · "),
    image: thumbnailsEnabled() ? thumbnail : ""
  });
  fetchedMetadataDraft = { thumbnail: thumbnailsEnabled() ? (data.image?.original || data.image?.medium || fallbackThumbnail || "") : "" };
  applySeriesMetadata({ totalSeasons, totalEpisodes, seasons: sortedSeasons.map(([, season]) => season.total) });

  const episodeRuntimeInput = document.getElementById("field-episode-runtime");
  if (episodeRuntimeInput && !episodeRuntimeInput.value && runtime) {
    episodeRuntimeInput.value = runtime;
  }
}

async function applySelectedMovieMetadata(entityId, title, fallbackThumbnail = "") {
  const entityRes = await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${entityId}&format=json&props=claims|descriptions|labels&languages=en&origin=*`);
  if (!entityRes.ok) return;
  const data = await entityRes.json();
  const entity = data.entities?.[entityId];
  if (!entity) return;

  const claims = entity.claims || {};
  const runtimeClaim = claims.P2047?.[0]?.mainsnak?.datavalue?.value?.amount;
  const runtime = runtimeClaim ? Math.round(parseFloat(runtimeClaim.replace("+", ""))) : 0;
  const imageFile = claims.P18?.[0]?.mainsnak?.datavalue?.value;
  const thumbnail = imageFile ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(imageFile)}` : fallbackThumbnail || "";
  const description = entity.descriptions?.en?.value || "Movie metadata found";

  applyMetadataPreview({
    title: entity.labels?.en?.value || title,
    meta: runtime ? `${runtime} min` : description,
    image: thumbnailsEnabled() ? thumbnail : ""
  });
  fetchedMetadataDraft = { thumbnail: thumbnailsEnabled() ? thumbnail : "" };

  const playtimeInput = document.getElementById("field-playtime");
  const playtimeHoursInput = document.getElementById("field-playtime-hours");
  const playtimeMinutesInput = document.getElementById("field-playtime-minutes");
  if (playtimeInput && !playtimeInput.value && runtime) {
    playtimeInput.value = runtime;
    if (playtimeHoursInput) playtimeHoursInput.value = Math.floor(runtime / 60);
    if (playtimeMinutesInput) playtimeMinutesInput.value = runtime % 60;
  }
  const statusSelect = document.getElementById("field-status");
  if (statusSelect && statusSelect.value === "Watchlist") statusSelect.value = "In Progress";
}

async function applySelectedGameMetadata(entityId, title) {
  const entityRes = await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${entityId}&format=json&props=claims|descriptions|labels&languages=en&origin=*`);
  if (!entityRes.ok) return;
  const data = await entityRes.json();
  const entity = data.entities?.[entityId];
  if (!entity) return;

  const claims = entity.claims || {};
  const imageFile = claims.P18?.[0]?.mainsnak?.datavalue?.value;
  const thumbnail = imageFile ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(imageFile)}` : "";
  const description = entity.descriptions?.en?.value || "Game metadata found";
  const releaseTime = claims.P577?.[0]?.mainsnak?.datavalue?.value?.time || "";
  const releaseYear = releaseTime ? String(releaseTime).replace(/^\+/, "").slice(0, 4) : "";

  applyMetadataPreview({
    title: entity.labels?.en?.value || title,
    meta: [description, releaseYear ? `Released ${releaseYear}` : ""].filter(Boolean).join(" · "),
    image: thumbnailsEnabled() ? thumbnail : ""
  });
  fetchedMetadataDraft = { thumbnail: thumbnailsEnabled() ? thumbnail : "" };
}

function clearMetadataPreview() {
  const preview = document.getElementById("metadata-preview");
  const thumb = document.getElementById("metadata-preview-thumb");
  const titleEl = document.getElementById("metadata-preview-title");
  const metaEl = document.getElementById("metadata-preview-meta");
  if (preview) preview.style.display = "none";
  if (thumb) {
    thumb.removeAttribute("src");
    thumb.alt = "";
    thumb.style.display = "none";
  }
  if (titleEl) titleEl.textContent = "";
  if (metaEl) metaEl.textContent = "";
}
