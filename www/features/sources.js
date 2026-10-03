// SquashDB - Sources: a browsable list of every built-in metadata source
// (static/pages/main/sources.html), plus a per-source search page (source-search.html?source=X)
// that queries just that one source across the categories it covers.
// Depends on globals from metadata.js (BUILTIN_METADATA_SOURCES,
// normalizeMetadataSources, builtinSourceEnabled), app.js (state, CATEGORIES,
// thumbnailOrPlaceholder) and — on the search page only — the per-source
// search functions defined in discover.js.

function sourceIsUsable(key) {
  const info = BUILTIN_METADATA_SOURCES[key];
  if (!info) return false;
  const enabled = state.preferences.metadataSources.builtinEnabled[key];
  const hasKey = !info.needsApiKey || Boolean(state.preferences.metadataSources.builtinApiKeys[key]);
  return enabled && hasKey;
}

// ---- Sources grid (static/pages/main/sources.html and static/pages/main/explore.html) ----
// static/pages/main/sources.html lists every built-in source (dimmed if disabled/missing a key)
// so it doubles as a way to discover what's available. static/pages/main/explore.html is meant
// to be a clean jumping-off point, so it only lists sources that are actually
// usable right now — the toolbox icon there links to Settings for the rest.
function renderSourcesList(enabledOnly = false) {
  const list = document.getElementById("sources-list");
  if (!list) return;
  normalizeMetadataSources();

  const keys = enabledOnly
    ? state.preferences.metadataSources.builtinOrder.filter(key => sourceIsUsable(key))
    : state.preferences.metadataSources.builtinOrder;

  list.innerHTML = keys.map(key => {
    const info = BUILTIN_METADATA_SOURCES[key];
    if (!info) return "";
    const enabled = state.preferences.metadataSources.builtinEnabled[key];
    const hasKey = !info.needsApiKey || Boolean(state.preferences.metadataSources.builtinApiKeys[key]);
    const status = !enabled ? "Disabled" : (!hasKey ? "API key needed" : "");
    return `
      <a class="source-tile${enabled && hasKey ? "" : " source-row-unavailable"}" href="static/pages/main/source-search.html?source=${key}">
        <span class="source-tile-icon"><i data-lucide="${info.icon || "database"}"></i></span>
        <span class="source-tile-name">${info.name}</span>
        <span class="source-tile-desc">${info.categories.map(c => CATEGORIES[c]?.label || c).join(", ")}</span>
        ${status ? `<span class="source-tile-status">${status}</span>` : ""}
      </a>
    `;
  }).join("");

  if (keys.length === 0) {
    list.innerHTML = `<p class="settings-row-note">No sources enabled yet. Use the toolbox icon above to enable one.</p>`;
  }

  if (window.lucide) lucide.createIcons();
}

// Explore page quick links (Timeline / Statistics) — plain anchors, but routed
// through recordCurrentPage so the in-app back stack stays correct.
function setupExploreQuickLinks() {
  document.querySelectorAll(".explore-quick-link").forEach(link => {
    if (link.dataset.bound) return;
    link.dataset.bound = "true";
    link.addEventListener("click", (e) => {
      e.preventDefault();
      recordCurrentPage();
      window.location.href = link.getAttribute("href");
    });
  });
}

// ---- Per-source search page ----
let sourceSearchState = {
  key: null,
  category: null,
  requestId: 0,
  results: []
};

// Top-rated/popular picks for a source before the user types anything.
// Sources with no browsable ranked feed (OMDb, Wikidata games, Google Books
// has only subject search) fall back to a subject query or nothing.
function suggestSingleSource(key, category) {
  switch (key) {
    case "steamdb": return Promise.resolve([]);
    case "freetogame": return fetchFreeToGameTopRated();
    case "tvmaze": return fetchTvmazeTopRated(category);
    case "anilist": return fetchAnilistTopRated(category === "manga" ? "MANGA" : "ANIME");
    case "jikan": return fetchJikanTopRated(category === "manga" ? "manga" : "anime");
    case "kitsu": return fetchKitsuTopRated(category === "manga" ? "manga" : "anime");
    case "openlibrary": return fetchOpenLibraryTopRated(category);
    case "googlebooks": return searchGoogleBooks(category === "manga" ? "subject:comics" : "subject:fiction", category);
    case "wikidata": return category === "game" ? Promise.resolve([]) : fetchWikidataPopularMovies();
    case "tmdb": return fetchTmdbTopRated(category === "movie" ? "movie" : "tv", category);
    case "rawg": return fetchRawgTopRated();
    default: return Promise.resolve([]);
  }
}

