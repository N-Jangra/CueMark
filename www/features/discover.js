// CueMark - Discover: category-first online search. Pick a tracking category
// (same enabled-categories chip row as Dashboard), see its top-rated
// suggestions immediately, then search scoped to just that category across
// every enabled metadata source for it, merged into one result list.
// Results here are ephemeral until the user opens one and marks progress/status
// on the detail page — only then does it get saved into state.items so it can
// still be ticked/tracked offline afterwards.
// Depends on globals from app.js/metadata.js: state, saveData(), CATEGORIES,
// getOrderedCategories(), builtinSourceEnabled(), thumbnailOrPlaceholder().

let discoverResults = [];
let discoverCategory = null;
let discoverRequestId = 0;
let howLongToBeatToken = null;

async function fetchTextPortable(url, init = {}) {
  const directFetch = window.cuemarkNativeFetch || fetch.bind(window);
  const candidates = [url];
  if (window.location?.origin && window.location.origin !== "null") {
    const proxy = new URL("/proxy", window.location.origin);
    proxy.searchParams.set("url", url);
    candidates.push(proxy.toString());
  } else if (window.location?.protocol === "file:") {
    const proxy = new URL("http://127.0.0.1:3000/proxy");
    proxy.searchParams.set("url", url);
    candidates.push(proxy.toString());
  }
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const response = await directFetch(candidate, { ...init, headers: { Accept: "text/html,application/xhtml+xml", ...(init.headers || {}) } });
      if (response.ok) return response.text();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error("Network request failed");
}

// Per-category source filter — a narrower scope on top of the permanent
// Settings → Metadata Sources enable/disable list, saved with the rest of
// state.preferences so it survives app restarts. Keyed by category so
// switching categories doesn't lose which sources were deselected for each
// one. Absence of a category's key means "all enabled sources".
function getDiscoverSourceFilter() {
  normalizeMetadataSources();
  return state.preferences.metadataSources.discoverSourceFilter;
}

function saveDiscoverSessionState(category, query) {
  try {
    sessionStorage.setItem("cuemark_discover_state", JSON.stringify({ category, query }));
  } catch (e) { /* sessionStorage unavailable — non-fatal */ }
}

function loadDiscoverSessionState() {
  try {
    return JSON.parse(sessionStorage.getItem("cuemark_discover_state") || "null") || {};
  } catch (e) {
    return {};
  }
}

function discoverIsOnline() {
  return typeof cueMarkIsOffline !== "function" || !cueMarkIsOffline();
}

function getNativeHttpPlugin() {
  return window.CapacitorHttp
    || window.Capacitor?.Plugins?.Http
    || window.Capacitor?.Plugins?.CapacitorHttp
    || null;
}

async function fetchJsonPortable(url, init = {}) {
  let lastError = null;
  const nativeHttp = getNativeHttpPlugin();
  const directFetch = window.cuemarkNativeFetch || fetch.bind(window);
  const proxyUrls = [];
  if (typeof window !== "undefined" && window.location?.protocol !== "file:" && window.location?.origin && window.location.origin !== "null") {
    const proxyUrl = new URL("/proxy", window.location.origin);
    proxyUrl.searchParams.set("url", url);
    proxyUrls.push(proxyUrl.toString());
  } else if (typeof window !== "undefined" && window.location?.protocol === "file:") {
    const proxyUrl = new URL("http://127.0.0.1:3000/proxy");
    proxyUrl.searchParams.set("url", url);
    proxyUrls.push(proxyUrl.toString());
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    if (nativeHttp) {
      try {
        const response = nativeHttp.get && (init.method || "GET").toUpperCase() === "GET"
          ? await nativeHttp.get({ url, headers: init.headers || {} })
          : await nativeHttp.request({
              url,
              method: init.method || "GET",
              headers: init.headers || {},
              data: init.body || null,
              responseType: "json"
            });
        const payload = parsePortableJson(response?.data);
        const status = Number(response?.status || 0);
        if (!status || status < 400) return payload;
        lastError = new Error(`HTTP ${status}`);
        lastError.status = status;
      } catch (error) {
        lastError = error;
      }
    }

    try {
      const response = await directFetch(url, init);
      if (response.ok) return await response.json();
      lastError = new Error(`HTTP ${response.status}`);
      lastError.status = response.status;
    } catch (error) {
      lastError = error;
    }

    if (!lastError?.status || lastError.status === 403 || lastError.status === 429 || lastError.status >= 500) {
      for (const proxyUrl of proxyUrls) {
        try {
          const response = await directFetch(proxyUrl, init);
          if (response.ok) return await response.json();
          const proxyError = new Error(`Proxy HTTP ${response.status}`);
          proxyError.status = response.status;
          if (!lastError?.status || lastError.name === "TypeError") lastError = proxyError;
        } catch (error) {
          if (!lastError || lastError.name === "TypeError") {
            lastError = new Error(`Proxy request failed: ${error?.message || "network request failed"}`);
          }
        }
      }
    }

    const retryable = !lastError?.status || lastError.status === 429 || lastError.status >= 500;
    if (!retryable || attempt === 2) throw lastError || new Error("Network request failed");
    await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
  }
  throw lastError || new Error("Network request failed");
}

