// CueMark - Show Details: shared detail page for both the Discover (online, not
// yet tracked) flow and the Dashboard (already-tracked local item) flow. Renders
// thumbnail/name/metadata, a season dropdown, and a per-episode list (thumbnail,
// name, air date, runtime, TVmaze rating, watched checkbox).
//
// Ticking any episode (or changing status) for an online result saves it into
// state.items immediately, so it and its progress remain available offline from
// then on. Depends on globals from app.js: state, CATEGORIES, saveData(),
// thumbnailOrPlaceholder(), EPISODE_TRACKED_CATEGORIES.

let showDetailState = {
  mode: null,       // "online" | "local"
  category: null,
  itemId: null,     // set once the item exists locally
  show: null,       // { title, thumbnail, meta, tvmazeShowId }
  episodes: [],     // flat list across all seasons
  seasons: [],      // sorted season numbers
  activeSeason: null,
  watchedEpisodeIds: [],
  episodeFilter: "all"
};



function buildSyntheticAnimeEpisodes(totalEpisodes, meta = {}) {
  const count = Math.max(0, parseInt(totalEpisodes) || 0);
  if (!count) return [];
  const summaryBase = meta.summary || meta.description || "";
  const runtime = meta.runtime || meta.episodeRuntime || null;
  const image = meta.thumbnail ? { medium: meta.thumbnail, original: meta.thumbnail } : null;
  const sourceLabel = meta.sourceLabel || "Anime";
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    season: 1,
    number: index + 1,
    name: `Episode ${index + 1}`,
    runtime,
    airdate: "",
    summary: summaryBase ? `${summaryBase}${count > 1 ? ` This is episode ${index + 1} of ${count}.` : ""}` : `Episode ${index + 1} of ${sourceLabel}.`,
    image,
    rating: null
  }));
}











function normalizeProviderTitle(value) {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}





















































