// Bulk list import for the dashboard.
// The import itself is synchronous and local; metadata is queued and fetched
// through a small bounded worker pool so a large file never blocks the WebView.
(function () {
  "use strict";

  const maxAttempts = () => Math.max(1, Number(state.preferences?.metadataRetryLimit) || 3);
  let dialog;
  let rows = [];
  let queueWorkers = 0;
  let importTimer;

  function queueConcurrency() {
    return Math.max(1, Math.min(10, Math.round(Number(state.preferences.metadataImportConcurrency) || 5)));
  }

  const uid = () => (window.crypto && typeof window.crypto.randomUUID === "function")
    ? window.crypto.randomUUID()
    : `item-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  function normalizeTitle(value) {
    return String(value || "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  }

  function csvLine(line, separator) {
    const fields = [];
    let value = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"') {
        if (quoted && line[i + 1] === '"') { value += '"'; i += 1; }
        else quoted = !quoted;
      } else if (char === separator && !quoted) {
        fields.push(value.trim()); value = "";
      } else value += char;
    }
    fields.push(value.trim());
    return fields;
  }

  function parseText(text, name) {
    const separator = name.toLowerCase().endsWith(".tsv") ? "\t" : ",";
    const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith("#"));
    if (!lines.length) return [];
    const first = csvLine(lines[0], separator).map(value => value.toLowerCase());
    const hasHeader = first.some(value => ["title", "name", "status", "category"].includes(value));
    const titleIndex = hasHeader ? Math.max(0, first.findIndex(value => value === "title" || value === "name")) : 0;
    const statusIndex = hasHeader ? first.findIndex(value => value === "status") : 1;
    const categoryIndex = hasHeader ? first.findIndex(value => value === "category") : 2;
    return lines.slice(hasHeader ? 1 : 0).map(line => {
      let fields = csvLine(line, separator);
      if (separator === "," && fields.length === 1) {
        const dash = line.lastIndexOf(" - ");
        fields = dash > 0 ? [line.slice(0, dash), line.slice(dash + 3)] : [line];
      }
      return {
        title: fields[titleIndex] || "",
        status: statusIndex >= 0 ? fields[statusIndex] || "" : "",
        category: categoryIndex >= 0 ? fields[categoryIndex] || "" : ""
      };
    }).filter(row => row.title.trim());
  }

  function categoryKeys() {
    if (typeof getEnabledOrderedCategories === "function") {
      const enabled = getEnabledOrderedCategories();
      if (enabled.length) return enabled;
    }
    return Object.keys(CATEGORIES || {});
  }

  function categoryLabel(key) { return CATEGORIES[key]?.label || key; }

  function canonicalStatus(value, category, fallback) {
    const raw = String(value || "").trim().toLowerCase();
    const statuses = CATEGORIES[category]?.statuses || [];
    const find = (...names) => statuses.find(status => names.includes(status.toLowerCase()));
    if (!raw) return fallback || statuses[0] || "Watchlist";
    const exact = statuses.find(status => status.toLowerCase() === raw);
    if (exact) return exact;
    if (/complete|done|finished/.test(raw)) return find("completed") || "Completed";
    if (/drop|abandon/.test(raw)) return find("dropped") || "Dropped";
    if (/hold|pause|hiatus/.test(raw)) return find("on hold") || "On Hold";
    if (/watching|playing|reading|progress|current/.test(raw)) {
      return find("in progress") || find("playing") || find("reading") || statuses[1] || statuses[0];
    }
    if (/backlog|plan|want|watchlist|to watch/.test(raw)) return find("backlog") || find("watchlist") || statuses[0];
    return fallback || statuses[0] || "Watchlist";
  }

  function defaultCategory() {
    return categoryKeys().includes("anime") ? "anime" : (categoryKeys()[0] || "movie");
  }

  function makeDialog() {
    if (dialog) return dialog;
    dialog = document.getElementById("settings-import-page");
    if (dialog) {
      dialog.dataset.inline = "true";
    } else {
      dialog = document.createElement("div");
      dialog.className = "modal-overlay";
      dialog.id = "import-list-modal";
      dialog.innerHTML = `
      <div class="modal-content">
        <div class="modal-header"><h3 class="modal-title">Import list</h3><button type="button" class="modal-close" data-import-close>&times;</button></div>
        <p class="settings-row-note">Use CSV, TSV, or one title per line. You can write TXT lines as <code>Title - Status</code>.</p>
        <div class="form-group"><label for="import-category">Category</label><select id="import-category" class="form-control"></select></div>
        <div class="form-group"><label for="import-default-status">Default status</label><select id="import-default-status" class="form-control"></select></div>
        <div class="form-group"><label for="import-duplicates">Duplicates</label><select id="import-duplicates" class="form-control"><option value="skip">Skip existing titles</option><option value="update">Update existing status</option><option value="create">Create another copy</option></select></div>
        <div class="form-group"><label for="import-metadata-source">Metadata source</label><select id="import-metadata-source" class="form-control"><option value="auto">Automatic</option><option value="tvmaze">TVmaze (series/anime)</option><option value="wikidata">Wikidata (movies/games)</option></select></div>
        <label class="form-check"><input type="checkbox" id="import-fetch-metadata" checked> Start background metadata syncing</label>
        <label class="form-check"><input type="checkbox" id="import-download-thumbnails" checked> Download thumbnails when available</label>
        <div id="import-list-summary" class="settings-row-note"></div><div id="import-list-preview" class="import-list-preview" hidden></div>
        <div class="form-actions"><button type="button" class="btn btn-secondary" data-import-close>Cancel</button><button type="button" class="btn btn-primary" id="import-list-confirm" disabled>Import</button></div>
      </div>`;
      document.body.appendChild(dialog);
    }
    if (dialog.dataset.importBound === "true") return dialog;
    dialog.dataset.importBound = "true";
    dialog.querySelectorAll("[data-import-close]").forEach(button => button.addEventListener("click", closeDialog));
    if (!dialog.dataset.inline) dialog.addEventListener("click", event => { if (event.target === dialog) closeDialog(); });
    dialog.querySelector("#import-category").addEventListener("change", () => { updateStatusOptions(); updateMetadataSourceOptions(); });
    dialog.querySelector("#import-list-confirm").addEventListener("click", commitImport);
    return dialog;
  }

  function updateStatusOptions() {
    const category = dialog.querySelector("#import-category").value;
    const select = dialog.querySelector("#import-default-status");
    const statuses = CATEGORIES[category]?.statuses || ["Watchlist", "In Progress", "Completed"];
    select.innerHTML = "";
    statuses.forEach(status => { const option = document.createElement("option"); option.value = status; option.textContent = status; select.appendChild(option); });
  }

  const sourceNames = {
    tvmaze: "TVmaze", anilist: "AniList", jikan: "MyAnimeList (Jikan)", kitsu: "Kitsu",
    mangadex: "MangaDex", openlibrary: "Open Library", googlebooks: "Google Books",
    wikidata: "Wikidata", tmdb: "TMDB", omdb: "OMDb", steamdb: "Steam + SteamDB",
    freetogame: "FreeToGame", rawg: "RAWG"
  };

  function metadataSourcesForCategory(category) {
    const byCategory = {
      game: ["steamdb", "freetogame"],
      anime: ["anilist", "tvmaze"],
      manga: ["anilist", "openlibrary"],
      movie: ["wikidata"],
      series: ["tvmaze"],
      kdrama: ["tvmaze"],
      cdrama: ["tvmaze"],
      novel: ["openlibrary"]
    };
    return byCategory[category] || ["auto"];
  }

  function updateMetadataSourceOptions() {
    const category = dialog.querySelector("#import-category").value;
    const select = dialog.querySelector("#import-metadata-source");
    const previous = select.value;
    select.innerHTML = "";
    const automatic = document.createElement("option");
    automatic.value = "auto";
    automatic.textContent = `Automatic (${sourceNames[metadataSourcesForCategory(category)[0]] || "recommended source"})`;
    select.appendChild(automatic);
    metadataSourcesForCategory(category).forEach(key => {
      const option = document.createElement("option"); option.value = key; option.textContent = sourceNames[key] || key; select.appendChild(option);
    });
    select.value = [...select.options].some(option => option.value === previous) ? previous : "auto";
  }

  function openDialog(file) {
    makeDialog();
    populateCategoryOptions();
    updateStatusOptions();
    updateMetadataSourceOptions();
    dialog.querySelector("#import-list-summary").textContent = `Total titles: ${rows.length}`;
    const preview = dialog.querySelector("#import-list-preview");
    preview.innerHTML = "";
    preview.hidden = true;
    dialog.querySelector("#import-list-confirm").disabled = rows.length === 0;
    if (!dialog.dataset.inline) dialog.classList.add("active");
  }

  function populateCategoryOptions() {
    const categorySelect = dialog.querySelector("#import-category");
    if (!categorySelect) return;
    const current = categorySelect.value;
    categorySelect.innerHTML = "";
    categoryKeys().forEach(key => { const option = document.createElement("option"); option.value = key; option.textContent = categoryLabel(key); categorySelect.appendChild(option); });
    categorySelect.value = categoryKeys().includes(current)
      ? current
      : (categoryKeys().includes(state.preferences.importDefaultCategory) ? state.preferences.importDefaultCategory : defaultCategory());
    const duplicateSelect = dialog.querySelector("#import-duplicates");
    if (duplicateSelect) duplicateSelect.value = state.preferences.importDuplicatePolicy || "skip";
    updateStatusOptions();
    updateMetadataSourceOptions();
  }

  function closeDialog() { if (dialog) dialog.classList.remove("active"); }

  function itemForRow(row, category, status) {
    const completed = status.toLowerCase() === "completed";
    const item = { id: uid(), title: row.title.trim(), category, status, source: "multi-import", metadataStatus: "manual", rating: 0, completionDate: completed ? new Date().toISOString().slice(0, 10) : "", notes: "", created: Date.now(), updated: Date.now(), thumbnail: "", totalSeasons: 0, episodesDone: 0, totalEpisodes: 0, seasonEpisodes: {}, watchedEpisodeIds: [], episodesCache: [] };
    return completed && typeof markItemAsCompleted === "function" ? markItemAsCompleted(item) : item;
  }

  function queueFor(item) {
    const queue = state.preferences.metadataQueue;
    const existing = queue.find(entry => entry.itemId === item.id);
    if (existing) {
      if (existing.state === "failed" || existing.state === "synced") { existing.state = "pending"; existing.attempts = 0; existing.lastError = ""; }
      item.metadataStatus = "pending";
      return;
    }
    item.metadataStatus = "pending";
    queue.push({ id: uid(), itemId: item.id, title: item.title, category: item.category, state: "pending", attempts: 0, source: "auto", thumbnails: true, createdAt: Date.now(), updatedAt: Date.now(), lastError: "" });
  }

  function commitImport() {
    const category = dialog.querySelector("#import-category").value;
    const fallback = dialog.querySelector("#import-default-status").value;
    const duplicateMode = dialog.querySelector("#import-duplicates").value;
    const fetchMetadata = dialog.querySelector("#import-fetch-metadata").checked;
    const metadataSource = dialog.querySelector("#import-metadata-source").value;
    const downloadThumbnails = dialog.querySelector("#import-download-thumbnails").checked;
    let added = 0; let updated = 0; let skipped = 0;
    rows.forEach(row => {
      const rowCategory = categoryKeys().find(key => key === String(row.category || "").toLowerCase() || categoryLabel(key).toLowerCase() === String(row.category || "").toLowerCase()) || category;
      const status = canonicalStatus(row.status, rowCategory, fallback);
      const duplicate = state.items.find(item => item.category === rowCategory && normalizeTitle(item.title) === normalizeTitle(row.title));
      if (duplicate && duplicateMode === "skip") { skipped += 1; return; }
      if (duplicate && duplicateMode === "update") {
        duplicate.status = status; duplicate.updated = Date.now();
        if (status === "Completed" && !duplicate.completionDate) duplicate.completionDate = new Date().toISOString().slice(0, 10);
        if (fetchMetadata) { queueFor(duplicate); const queued = state.preferences.metadataQueue.find(entry => entry.itemId === duplicate.id); if (queued) { queued.source = metadataSource; queued.thumbnails = downloadThumbnails; } } updated += 1; return;
      }
      const item = itemForRow(row, rowCategory, status); state.items.push(item); if (fetchMetadata) { queueFor(item); const queued = state.preferences.metadataQueue.find(entry => entry.itemId === item.id); if (queued) { queued.source = metadataSource; queued.thumbnails = downloadThumbnails; } } added += 1;
    });
    saveData();
    if (typeof renderDashboard === "function") renderDashboard();
    closeDialog();
    if (fetchMetadata) state.preferences.metadataQueuePaused = false;
    if (typeof showToast === "function") showToast(`Imported ${added} item${added === 1 ? "" : "s"}${updated ? `, updated ${updated}` : ""}${skipped ? `, skipped ${skipped}` : ""}.`, "success");
    renderQueueStatus();
    scheduleQueue();
    if (document.getElementById("settings-import-page")) {
      window.location.href = "static/pages/settings/manage-import-status.html";
    }
  }

  async function fetchPortable(url, init = {}) {
    const nativeHttp = window.CapacitorHttp || window.Capacitor?.Plugins?.Http || window.Capacitor?.Plugins?.CapacitorHttp;
    if (nativeHttp?.get && (init.method || "GET").toUpperCase() === "GET") {
      const response = await nativeHttp.get({ url, headers: init.headers || {} });
      return typeof response?.data === "string" ? JSON.parse(response.data) : response?.data;
    }
    if (nativeHttp?.request) {
      const response = await nativeHttp.request({ url, method: init.method || "GET", headers: init.headers || {}, data: init.body || null, responseType: "json" });
      return typeof response?.data === "string" ? JSON.parse(response.data) : response?.data;
    }
    if (window.location?.origin && window.location.origin !== "null") {
      const proxyUrl = new URL("/proxy", window.location.origin);
      proxyUrl.searchParams.set("url", url);
      const proxyResponse = await fetch(proxyUrl.toString(), init);
      if (proxyResponse.ok) return proxyResponse.json();
      if (proxyResponse.status !== 404) throw new Error(`Metadata proxy HTTP ${proxyResponse.status}`);
    }
    const response = await fetch(url, init);
    if (!response.ok) throw new Error(`Metadata HTTP ${response.status}`);
    return response.json();
  }

  async function steamMetadata(item, useThumbnail = true) {
    const search = await fetchPortable(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(item.title)}&l=english&cc=us`);
    const hit = search?.items?.[0];
    if (!hit?.id) throw new Error("No Steam game found");
    let details = null;
    try { details = (await fetchPortable(`https://store.steampowered.com/api/appdetails?appids=${hit.id}&l=english&cc=us`))?.[hit.id]?.data || null; } catch (error) { console.warn("Steam details unavailable", error); }
    Object.assign(item, { title: details?.name || hit.name || item.title, providerId: `app:${hit.id}`, steamAppId: hit.id, metadataSource: "steamdb", steamUrl: `https://store.steampowered.com/app/${hit.id}/`, thumbnail: useThumbnail && thumbnailsEnabled() ? (details?.header_image || hit.tiny_image || "") : "", summary: details?.short_description || "", genres: (details?.genres || []).map(value => value.description).filter(Boolean), releaseDate: details?.release_date?.date || "", updated: Date.now() });
  }

  async function freeGameMetadata(item, useThumbnail = true) {
    const results = await fetchPortable(`https://www.freetogame.com/api/games?title=${encodeURIComponent(item.title)}`);
    const hit = Array.isArray(results) ? results[0] : null;
    if (!hit?.id) throw new Error("No free game found");
    Object.assign(item, { title: hit.title || item.title, providerId: `freetogame:${hit.id}`, metadataSource: "freetogame", thumbnail: useThumbnail && thumbnailsEnabled() ? (hit.thumbnail || hit.freetogame_profile_url || "") : "", summary: hit.short_description || "", genres: hit.genre ? [hit.genre] : [], steamUrl: hit.game_url || "", updated: Date.now() });
  }

  async function anilistMetadata(item, useThumbnail = true) {
    const type = item.category === "manga" ? "MANGA" : "ANIME";
    const query = `query($search:String!,$type:MediaType!){Page(perPage:1){media(search:$search,type:$type){id title{romaji english} description coverImage{large medium} genres episodes chapters volumes duration startDate{year}}}}`;
    const data = await fetchPortable("https://graphql.anilist.co", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, variables: { search: item.title, type } }) });
    const media = data?.data?.Page?.media?.[0];
    if (!media?.id) throw new Error("No AniList metadata found");
    const title = media.title?.english || media.title?.romaji || item.title;
    Object.assign(item, { title, providerId: `anilist:${media.id}`, metadataSource: "anilist", thumbnail: useThumbnail && thumbnailsEnabled() ? (media.coverImage?.large || media.coverImage?.medium || "") : "", summary: String(media.description || "").replace(/<[^>]+>/g, "").trim(), genres: media.genres || [], releaseDate: media.startDate?.year ? String(media.startDate.year) : "", updated: Date.now() });
    if (type === "ANIME") Object.assign(item, { totalSeasons: media.episodes ? 1 : 0, totalEpisodes: Number(media.episodes) || 0, episodeRuntime: Number(media.duration) || "", seasonEpisodes: media.episodes ? { season1: { total: Number(media.episodes), watched: 0, completed: false } } : {} });
    else Object.assign(item, { totalVolumes: Number(media.volumes) || "", totalChapters: Number(media.chapters) || "" });
  }

  async function openLibraryMetadata(item, useThumbnail = true) {
    const data = await fetchPortable(`https://openlibrary.org/search.json?title=${encodeURIComponent(item.title)}&limit=1`);
    const hit = data?.docs?.[0];
    if (!hit?.key) throw new Error("No Open Library metadata found");
    Object.assign(item, { title: hit.title || item.title, providerId: `openlibrary:${hit.key}`, metadataSource: "openlibrary", thumbnail: useThumbnail && thumbnailsEnabled() && hit.cover_i ? `https://covers.openlibrary.org/b/id/${hit.cover_i}-M.jpg` : "", genres: hit.subject?.slice(0, 5) || [], releaseDate: hit.first_publish_year ? String(hit.first_publish_year) : "", totalVolumes: Number(hit.edition_count) || "", updated: Date.now() });
  }

  async function tvmazeMetadata(item, useThumbnail = true) {
    const search = await fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(item.title)}`);
    if (!search.ok) throw new Error("TV metadata search failed");
    const result = (await search.json())[0]?.show;
    if (!result?.id) throw new Error("No matching TV metadata found");
    const detailRes = await fetch(`https://api.tvmaze.com/shows/${result.id}?embed=episodes`);
    if (!detailRes.ok) throw new Error("TV metadata details failed");
    const show = await detailRes.json();
    const episodes = show._embedded?.episodes || [];
    const seasons = {};
    const cache = episodes.map(ep => {
      const key = `season${ep.season}`; seasons[key] = seasons[key] || { total: 0, watched: 0, completed: false }; seasons[key].total += 1;
      return { id: ep.id, season: ep.season, episode: ep.number, title: ep.name || `Episode ${ep.number}`, airdate: ep.airdate || "", runtime: ep.runtime || 0 };
    });
    Object.values(seasons).forEach(season => { season.watched = 0; });
    Object.assign(item, { title: show.name || item.title, providerId: `tvmaze:${show.id}`, tvmazeShowId: show.id, metadataSource: "tvmaze", thumbnail: useThumbnail && thumbnailsEnabled() ? (show.image?.original || show.image?.medium || "") : "", summary: String(show.summary || "").replace(/<[^>]+>/g, "").trim(), genres: show.genres || [], network: show.network?.name || show.webChannel?.name || "", premiered: show.premiered || "", totalSeasons: Object.keys(seasons).length, totalEpisodes: cache.length, seasonEpisodes: seasons, episodesCache: cache, updated: Date.now() });
  }

  async function wikidataMetadata(item, useThumbnail = true) {
    const search = await fetch(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(item.title)}&language=en&type=item&limit=1&format=json&origin=*`);
    if (!search.ok) throw new Error("Movie metadata search failed");
    const hit = (await search.json()).search?.[0];
    if (!hit?.id) throw new Error("No matching movie metadata found");
    const detail = await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${hit.id}&format=json&props=claims|descriptions|labels&languages=en&origin=*`);
    if (!detail.ok) throw new Error("Movie metadata details failed");
    const entity = (await detail.json()).entities?.[hit.id];
    if (!entity) throw new Error("Movie metadata was empty");
    const image = entity.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
    const release = entity.claims?.P577?.[0]?.mainsnak?.datavalue?.value?.time || "";
    Object.assign(item, { title: entity.labels?.en?.value || item.title, providerId: `wikidata:${hit.id}`, metadataSource: "wikidata", thumbnail: useThumbnail && thumbnailsEnabled() && image ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(image)}` : "", summary: entity.descriptions?.en?.value || "", releaseDate: release ? release.replace(/^\+/, "").slice(0, 10) : "", updated: Date.now() });
  }

  async function processQueue() {
    if (queueWorkers >= queueConcurrency() || state.preferences.metadataQueuePaused || state.preferences.metadataMode !== "online" || navigator.onLine === false) return;
    const queue = state.preferences.metadataQueue;
    const jobs = [];
    while (queueWorkers + jobs.length < queueConcurrency()) {
      const entry = queue.find(value => ["pending", "failed"].includes(value.state) && Number(value.attempts || 0) < maxAttempts());
      if (!entry) break;
      const item = state.items.find(value => value.id === entry.itemId);
      entry.state = "processing";
      entry.updatedAt = Date.now();
      if (item) jobs.push({ entry, item });
      else entry.state = "synced";
    }
    if (!jobs.length) { saveData(); renderQueueStatus(); return; }
    queueWorkers += jobs.length;
    saveData();
    renderQueueStatus();
    await Promise.all(jobs.map(job => processQueueJob(job.entry, job.item)));
    if (queue.some(entry => ["pending", "failed"].includes(entry.state) && Number(entry.attempts || 0) < maxAttempts())) {
      importTimer = setTimeout(processQueue, 250);
    }
  }

  async function processQueueJob(entry, item) {
    try {
      const source = entry.source === "auto" ? metadataSourcesForCategory(item.category)[0] : entry.source;
      const useThumbnail = entry.thumbnails !== false;
      if (source === "steamdb") await steamMetadata(item, useThumbnail);
      else if (source === "freetogame") await freeGameMetadata(item, useThumbnail);
      else if (source === "anilist") await anilistMetadata(item, useThumbnail);
      else if (source === "openlibrary") await openLibraryMetadata(item, useThumbnail);
      else if (source === "wikidata") await wikidataMetadata(item, useThumbnail);
      else if (source === "tvmaze") await tvmazeMetadata(item, useThumbnail);
      else throw new Error(`${sourceNames[source] || source} is not available for background import yet`);
      entry.state = "synced"; entry.lastError = ""; entry.syncedAt = Date.now(); item.metadataStatus = "synced";
      if (item.status === "Completed" && typeof markItemAsCompleted === "function") markItemAsCompleted(item);
    } catch (error) {
      entry.attempts = Number(entry.attempts || 0) + 1; entry.state = entry.attempts >= maxAttempts() ? "failed" : "pending"; entry.lastError = error.message || "Metadata request failed"; if (entry.state === "failed") item.metadataStatus = "not-found";
    } finally {
      entry.updatedAt = Date.now(); queueWorkers -= 1; saveData();
      if (typeof renderDashboard === "function") renderDashboard();
      window.dispatchEvent(new CustomEvent("metadata-queue-updated"));
      renderQueueStatus();
    }
  }

  function scheduleQueue() {
    clearTimeout(importTimer);
    const delays = { immediate: 500, "five-minutes": 5 * 60 * 1000, "fifteen-minutes": 15 * 60 * 1000 };
    importTimer = setTimeout(processQueue, delays[state.preferences.metadataSyncFrequency] || delays.immediate);
  }

  function renderQueueStatus() {
    const target = document.getElementById("import-list-progress");
    if (!target || !state.preferences?.metadataQueue) return;
    const queue = state.preferences.metadataQueue;
    if (!queue.length) { target.hidden = true; return; }
    const pending = queue.filter(entry => ["pending", "processing"].includes(entry.state)).length;
    const synced = queue.filter(entry => entry.state === "synced").length;
    const failed = queue.filter(entry => entry.state === "failed").length;
    target.hidden = false;
    target.innerHTML = `<strong>Metadata sync</strong> · ${synced} synced · ${pending} pending · ${failed} failed <button type="button" data-queue-action="toggle">${state.preferences.metadataQueuePaused ? "Resume" : "Pause"}</button>${failed ? '<button type="button" data-queue-action="retry">Retry failed</button><button type="button" data-queue-action="errors">View errors</button>' : ""}${synced ? '<button type="button" data-queue-action="clear">Clear completed</button>' : ""}`;
    target.querySelectorAll("[data-queue-action]").forEach(button => button.addEventListener("click", () => {
      if (button.dataset.queueAction === "toggle") { state.preferences.metadataQueuePaused = !state.preferences.metadataQueuePaused; saveData(); renderQueueStatus(); if (!state.preferences.metadataQueuePaused) scheduleQueue(); }
      if (button.dataset.queueAction === "retry") { queue.filter(entry => entry.state === "failed").forEach(entry => { entry.state = "pending"; entry.attempts = 0; }); saveData(); renderQueueStatus(); scheduleQueue(); }
      if (button.dataset.queueAction === "clear") { state.preferences.metadataQueue = queue.filter(entry => entry.state !== "synced"); saveData(); renderQueueStatus(); }
      if (button.dataset.queueAction === "errors") {
        const errors = queue.filter(entry => entry.state === "failed");
        const details = document.createElement("div"); details.className = "import-list-preview";
        errors.forEach(entry => { const line = document.createElement("div"); line.className = "import-list-preview-row"; const title = document.createElement("span"); title.textContent = entry.title; const message = document.createElement("span"); message.textContent = entry.lastError || "Metadata request failed"; line.append(title, message); details.appendChild(line); });
        target.querySelector(".import-list-preview")?.remove(); target.appendChild(details);
      }
    }));
  }

  function init() {
    const trigger = document.getElementById("dashboard-import-btn") || document.getElementById("settings-import-btn");
    const input = document.getElementById("dashboard-import-file") || document.getElementById("settings-import-file");
    if (trigger && input) {
      trigger.addEventListener("click", () => input.click());
      input.addEventListener("change", async () => {
        const file = input.files?.[0]; input.value = ""; if (!file) return;
        try { rows = parseText(await readFile(file), file.name); openDialog(file); }
        catch (error) { if (typeof showToast === "function") showToast(error.message || "Could not read the file", "error"); }
      });
    }
    if (document.getElementById("settings-import-page")) {
      makeDialog();
      populateCategoryOptions();
      const concurrency = document.getElementById("import-concurrency");
      if (concurrency) {
        concurrency.value = String(queueConcurrency());
        concurrency.addEventListener("change", () => {
          state.preferences.metadataImportConcurrency = Math.max(1, Math.min(10, Math.round(Number(concurrency.value) || 5)));
          concurrency.value = String(state.preferences.metadataImportConcurrency);
          saveData();
          scheduleQueue();
        });
      }
    }
    const interruptedJobs = state.preferences.metadataQueue.filter(entry => entry.state === "processing");
    if (interruptedJobs.length) {
      interruptedJobs.forEach(entry => { entry.state = "pending"; entry.updatedAt = Date.now(); });
      saveData();
    }
    window.addEventListener("online", scheduleQueue);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleQueue(); });
    renderQueueStatus(); scheduleQueue();
  }

  function readFile(file) {
    if (typeof file.text === "function") return file.text();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result || "");
      reader.onerror = () => reject(new Error("Could not read the selected file"));
      reader.readAsText(file);
    });
  }

  window.addEventListener("squashdb-app-ready", () => {
    try { init(); } catch (error) { console.warn("Import list initialization failed", error); }
  }, { once: true });
})();