async function searchSteamDb(query) {
  const data = await fetchJsonPortable(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(query)}&l=english&cc=us`);
  return (data?.items || []).slice(0, 25).map(game => ({
    source: "steamdb",
    category: "game",
    id: `app:${game.id}`,
    title: game.name || "Untitled",
    subtitle: [game.type, game.price?.final_formatted].filter(Boolean).join(" · "),
    thumbnail: game.tiny_image || "",
    rating: null
  }));
}

function howLongToBeatPayload(terms, token, page = 1, size = 15) {
  const options = {
    games: { userId: 0, platform: "", sortCategory: "popular", rangeCategory: "main", rangeTime: { min: null, max: null }, gameplay: { perspective: "", flow: "", genre: "", difficulty: "" }, rangeYear: { min: "", max: "" }, modifier: "" },
    users: { sortCategory: "postcount" }, lists: { sortCategory: "follows" }, filter: "", sort: 0, randomizer: 0
  };
  const payload = { searchType: "games", searchTerms: terms.trim().split(/\s+/).filter(Boolean), searchPage: page, size, searchOptions: options, useCache: true };
  if (token.hpKey && token.hpVal != null) payload[token.hpKey] = token.hpVal;
  return payload;
}

async function fetchHowLongToBeatJson(url, init = {}) {
  // Use the same server-side request path for token minting and search so the
  // provider sees one User-Agent fingerprint for both requests.
  const proxyUrl = window.location?.protocol === "file:"
    ? "http://127.0.0.1:3000/proxy"
    : window.location?.origin && window.location.origin !== "null" ? new URL("/proxy", window.location.origin).toString() : "";
  if (proxyUrl) {
    const target = new URL(proxyUrl);
    target.searchParams.set("url", url);
    try {
      const response = await (window.cuemarkNativeFetch || fetch.bind(window))(target.toString(), init);
      if (response.ok) return response.json();
      if (response.status !== 404 && response.status !== 405) {
        console.warn(`HowLongToBeat proxy returned HTTP ${response.status}; retrying through the portable request path`);
      }
    } catch { /* Retry through the normal native/direct/proxy transport below. */ }
  }
  return fetchJsonPortable(url, init);
}

async function fetchHowLongToBeatToken() {
  if (howLongToBeatToken && Date.now() - howLongToBeatToken.fetchedAt < 10 * 60 * 1000) return howLongToBeatToken;
  const token = await fetchHowLongToBeatJson(`https://howlongtobeat.com/api/search/site/init?t=${Date.now()}`, { headers: { Accept: "application/json", Referer: "https://howlongtobeat.com/" } });
  if (!token?.token) throw new Error("HowLongToBeat session unavailable");
  howLongToBeatToken = { ...token, fetchedAt: Date.now() };
  return howLongToBeatToken;
}

function hltbHours(seconds) {
  const value = Number(seconds);
  return value > 0 ? Math.round(value / 360) / 10 : null;
}

function howLongToBeatResult(game) {
  return {
    source: "howlongtobeat", category: "game", id: String(game.game_id), title: game.game_name || "Untitled",
    subtitle: [game.release_world, game.comp_main ? `${hltbHours(game.comp_main)}h main` : "", game.comp_plus ? `${hltbHours(game.comp_plus)}h +extras` : ""].filter(Boolean).join(" · "),
    thumbnail: game.game_image ? `https://howlongtobeat.com/games/${game.game_image}` : "",
    rating: Number(game.review_score) ? Number(game.review_score) / 10 : null,
    howLongToBeat: { main: hltbHours(game.comp_main), mainPlus: hltbHours(game.comp_plus), completionist: hltbHours(game.comp_100), platforms: game.profile_platform || "", type: game.game_type || "game" }
  };
}

async function searchHowLongToBeat(query) {
  const token = await fetchHowLongToBeatToken();
  const headers = { Accept: "application/json", "Content-Type": "application/json", Origin: "https://howlongtobeat.com", Referer: "https://howlongtobeat.com/", "x-auth-token": token.token };
  if (token.hpKey && token.hpVal != null) {
    headers["x-hp-key"] = token.hpKey;
    headers["x-hp-val"] = token.hpVal;
  }
  const json = await fetchHowLongToBeatJson("https://howlongtobeat.com/api/search/site", { method: "POST", headers, body: JSON.stringify(howLongToBeatPayload(query, token)) });
  return (Array.isArray(json?.data) ? json.data : []).filter(game => game.game_type === "game").map(howLongToBeatResult);
}

function howLongToReadResult(book) {
  return {
    source: "howlongtoread", category: book.category || "novel", id: book.url || String(book.id), title: book.title,
    subtitle: [book.author, book.readingTime].filter(Boolean).join(" · "), thumbnail: book.thumbnail || "", rating: null,
    howLongToRead: { author: book.author || "", readingTime: book.readingTime || "", pages: book.pages || "", words: book.words || "" }, url: book.url
  };
}

function extractHowLongToReadResults(html, query, category = "novel") {
  const results = [];
  const seen = new Set();
  const pattern = /href=["'](\/books\/(\d+)(?:\/[^"']*)?)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(html || ""))) {
    const id = match[2];
    if (seen.has(id)) continue;
    const title = match[3].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!title || title.length < 2 || /^(image|read more|details)$/i.test(title)) continue;
    seen.add(id);
    results.push(howLongToReadResult({ id, title, category, url: `https://howlongtoread.com${match[1]}` }));
  }
  return results.slice(0, 25);
}

async function searchHowLongToRead(query, category = "novel", allowCatalogFallback = false) {
  const encoded = encodeURIComponent(query.trim());
  let lastError = null;
  for (const url of [`https://howlongtoread.com/search?q=${encoded}`, `https://howlongtoread.com/search?query=${encoded}`, `https://howlongtoread.com/?q=${encoded}`]) {
    try {
      const html = await fetchTextPortable(url);
      const results = extractHowLongToReadResults(html, query, category);
      if (results.length) return results;
      if (/enable javascript to run this app/i.test(html)) {
        lastError = new Error("HowLongToRead search requires its interactive site and returned no server-rendered results");
      }
    } catch (error) { lastError = error; }
  }
  if (allowCatalogFallback) {
    const fallback = await searchGoogleBooks(query, category);
    return fallback.map(result => ({
      ...result,
      subtitle: ["Reading time unavailable", result.subtitle].filter(Boolean).join(" · ")
    }));
  }
  if (lastError) throw lastError;
  return [];
}

function vizResult(item) {
  return {
    source: "viz", category: "manga", id: item.url, title: item.title,
    subtitle: item.subtitle || "Manga", thumbnail: item.thumbnail || "", rating: null, url: item.url
  };
}

function extractVizResults(html) {
  const results = [], seen = new Set();
  const pattern = /href=["'](https?:\/\/www\.viz\.com)?(\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(html || ""))) {
    const path = match[2];
    if (!/(^\/[^/]+$|\/manga-books\/manga\/)/i.test(path) || /\/search|\/login|\/home|\/subscribe/i.test(path)) continue;
    const title = match[3].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!title || title.length < 2 || seen.has(path)) continue;
    seen.add(path);
    results.push(vizResult({ url: `https://www.viz.com${path}`, title, subtitle: "Manga" }));
  }
  return results.slice(0, 30);
}

async function searchViz(query) {
  return extractVizResults(await fetchTextPortable(`https://www.viz.com/search?search=${encodeURIComponent(query.trim())}`));
}