function formatRuntimeHM(minutes) {
  const total = Math.round(minutes) || 0;
  if (!total) return "";
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h}h ${m}min`;
  if (h) return `${h}h`;
  return `${m}min`;
}

function showDetailIsOnline() {
  return typeof cueMarkIsOffline !== "function" || !cueMarkIsOffline();
}

function getNativeHttpPlugin() {
  return window.CapacitorHttp
    || window.Capacitor?.Plugins?.Http
    || window.Capacitor?.Plugins?.CapacitorHttp
    || null;
}

function detailResponseMessage(payload) {
  const errors = Array.isArray(payload?.errors)
    ? payload.errors.map(error => error?.message).filter(Boolean).join("; ")
    : "";
  const message = errors || payload?.message || payload?.error || payload?.Error || payload?.detail || "";
  return String(message).replace(/\s+/g, " ").slice(0, 240);
}

function detailHttpError(status, payload) {
  const message = detailResponseMessage(payload);
  const error = new Error(`${message || `HTTP ${status}`}${message ? ` (HTTP ${status})` : ""}`);
  error.status = status;
  error.retryable = status >= 500;
  return error;
}

async function parseDetailResponse(response) {
  const raw = await response.text();
  let payload = null;
  try { payload = raw ? JSON.parse(raw) : null; } catch { payload = raw || null; }
  if (!response.ok) throw detailHttpError(response.status, payload);
  return payload;
}

function detailLoadFailure(provider, error) {
  const reason = String(error?.message || "Network request failed").replace(/\s+/g, " ").slice(0, 180);
  return `${provider} details unavailable: ${reason}`;
}

async function fetchJsonPortable(url, init = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const plugin = getNativeHttpPlugin();
      if (plugin?.get && (init.method || "GET").toUpperCase() === "GET") {
        const response = await plugin.get({ url, headers: init.headers || {} });
        const payload = parseDetailJson(response?.data);
        if (response?.status && response.status >= 400) throw detailHttpError(response.status, payload);
        return payload;
      }
      if (plugin?.request) {
        const response = await plugin.request({
          url,
          method: init.method || "GET",
          headers: init.headers || {},
          data: init.body || null,
          responseType: "json"
        });
        const payload = parseDetailJson(response?.data);
        if (response?.status && response.status >= 400) throw detailHttpError(response.status, payload);
        return payload;
      }

      const requestMethod = (init.method || "GET").toUpperCase();
      if (requestMethod === "GET" && typeof window !== "undefined") {
        let proxyUrl = null;
        if (window.location?.origin && window.location.origin !== "null") {
          proxyUrl = new URL("/proxy", window.location.origin);
        } else if (window.location?.protocol === "file:") {
          proxyUrl = new URL("http://127.0.0.1:3000/proxy");
        }
        if (proxyUrl) {
          proxyUrl.searchParams.set("url", url);
          try {
            const proxyResponse = await fetch(proxyUrl.toString(), init);
            if (proxyResponse.ok) return parseDetailResponse(proxyResponse);
            await parseDetailResponse(proxyResponse);
          } catch (proxyError) {
            // A local file page may not have the optional development proxy
            // running; continue with the direct request in that case.
            if (proxyError?.status && proxyError.status < 500 && proxyError.status !== 404) throw proxyError;
          }
        }
      }

      const response = await fetch(url, init);
      return await parseDetailResponse(response);
    } catch (err) {
      lastError = err;
      if (err?.retryable === false) break;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError || new Error("Network request failed");
}

function parseDetailJson(value) {
  if (typeof value !== "string") return value ?? null;
  try { return JSON.parse(value); } catch { return value; }
}

function getUrlParams() {
  return new URLSearchParams(window.location.search);
}

async function initShowDetail() {
  const params = getUrlParams();
  const source = params.get("source");
  const notice = document.getElementById("show-detail-offline-notice");

  if (source === "local") {
    const itemId = params.get("itemId");
    const item = state.items.find(i => i.id === itemId);
    if (!item) {
      window.location.href = "static/pages/main/dashboard.html";
      return;
    }
    showDetailState.mode = "local";
    showDetailState.category = item.category;
    showDetailState.itemId = item.id;
    showDetailState.provider = item.metadataSource || (item.tvmazeShowId ? "tvmaze" : "");
    // Keep the local record as the active detail object. The offline action
    // must merge with it instead of treating a local page as an empty online
    // result and wiping saved metadata.
    showDetailState.show = { ...item };
    showDetailState.watchedEpisodeIds = item.watchedEpisodeIds || [];

    if (EPISODE_TRACKED_CATEGORIES.includes(item.category) && (item.tvmazeShowId || item.metadataSource === "anilist" || item.metadataSource === "jikan" || item.metadataSource === "kitsu")) {
      if (Array.isArray(item.episodesCache) && item.episodesCache.length) {
        applyEpisodesToState(item.episodesCache, item);
      }
      if (showDetailIsOnline()) {
        try {
          if (item.tvmazeShowId) {
            const tvmazeDetails = await fetchTvmazeFullData(item.tvmazeShowId, item);
            renderTvmazeDetails(tvmazeDetails);
          } else if (item.metadataSource === "anilist" && item.providerId) {
            try {
              const details = await fetchAniListFullData(item.providerId, "ANIME", item);
              renderAniListDetails(details);
              const episodes = buildSyntheticAnimeEpisodes(item.totalEpisodes || details.media.episodes, {
                summary: item.summary, runtime: item.episodeRuntime, thumbnail: item.thumbnail, sourceLabel: item.title || "Anime"
              });
              if (episodes.length) applyEpisodesToState(episodes, item);
            } catch (error) {
              const fallback = item.anilistFallbackCache || await fetchJikanTitleFallback(item.title, item.category, error?.message || "");
              if (!fallback?.entry) throw error;
              item.anilistFallbackCache = fallback;
              saveData();
              renderJikanDetails(fallback);
              const episodes = buildSyntheticAnimeEpisodes(item.totalEpisodes || fallback.entry.episodes, {
                summary: item.summary || fallback.entry.synopsis, runtime: item.episodeRuntime, thumbnail: item.thumbnail, sourceLabel: item.title || "Anime"
              });
              if (episodes.length) applyEpisodesToState(episodes, item);
            }
          } else if (item.metadataSource === "jikan" && item.providerId) {
            const cacheIsFresh = Date.now() - Number(item.jikanDetailsCache?.fetchedAt || 0) < 24 * 60 * 60 * 1000;
            if (!cacheIsFresh) await fetchJikanFullData(item.providerId, "anime", item);
            if (item.jikanDetailsCache) renderJikanDetails(item.jikanDetailsCache);
            const episodes = item.episodesCache?.length ? item.episodesCache : await fetchJikanAnimeEpisodes(item.providerId, item.thumbnail || "");
            if (episodes.length) applyEpisodesToState(episodes, item);
          } else if (item.metadataSource === "kitsu" && item.providerId) {
            const cacheIsFresh = Date.now() - Number(item.kitsuDetailsCache?.fetchedAt || 0) < 24 * 60 * 60 * 1000;
            const details = cacheIsFresh ? item.kitsuDetailsCache : await fetchKitsuFullData(item.providerId, "anime", item);
            renderKitsuDetails(details);
            const episodes = buildSyntheticAnimeEpisodes(item.totalEpisodes || details.media.attributes?.episodeCount, {
              summary: item.summary, runtime: item.episodeRuntime, thumbnail: item.thumbnail, sourceLabel: item.title || "Anime"
            });
            if (episodes.length) applyEpisodesToState(episodes, item);
          } else if (item.metadataSource === "anilist" || item.metadataSource === "kitsu") {
            const episodes = buildSyntheticAnimeEpisodes(item.totalEpisodes, {
              summary: item.summary,
              runtime: item.episodeRuntime,
              thumbnail: item.thumbnail,
              sourceLabel: item.title || "Anime"
            });
            if (episodes.length) applyEpisodesToState(episodes, item);
          }
          removeQueuedMetadataUpdate(item.category, item.title, item.id);
        } catch (err) {
          console.warn("Could not refresh episode list", err);
          queueMetadataUpdate(item.category, item.title, item.id);
          if (notice) notice.style.display = "block";
        }
      } else if (notice) {
        notice.style.display = "block";
      }
    }

    if (item.category === "manga" && item.metadataSource === "anilist" && item.providerId && showDetailIsOnline()) {
      try {
        const details = await fetchAniListFullData(item.providerId, "MANGA", item);
        renderAniListDetails(details);
      } catch (err) {
        try {
          const fallback = item.anilistFallbackCache || await fetchJikanTitleFallback(item.title, item.category, err?.message || "");
          if (!fallback?.entry) throw err;
          item.anilistFallbackCache = fallback;
          saveData();
          renderJikanDetails(fallback);
        } catch (fallbackError) {
          console.warn("Could not refresh AniList or Jikan manga details", fallbackError);
          if (notice) notice.style.display = "block";
        }
      }
    }

    const jikanCacheIsFresh = Date.now() - Number(item.jikanDetailsCache?.fetchedAt || 0) < 24 * 60 * 60 * 1000;
    if (item.category === "manga" && item.metadataSource === "jikan" && item.providerId && showDetailIsOnline() && !jikanCacheIsFresh) {
      try {
        const details = await fetchJikanFullData(item.providerId, "manga", item);
        renderJikanDetails(details);
      } catch (err) {
        console.warn("Could not refresh Jikan manga details", err);
        if (notice) notice.style.display = "block";
      }
    }

    const kitsuCacheIsFresh = Date.now() - Number(item.kitsuDetailsCache?.fetchedAt || 0) < 24 * 60 * 60 * 1000;
    if (item.category === "manga" && item.metadataSource === "kitsu" && item.providerId && showDetailIsOnline() && !kitsuCacheIsFresh) {
      try {
        const details = await fetchKitsuFullData(item.providerId, "manga", item);
        renderKitsuDetails(details);
      } catch (err) {
        console.warn("Could not refresh Kitsu manga details", err);
        if (notice) notice.style.display = "block";
      }
    }

    if (item.metadataSource === "wikidata" && item.providerId && showDetailIsOnline()) {
      try {
        const details = await fetchWikidataFullData(item.providerId, item, entity => renderWikidataCoreDetails(entity, item.providerId, item.title));
        renderWikidataDetails(details);
        loadWikidataSuggestionsInBackground(item.providerId, details, item.id);
      } catch (err) {
        console.warn("Could not refresh Wikidata details", err);
        if (notice) notice.style.display = "block";
      }
    }

    const mangaDexCacheIsFresh = Date.now() - Number(item.mangadexDetailsCache?.fetchedAt || 0) < 24 * 60 * 60 * 1000;
    if (item.metadataSource === "mangadex" && item.providerId && showDetailIsOnline() && !mangaDexCacheIsFresh) {
      try { renderMangaDexDetails(await fetchMangaDexFullData(item.providerId, item, item.title)); }
      catch (err) { console.warn("Could not refresh MangaDex details", err); if (notice) notice.style.display = "block"; }
    }

    const openLibraryCacheIsFresh = Date.now() - Number(item.openlibraryDetailsCache?.fetchedAt || 0) < 24 * 60 * 60 * 1000;
    if (item.metadataSource === "openlibrary" && item.providerId && showDetailIsOnline() && !openLibraryCacheIsFresh) {
      try {
        const details = await fetchOpenLibraryFullData(item.providerId, item, core => renderOpenLibraryCoreDetails(core, item.title, item.id));
        renderOpenLibraryDetails(details);
      } catch (err) {
        console.warn("Could not refresh Open Library details", err);
        if (notice) notice.style.display = "block";
      }
    }

    const freeToGameCacheIsFresh = Date.now() - Number(item.freetogameDetailsCache?.fetchedAt || 0) < 24 * 60 * 60 * 1000;
    if (item.metadataSource === "freetogame" && item.providerId && showDetailIsOnline() && !freeToGameCacheIsFresh) {
      try {
        const details = await fetchFreeToGameFullData(item.providerId, item);
        renderFreeToGameDetails(details);
      } catch (err) {
        console.warn("Could not refresh FreeToGame details", err);
        if (notice) notice.style.display = "block";
      }
    }

    const googleBooksCacheIsFresh = Date.now() - Number(item.googlebooksDetailsCache?.fetchedAt || 0) < 24 * 60 * 60 * 1000;
    if (item.metadataSource === "googlebooks" && item.providerId && showDetailIsOnline() && !googleBooksCacheIsFresh) {
      try {
        const details = await fetchGoogleBooksFullData(item.providerId, item);
        renderGoogleBooksDetails(details);
      } catch (err) {
        console.warn("Could not refresh Google Books details", err);
        if (notice) notice.style.display = "block";
      }
    }

    const rawgCacheIsFresh = Date.now() - Number(item.rawgDetailsCache?.fetchedAt || 0) < 24 * 60 * 60 * 1000;
    if (item.metadataSource === "rawg" && item.providerId && showDetailIsOnline() && !rawgCacheIsFresh) {
      try {
        const details = await fetchRAWGFullData(item.providerId, item);
        renderRAWGDetails(details);
      } catch (err) {
        console.warn("Could not refresh RAWG details", err);
        if (notice) notice.style.display = "block";
      }
    }

    const omdbCacheIsFresh = Date.now() - Number(item.omdbDetailsCache?.fetchedAt || 0) < 24 * 60 * 60 * 1000;
    if (item.metadataSource === "omdb" && item.providerId && showDetailIsOnline() && !omdbCacheIsFresh) {
      try { renderOMDbDetails(await fetchOMDbFullData(item.providerId, item)); }
      catch (err) { console.warn("Could not refresh OMDb details", err); if (notice) notice.style.display = "block"; }
    }

    const tmdbCacheIsFresh = Date.now() - Number(item.tmdbDetailsCache?.fetchedAt || 0) < 24 * 60 * 60 * 1000;
    if (item.metadataSource === "tmdb" && item.providerId && showDetailIsOnline() && !tmdbCacheIsFresh) {
      try { renderTMDBDetails(await fetchTMDBFullData(item.providerId, item.category, item)); }
      catch (err) { console.warn("Could not refresh TMDB details", err); if (notice) notice.style.display = "block"; }
    }

    const runtimeMinutes = item.episodeRuntime || item.playtime || 0;
    renderShowDetailHeader({
      title: item.title,
      thumbnail: item.thumbnail || "",
      meta: [CATEGORIES[item.category]?.label || "", runtimeMinutes ? `~${formatRuntimeHM(runtimeMinutes)}${EPISODE_TRACKED_CATEGORIES.includes(item.category) ? "/ep" : ""}` : "", item.network || ""].filter(Boolean).join(" · "),
      summary: item.summary || "",
      productionStatus: item.productionStatus || ""
    });
    if (item.tvmazeShowId) renderTvmazeDetails(item.tvmazeDetailsCache || null);
    if (item.metadataSource === "anilist") {
      if (item.anilistDetailsCache) renderAniListDetails(item.anilistDetailsCache);
      else if (item.anilistFallbackCache?.provider === "kitsu") renderKitsuDetails(item.anilistFallbackCache.details);
      else if (item.anilistFallbackCache) renderJikanDetails(item.anilistFallbackCache);
      else renderAniListDetails(null);
    }
    if (item.metadataSource === "jikan") renderJikanDetails(item.jikanDetailsCache || null);
    if (item.metadataSource === "kitsu") renderKitsuDetails(item.kitsuDetailsCache || null);
    if (item.metadataSource === "wikidata") {
      renderWikidataDetails(item.wikidataDetailsCache || null);
      if (item.tmdbDetailsCache) renderTMDBDetails(item.tmdbDetailsCache);
      if (item.omdbDetailsCache) renderOMDbDetails(item.omdbDetailsCache);
    }
    if (item.metadataSource === "openlibrary") renderOpenLibraryDetails(item.openlibraryDetailsCache || null);
    if (item.metadataSource === "freetogame") renderFreeToGameDetails(item.freetogameDetailsCache || null);
    if (item.metadataSource === "googlebooks") renderGoogleBooksDetails(item.googlebooksDetailsCache || null);
    if (item.metadataSource === "rawg") renderRAWGDetails(item.rawgDetailsCache || null);
    if (item.metadataSource === "omdb") renderOMDbDetails(item.omdbDetailsCache || null);
    if (item.metadataSource === "tmdb") renderTMDBDetails(item.tmdbDetailsCache || null);
    if (item.metadataSource === "mangadex") renderMangaDexDetails(item.mangadexDetailsCache || null);
    if (item.metadataSource === "howlongtobeat") renderHowLongToBeatDetails(item.howLongToBeatDetailsCache || null);
    if (item.metadataSource === "howlongtoread") renderHowLongToReadDetails(item.howLongToReadDetailsCache || null);
    if (item.metadataSource === "viz") renderVizDetails(item.vizDetailsCache || null);
    renderStatusPicker(item);
    renderAddToListPicker();
    renderSeasonSection();
    renderBookProgressSection(item);
    renderRatingWidget(item);
    renderNotesField(item);
    renderRelatedTitles(item);
    updateShowDetailMenu();
    return;
  }

  // Online, not-yet-tracked flow (from Discover/Sources search). If this exact
  // provider+providerId is already tracked locally, redirect to that item
  // instead of creating a duplicate (legacy tvmaze items saved before
  // `providerId` existed are matched via their `tvmazeShowId` fallback).
  const category = params.get("category") || "series";
  const provider = params.get("provider");
  const providerId = params.get("providerId");
  const title = params.get("title") || "";
  const providerUrl = params.get("providerUrl") || "";

  const existingItem = state.items.find(i => {
    if (provider === "tvmaze" && i.tvmazeShowId && String(i.tvmazeShowId) === String(providerId)) return true;
    return i.metadataSource === provider && i.providerId != null && String(i.providerId) === String(providerId);
  });
  if (existingItem) {
    window.location.href = `static/pages/main/show-detail.html?source=local&itemId=${encodeURIComponent(existingItem.id)}`;
    return;
  }

  showDetailState.mode = "online";
  showDetailState.category = category;
  showDetailState.provider = provider;

  if (!showDetailIsOnline()) {
    renderShowDetailHeader({ title, thumbnail: "", meta: "Offline — can't load details for a new title." });
    if (notice) notice.style.display = "block";
    return;
  }

  if (provider === "tvmaze") {
    try {
      const details = await fetchTvmazeFullData(providerId, null);
      const show = details.show;
      const runtime = show ? Math.round(show.averageRuntime || show.runtime || 0) : 0;
      const genres = (show?.genres || []).slice(0, 3);
      const network = show?.webChannel?.name || show?.network?.name || "";
      showDetailState.show = {
        title: show?.name || title,
        thumbnail: show?.image?.original || show?.image?.medium || "",
        meta: [show?.premiered ? show.premiered.slice(0, 4) : "", genres.join(", "), runtime ? `~${formatRuntimeHM(runtime)}/ep` : "", show?.rating?.average ? `★ ${show.rating.average}/10` : "", network].filter(Boolean).join(" · "),
        summary: stripHtml(show?.summary || ""),
        tvmazeShowId: providerId,
        providerId,
        episodeRuntime: runtime,
        network,
        genres,
        productionStatus: show?.status || "",
        rating: show?.rating?.average ?? null,
        tvmazeDetailsCache: details
      };
      renderShowDetailHeader(showDetailState.show);
      renderTvmazeDetails(details);
      renderStatusPicker(null);
      renderAddToListPicker();
      renderSeasonSection();
      renderRatingWidget(null);
      renderNotesField(null);
      } catch (err) {
        console.warn("Could not load show details", err);
      renderShowDetailHeader({ title, thumbnail: "", meta: detailLoadFailure("TVmaze", err) });
    }
  } else if (provider === "wikidata") {
    showDetailState.show = { title, thumbnail: "", meta: "Wikidata item · Loading details…", providerId };
    renderSimpleShowDetail();
    try {
      const details = await fetchWikidataFullData(providerId, null, entity => renderWikidataCoreDetails(entity, providerId, title));
      const entity = details.entity;
      const genres = details.genres.map(entry => entry.label);
      const runtime = details.runtime;
      const summary = details.wikipedia?.extract || entity?.descriptions?.en?.value || "";
      showDetailState.show = {
        title: entity?.labels?.en?.value || title,
        thumbnail: details.thumbnail,
        meta: [details.releaseYear, genres.join(", "), runtime ? formatRuntimeHM(runtime) : "", details.reviewScores[0] || ""].filter(Boolean).join(" · "),
        summary,
        playtime: runtime,
        genres,
        providerId,
        wikidataDetailsCache: details
      };
      renderWikidataDetails(details);
      renderSimpleShowDetail();
      loadWikidataSuggestionsInBackground(providerId, details);
      const builtinKeys = state.preferences?.metadataSources?.builtinApiKeys || {};
      const tmdbId = wikidataClaimValues(details.claims, "P4947").map(String).find(value => /^\d+$/.test(value));
      const imdbId = wikidataClaimValues(details.claims, "P345").map(String).find(value => /^tt\d+$/.test(value));
      const supplements = [];
      if (tmdbId && builtinKeys.tmdb) supplements.push((async () => {
        try {
          const tmdb = await fetchTMDBFullData(tmdbId, "movie");
          showDetailState.show.tmdbDetailsCache = tmdb;
          renderTMDBDetails(tmdb);
        } catch (error) { console.warn("Could not load linked TMDB movie details", error); }
      })());
      if (imdbId && builtinKeys.omdb) supplements.push((async () => {
        try {
          const omdb = await fetchOMDbFullData(imdbId);
          showDetailState.show.omdbDetailsCache = omdb;
          renderOMDbDetails(omdb);
        } catch (error) { console.warn("Could not load linked OMDb movie details", error); }
      })());
      // TMDB and OMDb render into their own sections; don't hold up the page.
    } catch (err) {
      console.warn("Could not load movie details", err);
      // Keep the detail page usable when Wikidata is temporarily unavailable.
      // The old basic flow rendered this title even when metadata could not be
      // fetched; the HTTP failure remains available in the console for debug.
      showDetailState.show = { title, thumbnail: "", meta: "Wikidata item", providerId };
      renderSimpleShowDetail();
      const section = document.getElementById("wikidata-extra-section");
      if (section) {
        section.style.display = "block";
        section.innerHTML = `<section class="tvmaze-detail-block"><h2>Wikidata record unavailable</h2><p>Could not retrieve this item’s metadata right now.</p><a href="https://www.wikidata.org/wiki/${encodeURIComponent(providerId)}" target="_blank" rel="noopener">Open Wikidata item</a></section>`;
      }
    }
  } else if (provider === "openlibrary") {
    showDetailState.show = { title, thumbnail: "", meta: "Open Library · Loading details…", providerId };
    renderSimpleShowDetail();
    try {
      const details = await fetchOpenLibraryFullData(providerId, null, core => renderOpenLibraryCoreDetails(core, title));
      renderOpenLibraryCoreDetails(details, title);
    } catch (err) {
      console.warn("Could not load book details", err);
      renderShowDetailHeader({ title, thumbnail: "", meta: detailLoadFailure("Open Library", err) });
    }
  } else if (provider === "anilist" || provider === "jikan" || provider === "kitsu") {
    try {
      let show = null;
      if (provider === "anilist") {
        const mediaType = category === "manga" ? "MANGA" : "ANIME";
        const details = await fetchAniListFullData(providerId, mediaType, null);
        const media = details.media;
        if (media) {
          const totalEpisodes = parseInt(media.episodes) || 0;
          const totalChapters = parseInt(media.chapters) || 0;
          const totalVolumes = parseInt(media.volumes) || 0;
          show = {
            title: media.title?.english || media.title?.romaji || title,
            thumbnail: media.coverImage?.extraLarge || media.coverImage?.large || media.coverImage?.medium || "",
            meta: [media.startDate?.year || "", category === "manga" ? (totalVolumes ? `${totalVolumes} volumes` : "") : (totalEpisodes ? `${totalEpisodes} episodes` : ""), category === "manga" ? (totalChapters ? `${totalChapters} chapters` : "") : (media.duration ? `~${media.duration} min/ep` : ""), media.averageScore ? `★ ${media.averageScore}/100` : ""].filter(Boolean).join(" · "),
            summary: media.description || "",
            providerId,
            totalEpisodes,
            totalChapters,
            totalVolumes,
            episodeRuntime: media.duration || 0,
            productionStatus: media.status || "",
            genres: media.genres || [],
            anilistDetailsCache: details
          };
          renderAniListDetails(details);
        }
      } else if (provider === "jikan") {
        const isManga = category === "manga";
        const details = await fetchJikanFullData(providerId, isManga ? "manga" : "anime");
        const entry = details.entry;
        if (entry) {
          const runtime = parseInt(String(entry.duration || "").match(/\d+/)?.[0] || "") || 0;
          const genres = (entry.genres || []).map(genre => genre.name);
          show = {
            title: entry.title || title,
            thumbnail: entry.images?.jpg?.large_image_url || entry.images?.jpg?.image_url || "",
            meta: [isManga ? entry.published?.from?.slice(0, 4) : entry.aired?.from?.slice(0, 4), isManga ? (entry.volumes ? `${entry.volumes} volumes` : "") : (entry.episodes ? `${entry.episodes} episodes` : ""), isManga ? (entry.chapters ? `${entry.chapters} chapters` : "") : (runtime ? `~${runtime} min/ep` : ""), entry.score ? `★ ${entry.score}/10` : ""].filter(Boolean).join(" · "),
            summary: entry.synopsis || "",
            providerId,
            totalEpisodes: parseInt(entry.episodes) || 0,
            totalChapters: parseInt(entry.chapters) || 0,
            totalVolumes: parseInt(entry.volumes) || 0,
            episodeRuntime: runtime,
            productionStatus: entry.status || "",
            genres,
            jikanDetailsCache: details
          };
          renderJikanDetails(details);
        }
      } else if (provider === "kitsu") {
        const isManga = category === "manga";
        const details = await fetchKitsuFullData(providerId, isManga ? "manga" : "anime");
        const media = details.media;
        const attrs = media.attributes || {};
        if (media) {
          const genres = (details.genres || []).map(item => item.attributes?.name).filter(Boolean);
          const totalEpisodes = parseInt(attrs.episodeCount) || 0;
          const totalChapters = parseInt(attrs.chapterCount) || 0;
          const totalVolumes = parseInt(attrs.volumeCount) || 0;
          show = {
            title: attrs.canonicalTitle || attrs.titles?.en || attrs.titles?.en_jp || title,
            thumbnail: attrs.posterImage?.large || attrs.posterImage?.original || attrs.posterImage?.medium || "",
            meta: [attrs.startDate ? attrs.startDate.slice(0, 4) : "", isManga ? (totalVolumes ? `${totalVolumes} volumes` : "") : (totalEpisodes ? `${totalEpisodes} episodes` : ""), isManga ? (totalChapters ? `${totalChapters} chapters` : "") : (attrs.episodeLength ? `~${attrs.episodeLength} min/ep` : ""), attrs.averageRating ? `★ ${(Number(attrs.averageRating) / 10).toFixed(1)}/10` : ""].filter(Boolean).join(" · "),
            summary: attrs.synopsis || attrs.description || "",
            providerId,
            totalEpisodes,
            totalChapters,
            totalVolumes,
            episodeRuntime: parseInt(attrs.episodeLength) || 0,
            productionStatus: attrs.status || "",
            genres,
            kitsuDetailsCache: details
          };
          renderKitsuDetails(details);
        }
      }

      if (!show) {
        renderShowDetailHeader({ title, thumbnail: "", meta: detailLoadFailure(provider, new Error("Provider returned no title record")) });
        return;
      }

      showDetailState.show = show;
      if (category === "manga") {
        renderSimpleShowDetail();
      } else if (provider === "jikan" && show.providerId) {
        const episodes = await fetchJikanAnimeEpisodes(show.providerId, show.thumbnail || "");
        if (episodes.length) {
          applyEpisodesToState(episodes, null);
        } else {
          showDetailState.seasons = show.totalEpisodes > 0 ? [1] : [];
          showDetailState.episodes = buildSyntheticAnimeEpisodes(show.totalEpisodes, show);
          showDetailState.activeSeason = showDetailState.seasons[0] || null;
        }
      } else if (provider === "kitsu" && show.providerId) {
        showDetailState.seasons = show.totalEpisodes > 0 ? [1] : [];
        showDetailState.episodes = buildSyntheticAnimeEpisodes(show.totalEpisodes, show);
        showDetailState.activeSeason = showDetailState.seasons[0] || null;
      } else {
        showDetailState.seasons = show.totalEpisodes > 0 ? [1] : [];
        showDetailState.episodes = buildSyntheticAnimeEpisodes(show.totalEpisodes, show);
        showDetailState.activeSeason = showDetailState.seasons[0] || null;
      }
      if (category !== "manga") {
        renderShowDetailHeader(showDetailState.show);
        renderStatusPicker(null);
        renderAddToListPicker();
        renderSeasonSection();
        renderRatingWidget(null);
        renderNotesField(null);
      }
    } catch (err) {
      console.warn("Could not load anime details", err);
      if (provider === "anilist") {
        const fallbackFailures = [];
        try {
          const fallback = await fetchJikanTitleFallback(title, category, err?.message || "");
          if (fallback?.entry) {
            const isManga = fallback.type === "manga";
            const entry = fallback.entry;
            const runtime = parseInt(String(entry.duration || "").match(/\d+/)?.[0] || "") || 0;
            const genres = (entry.genres || []).map(genre => genre.name).filter(Boolean);
            const totalEpisodes = parseInt(entry.episodes) || 0;
            const totalChapters = parseInt(entry.chapters) || 0;
            const totalVolumes = parseInt(entry.volumes) || 0;
            showDetailState.show = {
              title: entry.title || title,
              thumbnail: entry.images?.jpg?.large_image_url || entry.images?.jpg?.image_url || "",
              meta: [isManga ? entry.published?.from?.slice(0, 4) : entry.aired?.from?.slice(0, 4), isManga ? (totalVolumes ? `${totalVolumes} volumes` : "") : (totalEpisodes ? `${totalEpisodes} episodes` : ""), isManga ? (totalChapters ? `${totalChapters} chapters` : "") : (runtime ? `~${runtime} min/ep` : ""), entry.score ? `★ ${entry.score}/10` : "", "Jikan fallback"].filter(Boolean).join(" · "),
              summary: entry.synopsis || "",
              genres,
              providerId,
              totalEpisodes,
              totalChapters,
              totalVolumes,
              episodeRuntime: runtime,
              anilistFallbackCache: fallback
            };
            renderJikanDetails(fallback);
            if (isManga) {
              renderSimpleShowDetail();
            } else {
              showDetailState.seasons = totalEpisodes > 0 ? [1] : [];
              showDetailState.episodes = buildSyntheticAnimeEpisodes(totalEpisodes, showDetailState.show);
              showDetailState.activeSeason = showDetailState.seasons[0] || null;
              renderShowDetailHeader(showDetailState.show);
              renderStatusPicker(null);
              renderAddToListPicker();
              renderSeasonSection();
              renderRatingWidget(null);
              renderNotesField(null);
            }
            return;
          }
          fallbackFailures.push("Jikan found no exact title match");
        } catch (fallbackError) {
          console.warn("Could not load the exact-title Jikan fallback", fallbackError);
          fallbackFailures.push(`Jikan: ${fallbackError?.message || "request failed"}`);
        }
        try {
          const details = await fetchKitsuTitleFallback(title, category);
          const media = details?.media;
          if (media) {
            const attrs = media.attributes || {};
            const isManga = details.type === "manga";
            const totalEpisodes = parseInt(attrs.episodeCount) || 0;
            const totalChapters = parseInt(attrs.chapterCount) || 0;
            const totalVolumes = parseInt(attrs.volumeCount) || 0;
            const runtime = parseInt(attrs.episodeLength) || 0;
            const genres = (details.genres || []).map(item => item.attributes?.name).filter(Boolean);
            showDetailState.show = {
              title: attrs.canonicalTitle || attrs.titles?.en || attrs.titles?.en_jp || title,
              thumbnail: attrs.posterImage?.large || attrs.posterImage?.original || attrs.posterImage?.medium || "",
              meta: [attrs.startDate?.slice(0, 4), isManga ? (totalVolumes ? `${totalVolumes} volumes` : "") : (totalEpisodes ? `${totalEpisodes} episodes` : ""), isManga ? (totalChapters ? `${totalChapters} chapters` : "") : (runtime ? `~${runtime} min/ep` : ""), attrs.averageRating ? `★ ${(Number(attrs.averageRating) / 10).toFixed(1)}/10` : "", "Kitsu fallback"].filter(Boolean).join(" · "),
              summary: attrs.synopsis || attrs.description || "",
              genres, providerId, totalEpisodes, totalChapters, totalVolumes,
              episodeRuntime: runtime, productionStatus: attrs.status || "",
              anilistFallbackCache: { provider: "kitsu", details }, kitsuDetailsCache: details
            };
            renderKitsuDetails(details);
            if (category === "manga" || category === "novel") {
              renderSimpleShowDetail();
            } else {
              showDetailState.seasons = totalEpisodes > 0 ? [1] : [];
              showDetailState.episodes = details.episodeItems?.length
                ? details.episodeItems
                : buildSyntheticAnimeEpisodes(totalEpisodes, showDetailState.show);
              showDetailState.activeSeason = showDetailState.seasons[0] || null;
              renderShowDetailHeader(showDetailState.show);
              renderStatusPicker(null);
              renderAddToListPicker();
              renderSeasonSection();
              renderRatingWidget(null);
              renderNotesField(null);
            }
            return;
          }
          fallbackFailures.push("Kitsu found no exact title match");
        } catch (fallbackError) {
          console.warn("Could not load the exact-title Kitsu fallback", fallbackError);
          fallbackFailures.push(`Kitsu: ${fallbackError?.message || "request failed"}`);
        }
        const aniListReason = err?.status ? `HTTP ${err.status}` : (err?.message || "request failed").slice(0, 55);
        const backupReason = fallbackFailures.map(message => message.slice(0, 55)).join("; ");
        const failure = new Error(`AniList ${aniListReason}; ${backupReason}`);
        showDetailState.show = { title, thumbnail: "", meta: detailLoadFailure("AniList and backup sources", failure), providerId };
        renderShowDetailHeader(showDetailState.show);
        renderStatusPicker(null);
        renderAddToListPicker();
        renderRatingWidget(null);
        renderNotesField(null);
        return;
      }
      renderShowDetailHeader({ title, thumbnail: "", meta: detailLoadFailure(provider, err) });
    }
  } else if (provider === "rawg") {
    try {
      const details = await fetchRAWGFullData(providerId, null);
      const game = details.game;
      const genres = (game?.genres || []).map(g => g.name).filter(Boolean);
      const releaseYear = game?.released ? game.released.slice(0, 4) : "";
      showDetailState.show = {
        title: game?.name || title,
        thumbnail: game?.background_image || "",
        meta: [releaseYear, genres.join(", "), game?.rating ? `★ ${game.rating}/5 (${game.ratings_count || 0})` : "", game?.metacritic ? `Metacritic ${game.metacritic}` : ""].filter(Boolean).join(" · "),
        summary: game?.description_raw || stripHtml(game?.description || ""),
        genres,
        providerId,
        rawgDetailsCache: details
      };
      renderRAWGDetails(details);
      renderShowDetailHeader(showDetailState.show);
      renderStatusPicker(null);
      renderAddToListPicker();
      renderRatingWidget(null);
      renderNotesField(null);
    } catch (err) {
      console.warn("Could not load game details", err);
      renderShowDetailHeader({ title, thumbnail: "", meta: detailLoadFailure("RAWG", err) });
    }
  } else if (provider === "freetogame") {
    try {
      const details = await fetchFreeToGameFullData(providerId, null, providerUrl, title);
      const game = details.game;
      const genres = [game.genre, game.platform, game.publisher].filter(Boolean);
      showDetailState.show = {
        title: game.title || title,
        thumbnail: game.thumbnail || "",
        meta: [game.release_date || "", game.genre || "", game.platform || "", game.publisher || "", game.developer || ""].filter(Boolean).join(" · "),
        summary: game.short_description || game.description || "",
        genres,
        providerId,
        freetogameDetailsCache: details
      };
      renderFreeToGameDetails(details);
      renderSimpleShowDetail();
    } catch (err) {
      console.warn("Could not load FreeToGame details", err);
      renderShowDetailHeader({ title, thumbnail: "", meta: detailLoadFailure("FreeToGame", err) });
    }
  } else if (provider === "howlongtoread") {
    try {
      const details = await fetchHowLongToReadDetails(providerId, title);
      showDetailState.show = { title: details.title || title, thumbnail: details.thumbnail || "", meta: details.subtitle || "", summary: details.summary || "", genres: [], providerId, howLongToReadDetailsCache: details };
      renderHowLongToReadDetails(details);
      renderSimpleShowDetail();
    } catch (err) {
      console.warn("Could not load HowLongToRead details", err);
      renderShowDetailHeader({ title, thumbnail: "", meta: detailLoadFailure("HowLongToRead", err) });
    }
  } else if (provider === "viz") {
    try {
      const details = await fetchVizDetails(providerId, title);
      showDetailState.show = { title: details.title || title, thumbnail: details.thumbnail || "", meta: details.subtitle || "", summary: details.summary || "", genres: ["Manga"], providerId, vizDetailsCache: details };
      renderVizDetails(details);
      renderSimpleShowDetail();
    } catch (err) {
      console.warn("Could not load VIZ details", err);
      renderShowDetailHeader({ title, thumbnail: "", meta: detailLoadFailure("VIZ", err) });
    }
  } else if (provider === "howlongtobeat") {
    try {
      const details = await fetchHowLongToBeatDetails(providerId, title);
      const times = details.howLongToBeat || {};
      showDetailState.show = {
        title: details.title || title,
        thumbnail: details.thumbnail || "",
        meta: [details.subtitle, times.completionist ? `${times.completionist}h completionist` : ""].filter(Boolean).join(" · "),
        summary: details.summary || "",
        genres: [], providerId, howLongToBeatDetailsCache: details
      };
      renderHowLongToBeatDetails(details);
      renderSimpleShowDetail();
    } catch (err) {
      console.warn("Could not load HowLongToBeat details", err);
      renderShowDetailHeader({ title, thumbnail: "", meta: detailLoadFailure("HowLongToBeat", err) });
    }
  } else if (provider === "steamdb") {
    const [kind, numericId] = String(providerId).split(":");
    const steamDbUrl = `https://steamdb.info/${kind || "app"}/${numericId || providerId}/`;
    const steamUrl = kind === "app" ? `https://store.steampowered.com/app/${numericId || providerId}/` : "";
    let game = null;
    try {
      if (kind === "app") {
        const apiUrl = `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(numericId)}&l=english&cc=us`;
        const payload = await fetchSteamJsonPortable(apiUrl);
        game = payload?.[numericId]?.success ? payload[numericId].data : null;
      }
    } catch (err) {
      console.warn("Could not load Steam app details", err);
    }
    showDetailState.show = {
      title: game?.name || title,
      thumbnail: game?.header_image || "",
      meta: [game?.type, game?.release_date?.date, game?.developers?.[0], game?.publishers?.[0]].filter(Boolean).join(" · "),
      summary: stripHtml(game?.detailed_description || game?.short_description || ""),
      genres: (game?.genres || []).map(g => g.description).slice(0, 5),
      providerId
    };
    renderSteamExtra(game, steamUrl, steamDbUrl);
    renderSimpleShowDetail();
  } else if (provider === "mangadex") {
    try {
      const details = await fetchMangaDexFullData(providerId, null, title);
      const attrs = details.manga.attributes || {};
      const titleText = mangaDexLocalized(attrs.title) || title;
      const thumbnail = mangaDexCoverUrl(providerId, details.primaryCover || details.covers?.[0]?.attributes?.fileName, "512");
      const genres = (details.tags || []).map(tag => mangaDexLocalized(tag.attributes?.name)).filter(Boolean);
      const totalChapters = (details.aggregate || []).reduce((sum, volume) => sum + volume.chapters.length, 0);
      const chapterCount = totalChapters || Number(attrs.lastChapter) || 0;
      const volumeCount = details.aggregate?.length || Number(attrs.lastVolume) || 0;
      showDetailState.show = {
        title: titleText,
        thumbnail: details.coverUrl || thumbnail,
        meta: [attrs.year, attrs.status, chapterCount ? `${chapterCount} chapters` : "", volumeCount ? `${volumeCount} volumes` : ""].filter(Boolean).join(" · "),
        summary: mangaDexLocalized(attrs.description),
        genres,
        providerId,
        totalChapters: chapterCount,
        totalVolumes: volumeCount,
        mangadexDetailsCache: details
      };
      renderSimpleShowDetail();
      renderMangaDexDetails(details);
    } catch (err) {
      console.warn("Could not load MangaDex details", err);
      renderShowDetailHeader({ title, thumbnail: "", meta: detailLoadFailure("MangaDex", err) });
    }
  } else if (provider === "anilist") {
    try {
      const isManga = category === "manga";
      const query = `query($id:Int){Media(id:$id){title{romaji english} coverImage{large} description(asHtml:false) genres startDate{year} status episodes chapters volumes}}`;
      const data = await fetchAniListJson("https://graphql.anilist.co", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query, variables: { id: parseInt(providerId, 10) } })
      });
      const media = data?.data?.Media;
      const genres = (media?.genres || []).slice(0, 3);
      const unitLabel = isManga ? (media?.chapters ? `${media.chapters} chapters` : "") : (media?.episodes ? `${media.episodes} episodes` : "");
      showDetailState.show = {
        title: media?.title?.english || media?.title?.romaji || title,
        thumbnail: media?.coverImage?.large || "",
        meta: [media?.startDate?.year, genres.join(", "), unitLabel, media?.status || ""].filter(Boolean).join(" · "),
        summary: stripHtml(media?.description || ""),
        genres,
        providerId
      };
      renderSimpleShowDetail();
    } catch (err) {
      console.warn("Could not load AniList details", err);
      renderShowDetailHeader({ title, thumbnail: "", meta: detailLoadFailure("AniList", err) });
    }
  } else if (provider === "jikan") {
    try {
      const isManga = category === "manga";
      const res = await fetch(`https://api.jikan.moe/v4/${isManga ? "manga" : "anime"}/${providerId}`);
      const data = res.ok ? await res.json() : null;
      const entry = data?.data;
      const genres = (entry?.genres || []).map(g => g.name).slice(0, 3);
      const year = (entry?.aired?.from || entry?.published?.from || "").slice(0, 4);
      const unitLabel = isManga ? (entry?.chapters ? `${entry.chapters} chapters` : "") : (entry?.episodes ? `${entry.episodes} episodes` : "");
      showDetailState.show = {
        title: entry?.title || title,
        thumbnail: entry?.images?.jpg?.large_image_url || entry?.images?.jpg?.image_url || "",
        meta: [year, genres.join(", "), unitLabel, entry?.score ? `★ ${entry.score}` : ""].filter(Boolean).join(" · "),
        summary: entry?.synopsis || "",
        genres,
        providerId
      };
      renderSimpleShowDetail();
    } catch (err) {
      console.warn("Could not load Jikan details", err);
      renderShowDetailHeader({ title, thumbnail: "", meta: detailLoadFailure("Jikan", err) });
    }
  } else if (provider === "kitsu") {
    try {
      const isManga = category === "manga";
      const res = await fetch(`https://kitsu.io/api/edge/${isManga ? "manga" : "anime"}/${providerId}`, { headers: { Accept: "application/vnd.api+json" } });
      const data = res.ok ? await res.json() : null;
      const attrs = data?.data?.attributes;
      const unitLabel = isManga ? (attrs?.chapterCount ? `${attrs.chapterCount} chapters` : "") : (attrs?.episodeCount ? `${attrs.episodeCount} episodes` : "");
      showDetailState.show = {
        title: attrs?.canonicalTitle || attrs?.titles?.en || title,
        thumbnail: attrs?.posterImage?.large || attrs?.posterImage?.medium || "",
        meta: [attrs?.startDate ? attrs.startDate.slice(0, 4) : "", unitLabel, attrs?.averageRating ? `★ ${(attrs.averageRating / 10).toFixed(1)}` : ""].filter(Boolean).join(" · "),
        summary: attrs?.synopsis || attrs?.description || "",
        providerId
      };
      renderSimpleShowDetail();
    } catch (err) {
      console.warn("Could not load Kitsu details", err);
      renderShowDetailHeader({ title, thumbnail: "", meta: detailLoadFailure("Kitsu", err) });
    }
  } else if (provider === "googlebooks") {
    try {
      const details = await fetchGoogleBooksFullData(providerId, null);
      const info = details.volume.volumeInfo;
      showDetailState.show = {
        title: info?.title || title,
        thumbnail: (info?.imageLinks?.extraLarge || info?.imageLinks?.large || info?.imageLinks?.thumbnail || info?.imageLinks?.smallThumbnail || "").replace("http://", "https://"),
        meta: [info?.publishedDate ? info.publishedDate.slice(0, 4) : "", info?.authors?.[0] || "", info?.pageCount ? `${info.pageCount} pages` : ""].filter(Boolean).join(" · "),
        summary: info?.description || "",
        genres: info?.categories || [],
        providerId,
        googlebooksDetailsCache: details
      };
      renderSimpleShowDetail();
      renderGoogleBooksDetails(details);
    } catch (err) {
      console.warn("Could not load Google Books details", err);
      renderShowDetailHeader({ title, thumbnail: "", meta: detailLoadFailure("Google Books", err) });
    }
  } else if (provider === "omdb") {
    try {
      const details = await fetchOMDbFullData(providerId, null);
      const data = details.title;
      const genres = (data?.Genre || "").split(",").map(g => g.trim()).filter(Boolean).slice(0, 3);
      showDetailState.show = {
        title: data?.Title || title,
        thumbnail: data?.Poster && data.Poster !== "N/A" ? data.Poster : "",
        meta: [data?.Year, genres.join(", "), data?.Runtime && data.Runtime !== "N/A" ? data.Runtime : "", data?.imdbRating && data.imdbRating !== "N/A" ? `IMDb ${data.imdbRating}/10` : "", data?.imdbVotes && data.imdbVotes !== "N/A" ? `${data.imdbVotes} votes` : ""].filter(Boolean).join(" · "),
        summary: data?.Plot && data.Plot !== "N/A" ? data.Plot : "",
        genres,
        providerId,
        omdbDetailsCache: details
      };
      renderSimpleShowDetail();
      renderOMDbDetails(details);
    } catch (err) {
      console.warn("Could not load OMDb details", err);
      renderShowDetailHeader({ title, thumbnail: "", meta: detailLoadFailure("OMDb", err) });
    }
  } else if (provider === "tmdb") {
    try {
      const mediaType = EPISODE_TRACKED_CATEGORIES.includes(category) ? "tv" : "movie";
      const details = await fetchTMDBFullData(providerId, category, null);
      const data = details.media;
      const genres = (data?.genres || []).map(g => g.name).slice(0, 3);
      const releaseDate = mediaType === "tv" ? data?.first_air_date : data?.release_date;
      const runtime = mediaType === "tv" ? (data?.episode_run_time?.[0] || 0) : (data?.runtime || 0);
      showDetailState.show = {
        title: (mediaType === "tv" ? data?.name : data?.title) || title,
        thumbnail: data?.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : "",
        meta: [releaseDate ? releaseDate.slice(0, 4) : "", genres.join(", "), runtime ? formatRuntimeHM(runtime) : "", data?.vote_average ? `★ ${data.vote_average.toFixed(1)}` : ""].filter(Boolean).join(" · "),
        summary: data?.overview || "",
        genres,
        providerId,
        productionStatus: data?.status || "",
        episodeRuntime: data?.runtime || data?.episode_run_time?.[0] || 0,
        totalEpisodes: data?.number_of_episodes || 0,
        tmdbDetailsCache: details
      };
      renderSimpleShowDetail();
      renderTMDBDetails(details);
    } catch (err) {
      console.warn("Could not load TMDB details", err);
      renderShowDetailHeader({ title, thumbnail: "", meta: detailLoadFailure("TMDB", err) });
    }
  } else {
    renderShowDetailHeader({ title, thumbnail: "", meta: "Missing show information." });
  }
}