// Routes a (source, category, query) triple to the right discover.js search
// function. Each source speaks a different dialect, so this is the one place
// that mapping lives.
function searchSingleSource(key, category, query) {
  switch (key) {
    case "steamdb": return searchSteamDb(query);
    case "freetogame": return searchFreeToGame(query);
    case "shikimori": return searchShikimori(query, category);
    case "tvmaze": return searchTvmaze(query, category);
    case "anilist": return searchAnilist(query, category === "manga" ? "MANGA" : "ANIME", category);
    case "jikan": return searchJikan(query, category === "manga" ? "manga" : "anime");
    case "kitsu": return searchKitsu(query, category === "manga" ? "manga" : "anime");
    case "mangadex": return searchMangaDex(query);
    case "openlibrary": return searchOpenLibrary(query, category);
    case "googlebooks": return searchGoogleBooks(query, category);
    case "wikidata": return category === "game" ? searchWikidataGames(query) : searchWikidataMovies(query);
    case "omdb": return searchOmdb(query, category, category === "movie" ? "movie" : "series");
    case "tmdb": return searchTmdb(query, category === "movie" ? "movie" : "tv", category);
    case "rawg": return searchRawg(query);
    default: return Promise.resolve([]);
  }
}

function initSourceSearchPage() {
  const titleEl = document.getElementById("source-search-title");
  if (!titleEl) return;

  normalizeMetadataSources();
  const params = new URLSearchParams(window.location.search);
  const key = params.get("source");
  const info = BUILTIN_METADATA_SOURCES[key];
  if (!info) {
    window.location.href = "static/pages/main/sources.html";
    return;
  }

  sourceSearchState.key = key;
  // MangaDex and Shikimori are being opened from the manga/manhwa/manhua
  // source flow, so start on manga instead of silently querying anime.
  sourceSearchState.category = ["mangadex", "shikimori"].includes(key) && info.categories.includes("manga")
    ? "manga"
    : info.categories[0];
  titleEl.textContent = info.name;

  const notice = document.getElementById("source-search-notice");
  if (!sourceIsUsable(key) && notice) {
    notice.textContent = info.needsApiKey && !state.preferences.metadataSources.builtinApiKeys[key]
      ? `${info.name} needs an API key — add one in Settings → Metadata Sources to search here.`
      : `${info.name} is disabled in Settings → Metadata Sources. Searching here still works, but Discover won't use it.`;
    notice.style.display = "block";
  }

  renderSourceCategoryChips(info);

  const searchInput = document.getElementById("source-search-input");
  if (searchInput) {
    searchInput.placeholder = `Search ${info.name}...`;
    let debounceTimer = null;
    searchInput.addEventListener("input", (e) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => runSourceSearch(e.target.value), 400);
    });
  }

  loadSourceSuggestions();
}

async function loadSourceSuggestions() {
  const resultsEl = document.getElementById("source-search-results");
  const emptyEl = document.getElementById("source-search-empty");
  if (!resultsEl || !emptyEl) return;

  resultsEl.innerHTML = "";
  emptyEl.style.display = "flex";
  emptyEl.querySelector("h3").textContent = "Loading top picks…";
  emptyEl.querySelector("p").textContent = "";

  const requestId = ++sourceSearchState.requestId;
  let results = [];
  try {
    results = await suggestSingleSource(sourceSearchState.key, sourceSearchState.category);
  } catch (err) {
    console.warn(`${sourceSearchState.key} suggestions failed`, err);
  }
  if (requestId !== sourceSearchState.requestId) return;

  sourceSearchState.results = (results || []).slice(0, 15);
  if (sourceSearchState.results.length === 0) {
    resultsEl.innerHTML = "";
    emptyEl.style.display = "flex";
    emptyEl.querySelector("h3").textContent = "Search This Source";
    emptyEl.querySelector("p").textContent = "Type a title to search only this metadata source.";
    return;
  }
  renderSourceSearchResults();
}