function parsePortableJson(value) {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// Best-effort category detection from a TVmaze show's language/genres, since
// TVmaze itself has no first-class "anime"/"kdrama"/"cdrama" field.
function detectTvmazeCategory(show) {
  const genres = (show.genres || []).map(g => g.toLowerCase());
  const language = (show.language || "").toLowerCase();
  const country = (show.network?.country?.code || show.webChannel?.country?.code || "").toUpperCase();

  if (genres.includes("anime") || (language === "japanese" && show.type === "Animation")) {
    return "anime";
  }
  if (language === "korean" || country === "KR") return "kdrama";
  if (language === "mandarin" || language === "chinese" || country === "CN" || country === "TW") return "cdrama";
  return "series";
}

const OPEN_LIBRARY_SUBJECT = { manga: "manga", novel: "fiction" };
const EPISODE_CATEGORIES_DISCOVER = ["series", "kdrama", "cdrama", "anime"];
const BOOK_CATEGORIES_DISCOVER = ["manga", "novel"];

function rawgKey() {
  return window.CUEMARK_LOCAL_API_KEYS?.rawg
    || state.preferences.metadataSources.builtinApiKeys?.rawg
    || "";
}
function omdbKey() { return state.preferences.metadataSources.builtinApiKeys?.omdb || ""; }
function tmdbKey() { return state.preferences.metadataSources.builtinApiKeys?.tmdb || ""; }
function rawgAvailable() { return builtinSourceEnabled("rawg") && Boolean(rawgKey()); }
function omdbAvailable() { return builtinSourceEnabled("omdb") && Boolean(omdbKey()); }
function tmdbAvailable() { return builtinSourceEnabled("tmdb") && Boolean(tmdbKey()); }

// Each category maps to a list of {key, suggest, search} providers. `key` must
// match a BUILTIN_METADATA_SOURCES id (metadata.js) so enable/disable + API
// key state stay in one place. `suggest()` returns top-rated picks with no
// query; `search(query)` scopes to typed text. Both return normalized
// {source, category, id, title, subtitle, thumbnail, rating} objects.
function getDiscoverProviders(category) {
  const providers = [];

  if ((category === "novel" || category === "manga") && builtinSourceEnabled("howlongtoread")) {
    providers.push({ key: "howlongtoread", suggest: () => Promise.resolve([]), search: query => searchHowLongToRead(query, category) });
  }
  if (category === "manga" && builtinSourceEnabled("viz")) {
    providers.push({ key: "viz", suggest: () => Promise.resolve([]), search: searchViz });
  }

  if (category === "game" && builtinSourceEnabled("freetogame")) {
    providers.push({ key: "freetogame", suggest: fetchFreeToGameTopRated, search: searchFreeToGame });
  }

  if (EPISODE_CATEGORIES_DISCOVER.includes(category)) {
    if (builtinSourceEnabled("tvmaze")) {
      providers.push({
        key: "tvmaze",
        suggest: () => fetchTvmazeTopRated(category),
        search: (q) => searchTvmaze(q, category)
      });
    }
    if (builtinSourceEnabled("anilist")) {
      providers.push({
        key: "anilist",
        suggest: () => fetchAnilistTopRated("ANIME"),
        search: (q) => searchAnilist(q, "ANIME", category)
      });
    }
    if (category === "anime") {
      if (builtinSourceEnabled("jikan")) {
        providers.push({ key: "jikan", suggest: () => fetchJikanTopRated("anime"), search: (q) => searchJikan(q, "anime") });
      }
      if (builtinSourceEnabled("kitsu")) {
        providers.push({ key: "kitsu", suggest: () => fetchKitsuTopRated("anime"), search: (q) => searchKitsu(q, "anime") });
      }
    }
    if (omdbAvailable()) {
      providers.push({ key: "omdb", suggest: () => Promise.resolve([]), search: (q) => searchOmdb(q, category, "series") });
    }
    if (tmdbAvailable()) {
      providers.push({ key: "tmdb", suggest: () => fetchTmdbTopRated("tv", category), search: (q) => searchTmdb(q, "tv", category) });
    }
  }

  if (category === "movie") {
    if (builtinSourceEnabled("wikidata")) {
      providers.push({ key: "wikidata", suggest: fetchWikidataPopularMovies, search: searchWikidataMovies });
    }
    if (omdbAvailable()) {
      providers.push({ key: "omdb", suggest: () => Promise.resolve([]), search: (q) => searchOmdb(q, "movie", "movie") });
    }
    if (tmdbAvailable()) {
      providers.push({ key: "tmdb", suggest: () => fetchTmdbTopRated("movie", "movie"), search: (q) => searchTmdb(q, "movie", "movie") });
    }
  }

  if (BOOK_CATEGORIES_DISCOVER.includes(category)) {
    if (builtinSourceEnabled("openlibrary")) {
      providers.push({
        key: "openlibrary",
        suggest: () => fetchOpenLibraryTopRated(category),
        search: (q) => searchOpenLibrary(q, category)
      });
    }
    if (builtinSourceEnabled("googlebooks")) {
      providers.push({ key: "googlebooks", suggest: () => Promise.resolve([]), search: (q) => searchGoogleBooks(q, category) });
    }
    if (category === "manga" && builtinSourceEnabled("mangadex")) {
      providers.push({ key: "mangadex", suggest: () => Promise.resolve([]), search: searchMangaDex });
    }
    if (category === "manga") {
      if (builtinSourceEnabled("anilist")) {
        providers.push({ key: "anilist", suggest: () => fetchAnilistTopRated("MANGA"), search: (q) => searchAnilist(q, "MANGA", "manga") });
      }
      if (builtinSourceEnabled("jikan")) {
        providers.push({ key: "jikan", suggest: () => fetchJikanTopRated("manga"), search: (q) => searchJikan(q, "manga") });
      }
      if (builtinSourceEnabled("kitsu")) {
        providers.push({ key: "kitsu", suggest: () => fetchKitsuTopRated("manga"), search: (q) => searchKitsu(q, "manga") });
      }
    }
  }

  if (category === "game") {
    if (builtinSourceEnabled("steamdb")) {
      providers.push({ key: "steamdb", suggest: () => Promise.resolve([]), search: searchSteamDb });
    }
    if (builtinSourceEnabled("howlongtobeat")) {
      providers.push({ key: "howlongtobeat", suggest: () => Promise.resolve([]), search: searchHowLongToBeat });
    }
    if (rawgAvailable()) {
      providers.push({ key: "rawg", suggest: fetchRawgTopRated, search: searchRawg });
    }
    if (builtinSourceEnabled("wikidata")) {
      providers.push({ key: "wikidata", suggest: () => Promise.resolve([]), search: searchWikidataGames });
    }
  }

  if (category === "anime" || category === "manga") {
  }

  const filter = getDiscoverSourceFilter();
  const selected = filter[category];
  if (Array.isArray(selected)) {
    return providers.filter(p => selected.includes(p.key));
  }
  return providers;
}

// All providers that could possibly serve this category, ignoring the saved
// filter — used to populate the filter sheet's checkbox list (so a source the
// user just deselected still shows up to be re-selected later).
function getAllDiscoverProviderKeysForCategory(category) {
  const filter = getDiscoverSourceFilter();
  const selected = filter[category];
  filter[category] = null;
  const keys = getDiscoverProviders(category).map(p => p.key);
  if (selected != null) filter[category] = selected;
  else delete filter[category];
  return [...new Set(keys)];
}

function updateDiscoverOnlineNotice() {
  const notice = document.getElementById("discover-offline-notice");
  const searchInput = document.getElementById("discover-search-input");
  if (!notice) return;
  const online = discoverIsOnline();
  notice.style.display = online ? "none" : "block";
  if (searchInput) searchInput.disabled = !online;
}

// Kdrama/Cdrama are dashboard-only tracking categories in Discover — TVmaze
// (their main source) has no first-class distinction for them, so searching
// "Series" already surfaces them (see tvmazeCategoryMatches) without a
// separate chip that would just duplicate the same TV-series search.
const DISCOVER_HIDDEN_CATEGORIES = ["kdrama", "cdrama"];

function renderDiscoverCategoryChips() {
  const chipsEl = document.getElementById("discover-category-chips");
  if (!chipsEl) return;

  const enabledCategories = getEnabledOrderedCategories().filter(cat => !DISCOVER_HIDDEN_CATEGORIES.includes(cat));
  if (enabledCategories.length === 0) {
    chipsEl.style.display = "none";
    chipsEl.innerHTML = "";
    setDiscoverCategory(null);
    return;
  }

  const savedState = loadDiscoverSessionState();
  const preferredCategory = discoverCategory || savedState.category;
  const nextCategory = (preferredCategory && enabledCategories.includes(preferredCategory))
    ? preferredCategory
    : enabledCategories[0];

  chipsEl.style.display = "flex";
  chipsEl.innerHTML = enabledCategories.map(cat => `
    <div class="chip${nextCategory === cat ? " active" : ""}" data-category="${cat}" style="--theme-color:${CATEGORIES[cat].color}">
      <i data-lucide="${CATEGORIES[cat].icon}"></i> ${CATEGORIES[cat].label}
    </div>
  `).join("") + `
    <a class="chip" href="static/pages/main/sources.html" title="Browse individual metadata sources">
      <i data-lucide="database"></i> Sources
    </a>
  `;

  chipsEl.querySelectorAll(".chip[data-category]").forEach(chip => {
    chip.addEventListener("click", () => setDiscoverCategory(chip.dataset.category));
  });

  if (window.lucide) lucide.createIcons();

  const preservedQuery = (preferredCategory === nextCategory) ? (savedState.query || "") : "";
  setDiscoverCategory(nextCategory, preservedQuery);
}

function setDiscoverCategory(category, preservedQuery = "") {
  discoverCategory = category;
  saveDiscoverSessionState(category, preservedQuery);
  document.querySelectorAll("#discover-category-chips .chip").forEach(chip => {
    chip.classList.toggle("active", chip.dataset.category === category);
  });

  const searchInput = document.getElementById("discover-search-input");
  const gameNotice = document.getElementById("discover-game-unavailable");
  const noCategoryNotice = document.getElementById("discover-no-category");

  if (!category) {
    if (searchInput) searchInput.style.display = "none";
    if (noCategoryNotice) noCategoryNotice.style.display = "flex";
    if (gameNotice) gameNotice.style.display = "none";
    clearDiscoverResults();
    return;
  }
  if (noCategoryNotice) noCategoryNotice.style.display = "none";

  const allKeys = getAllDiscoverProviderKeysForCategory(category);
  const filterBtn = document.getElementById("discover-filter-btn");
  if (allKeys.length === 0) {
    if (searchInput) searchInput.style.display = "none";
    if (gameNotice) gameNotice.style.display = "flex";
    if (filterBtn) filterBtn.style.display = "none";
    clearDiscoverResults();
    return;
  }
  if (gameNotice) gameNotice.style.display = "none";
  if (searchInput) {
    searchInput.style.display = "block";
    searchInput.value = preservedQuery;
    searchInput.placeholder = `Search ${CATEGORIES[category].label.toLowerCase()}...`;
  }
  if (filterBtn) {
    filterBtn.style.display = "flex";
    updateDiscoverFilterButtonState();
  }

  const providers = getDiscoverProviders(category);
  if (providers.length === 0) {
    clearDiscoverResults();
    const emptyEl = document.getElementById("discover-empty");
    if (emptyEl) {
      emptyEl.style.display = "flex";
      emptyEl.querySelector("h3").textContent = "No Sources Selected";
      emptyEl.querySelector("p").textContent = "Use the filter button to enable at least one source for this category.";
    }
    return;
  }

  if (preservedQuery) {
    runDiscoverSearch(preservedQuery);
  } else {
    loadDiscoverSuggestions(category);
  }
}

function updateDiscoverFilterButtonState() {
  const filterBtn = document.getElementById("discover-filter-btn");
  if (!filterBtn || !discoverCategory) return;
  const allKeys = getAllDiscoverProviderKeysForCategory(discoverCategory);
  const selected = getDiscoverSourceFilter()[discoverCategory];
  const isNarrowed = Array.isArray(selected) && selected.length < allKeys.length;
  filterBtn.classList.toggle("has-active-filter", isNarrowed);
}

function openDiscoverFilterModal() {
  if (!discoverCategory) return;
  const modal = document.getElementById("discover-filter-modal");
  const list = document.getElementById("discover-filter-source-list");
  if (!modal || !list) return;

  const allKeys = getAllDiscoverProviderKeysForCategory(discoverCategory);
  const selected = getDiscoverSourceFilter()[discoverCategory] || allKeys;

  list.innerHTML = allKeys.map(key => {
    const info = BUILTIN_METADATA_SOURCES[key];
    return `
    <label class="discover-filter-source-row">
      <span class="discover-filter-source-name"><i data-lucide="${info?.icon || "database"}"></i>${info?.name || key}</span>
      <label class="switch">
        <input type="checkbox" data-source-key="${key}" ${selected.includes(key) ? "checked" : ""}>
        <span class="slider"></span>
      </label>
    </label>
  `;
  }).join("");

  list.querySelectorAll("input[data-source-key]").forEach(input => {
    input.addEventListener("change", () => {
      const filter = getDiscoverSourceFilter();
      const currentAllKeys = getAllDiscoverProviderKeysForCategory(discoverCategory);
      const currentlySelected = new Set(filter[discoverCategory] || currentAllKeys);
      if (input.checked) currentlySelected.add(input.dataset.sourceKey);
      else currentlySelected.delete(input.dataset.sourceKey);
      filter[discoverCategory] = currentAllKeys.filter(k => currentlySelected.has(k));
      saveData();
      updateDiscoverFilterButtonState();
      runDiscoverSearch(document.getElementById("discover-search-input")?.value || "");
    });
  });

  if (window.lucide) lucide.createIcons();
  modal.classList.add("active");
}

function closeDiscoverFilterModal() {
  const modal = document.getElementById("discover-filter-modal");
  if (modal) modal.classList.remove("active");
}

function clearDiscoverResults() {
  discoverResults = [];
  const resultsEl = document.getElementById("discover-results");
  const emptyEl = document.getElementById("discover-empty");
  if (resultsEl) resultsEl.innerHTML = "";
  if (emptyEl) emptyEl.style.display = "none";
}

// Dedupe merged multi-source results by normalized title — different sources
// use different id schemes, so title is the only cheap common key.
function dedupeResults(results) {
  const seen = new Set();
  return results.filter(r => {
    const key = (r.title || "").trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Top-rated suggestions shown before the user types anything, merged across
// every enabled source for the category. None of these providers expose a
// real "trending" feed for free, so each uses the closest available proxy
// (own rating field, popularity score, or sitelink count for Wikidata).
async function loadDiscoverSuggestions(category) {
  if (!discoverIsOnline()) return;
  const resultsEl = document.getElementById("discover-results");
  const emptyEl = document.getElementById("discover-empty");
  if (!resultsEl || !emptyEl) return;

  const requestId = ++discoverRequestId;

  resultsEl.innerHTML = "";
  emptyEl.style.display = "flex";
  emptyEl.querySelector("h3").textContent = "Loading top picks…";
  emptyEl.querySelector("p").textContent = "";

  const providers = getDiscoverProviders(category);
  const perProvider = await Promise.all(providers.map(p =>
    p.suggest().catch(err => { console.warn(`${p.key} suggestions failed`, err); return []; })
  ));

  if (requestId !== discoverRequestId) return; // a newer category/search superseded this one
  discoverResults = dedupeResults(perProvider.flat()).slice(0, 15);
  renderDiscoverResults();
}

async function runDiscoverSearch(query) {
  if (!discoverCategory) return;
  const providers = getDiscoverProviders(discoverCategory);
  if (providers.length === 0) return;

  const trimmed = query.trim();
  if (!trimmed) {
    loadDiscoverSuggestions(discoverCategory);
    return;
  }
  if (!discoverIsOnline()) return;

  const requestId = ++discoverRequestId;
  const perProvider = await Promise.all(providers.map(p =>
    p.search(trimmed).catch(err => { console.warn(`${p.key} search failed`, err); return []; })
  ));

  if (requestId !== discoverRequestId) return; // a newer category/search superseded this one
  discoverResults = dedupeResults(perProvider.flat());
  renderDiscoverResults();
}

// ---- TVmaze ----
function tvmazeShowToResult(show, category) {
  return {
    source: "tvmaze",
    category,
    id: show.id,
    title: show.name,
    subtitle: [show.premiered ? show.premiered.slice(0, 4) : "", show.type || ""].filter(Boolean).join(" · "),
    thumbnail: show.image?.medium || show.image?.original || "",
    rating: show.rating?.average || null
  };
}

// "Series" is the only TV chip shown in Discover — Kdrama/Cdrama are
// dashboard-only tracking categories now, since TVmaze has no first-class
// distinction for them either. Searching "series" therefore accepts anything
// detected as series/kdrama/cdrama, but each result keeps its own detected
// category so the detail page still defaults status/progress fields
// correctly and the user can still see/change it to Kdrama or Cdrama there.
function tvmazeCategoryMatches(show, category) {
  const detected = detectTvmazeCategory(show);
  if (category === "series") return ["series", "kdrama", "cdrama"].includes(detected);
  return detected === category;
}

async function fetchTvmazeTopRated(category) {
  const res = await fetch("https://api.tvmaze.com/shows?page=1");
  if (!res.ok) return [];
  const shows = await res.json();
  return (Array.isArray(shows) ? shows : [])
    .filter(show => show.rating?.average && tvmazeCategoryMatches(show, category))
    .sort((a, b) => b.rating.average - a.rating.average)
    .slice(0, 15)
    .map(show => tvmazeShowToResult(show, detectTvmazeCategory(show)));
}

async function searchTvmaze(query, category) {
  const res = await fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query)}`);
  if (!res.ok) return [];
  const json = await res.json();
  return (Array.isArray(json) ? json : [])
    .map(entry => entry.show)
    .filter(show => show && tvmazeCategoryMatches(show, category))
    .map(show => tvmazeShowToResult(show, detectTvmazeCategory(show)));
}

// ---- Wikidata (movies + games) ----
// wbsearchentities never returns images, so results start thumbnail-less and
// get backfilled in one batched wbgetentities call (P18) afterward.
async function attachWikidataThumbnails(results) {
  const ids = results.map(r => r.id).filter(Boolean);
  if (ids.length === 0) return results;
  try {
    const res = await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids.join("|")}&format=json&props=claims&origin=*`);
    if (!res.ok) return results;
    const data = await res.json();
    return results.map(r => {
      const imageFile = data.entities?.[r.id]?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
      return imageFile ? { ...r, thumbnail: `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(imageFile)}` } : r;
    });
  } catch (err) {
    console.warn("Could not load Wikidata thumbnails", err);
    return results;
  }
}