// Re-syncs a tracked item's show-level metadata (production status, network,
// genres, summary, runtime, thumbnail) from TVmaze whenever its detail page
// is opened online, so changes on the source site — a show ending, moving
// network, new artwork — flow into the local copy. Mutates the item in place
// so the render below picks up the fresh values.


// Pull the full public TVmaze show record and its related collections. TVmaze
// has no reviews endpoint; its user score is the aggregate rating on the show.
// Collections are stored on tracked items so cast/crew and the gallery remain
// visible offline after the first successful load.

















































function applyEpisodesToState(episodes, existingItem) {
  showDetailState.episodes = episodes;
  const seasonSet = new Set(episodes.map(ep => parseInt(ep.season, 10)).filter(Number.isFinite));
  showDetailState.seasons = Array.from(seasonSet).sort((a, b) => a - b);
  if (existingItem) {
    showDetailState.watchedEpisodeIds = existingItem.watchedEpisodeIds || [];
  }
  if (showDetailState.activeSeason === null || !showDetailState.seasons.includes(showDetailState.activeSeason)) {
    // Open on the first season that still has something unwatched, so a show
    // with 7 finished seasons lands on season 8 instead of season 1. Fully
    // watched shows fall back to the last season.
    const watched = new Set(showDetailState.watchedEpisodeIds);
    const firstUnfinished = showDetailState.seasons.find(s => s > 0 &&
      episodes.some(ep => (parseInt(ep.season) || 0) === s && !watched.has(ep.id))
    );
    const regularSeasons = showDetailState.seasons.filter(s => s > 0);
    showDetailState.activeSeason = firstUnfinished ?? regularSeasons[regularSeasons.length - 1] ?? showDetailState.seasons[0] ?? null;
  }
  scheduleNextEpisodeReminder();
}