function renderSourceCategoryChips(info) {
  const chipsEl = document.getElementById("source-category-chips");
  if (!chipsEl) return;

  if (info.categories.length < 2) {
    chipsEl.style.display = "none";
    return;
  }

  chipsEl.style.display = "flex";
  chipsEl.innerHTML = info.categories.map(cat => `
    <div class="chip${sourceSearchState.category === cat ? " active" : ""}" data-category="${cat}" style="--theme-color:${CATEGORIES[cat]?.color || "var(--primary)"}">
      <i data-lucide="${CATEGORIES[cat]?.icon || "list"}"></i> ${CATEGORIES[cat]?.label || cat}
    </div>
  `).join("");

  chipsEl.querySelectorAll(".chip").forEach(chip => {
    chip.addEventListener("click", () => {
      sourceSearchState.category = chip.dataset.category;
      chipsEl.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === chip));
      const query = document.getElementById("source-search-input")?.value || "";
      if (query.trim()) runSourceSearch(query);
      else loadSourceSuggestions();
    });
  });

  if (window.lucide) lucide.createIcons();
}

async function runSourceSearch(query) {
  const resultsEl = document.getElementById("source-search-results");
  const emptyEl = document.getElementById("source-search-empty");
  if (!resultsEl || !emptyEl) return;

  const trimmed = query.trim();
  if (!trimmed) {
    loadSourceSuggestions();
    return;
  }

  const notice = document.getElementById("source-search-notice");
  if (notice) {
    notice.textContent = "";
    notice.style.display = "none";
  }

  const requestId = ++sourceSearchState.requestId;
  let results = [];
  try {
    results = await searchSingleSource(sourceSearchState.key, sourceSearchState.category, trimmed);
  } catch (err) {
    console.warn(`${sourceSearchState.key} source search failed`, err);
    if (notice) {
      notice.textContent = `${sourceSearchState.key} could not be reached: ${err?.message || "network request failed"}.`;
      notice.style.display = "block";
    }
  }
  if (requestId !== sourceSearchState.requestId) return;

  sourceSearchState.results = results;
  renderSourceSearchResults();
}

function renderSourceSearchResults() {
  const resultsEl = document.getElementById("source-search-results");
  const emptyEl = document.getElementById("source-search-empty");
  if (!resultsEl || !emptyEl) return;

  if (sourceSearchState.results.length === 0) {
    resultsEl.innerHTML = "";
    emptyEl.style.display = "flex";
    emptyEl.querySelector("h3").textContent = "No Results";
    emptyEl.querySelector("p").textContent = "Try a different title or check your spelling.";
    return;
  }

  emptyEl.style.display = "none";
  resultsEl.innerHTML = sourceSearchState.results.map((r, index) => `
    <button type="button" class="discover-result-card" data-index="${index}">
      ${thumbnailOrPlaceholder(r.thumbnail, "discover-result-thumb")}
      <div class="discover-result-body">
        <span class="discover-result-title">${r.title}</span>
        <span class="discover-result-subtitle">${r.subtitle || ""}</span>
        ${r.rating ? `<span class="discover-result-rating"><i data-lucide="star"></i> ${r.rating}</span>` : ""}
      </div>
    </button>
  `).join("");

  resultsEl.querySelectorAll(".discover-result-card").forEach(card => {
    card.addEventListener("click", () => {
      const result = sourceSearchState.results[parseInt(card.dataset.index, 10)];
      if (!result) return;
      const urlParams = new URLSearchParams({
        source: "online",
        provider: result.source,
        providerId: result.id,
        category: result.category,
        title: result.title
      });
      window.location.href = `static/pages/main/show-detail.html?${urlParams.toString()}`;
    });
  });

  if (window.lucide) lucide.createIcons();
}

document.addEventListener("DOMContentLoaded", () => {
  const isExplorePage = Boolean(document.getElementById("tab-explore"));
  renderSourcesList(isExplorePage);
  setupExploreQuickLinks();
  initSourceSearchPage();
});