async function fetchWikidataPopularMovies() {
  const query = `SELECT ?film ?filmLabel WHERE { ?film wdt:P31 wd:Q11424; wikibase:sitelinks ?sitelinks. FILTER(?sitelinks > 50) SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } ORDER BY DESC(?sitelinks) LIMIT 15`;
  const res = await fetch(`https://query.wikidata.org/sparql?query=${encodeURIComponent(query)}&format=json`, {
    headers: { Accept: "application/sparql-results+json" }
  });
  if (!res.ok) return [];
  const data = await res.json();
  const bindings = data?.results?.bindings || [];
  const results = bindings
    .map(b => {
      const uri = b.film?.value || "";
      const id = uri.split("/").pop();
      const label = b.filmLabel?.value || "";
      if (!id || !label || /^Q\d+$/.test(label)) return null;
      return { source: "wikidata", category: "movie", id, title: label, subtitle: "Movie", thumbnail: "", rating: null };
    })
    .filter(Boolean);
  return attachWikidataThumbnails(results);
}

async function searchWikidataMovies(query) {
  const res = await fetch(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(query)}&language=en&type=item&limit=15&format=json&origin=*`);
  if (!res.ok) return [];
  const json = await res.json();
  const results = (Array.isArray(json.search) ? json.search : []).map(entry => ({
    source: "wikidata", category: "movie", id: entry.id, title: entry.label || query,
    subtitle: entry.description || "Movie", thumbnail: "", rating: null
  }));
  return attachWikidataThumbnails(results);
}

async function searchWikidataGames(query) {
  const res = await fetch(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(query)}&language=en&type=item&limit=15&format=json&origin=*`);
  if (!res.ok) return [];
  const json = await res.json();
  const results = (Array.isArray(json.search) ? json.search : []).map(entry => ({
    source: "wikidata", category: "game", id: entry.id, title: entry.label || query,
    subtitle: entry.description || "Game", thumbnail: "", rating: null
  }));
  return attachWikidataThumbnails(results);
}