function updateShowDetailMenu() {
  const btn = document.getElementById("show-detail-delete-btn-top");
  if (!btn) return;

  const item = state.items.find(i => i.id === showDetailState.itemId);
  const canDelete = !!item;
  btn.style.display = canDelete ? "flex" : "none";

  if (!btn.dataset.bound) {
    btn.dataset.bound = "true";
    btn.addEventListener("click", confirmDeleteShowDetailItem);
  }
  if (window.lucide) lucide.createIcons();
}

function confirmDeleteShowDetailItem() {
  const item = state.items.find(i => i.id === showDetailState.itemId);
  if (!item) return;
  const modal = document.getElementById("picker-modal");
  const list = document.getElementById("picker-options-list");
  const titleEl = document.getElementById("picker-modal-title");
  if (!modal || !list || !titleEl) {
    deleteEntry(item.id);
    flushPendingSave();
    window.location.href = "static/pages/main/dashboard.html";
    return;
  }

  titleEl.textContent = "Delete this tracker?";
  list.innerHTML = "";

  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.className = "picker-option";
  confirmBtn.innerHTML = `<i data-lucide="trash-2" class="picker-option-check" style="visibility:visible; color: var(--danger);"></i><span style="color: var(--danger);">Delete</span>`;
  confirmBtn.addEventListener("click", () => {
    closeSettingsPicker();
    deleteEntry(item.id);
    flushPendingSave();
    window.location.href = "static/pages/main/dashboard.html";
  });
  list.appendChild(confirmBtn);

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "picker-option";
  cancelBtn.innerHTML = `<i data-lucide="x" class="picker-option-check" style="visibility:visible;"></i><span>Cancel</span>`;
  cancelBtn.addEventListener("click", closeSettingsPicker);
  list.appendChild(cancelBtn);

  modal.classList.add("active");
  if (window.lucide) lucide.createIcons();
}