// ---- Open Library (manga + novel) ----
function openLibraryWorkToResult(doc, category) {
  const key = (doc.key || "").replace("/works/", "");
  if (!key) return null;
  return {
    source: "openlibrary",
    category,
    id: key,
    title: doc.title || "",
    subtitle: [doc.authors?.[0]?.name, doc.first_publish_year ? `First published ${doc.first_publish_year}` : ""].filter(Boolean).join(" · "),
    thumbnail: doc.cover_id ? `https://covers.openlibrary.org/b/id/${doc.cover_id}-M.jpg` : "",
    rating: null
  };
}

async function fetchOpenLibraryTopRated(category) {
  const subject = OPEN_LIBRARY_SUBJECT[category];
  const res = await fetch(`https://openlibrary.org/subjects/${subject}.json?limit=15&sort=rating`);
  if (!res.ok) return [];
  const data = await res.json();
  return (Array.isArray(data.works) ? data.works : []).map(w => openLibraryWorkToResult(w, category)).filter(Boolean);
}

async function searchOpenLibrary(query, category) {
  const json = await fetchJsonPortable(`https://openlibrary.org/search.json?title=${encodeURIComponent(query)}&fields=key,title,author_name,first_publish_year,cover_i&limit=15`);
  return (Array.isArray(json.docs) ? json.docs : []).slice(0, 15).map(doc => {
    const key = (doc.key || "").replace("/works/", "");
    if (!key) return null;
    return {
      source: "openlibrary", category, id: key, title: doc.title || query,
      subtitle: [doc.author_name?.[0], doc.first_publish_year ? `First published ${doc.first_publish_year}` : ""].filter(Boolean).join(" · "),
      thumbnail: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : "",
      rating: null
    };
  }).filter(Boolean);
}

// ---- Google Books (novel + manga) ----
async function searchGoogleBooks(query, category) {
  let json;
  try {
    json = await fetchJsonPortable(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=15`);
  } catch (error) {
    if (error?.status !== 429 && !/\b429\b|rate.?limit/i.test(String(error?.message || error))) throw error;
    const fallback = await searchOpenLibrary(query, category);
    return fallback.map(result => ({ ...result, subtitle: ["Google Books rate limited · Open Library fallback", result.subtitle].filter(Boolean).join(" · ") }));
  }
  return (Array.isArray(json.items) ? json.items : []).map(item => {
    const info = item.volumeInfo || {};
    return {
      source: "googlebooks",
      category,
      id: item.id,
      title: info.title || query,
      subtitle: [info.authors?.[0], info.publishedDate ? info.publishedDate.slice(0, 4) : ""].filter(Boolean).join(" · "),
      thumbnail: (info.imageLinks?.thumbnail || "").replace("http://", "https://"),
      rating: info.averageRating || null
    };
  });
}

// ---- RAWG (games) ----
function rawgGameToResult(entry) {
  return {
    source: "rawg",
    category: "game",
    id: entry.id,
    title: entry.name || "",
    subtitle: [entry.released ? entry.released.slice(0, 4) : "", entry.rating ? `★ ${entry.rating}` : ""].filter(Boolean).join(" · "),
    thumbnail: entry.background_image || "",
    rating: entry.rating || null
  };
}

async function fetchRawgTopRated() {
  const res = await fetch(`https://api.rawg.io/api/games?key=${encodeURIComponent(rawgKey())}&ordering=-rating&page_size=15`);
  if (!res.ok) return [];
  const data = await res.json();
  return (Array.isArray(data.results) ? data.results : []).map(rawgGameToResult);
}

async function searchRawg(query) {
  const res = await fetch(`https://api.rawg.io/api/games?key=${encodeURIComponent(rawgKey())}&search=${encodeURIComponent(query)}&page_size=15`);
  if (!res.ok) return [];
  const json = await res.json();
  return (Array.isArray(json.results) ? json.results : []).map(rawgGameToResult);
}

function freeToGameGameToResult(entry) {
  return {
    source: "freetogame",
    category: "game",
    id: entry.id,
    title: entry.title || "",
    subtitle: [entry.genre, entry.release_date || "", entry.developer || ""].filter(Boolean).join(" · "),
    thumbnail: entry.thumbnail || "",
    providerUrl: entry.freetogame_profile_url || "",
    rating: null
  };
}

async function fetchFreeToGameTopRated() {
  const json = await fetchJsonPortable("https://www.freetogame.com/api/games?sort-by=popularity");
  return (Array.isArray(json) ? json : []).slice(0, 15).map(freeToGameGameToResult);
}

async function searchFreeToGame(query) {
  const json = await fetchJsonPortable("https://www.freetogame.com/api/games");
  const q = query.trim().toLowerCase();
  return (Array.isArray(json) ? json : [])
    .filter(entry =>
      (entry.title || "").toLowerCase().includes(q) ||
      (entry.genre || "").toLowerCase().includes(q) ||
      (entry.developer || "").toLowerCase().includes(q)
    )
    .slice(0, 15)
    .map(freeToGameGameToResult);
}

function mangaDexMangaToResult(entry) {
  const attrs = entry.attributes || {};
  const titles = attrs.title || {};
  const title = titles.en || Object.values(titles)[0] || "";
  const coverRel = (entry.relationships || []).find(rel => rel.type === "cover_art");
  const coverId = coverRel?.attributes?.fileName || "";
  return {
    source: "mangadex",
    category: "manga",
    id: entry.id,
    title,
    subtitle: [attrs.year || "", attrs.status || ""].filter(Boolean).join(" · "),
    thumbnail: coverId ? `https://uploads.mangadex.org/covers/${entry.id}/${coverId}.256.jpg` : "",
    rating: null
  };
}

async function searchMangaDex(query) {
  const params = new URLSearchParams({
    title: query.trim(),
    limit: "15",
    "order[relevance]": "desc"
  });
  params.append("includes[]", "cover_art");
  const json = await fetchJsonPortable(`https://api.mangadex.org/manga?${params.toString()}`);
  const entries = Array.isArray(json?.data) ? json.data : (Array.isArray(json?.results) ? json.results : []);
  return entries.filter(entry => entry?.id).map(mangaDexMangaToResult);
}

async function fetchMangaDexTopRated() {
  const params = new URLSearchParams({ limit: "15", "order[followedCount]": "desc" });
  params.append("includes[]", "cover_art");
  params.append("contentRating[]", "safe");
  params.append("availableTranslatedLanguage[]", "en");
  const json = await fetchJsonPortable(`https://api.mangadex.org/manga?${params.toString()}`);
  const entries = Array.isArray(json?.data) ? json.data : [];
  return entries.filter(entry => entry?.id).map(mangaDexMangaToResult);
}

// ---- AniList (anime + manga; also used as a supplemental source for
// series/kdrama/cdrama since it covers a lot of Asian drama/animation too) ----
async function anilistQuery(query, variables) {
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables })
  });
  if (!res.ok) return null;
  return res.json();
}