function renderWikidataCoreDetails(entity, providerId, fallbackTitle = "Title") {
  const claims = entity.claims || {};
  const value = propertyId => wikidataClaimValues(claims, propertyId)[0];
  const releaseTime = value("P577")?.time || "";
  const releaseYear = releaseTime.replace(/^\+/, "").slice(0, 4);
  const runtime = Number.parseFloat(String(value("P2047")?.amount || "").replace(/^\+/, "")) || 0;
  const image = value("P18");
  const thumbnail = image ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(image)}?width=640` : "";
  showDetailState.show = {
    title: entity.labels?.en?.value || fallbackTitle,
    thumbnail,
    meta: [releaseYear, runtime ? formatRuntimeHM(runtime) : ""].filter(Boolean).join(" · "),
    summary: entity.descriptions?.en?.value || "",
    providerId,
    wikidataDetailsCache: null
  };
  renderSimpleShowDetail();
  const section = document.getElementById("wikidata-extra-section");
  if (section) {
    section.style.display = "block";
    section.innerHTML = '<section class="tvmaze-detail-block"><h2>Wikidata record</h2><p>Loading linked labels and supporting details…</p></section>';
  }
}

function loadWikidataSuggestionsInBackground(providerId, details, itemId = "") {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Wikidata suggestions timed out")), 12000));
  Promise.race([fetchWikidataSuggestions(providerId), timeout]).then(suggestions => {
    if (String(showDetailState.show?.providerId) !== String(providerId)) return;
    details.suggestions = suggestions || [];
    showDetailState.show.wikidataDetailsCache = details;
    const item = itemId ? state.items.find(entry => entry.id === itemId) : null;
    if (item) {
      item.wikidataDetailsCache = details;
      saveData();
    }
    renderWikidataDetails(details);
  }).catch(error => console.warn("Could not load Wikidata genre suggestions", error));
}

function renderOpenLibraryCoreDetails(details, fallbackTitle = "Book", itemId = "") {
  const work = details.work || {};
  showDetailState.show = {
    title: work.title || fallbackTitle,
    thumbnail: details.thumbnail || "",
    meta: [details.publishYear, (details.authors || []).map(author => author.name).join(", "), details.rating ? `★ ${details.rating}/5` : ""].filter(Boolean).join(" · "),
    summary: details.summary || "",
    genres: details.subjects || [],
    providerId: details.workId,
    openlibraryDetailsCache: details
  };
  if (itemId) showDetailState.itemId = itemId;
  renderOpenLibraryDetails(details);
  renderSimpleShowDetail();
}

// Shared render for providers with no episode/season feed — just header +
// status/list/rating/notes, and book-progress fields when the category calls
// for them (manga/novel from AniList/Jikan/Kitsu/Google Books).
function renderSimpleShowDetail() {
  renderShowDetailHeader(showDetailState.show);
  renderStatusPicker(null);
  renderAddToListPicker();
  if (BOOK_TRACKED_CATEGORIES.includes(showDetailState.category)) {
    renderBookProgressSection(null);
  }
  renderRatingWidget(null);
  renderNotesField(null);
  renderRelatedTitles(showDetailState.show);
}

function renderSteamExtra(game, steamUrl, steamDbUrl) {
  const section = document.getElementById("steam-extra-section");
  if (!section) return;
  const screenshots = (game?.screenshots || []).slice(0, 20);
  section.style.display = "block";
  const price = game?.price_overview;
  const currentPrice = price?.final_formatted || (game?.is_free ? "Free" : "Price unavailable");
  const storeImage = game?.header_image || "";
  section.innerHTML = `
    ${game ? `<div class="steam-price-card">
      <div class="steam-price-card-heading">${game.is_free ? "Play" : "Buy"} ${game.name || "this game"} <span>on Steam</span></div>
      <div class="steam-price-card-body">
        ${storeImage ? `<img src="${storeImage}" alt="${game.name || "Game"}" loading="lazy">` : ""}
        <p>${stripHtml(game.short_description || "Open the Steam store page for the latest offer and availability.")}</p>
      </div>
      <div class="steam-price-card-footer"><strong>${currentPrice}</strong><a class="btn btn-primary" href="${steamUrl}" target="_blank" rel="noopener">${game.is_free ? "Play on Steam" : "Buy on Steam"}</a></div>
    </div>` : ""}
    <div class="steam-link-row">
      <a class="btn btn-secondary" href="${steamDbUrl}" target="_blank" rel="noopener">View in SteamDB</a>
    </div>
    ${screenshots.length ? `<div class="show-detail-section-title">Screenshots</div><div class="steam-screenshots">${screenshots.map((image, index) => `<button type="button" class="steam-screenshot-thumb" data-steam-screenshot-index="${index}"><img src="${image.path_thumbnail || image.path_full}" loading="lazy" alt="Game screenshot"></button>`).join("")}</div>` : ""}
  `;
  section.querySelectorAll("[data-steam-screenshot-index]").forEach(button => button.addEventListener("click", () => openSteamScreenshotGallery(screenshots, Number(button.dataset.steamScreenshotIndex))));
}

let steamScreenshotGallery = [];
let steamScreenshotIndex = 0;
function openSteamScreenshotGallery(images, index) {
  steamScreenshotGallery = images || [];
  steamScreenshotIndex = Math.max(0, Math.min(index, steamScreenshotGallery.length - 1));
  document.getElementById("steam-screenshot-modal")?.classList.add("active");
  renderSteamScreenshotGallery();
}
function renderSteamScreenshotGallery() {
  const image = steamScreenshotGallery[steamScreenshotIndex];
  const img = document.getElementById("steam-screenshot-modal-img");
  if (img && image) img.src = image.path_full || image.path_thumbnail || "";
}
function closeSteamScreenshotGallery() { document.getElementById("steam-screenshot-modal")?.classList.remove("active"); }
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("steam-screenshot-close")?.addEventListener("click", closeSteamScreenshotGallery);
  document.getElementById("steam-screenshot-modal")?.addEventListener("click", e => { if (e.target.id === "steam-screenshot-modal") closeSteamScreenshotGallery(); });
  document.getElementById("steam-screenshot-prev")?.addEventListener("click", () => { if (steamScreenshotGallery.length) { steamScreenshotIndex = (steamScreenshotIndex - 1 + steamScreenshotGallery.length) % steamScreenshotGallery.length; renderSteamScreenshotGallery(); } });
  document.getElementById("steam-screenshot-next")?.addEventListener("click", () => { if (steamScreenshotGallery.length) { steamScreenshotIndex = (steamScreenshotIndex + 1) % steamScreenshotGallery.length; renderSteamScreenshotGallery(); } });
});

function stripHtml(html) {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent || div.innerText || "";
}

function applyThumbnailBackdrop(header, thumbnail) {
  if (!header || !thumbnail) return;
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.onload = () => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 24;
      canvas.height = 24;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let r = 0; let g = 0; let b = 0; let weightTotal = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        const alpha = pixels[index + 3];
        if (alpha < 100) continue;
        const red = pixels[index] / 255;
        const green = pixels[index + 1] / 255;
        const blue = pixels[index + 2] / 255;
        const max = Math.max(red, green, blue);
        const min = Math.min(red, green, blue);
        const saturation = max === 0 ? 0 : (max - min) / max;
        const weight = 0.35 + saturation * 2.4;
        r += pixels[index] * weight;
        g += pixels[index + 1] * weight;
        b += pixels[index + 2] * weight;
        weightTotal += weight;
      }
      if (!weightTotal) return;
      const color = `rgb(${Math.round(r / weightTotal)}, ${Math.round(g / weightTotal)}, ${Math.round(b / weightTotal)})`;
      header.style.setProperty("--detail-thumb-color", color);
      header.classList.add("has-thumbnail-backdrop");
    } catch (error) {
      // Cross-origin artwork may not be readable; keep the normal theme card.
    }
  };
  image.src = thumbnail;
}

function renderShowDetailHeader(show) {
  const localItem = state.items.find(item => item.id === showDetailState.itemId) || {};
  const runtimeMinutes = show.episodeRuntime || show.playtime || localItem.episodeRuntime || localItem.playtime || 0;
  const fallbackMeta = [
    CATEGORIES[show.category || showDetailState.category]?.label || "",
    runtimeMinutes ? `~${formatRuntimeHM(runtimeMinutes)}${EPISODE_TRACKED_CATEGORIES.includes(show.category || showDetailState.category) ? "/ep" : ""}` : "",
    show.network || localItem.network || ""
  ].filter(Boolean).join(" · ");
  document.getElementById("show-detail-topbar-title").textContent = show.title || "";
  document.getElementById("show-detail-meta").textContent = show.meta || fallbackMeta;

  const categoryEl = document.getElementById("show-detail-topbar-category");
  if (categoryEl) categoryEl.textContent = CATEGORIES[showDetailState.category]?.label || "";

  const thumbWrap = document.getElementById("show-detail-thumb-wrap");
  const detailHeader = document.querySelector(".show-detail-header");
  detailHeader?.classList.remove("has-thumbnail-backdrop");
  applyThumbnailBackdrop(detailHeader, show.thumbnail);
  thumbWrap.innerHTML = thumbnailOrPlaceholder(show.thumbnail, "show-detail-thumb");
  if (show.thumbnail) {
    thumbWrap.classList.add("show-detail-poster-clickable");
    thumbWrap.onclick = () => openEpisodeImageModal(show.thumbnail);
  } else {
    thumbWrap.classList.remove("show-detail-poster-clickable");
    thumbWrap.onclick = null;
  }

  const summaryEl = document.getElementById("show-detail-summary");
  if (summaryEl) {
    if (show.summary) {
      summaryEl.textContent = show.summary;
      summaryEl.style.display = "block";
    } else {
      summaryEl.textContent = "";
      summaryEl.style.display = "none";
    }
  }

  const badgeEl = document.getElementById("show-detail-production-badge");
  if (badgeEl) {
    if (show.productionStatus) {
      badgeEl.textContent = show.productionStatus;
      badgeEl.className = `show-detail-production-badge show-detail-production-badge-${productionStatusSlug(show.productionStatus)}`;
      badgeEl.style.display = "inline-block";
    } else {
      badgeEl.textContent = "";
      badgeEl.style.display = "none";
    }
  }

  const sourceBadgeEl = document.getElementById("show-detail-source-badge");
  if (sourceBadgeEl) {
    const key = showDetailState.provider;
    const sourceName = key ? ((typeof BUILTIN_METADATA_SOURCES !== "undefined" && BUILTIN_METADATA_SOURCES[key]?.name) || key) : "";
    if (sourceName) {
      sourceBadgeEl.textContent = sourceName;
      sourceBadgeEl.style.display = "inline-block";
    } else {
      sourceBadgeEl.textContent = "";
      sourceBadgeEl.style.display = "none";
    }
  }

  const cacheBadge = document.getElementById("show-detail-cache-badge");
  const hasCachedMetadata = Boolean(localItem && (localItem.summary || localItem.thumbnail || localItem.metadataSource || localItem.episodesCache?.length));
  if (cacheBadge) {
    cacheBadge.style.display = hasCachedMetadata ? "inline-flex" : "none";
    const offline = typeof cueMarkIsOffline === "function" ? cueMarkIsOffline() : navigator.onLine === false;
    cacheBadge.title = offline ? "Showing saved metadata while offline" : "Metadata saved on this device";
    cacheBadge.innerHTML = `<i data-lucide="${offline ? "wifi-off" : "database"}"></i> ${offline ? "Offline cache" : "Cached metadata"}`;
  }

  renderShowDetailProgress(show, localItem);
  renderPrimaryDetailActions();
  renderRelatedTitles(localItem || show);

  if (window.lucide) lucide.createIcons();
}

function showDetailProgress(item) {
  if (!item || typeof calculateProgress !== "function") return 0;
  return Math.max(0, Math.min(100, Number(calculateProgress(item)) || 0));
}

function renderShowDetailProgress(show, localItem) {
  const bar = document.getElementById("show-detail-progress-bar");
  const label = document.getElementById("show-detail-progress-label");
  const wrapper = bar?.closest(".show-detail-progress-wrap");
  const category = localItem?.category || show?.category || showDetailState.category;
  const isCompletedMovie = category === "movie" && localItem?.status === "Completed";
  const showProgress = category !== "movie" || isCompletedMovie;
  if (wrapper) wrapper.style.display = showProgress ? "" : "none";
  const progress = showDetailProgress(localItem || show);
  if (bar) bar.style.width = `${progress}%`;
  if (label) label.textContent = showProgress && localItem ? `${progress}% complete` : "";
}

function nextDetailEpisode() {
  const watched = new Set(showDetailState.watchedEpisodeIds || []);
  return [...showDetailState.episodes]
    .filter(episode => !watched.has(episode.id))
    .sort((a, b) => {
      const season = episodeSeasonOrder(a) - episodeSeasonOrder(b);
      return season || ((parseInt(a.number) || 0) - (parseInt(b.number) || 0));
    })[0] || null;
}

function episodeSeasonOrder(episode) {
  const season = parseInt(episode?.season, 10) || 0;
  return season === 0 ? Number.MAX_SAFE_INTEGER : season;
}

function renderPrimaryDetailActions() {
  const root = document.getElementById("show-detail-primary-actions");
  const nextButton = document.getElementById("show-detail-next-episode-btn");
  const previousButton = document.getElementById("show-detail-mark-previous-btn");
  const offlineButton = document.getElementById("show-detail-offline-download-btn");
  const visible = showDetailState.episodes.length > 0 || Boolean(showDetailState.show);
  if (root) root.style.display = visible ? "flex" : "none";
  if (!visible || !nextButton || !previousButton || !offlineButton) return;
  const next = nextDetailEpisode();
  const hasEpisodes = showDetailState.episodes.length > 0;
  nextButton.style.display = hasEpisodes ? "inline-flex" : "none";
  previousButton.style.display = hasEpisodes ? "inline-flex" : "none";
  nextButton.disabled = !next;
  nextButton.querySelector("span").textContent = next ? `Next: Episode ${next.number || "next"}` : "All episodes watched";
  previousButton.disabled = !next;
  nextButton.onclick = () => {
    if (!next) return;
    const nextSeason = parseInt(next.season, 10);
    showDetailState.activeSeason = Number.isFinite(nextSeason) ? nextSeason : showDetailState.activeSeason;
    const seasonLabel = document.getElementById("show-detail-season-btn-label");
    if (seasonLabel) seasonLabel.textContent = seasonDisplayName(showDetailState.activeSeason);
    showDetailState.episodeFilter = "all";
    renderEpisodeList();
    const nextRow = Array.from(document.querySelectorAll("[data-episode-id]")).find(row => String(row.dataset.episodeId) === String(next.id));
    // Selecting Next should open the episode's synopsis as well as navigating
    // to its season, so the user lands on the actual next episode details.
    nextRow?.classList.add("expanded");
    nextRow?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  previousButton.onclick = () => {
    if (!next) return;
    const sorted = [...showDetailState.episodes].sort((a, b) => {
      const season = episodeSeasonOrder(a) - episodeSeasonOrder(b);
      return season || ((parseInt(a.number) || 0) - (parseInt(b.number) || 0));
    });
    const nextIndex = sorted.findIndex(episode => episode.id === next.id);
    const watched = new Set(showDetailState.watchedEpisodeIds || []);
    sorted.slice(0, Math.max(0, nextIndex)).forEach(episode => watched.add(episode.id));
    showDetailState.watchedEpisodeIds = Array.from(watched);
    ensureLocalItem({ watchedEpisodeIds: showDetailState.watchedEpisodeIds, episodesDone: showDetailState.watchedEpisodeIds.length, totalEpisodes: showDetailState.episodes.length });
    renderEpisodeList();
    renderPrimaryDetailActions();
    renderShowDetailProgress(showDetailState.show, state.items.find(item => item.id === showDetailState.itemId));
  };
  const currentItem = state.items.find(item => item.id === showDetailState.itemId);
  const isAdded = Boolean(currentItem);
  offlineButton.querySelector("span").textContent = isAdded ? "Added to dashboard" : "Add to dashboard";
  offlineButton.classList.toggle("active", isAdded);
  offlineButton.onclick = () => {
    if (!state.items.find(item => item.id === showDetailState.itemId)) {
      ensureLocalItem({});
      const created = state.items[state.items.length - 1];
      showDetailState.itemId = created.id;
      showDetailState.mode = "local";
      updateShowDetailMenu();
    }
    offlineButton.querySelector("span").textContent = "Added to dashboard";
    offlineButton.classList.add("active");
  };
}

async function downloadCurrentItemForOffline() {
  if (typeof cueMarkIsOffline === "function" ? cueMarkIsOffline() : navigator.onLine === false) {
    if (showDetailState.show?.title) queueMetadataUpdate(showDetailState.category, showDetailState.show.title, showDetailState.itemId || "");
    const notice = document.getElementById("show-detail-offline-notice");
    if (notice) { notice.textContent = "You are offline. This title will be queued for download when you reconnect."; notice.style.display = "block"; }
    return;
  }
  const currentItem = state.items.find(entry => entry.id === showDetailState.itemId) || {};
  const show = { ...currentItem, ...(showDetailState.show || {}) };
  let offlineThumbnail = show.thumbnail || currentItem.thumbnail || "";
  if (thumbnailsEnabled() && offlineThumbnail && !offlineThumbnail.startsWith("data:")) {
    try {
      const response = await fetch(offlineThumbnail);
      if (response.ok) {
        const blob = await response.blob();
        offlineThumbnail = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ""));
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }
    } catch (err) {
      console.warn("Could not save thumbnail for offline use", err);
    }
  }
  ensureLocalItem({
    summary: show.summary || currentItem.summary || "",
    thumbnail: thumbnailsEnabled() ? offlineThumbnail : (currentItem.thumbnail || ""),
    genres: show.genres || currentItem.genres || [],
    network: show.network || currentItem.network || "",
    metadataSource: showDetailState.provider || "",
    providerId: show.providerId || null,
    episodesCache: showDetailState.episodes.length ? showDetailState.episodes : (showDetailState.pendingEpisodesCache || []),
    metadataCached: true,
    offlineAvailableAt: Date.now()
  });
  const item = state.items.find(entry => entry.id === showDetailState.itemId);
  if (item) {
    item.metadataCached = true;
    item.offlineAvailableAt = Date.now();
    saveData();
  }
  showDetailState.show = { ...show, thumbnail: offlineThumbnail || show.thumbnail || "" };
  renderPrimaryDetailActions();
  renderShowDetailHeader(show);
}

function renderProviderRelatedTitles(items) {
  const root = document.getElementById("show-detail-related-section");
  const list = document.getElementById("show-detail-related-list");
  if (!root || !list || !Array.isArray(items) || !items.length) {
    if (root) root.style.display = "none";
    return;
  }
  root.style.display = "block";
  list.innerHTML = items.slice(0, 6).map(item => `<button type="button" class="show-detail-related-card" data-related-url="${encodeURIComponent(item.url || "")}">${thumbnailOrPlaceholder(item.thumbnail, "show-detail-related-thumb")}<span>${detailText(item.title)}</span><small>${detailText(item.meta || "Online recommendation")}</small></button>`).join("");
  list.querySelectorAll("[data-related-url]").forEach(card => card.addEventListener("click", () => {
    const url = decodeURIComponent(card.dataset.relatedUrl || "");
    if (url) window.location.href = url;
  }));
}

async function loadProviderRecommendations(current) {
  const root = document.getElementById("show-detail-related-section");
  if (!root || !current) return;
  const provider = showDetailState.provider || current.metadataSource || (current.tvmazeShowId ? "tvmaze" : "");
  const providerId = current.tvmazeShowId || current.providerId;
  if (!providerId) {
    root.style.display = "none";
    return;
  }

  try {
    let recommendations = [];
    if (provider === "tvmaze") {
      recommendations = await fetchTvmazeRecommendations(current);
    } else if (provider === "jikan") {
      const type = showDetailState.category === "manga" ? "manga" : "anime";
      const cached = current.jikanDetailsCache?.recommendations;
      const response = cached ? null : await fetchJikanJson(`https://api.jikan.moe/v4/${type}/${encodeURIComponent(providerId)}/recommendations`);
      recommendations = (cached || response?.data || []).map(item => item.entry || item).map(show => ({
        title: show.title || "Untitled",
        thumbnail: show.images?.jpg?.image_url || "",
        meta: "MyAnimeList recommendation",
        url: `static/pages/main/show-detail.html?category=${encodeURIComponent(showDetailState.category)}&provider=jikan&providerId=${encodeURIComponent(show.mal_id)}&title=${encodeURIComponent(show.title || "")}`
      }));
    } else if (provider === "kitsu") {
      recommendations = (current.kitsuDetailsCache?.recommendations || []).map(({ relation, media }) => ({
        title: media.attributes?.canonicalTitle || media.attributes?.titles?.en || media.attributes?.titles?.en_jp || "Untitled",
        thumbnail: media.attributes?.posterImage?.small || media.attributes?.posterImage?.medium || "",
        meta: `Kitsu · ${relation}`,
        url: `static/pages/main/show-detail.html?category=${encodeURIComponent(showDetailState.category)}&provider=kitsu&providerId=${encodeURIComponent(media.id)}&title=${encodeURIComponent(media.attributes?.canonicalTitle || media.attributes?.titles?.en || "")}`
      }));
    } else if (provider === "anilist") {
      const cachedRecommendations = current.anilistDetailsCache?.media?.recommendations?.nodes;
      const recommendationNodes = cachedRecommendations || await fetchAniListRecommendations(providerId);
      recommendations = recommendationNodes.map(node => node.mediaRecommendation).filter(Boolean).map(show => ({
        title: show.title?.english || show.title?.romaji || "Untitled",
        thumbnail: show.coverImage?.medium || "",
        meta: "AniList recommendation",
        url: `static/pages/main/show-detail.html?category=${encodeURIComponent(showDetailState.category)}&provider=anilist&providerId=${encodeURIComponent(show.id)}&title=${encodeURIComponent(show.title?.english || show.title?.romaji || "")}`
      }));
    } else if (provider === "wikidata") {
      recommendations = (current.wikidataDetailsCache?.related || []).map(item => ({
        title: item.label,
        thumbnail: item.thumbnail ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(item.thumbnail)}?width=320` : "",
        meta: item.relationship,
        url: `static/pages/main/show-detail.html?category=${encodeURIComponent(showDetailState.category)}&provider=wikidata&providerId=${encodeURIComponent(item.id)}&title=${encodeURIComponent(item.label)}`
      }));
    } else if (provider === "openlibrary") {
      recommendations = (current.openlibraryDetailsCache?.recommendations || []).map(book => ({
        title: book.title,
        thumbnail: book.thumbnail || "",
        meta: [book.subject, book.authors?.map(author => author.name).join(", ")].filter(Boolean).join(" · ") || "Open Library subject match",
        url: `static/pages/main/show-detail.html?category=${encodeURIComponent(showDetailState.category)}&provider=openlibrary&providerId=${encodeURIComponent(book.workId)}&title=${encodeURIComponent(book.title)}`
      }));
    } else if (provider === "freetogame") {
      recommendations = (current.freetogameDetailsCache?.recommendations || []).map(game => ({
        title: game.title,
        thumbnail: game.thumbnail || "",
        meta: [game.genre, game.platform, game.releaseDate].filter(Boolean).join(" · ") || "Similar FreeToGame title",
        url: `static/pages/main/show-detail.html?category=game&provider=freetogame&providerId=${encodeURIComponent(game.id)}&title=${encodeURIComponent(game.title)}`
      }));
    }

    const currentTitle = String(current.title || "").toLowerCase();
    const localTitles = new Set(state.items.map(item => String(item.title || "").toLowerCase()));
    recommendations = recommendations.filter(item => {
      const title = String(item.title || "").toLowerCase();
      return title && title !== currentTitle && !localTitles.has(title);
    });
    recommendations = Array.from(new Map(recommendations.map(item => [String(item.title).toLowerCase(), item])).values());
    renderProviderRelatedTitles(recommendations);
  } catch (err) {
    console.warn("Could not load provider recommendations", err);
    root.style.display = "none";
  }
}

function renderRelatedTitles(current) {
  const root = document.getElementById("show-detail-related-section");
  if (!root || !current) return;
  const provider = showDetailState.provider || current.metadataSource || (current.tvmazeShowId ? "tvmaze" : "");
  const providerId = current.tvmazeShowId || current.providerId || "";
  const requestKey = `${provider}:${providerId}:${current.title || ""}`;
  if (showDetailState.relatedRequestKey === requestKey) return;
  showDetailState.relatedRequestKey = requestKey;
  root.style.display = "none";
  loadProviderRecommendations(current);
}

function detailText(value) {
  return String(value || "").replace(/[&<>\"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[character]));
}

function productionStatusSlug(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "running") return "running";
  if (normalized === "ended") return "ended";
  if (normalized === "in development") return "development";
  return "unknown";
}

function showTrackingGroup() {
  const title = document.getElementById("show-detail-tracking-title");
  const group = document.getElementById("show-detail-tracking-group");
  if (title) title.style.display = "block";
  if (group) group.style.display = "block";
}

function renderAddToListPicker() {
  const row = document.getElementById("show-detail-addlist-row");
  const valueEl = document.getElementById("show-detail-addlist-value");
  const select = document.getElementById("show-detail-addlist");
  if (!row || !select || !valueEl) return;

  const enabledCategories = getEnabledOrderedCategories();
  const options = enabledCategories.includes(showDetailState.category)
    ? enabledCategories
    : [showDetailState.category, ...enabledCategories].filter(Boolean);
  select.innerHTML = `<option value="">Select a list…</option>` +
    options.map(cat => `<option value="${cat}">${CATEGORIES[cat].label}</option>`).join("");
  select.value = showDetailState.category || "";
  valueEl.textContent = CATEGORIES[showDetailState.category]?.label || "Select a list…";
  row.style.display = "flex";
  showTrackingGroup();

  const applyChoice = (cat) => {
    if (!cat || !CATEGORIES[cat]) return;
    showDetailState.category = cat;
    ensureLocalItem({ category: cat });
    renderStatusPicker(state.items.find(i => i.id === showDetailState.itemId));
    renderAddToListPicker();
    renderSeasonSection();
  };

  select.onchange = () => applyChoice(select.value);

  row.onclick = () => {
    const modal = document.getElementById("picker-modal");
    const list = document.getElementById("picker-options-list");
    const titleEl = document.getElementById("picker-modal-title");
    if (!modal || !list) return;
    if (titleEl) titleEl.textContent = "Add to list";
    list.innerHTML = "";
    options.forEach(cat => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `picker-option${cat === showDetailState.category ? " active" : ""}`;
      btn.innerHTML = `<i data-lucide="check" class="picker-option-check"></i><span>${CATEGORIES[cat].label}</span>`;
      btn.addEventListener("click", () => {
        closeSettingsPicker();
        applyChoice(cat);
      });
      list.appendChild(btn);
    });
    modal.classList.add("active");
    lucide.createIcons();
  };
}

function renderRatingWidget(existingItem) {
  const title = document.getElementById("show-detail-rating-title");
  const group = document.getElementById("show-detail-rating-group");
  const container = document.getElementById("show-detail-rating-widget");
  if (!group || !container) return;

  if (title) title.style.display = "block";
  group.style.display = "block";
  const currentRating = existingItem?.rating || 0;
  const format = state.preferences.ratingFormat || "5-stars";

  const save = (rating) => {
    ensureLocalItem({ rating });
  };

  if (format === "5-stars") {
    container.innerHTML = `<div class="rating-container" id="show-detail-stars-picker">` +
      [1, 2, 3, 4, 5].map(i => `<i class="star${i <= currentRating ? " active" : ""}" style="fill:${i <= currentRating ? "currentColor" : "none"}" data-rating="${i}" data-lucide="star"></i>`).join("") +
      `</div>`;
    if (window.lucide) lucide.createIcons();
    container.querySelectorAll(".star").forEach(star => {
      star.addEventListener("click", () => {
        const val = parseInt(star.getAttribute("data-rating"), 10);
        save(val);
        renderRatingWidget(state.items.find(i => i.id === showDetailState.itemId) || { rating: val });
      });
    });
  } else {
    const maxRating = format === "100-points" ? 100 : 10;
    const step = format === "10-decimal" ? "0.1" : "1";
    const displayValue = format === "100-points" ? Math.round(currentRating * 20) : Math.round(currentRating * 2);
    container.innerHTML = `<input type="number" id="show-detail-rating-score" class="form-control" min="0" max="${maxRating}" step="${step}" value="${displayValue || ""}">`;
    const input = document.getElementById("show-detail-rating-score");
    input.addEventListener("change", () => {
      save(ratingToStoredValue(input.value));
    });
  }
}

function renderNotesField(existingItem) {
  const title = document.getElementById("show-detail-notes-title");
  const group = document.getElementById("show-detail-notes-group");
  const textarea = document.getElementById("show-detail-notes");
  if (!group || !textarea) return;

  if (title) title.style.display = "block";
  group.style.display = "block";
  textarea.value = existingItem?.notes || "";
  const toggle = document.getElementById("show-detail-notes-toggle");
  if (toggle) {
    group.classList.toggle("collapsed", !existingItem?.notes);
    toggle.querySelector("span").textContent = existingItem?.notes ? "Collapse notes" : "Expand notes";
    toggle.onclick = () => {
      group.classList.toggle("collapsed");
      toggle.querySelector("span").textContent = group.classList.contains("collapsed") ? "Expand notes" : "Collapse notes";
    };
  }
  textarea.onchange = () => {
    ensureLocalItem({ notes: textarea.value });
  };
  if (window.lucide) lucide.createIcons();
}

function renderStatusPicker(existingItem) {
  const row = document.getElementById("show-detail-status-row");
  const valueEl = document.getElementById("show-detail-status-value");
  const select = document.getElementById("show-detail-status");
  if (!row || !select || !valueEl) return;

  const category = showDetailState.category;
  const config = CATEGORIES[category];
  if (!config) return;

  select.innerHTML = config.statuses.map(st => `<option value="${st}">${st}</option>`).join("");
  const currentStatus = existingItem?.status || config.statuses[0];
  select.value = currentStatus;
  valueEl.textContent = currentStatus;
  row.style.display = "flex";
  showTrackingGroup();

  renderCompletionDatePicker(existingItem, currentStatus);

  const applyChoice = (status) => {
    select.value = status;
    valueEl.textContent = status;
    renderCompletionDatePicker(existingItem, status);
    const compDateInput = document.getElementById("show-detail-compdate");
    ensureLocalItem({ status, completionDate: compDateInput ? compDateInput.value : (existingItem?.completionDate || "") });
  };

  select.onchange = () => applyChoice(select.value);

  row.onclick = () => {
    const modal = document.getElementById("picker-modal");
    const list = document.getElementById("picker-options-list");
    const titleEl = document.getElementById("picker-modal-title");
    if (!modal || !list) return;
    if (titleEl) titleEl.textContent = "Status";
    list.innerHTML = "";
    config.statuses.forEach(st => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `picker-option${st === select.value ? " active" : ""}`;
      btn.innerHTML = `<i data-lucide="check" class="picker-option-check"></i><span>${st}</span>`;
      btn.addEventListener("click", () => {
        closeSettingsPicker();
        applyChoice(st);
      });
      list.appendChild(btn);
    });
    modal.classList.add("active");
    lucide.createIcons();
  };
}

function renderCompletionDatePicker(existingItem, status) {
  const row = document.getElementById("show-detail-compdate-row");
  const input = document.getElementById("show-detail-compdate");
  if (!row || !input) return;

  if (status !== "Completed") {
    row.style.display = "none";
    return;
  }

  row.style.display = "flex";
  if (!input.value) {
    input.value = existingItem?.completionDate || new Date().toISOString().split("T")[0];
  }

  input.onchange = () => {
    ensureLocalItem({ completionDate: input.value });
  };
}

function seasonDisplayName(season) {
  return Number(season) === 0 ? "Specials" : `Season ${season}`;
}

function renderSeasonSection() {
  const section = document.getElementById("show-detail-season-section");
  const seasonBtn = document.getElementById("show-detail-season-select");
  const seasonBtnLabel = document.getElementById("show-detail-season-btn-label");
  if (!section || !seasonBtn || !seasonBtnLabel) return;

  if (!EPISODE_TRACKED_CATEGORIES.includes(showDetailState.category) || showDetailState.seasons.length === 0) {
    section.style.display = "none";
    return;
  }

  section.style.display = "block";
  seasonBtnLabel.textContent = seasonDisplayName(showDetailState.activeSeason);

  seasonBtn.onclick = () => {
    const modal = document.getElementById("picker-modal");
    const list = document.getElementById("picker-options-list");
    const titleEl = document.getElementById("picker-modal-title");
    if (!modal || !list) return;
    if (titleEl) titleEl.textContent = "Select season";
    list.innerHTML = "";
    showDetailState.seasons.forEach(s => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `picker-option${s === showDetailState.activeSeason ? " active" : ""}`;
      btn.innerHTML = `<i data-lucide="check" class="picker-option-check"></i><span>${detailText(seasonDisplayName(s))}</span>`;
      btn.addEventListener("click", () => {
        closeSettingsPicker();
        showDetailState.activeSeason = s;
        seasonBtnLabel.textContent = seasonDisplayName(s);
        renderEpisodeList();
      });
      list.appendChild(btn);
    });
    modal.classList.add("active");
    lucide.createIcons();
  };

  renderEpisodeList();
  scheduleNextEpisodeReminder();
}

async function scheduleNextEpisodeReminder() {
  if (!state.preferences.notificationEpisodeReminders || !state.preferences.notificationsEnabled || isNotificationQuietHours()) return;
  const notifications = window.Capacitor?.Plugins?.Notifications;
  if (!notifications?.schedule) return;
  const watched = new Set(showDetailState.watchedEpisodeIds || []);
  const next = [...showDetailState.episodes]
    .filter(ep => ep.airdate && !watched.has(ep.id))
    .sort((a, b) => String(a.airdate).localeCompare(String(b.airdate)))[0];
  if (!next) return;
  const date = new Date(`${next.airdate}T09:00:00`);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) return;
  const item = state.items.find(entry => entry.id === showDetailState.itemId);
  const title = item?.title || showDetailState.show?.title || "Tracked show";
  const id = Math.abs([...`${showDetailState.itemId || title}:${next.id}`].reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0));
  try {
    await notifications.schedule({
      id: id || 1,
      at: date.getTime(),
      title: `${title}: new episode`,
      body: `Episode ${next.number || "next"} is scheduled for ${next.airdate}.`,
      itemId: showDetailState.itemId || "",
      actionUrl: showDetailState.itemId ? `static/pages/main/show-detail.html?source=local&itemId=${encodeURIComponent(showDetailState.itemId)}` : "",
      snoozeMinutes: state.preferences.notificationSnoozeMinutes || 60
    });
  } catch (err) {
    console.warn("Could not schedule episode reminder", err);
  }
}

function renderEpisodeList() {
  const list = document.getElementById("show-detail-episode-list");
  if (!list) return;

  const today = new Date().toISOString().slice(0, 10);
  const watchedSet = new Set(showDetailState.watchedEpisodeIds);
  const seasonEpisodes = showDetailState.episodes.filter(ep => (parseInt(ep.season) || 0) === showDetailState.activeSeason);
  const filter = showDetailState.episodeFilter || "all";
  const episodes = seasonEpisodes.filter(ep => {
    if (filter === "watched") return watchedSet.has(ep.id);
    if (filter === "unwatched") return !watchedSet.has(ep.id);
    if (filter === "upcoming") return Boolean(ep.airdate && ep.airdate > today && !watchedSet.has(ep.id));
    if (filter === "filler") return Boolean(ep.filler);
    if (filter === "recap") return Boolean(ep.recap);
    return true;
  });
  document.querySelectorAll("[data-episode-filter]").forEach(button => {
    button.classList.toggle("active", button.dataset.episodeFilter === filter);
  });

  list.innerHTML = episodes.length ? episodes.map(ep => {
    const summary = stripHtml(ep.summary || "");
    const thumbUrl = ep.image?.medium || ep.image?.original || "";
    return `
    <div class="show-detail-episode-row${summary ? " has-summary" : ""}" data-episode-id="${ep.id}">
      <div class="show-detail-episode-row-main">
        <div class="show-detail-episode-thumb-btn" data-thumb-url="${thumbUrl ? encodeURIComponent(ep.image?.original || thumbUrl) : ""}">
          ${thumbnailOrPlaceholder(thumbUrl, "show-detail-episode-thumb")}
        </div>
        <div class="show-detail-episode-body">
          <span class="show-detail-episode-title">${ep.number}. ${ep.name || "Untitled"}</span>
          <span class="show-detail-episode-meta">
            ${ep.airdate ? `<span><i data-lucide="calendar"></i> ${ep.airdate}</span>` : ""}
            ${ep.runtime ? `<span><i data-lucide="clock"></i> ${ep.runtime}m</span>` : ""}
            ${ep.rating?.average ? `<span><i data-lucide="star"></i> ${ep.rating.average}</span>` : ""}
            ${summary ? `<i data-lucide="chevron-down" class="show-detail-episode-expand-caret"></i>` : ""}
          </span>
        </div>
        <button type="button" class="show-detail-episode-check${watchedSet.has(ep.id) ? " checked" : ""}" data-episode-id="${ep.id}" aria-label="Mark episode watched"></button>
      </div>
      ${summary ? `<p class="show-detail-episode-summary">${summary}</p>` : ""}
    </div>
  `;
  }).join("") : `<div class="show-detail-episode-empty">No episodes match this filter.</div>`;

  list.querySelectorAll(".show-detail-episode-check").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const epId = parseInt(btn.dataset.episodeId, 10);
      const nowWatched = !btn.classList.contains("checked");
      toggleEpisodeWatched(epId, nowWatched);
    });
  });

  list.querySelectorAll(".show-detail-episode-thumb-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const url = btn.dataset.thumbUrl;
      if (url) openEpisodeImageModal(decodeURIComponent(url));
    });
  });

  list.querySelectorAll(".show-detail-episode-row.has-summary").forEach(row => {
    row.addEventListener("click", () => {
      row.classList.toggle("expanded");
    });
  });

  if (window.lucide) lucide.createIcons();
}

function openEpisodeImageModal(url) {
  const modal = document.getElementById("episode-image-modal");
  const img = document.getElementById("episode-image-modal-img");
  if (!modal || !img) return;
  img.src = url;
  modal.classList.add("active");
}

function closeEpisodeImageModal() {
  const modal = document.getElementById("episode-image-modal");
  const img = document.getElementById("episode-image-modal-img");
  if (!modal) return;
  modal.classList.remove("active");
  if (img) img.src = "";
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-episode-filter]").forEach(button => button.addEventListener("click", () => {
    showDetailState.episodeFilter = button.dataset.episodeFilter || "all";
    renderEpisodeList();
  }));
  const modal = document.getElementById("episode-image-modal");
  const closeBtn = document.getElementById("episode-image-modal-close");
  if (closeBtn) closeBtn.addEventListener("click", closeEpisodeImageModal);
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeEpisodeImageModal();
    });
  }
});

const BOOK_TRACKED_CATEGORIES = ["manga", "novel"];

function renderBookProgressSection(existingItem) {
  const section = document.getElementById("show-detail-book-progress-section");
  const chaptersRow = document.getElementById("show-detail-chapters-row");
  const minPerChapterGroup = document.getElementById("show-detail-min-per-chapter-group");
  if (!section || !chaptersRow || !minPerChapterGroup) return;

  if (!BOOK_TRACKED_CATEGORIES.includes(showDetailState.category)) {
    section.style.display = "none";
    return;
  }

  section.style.display = "flex";
  const isNovel = showDetailState.category === "novel";
  chaptersRow.style.display = isNovel ? "flex" : "none";
  minPerChapterGroup.style.display = isNovel ? "block" : "none";

  const totalVolumesInput = document.getElementById("show-detail-total-volumes");
  const volumesReadInput = document.getElementById("show-detail-volumes-read");
  const totalChaptersInput = document.getElementById("show-detail-total-chapters");
  const chaptersReadInput = document.getElementById("show-detail-chapters-read");
  const minPerChapterInput = document.getElementById("show-detail-min-per-chapter");

  totalVolumesInput.value = existingItem?.totalVolumes || "";
  volumesReadInput.value = existingItem?.volumesRead || 0;
  totalChaptersInput.value = existingItem?.totalChapters || "";
  chaptersReadInput.value = existingItem?.chaptersRead || 0;
  minPerChapterInput.value = existingItem?.minutesPerChapter || 15;

  const save = () => {
    ensureLocalItem({
      totalVolumes: parseInt(totalVolumesInput.value) || 0,
      volumesRead: parseInt(volumesReadInput.value) || 0,
      totalChapters: parseInt(totalChaptersInput.value) || 0,
      chaptersRead: parseInt(chaptersReadInput.value) || 0,
      minutesPerChapter: parseInt(minPerChapterInput.value) || 15
    });
  };

  [totalVolumesInput, volumesReadInput, totalChaptersInput, chaptersReadInput, minPerChapterInput].forEach(input => {
    input.onchange = save;
  });
}

function toggleEpisodeWatched(episodeId, watched) {
  const set = new Set(showDetailState.watchedEpisodeIds);
  const newlyWatchedIds = [];
  if (watched) {
    set.add(episodeId);
    newlyWatchedIds.push(episodeId);
    const sorted = [...showDetailState.episodes].sort((a, b) => {
      const seasonDiff = (parseInt(a.season) || 0) - (parseInt(b.season) || 0);
      return seasonDiff !== 0 ? seasonDiff : (parseInt(a.number) || 0) - (parseInt(b.number) || 0);
    });
    const tickedIndex = sorted.findIndex(ep => ep.id === episodeId);
    if (tickedIndex !== -1) {
      sorted.slice(0, tickedIndex).forEach(ep => {
        if (!set.has(ep.id)) newlyWatchedIds.push(ep.id);
        set.add(ep.id);
      });
    }
  } else {
    set.delete(episodeId);
  }
  showDetailState.watchedEpisodeIds = Array.from(set);

  const totalEpisodes = showDetailState.episodes.length;
  const episodesDone = showDetailState.watchedEpisodeIds.length;
  const totalSeasons = showDetailState.seasons.length;

  renderEpisodeList();

  if (newlyWatchedIds.length) {
    logEpisodeWatches(newlyWatchedIds);
  }
  scheduleNextEpisodeReminder();

  const updates = {
    watchedEpisodeIds: showDetailState.watchedEpisodeIds,
    episodesDone,
    totalEpisodes,
    totalSeasons
  };

  // Keep status in sync with progress: ticking the final episode completes
  // the show; unticking below full (or starting from the watchlist) moves it
  // to In Progress.
  const currentItem = state.items.find(i => i.id === showDetailState.itemId);
  if (totalEpisodes > 0 && episodesDone >= totalEpisodes) {
    updates.status = "Completed";
    updates.completionDate = currentItem?.completionDate || new Date().toISOString().split("T")[0];
  } else if (episodesDone > 0 && (!currentItem || currentItem.status === "Completed" || currentItem.status === "Watchlist")) {
    updates.status = "In Progress";
    if (currentItem?.status === "Completed") updates.completionDate = "";
  }

  ensureLocalItem(updates);
  renderPrimaryDetailActions();
  renderShowDetailProgress(showDetailState.show, state.items.find(item => item.id === showDetailState.itemId));

  if (updates.status) {
    renderStatusPicker(state.items.find(i => i.id === showDetailState.itemId));
  }
}

// Appends a watch-event entry per newly-ticked episode so Statistics can build
// weekly time-series charts and detect same-day marathons. Only forward-looking
// from when this shipped — episodes ticked before this existed have no entry.
function logEpisodeWatches(episodeIds) {
  if (!Array.isArray(state.watchLog)) state.watchLog = [];
  const item = state.items.find(i => i.id === showDetailState.itemId);
  const runtime = item?.episodeRuntime || showDetailState.show?.episodeRuntime || 0;
  const itemId = showDetailState.itemId;
  const title = item?.title || showDetailState.show?.title || "";
  const now = Date.now();
  episodeIds.forEach(episodeId => {
    state.watchLog.push({ itemId, title, episodeId, runtime, watchedAt: now });
  });
}

// Creates the local tracked item on first interaction (status change or episode
// tick) for an online result, or updates the existing local item otherwise. This
// is the point where an online-only browse becomes a locally-stored, offline-
// available tracked entry.
function ensureLocalItem(extraFields) {
  if (showDetailState.mode === "local" && showDetailState.itemId) {
    const itemIndex = state.items.findIndex(i => i.id === showDetailState.itemId);
    if (itemIndex !== -1) {
      state.items[itemIndex] = { ...state.items[itemIndex], ...extraFields };
      if (extraFields.status === "Completed" && typeof markItemAsCompleted === "function") markItemAsCompleted(state.items[itemIndex]);
      saveData();
      updateShowDetailMenu();
    }
    return;
  }

  // First time this online result is being tracked — create it now.
  const show = showDetailState.show || {};
  const category = showDetailState.category;
  const config = CATEGORIES[category];
  const newItem = {
    id: crypto.randomUUID(),
    title: show.title || "",
    category,
    status: config ? config.statuses[0] : "Backlog",
    rating: 0,
    completionDate: "",
    notes: "",
    created: Date.now(),
    thumbnail: thumbnailsEnabled() ? (show.thumbnail || "") : "",
    summary: show.summary || "",
    network: show.network || "",
    genres: show.genres || [],
    metadataSource: showDetailState.provider || "",
    providerId: show.providerId || null,
    productionStatus: show.productionStatus || "",
    tvmazeShowId: show.tvmazeShowId || null,
    tvmazeDetailsCache: show.tvmazeDetailsCache || null,
    anilistDetailsCache: show.anilistDetailsCache || null,
    anilistFallbackCache: show.anilistFallbackCache || null,
    jikanDetailsCache: show.jikanDetailsCache || null,
    kitsuDetailsCache: show.kitsuDetailsCache || null,
    wikidataDetailsCache: show.wikidataDetailsCache || null,
    openlibraryDetailsCache: show.openlibraryDetailsCache || null,
    freetogameDetailsCache: show.freetogameDetailsCache || null,
    googlebooksDetailsCache: show.googlebooksDetailsCache || null,
    rawgDetailsCache: show.rawgDetailsCache || null,
    omdbDetailsCache: show.omdbDetailsCache || null,
    tmdbDetailsCache: show.tmdbDetailsCache || null,
    mangadexDetailsCache: show.mangadexDetailsCache || null,
    howLongToBeatDetailsCache: show.howLongToBeatDetailsCache || null,
    howLongToReadDetailsCache: show.howLongToReadDetailsCache || null,
    vizDetailsCache: show.vizDetailsCache || null,
    episodeRuntime: show.episodeRuntime || "",
    totalEpisodes: show.totalEpisodes || showDetailState.episodes.length || 0,
    totalVolumes: show.totalVolumes || 0,
    totalChapters: show.totalChapters || 0,
    playtime: show.playtime || "",
    // The active detail state contains the complete season/episode list after
    // metadata loading. The pending cache is only a fallback for older flows;
    // using it first could save a partial Season 1-only payload.
    episodesCache: showDetailState.episodes.length
      ? showDetailState.episodes
      : (showDetailState.pendingEpisodesCache || []),
    ...extraFields
  };
  if (newItem.status === "Completed" && typeof markItemAsCompleted === "function") markItemAsCompleted(newItem);
  state.items.push(newItem);
  saveData();

  showDetailState.mode = "local";
  showDetailState.itemId = newItem.id;
  updateShowDetailMenu();
}

function bootShowDetailWhenReady() {
  if (document.getElementById("show-detail-topbar-title")) {
    const waitForState = () => {
      if (typeof state === "undefined" || !window.cueMarkAppReady) {
        setTimeout(waitForState, 10);
      } else {
        // app.js declares state before restoring the encrypted/local database.
        // Wait for that restore to finish or a local item can appear missing
        // briefly and incorrectly redirect this page to Dashboard.
        Promise.resolve(window.cueMarkAppReady)
          .then(() => initShowDetail())
          .catch(err => {
            console.error("Could not initialize show details", err);
            initShowDetail();
          });
      }
    };
    waitForState();
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootShowDetailWhenReady, { once: true });
} else {
  bootShowDetailWhenReady();
}