function anilistMediaToResult(media, category) {
  return {
    source: "anilist",
    category,
    id: media.id,
    title: media.title?.english || media.title?.romaji || "",
    subtitle: [media.startDate?.year, media.averageScore ? `★ ${(media.averageScore / 10).toFixed(1)}` : ""].filter(Boolean).join(" · "),
    thumbnail: media.coverImage?.large || media.coverImage?.medium || "",
    rating: media.averageScore ? media.averageScore / 10 : null
  };
}

async function fetchAnilistTopRated(type) {
  const query = `query($type:MediaType){Page(perPage:15){media(type:$type,sort:SCORE_DESC){id title{romaji english} coverImage{large medium} averageScore startDate{year}}}}`;
  const data = await anilistQuery(query, { type });
  const media = data?.data?.Page?.media || [];
  return media.map(m => anilistMediaToResult(m, type === "ANIME" ? "anime" : "manga"));
}

async function searchAnilist(searchTerm, type, category) {
  const query = `query($s:String,$type:MediaType){Page(perPage:15){media(search:$s,type:$type){id title{romaji english} coverImage{large medium} averageScore startDate{year}}}}`;
  const data = await anilistQuery(query, { s: searchTerm, type });
  const media = data?.data?.Page?.media || [];
  return media.map(m => anilistMediaToResult(m, category));
}

// ---- Jikan (MyAnimeList wrapper; anime + manga) ----
async function fetchJikanJson(url) {
  const directFetch = window.cuemarkNativeFetch || fetch.bind(window);
  const proxyUrl = window.location?.protocol === "file:"
    ? "http://127.0.0.1:3000/proxy"
    : window.location?.origin && window.location.origin !== "null" ? new URL("/proxy", window.location.origin).toString() : "";
  if (proxyUrl) {
    const target = new URL(proxyUrl);
    target.searchParams.set("url", url);
    const proxyController = new AbortController();
    const proxyTimeout = setTimeout(() => proxyController.abort(), 8000);
    try {
      const response = await directFetch(target.toString(), { headers: { Accept: "application/json" }, signal: proxyController.signal });
      if (response.ok) return await response.json();
      if (response.status === 429) throw new Error("Jikan HTTP 429");
    } catch (error) {
      if (error?.message === "Jikan HTTP 429") throw error;
    } finally {
      clearTimeout(proxyTimeout);
    }
  }
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 25000);
  try {
    const response = await directFetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
    if (!response.ok) throw new Error(`Jikan HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (timedOut) throw new Error("Jikan request timed out after 25 seconds");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function jikanEntryToResult(entry, category) {
  return {
    source: "jikan",
    category,
    id: entry.mal_id,
    title: entry.title || "",
    subtitle: [(entry.aired?.from || entry.published?.from || "").slice(0, 4), entry.score ? `★ ${entry.score}` : ""].filter(Boolean).join(" · "),
    thumbnail: entry.images?.jpg?.image_url || "",
    rating: entry.score || null
  };
}

async function fetchJikanTopRated(kind) {
  const json = await fetchJikanJson(`https://api.jikan.moe/v4/top/${kind}?limit=15`);
  return (Array.isArray(json.data) ? json.data : []).map(e => jikanEntryToResult(e, kind === "anime" ? "anime" : "manga"));
}

async function searchJikan(query, kind) {
  const json = await fetchJikanJson(`https://api.jikan.moe/v4/${kind}?q=${encodeURIComponent(query)}&limit=15`);
  return (Array.isArray(json.data) ? json.data : []).map(e => jikanEntryToResult(e, kind === "anime" ? "anime" : "manga"));
}

// ---- Kitsu (anime + manga) ----
function kitsuEntryToResult(entry, category) {
  const attrs = entry.attributes || {};
  const posterImage = attrs.posterImage || {};
  return {
    source: "kitsu",
    category,
    id: entry.id,
    title: attrs.canonicalTitle || attrs.titles?.en || attrs.titles?.en_jp || "",
    subtitle: [attrs.startDate ? attrs.startDate.slice(0, 4) : "", attrs.averageRating ? `★ ${(attrs.averageRating / 10).toFixed(1)}` : ""].filter(Boolean).join(" · "),
    thumbnail: posterImage.small || posterImage.medium || "",
    rating: attrs.averageRating ? attrs.averageRating / 10 : null
  };
}

async function fetchKitsuTopRated(kind) {
  const res = await fetch(`https://kitsu.io/api/edge/${kind}?sort=-averageRating&page[limit]=15`, { headers: { Accept: "application/vnd.api+json" } });
  if (!res.ok) return [];
  const json = await res.json();
  return (Array.isArray(json.data) ? json.data : []).map(e => kitsuEntryToResult(e, kind === "anime" ? "anime" : "manga"));
}

async function searchKitsu(query, kind) {
  const res = await fetch(`https://kitsu.io/api/edge/${kind}?filter[text]=${encodeURIComponent(query)}&page[limit]=15`, { headers: { Accept: "application/vnd.api+json" } });
  if (!res.ok) return [];
  const json = await res.json();
  return (Array.isArray(json.data) ? json.data : []).map(e => kitsuEntryToResult(e, kind === "anime" ? "anime" : "manga"));
}

// ---- OMDb (movies + series; search-only, no keyless "top rated" endpoint) ----
async function searchOmdb(query, category, omdbType) {
  const res = await fetch(`https://www.omdbapi.com/?s=${encodeURIComponent(query)}&type=${omdbType}&apikey=${encodeURIComponent(omdbKey())}`);
  if (!res.ok) return [];
  const json = await res.json();
  if (json.Response === "False" || !Array.isArray(json.Search)) return [];
  return json.Search.map(entry => ({
    source: "omdb",
    category,
    id: entry.imdbID,
    title: entry.Title || query,
    subtitle: entry.Year || "",
    thumbnail: entry.Poster && entry.Poster !== "N/A" ? entry.Poster : "",
    rating: null
  }));
}

// ---- TMDB (movies + series; richest data, needs a free API key) ----
async function tmdbFetch(path) {
  const res = await fetch(`https://api.themoviedb.org/3${path}${path.includes("?") ? "&" : "?"}api_key=${encodeURIComponent(tmdbKey())}`);
  if (!res.ok) return null;
  return res.json();
}

function tmdbEntryToResult(entry, mediaType, category) {
  const title = mediaType === "tv" ? entry.name : entry.title;
  const date = mediaType === "tv" ? entry.first_air_date : entry.release_date;
  return {
    source: "tmdb",
    category,
    id: entry.id,
    title: title || "",
    subtitle: [date ? date.slice(0, 4) : "", entry.vote_average ? `★ ${entry.vote_average.toFixed(1)}` : ""].filter(Boolean).join(" · "),
    thumbnail: entry.poster_path ? `https://image.tmdb.org/t/p/w342${entry.poster_path}` : "",
    rating: entry.vote_average || null
  };
}

async function fetchTmdbTopRated(mediaType, category) {
  const data = await tmdbFetch(`/${mediaType}/top_rated`);
  const results = data?.results || [];
  return results.slice(0, 15).map(e => tmdbEntryToResult(e, mediaType, category));
}

async function searchTmdb(query, mediaType, category) {
  const data = await tmdbFetch(`/search/${mediaType}?query=${encodeURIComponent(query)}`);
  const results = data?.results || [];
  return results.slice(0, 15).map(e => tmdbEntryToResult(e, mediaType, category));
}

function renderDiscoverResults() {
  const resultsEl = document.getElementById("discover-results");
  const emptyEl = document.getElementById("discover-empty");
  if (!resultsEl || !emptyEl) return;

  if (discoverResults.length === 0) {
    resultsEl.innerHTML = "";
    emptyEl.style.display = "flex";
    emptyEl.querySelector("h3").textContent = "No Results";
    emptyEl.querySelector("p").textContent = "Try a different title or check your spelling.";
    return;
  }

  emptyEl.style.display = "none";
  resultsEl.innerHTML = discoverResults.map((r, index) => `
    <button type="button" class="discover-result-card" data-index="${index}">
      ${thumbnailOrPlaceholder(r.thumbnail, "discover-result-thumb")}
      <div class="discover-result-body">
        <span class="discover-result-title">${r.title}</span>
        <span class="discover-result-subtitle">${r.subtitle || ""}</span>
        <span class="discover-result-badges">
          ${r.rating ? `<span class="discover-result-rating"><i data-lucide="star"></i> ${r.rating}</span>` : ""}
          <span class="discover-result-source">${BUILTIN_METADATA_SOURCES[r.source]?.name || r.source}</span>
        </span>
      </div>
    </button>
  `).join("");

  resultsEl.querySelectorAll(".discover-result-card").forEach(card => {
    card.addEventListener("click", () => {
      const result = discoverResults[parseInt(card.dataset.index, 10)];
      if (!result) return;
      const params = new URLSearchParams({
        source: "online",
        provider: result.source,
        providerId: result.id,
        category: result.category,
        title: result.title
      });
      if (result.source === "freetogame" && result.providerUrl) params.set("providerUrl", result.providerUrl);
      window.location.href = `static/pages/main/show-detail.html?${params.toString()}`;
    });
  });

  if (window.lucide) lucide.createIcons();
}

document.addEventListener("DOMContentLoaded", () => {
  updateDiscoverOnlineNotice();
  window.addEventListener("online", updateDiscoverOnlineNotice);
  window.addEventListener("offline", updateDiscoverOnlineNotice);

  renderDiscoverCategoryChips();

  const searchInput = document.getElementById("discover-search-input");
  if (searchInput) {
    let debounceTimer = null;
    searchInput.addEventListener("input", (e) => {
      saveDiscoverSessionState(discoverCategory, e.target.value);
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => runDiscoverSearch(e.target.value), 400);
    });
  }

  const filterBtn = document.getElementById("discover-filter-btn");
  if (filterBtn) filterBtn.addEventListener("click", openDiscoverFilterModal);

  const filterModal = document.getElementById("discover-filter-modal");
  const filterModalClose = document.getElementById("discover-filter-modal-close");
  if (filterModalClose) filterModalClose.addEventListener("click", closeDiscoverFilterModal);
  if (filterModal) {
    filterModal.addEventListener("click", (e) => {
      if (e.target === filterModal) closeDiscoverFilterModal();
    });
  }

  const selectAllBtn = document.getElementById("discover-filter-select-all");
  const selectNoneBtn = document.getElementById("discover-filter-select-none");
  if (selectAllBtn) {
    selectAllBtn.addEventListener("click", () => {
      if (!discoverCategory) return;
      delete getDiscoverSourceFilter()[discoverCategory];
      saveData();
      openDiscoverFilterModal();
      updateDiscoverFilterButtonState();
      runDiscoverSearch(document.getElementById("discover-search-input")?.value || "");
    });
  }
  if (selectNoneBtn) {
    selectNoneBtn.addEventListener("click", () => {
      if (!discoverCategory) return;
      getDiscoverSourceFilter()[discoverCategory] = [];
      saveData();
      openDiscoverFilterModal();
      updateDiscoverFilterButtonState();
      runDiscoverSearch(document.getElementById("discover-search-input")?.value || "");
    });
  }

  if (window.lucide) lucide.createIcons();
});
