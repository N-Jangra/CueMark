// SquashDB - Show Details: shared detail page for both the Discover (online, not
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

async function fetchSteamJsonPortable(url) {
  const plugin = window.CapacitorHttp || window.Capacitor?.Plugins?.Http || window.Capacitor?.Plugins?.CapacitorHttp;
  if (plugin?.get) {
    const response = await plugin.get({ url, headers: { Accept: "application/json" } });
    if (response?.status && response.status >= 400) throw new Error(`HTTP ${response.status}`);
    return typeof response?.data === "string" ? JSON.parse(response.data) : response.data;
  }
  if (plugin?.request) {
    const response = await plugin.request({ url, method: "GET", headers: { Accept: "application/json" }, responseType: "json" });
    if (response?.status && response.status >= 400) throw new Error(`HTTP ${response.status}`);
    return typeof response?.data === "string" ? JSON.parse(response.data) : response.data;
  }
  if (window.location?.origin && window.location.origin !== "null") {
    const proxyUrl = new URL("/proxy", window.location.origin);
    proxyUrl.searchParams.set("url", url);
    const response = await fetch(proxyUrl.toString());
    if (response.ok) return response.json();
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

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

async function fetchJikanAnimeEpisodes(malId, fallbackThumbnail = "") {
  const episodes = [];
  let page = 1;
  let hasNextPage = true;

  while (hasNextPage && page <= 5) {
    const res = await fetch(`https://api.jikan.moe/v4/anime/${malId}/episodes?page=${page}`);
    if (!res.ok) break;
    const data = await res.json();
    const items = Array.isArray(data?.data) ? data.data : [];
    items.forEach(ep => {
      episodes.push({
        id: ep.mal_id ?? episodes.length + 1,
        season: 1,
        number: ep.mal_id ?? episodes.length + 1,
        name: ep.title || `Episode ${ep.mal_id ?? episodes.length + 1}`,
        runtime: ep.duration || null,
        airdate: ep.aired ? String(ep.aired).slice(0, 10) : "",
        summary: ep.synopsis || "",
        image: fallbackThumbnail ? { medium: fallbackThumbnail, original: fallbackThumbnail } : null,
        rating: null,
        filler: Boolean(ep.filler),
        recap: Boolean(ep.recap)
      });
    });
    hasNextPage = Boolean(data?.pagination?.has_next_page);
    page += 1;
  }

  return episodes;
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
  return typeof squashDbIsOffline !== "function" || !squashDbIsOffline();
}

function getNativeHttpPlugin() {
  return window.CapacitorHttp
    || window.Capacitor?.Plugins?.Http
    || window.Capacitor?.Plugins?.CapacitorHttp
    || null;
}

async function fetchJsonPortable(url, init = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const plugin = getNativeHttpPlugin();
      if (plugin?.get && (init.method || "GET").toUpperCase() === "GET") {
        const response = await plugin.get({ url, headers: init.headers || {} });
        return response?.data ?? null;
      }
      if (plugin?.request) {
        const response = await plugin.request({
          url,
          method: init.method || "GET",
          headers: init.headers || {},
          data: init.body || null,
          responseType: "json"
        });
        return response?.data ?? null;
      }

      if (typeof window !== "undefined" && window.location?.origin && window.location.origin !== "null") {
        const proxyUrl = new URL("/proxy", window.location.origin);
        proxyUrl.searchParams.set("url", url);
        const proxyResponse = await fetch(proxyUrl.toString(), init);
        if (proxyResponse.ok) return proxyResponse.json();
      }

      const response = await fetch(url, init);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    } catch (err) {
      lastError = err;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError || new Error("Network request failed");
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
            await refreshTvmazeItemMetadata(item);
            await fetchAndCacheEpisodes(item.tvmazeShowId, item);
          } else if (item.metadataSource === "jikan" && item.providerId) {
            const episodes = await fetchJikanAnimeEpisodes(item.providerId, item.thumbnail || "");
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

    const runtimeMinutes = item.episodeRuntime || item.playtime || 0;
    renderShowDetailHeader({
      title: item.title,
      thumbnail: item.thumbnail || "",
      meta: [CATEGORIES[item.category]?.label || "", runtimeMinutes ? `~${formatRuntimeHM(runtimeMinutes)}${EPISODE_TRACKED_CATEGORIES.includes(item.category) ? "/ep" : ""}` : "", item.network || ""].filter(Boolean).join(" · "),
      summary: item.summary || "",
      productionStatus: item.productionStatus || ""
    });
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
      const res = await fetch(`https://api.tvmaze.com/shows/${providerId}`);
      if (!res.ok) {
        console.warn(`TVmaze show fetch failed: ${res.status} ${res.statusText}`);
        renderShowDetailHeader({ title, thumbnail: "", meta: "Failed to load show details." });
        return;
      }
      const show = await res.json();
      const runtime = show ? Math.round(show.averageRuntime || show.runtime || 0) : 0;
      const genres = (show?.genres || []).slice(0, 3);
      const network = show?.webChannel?.name || show?.network?.name || "";
      showDetailState.show = {
        title: show?.name || title,
        thumbnail: show?.image?.original || show?.image?.medium || "",
        meta: [show?.premiered ? show.premiered.slice(0, 4) : "", genres.join(", "), runtime ? `~${formatRuntimeHM(runtime)}/ep` : "", network].filter(Boolean).join(" · "),
        summary: stripHtml(show?.summary || ""),
        tvmazeShowId: providerId,
        providerId,
        episodeRuntime: runtime,
        network,
        genres,
        productionStatus: show?.status || ""
      };
      renderShowDetailHeader(showDetailState.show);
      renderStatusPicker(null);
      renderAddToListPicker();
      await fetchAndCacheEpisodes(providerId, null);
      renderSeasonSection();
      renderRatingWidget(null);
      renderNotesField(null);
    } catch (err) {
      console.warn("Could not load show details", err);
      renderShowDetailHeader({ title, thumbnail: "", meta: "Failed to load show details." });
    }
  } else if (provider === "wikidata") {
    // Movies have no episode list — just show basic metadata and let status changes save it.
    try {
      const res = await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${providerId}&format=json&props=claims|descriptions|labels|sitelinks&sitefilter=enwiki&languages=en&origin=*`);
      const data = res.ok ? await res.json() : null;
      const entity = data?.entities?.[providerId];
      const claims = entity?.claims || {};
      const runtimeClaim = claims.P2047?.[0]?.mainsnak?.datavalue?.value?.amount;
      const runtime = runtimeClaim ? Math.round(parseFloat(runtimeClaim.replace("+", ""))) : 0;
      const imageFile = claims.P18?.[0]?.mainsnak?.datavalue?.value;
      const thumbnail = imageFile ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(imageFile)}` : "";
      const releaseDate = claims.P577?.[0]?.mainsnak?.datavalue?.value?.time;
      const releaseYear = releaseDate ? releaseDate.slice(1, 5) : "";
      const genreIds = (claims.P136 || []).map(c => c.mainsnak?.datavalue?.value?.id).filter(Boolean).slice(0, 3);
      let genres = [];
      if (genreIds.length) {
        try {
          const genreRes = await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${genreIds.join("|")}&format=json&props=labels&languages=en&origin=*`);
          if (genreRes.ok) {
            const genreData = await genreRes.json();
            genres = genreIds.map(id => genreData.entities?.[id]?.labels?.en?.value).filter(Boolean);
          }
        } catch (err) {
          console.warn("Could not load genre labels", err);
        }
      }
      const genreLabel = genres.join(", ");
      const wikiTitle = entity?.sitelinks?.enwiki?.title;
      let summary = entity?.descriptions?.en?.value || "";
      if (wikiTitle) {
        try {
          const summaryRes = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(wikiTitle)}`);
          if (summaryRes.ok) {
            const summaryData = await summaryRes.json();
            if (summaryData.extract) summary = summaryData.extract;
          }
        } catch (err) {
          console.warn("Could not load Wikipedia summary", err);
        }
      }
      showDetailState.show = {
        title: entity?.labels?.en?.value || title,
        thumbnail,
        meta: [releaseYear, genreLabel, runtime ? formatRuntimeHM(runtime) : ""].filter(Boolean).join(" · "),
        summary,
        playtime: runtime,
        genres,
        providerId
      };
      renderShowDetailHeader(showDetailState.show);
      renderStatusPicker(null);
      renderAddToListPicker();
      renderRatingWidget(null);
      renderNotesField(null);
    } catch (err) {
      console.warn("Could not load movie details", err);
    }
  } else if (provider === "openlibrary") {
    // Manga/Novel: Open Library has no episode-style unit, just volume/chapter
    // progress fields (see renderBookProgressSection).
    try {
      const res = await fetch(`https://openlibrary.org/works/${providerId}.json`);
      const work = res.ok ? await res.json() : null;
      const rawDescription = work?.description;
      const summary = typeof rawDescription === "string" ? rawDescription : (rawDescription?.value || "");
      const coverId = work?.covers?.find(id => id > 0);
      const thumbnail = coverId ? `https://covers.openlibrary.org/b/id/${coverId}-M.jpg` : "";
      const publishYear = work?.first_publish_date ? work.first_publish_date.slice(0, 4) : "";
      showDetailState.show = {
        title: work?.title || title,
        thumbnail,
        meta: [publishYear].filter(Boolean).join(" · "),
        summary,
        providerId
      };
      renderShowDetailHeader(showDetailState.show);
      renderStatusPicker(null);
      renderAddToListPicker();
      renderBookProgressSection(null);
      renderRatingWidget(null);
      renderNotesField(null);
    } catch (err) {
      console.warn("Could not load book details", err);
      renderShowDetailHeader({ title, thumbnail: "", meta: "Failed to load book details." });
    }
  } else if (provider === "anilist" || provider === "jikan" || provider === "kitsu") {
    try {
      let show = null;
      if (provider === "anilist") {
        const query = `query($id:Int){Media(id:$id,type:ANIME){title{romaji english} coverImage{large medium} description(asHtml:false) episodes averageScore duration startDate{year} status}}`;
        const res = await fetch("https://graphql.anilist.co", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ query, variables: { id: Number(providerId) } })
        });
        const data = res.ok ? await res.json() : null;
        const media = data?.data?.Media;
        if (media) {
          const totalEpisodes = parseInt(media.episodes) || 0;
          show = {
            title: media.title?.english || media.title?.romaji || title,
            thumbnail: media.coverImage?.large || media.coverImage?.medium || "",
            meta: [media.startDate?.year || "", totalEpisodes ? `${totalEpisodes} episodes` : "", media.duration ? `~${media.duration} min/ep` : ""].filter(Boolean).join(" · "),
            summary: media.description || "",
            providerId,
            totalEpisodes,
            episodeRuntime: media.duration || 0,
            productionStatus: media.status || ""
          };
        }
      } else if (provider === "jikan") {
        const res = await fetch(`https://api.jikan.moe/v4/anime/${providerId}/full`);
        const data = res.ok ? await res.json() : null;
        const entry = data?.data;
        if (entry) {
          const runtime = parseInt(String(entry.duration || "").match(/\d+/)?.[0] || "") || 0;
          show = {
            title: entry.title || title,
            thumbnail: entry.images?.jpg?.large_image_url || entry.images?.jpg?.image_url || "",
            meta: [entry.aired?.from ? String(entry.aired.from).slice(0, 4) : "", entry.episodes ? `${entry.episodes} episodes` : "", runtime ? `~${runtime} min/ep` : ""].filter(Boolean).join(" · "),
            summary: stripHtml(entry.synopsis || ""),
            providerId,
            totalEpisodes: parseInt(entry.episodes) || 0,
            episodeRuntime: runtime,
            productionStatus: entry.status || ""
          };
        }
      } else if (provider === "kitsu") {
        const res = await fetch(`https://kitsu.io/api/edge/anime/${providerId}`, { headers: { Accept: "application/vnd.api+json" } });
        const data = res.ok ? await res.json() : null;
        const attrs = data?.data?.attributes || {};
        if (data?.data) {
          show = {
            title: attrs.canonicalTitle || attrs.titles?.en || title,
            thumbnail: attrs.posterImage?.large || attrs.posterImage?.medium || attrs.posterImage?.small || "",
            meta: [attrs.startDate ? attrs.startDate.slice(0, 4) : "", attrs.episodeCount ? `${attrs.episodeCount} episodes` : "", attrs.episodeLength ? `~${attrs.episodeLength} min/ep` : ""].filter(Boolean).join(" · "),
            summary: attrs.synopsis || "",
            providerId,
            totalEpisodes: parseInt(attrs.episodeCount) || 0,
            episodeRuntime: parseInt(attrs.episodeLength) || 0,
            productionStatus: attrs.status || ""
          };
        }
      }

      if (!show) {
        renderShowDetailHeader({ title, thumbnail: "", meta: "Failed to load anime details." });
        return;
      }

      showDetailState.show = show;
      if (provider === "jikan" && show.providerId) {
        const episodes = await fetchJikanAnimeEpisodes(show.providerId, show.thumbnail || "");
        if (episodes.length) {
          applyEpisodesToState(episodes, null);
        } else {
          showDetailState.seasons = show.totalEpisodes > 0 ? [1] : [];
          showDetailState.episodes = buildSyntheticAnimeEpisodes(show.totalEpisodes, show);
          showDetailState.activeSeason = showDetailState.seasons[0] || null;
        }
      } else {
        showDetailState.seasons = show.totalEpisodes > 0 ? [1] : [];
        showDetailState.episodes = buildSyntheticAnimeEpisodes(show.totalEpisodes, show);
        showDetailState.activeSeason = showDetailState.seasons[0] || null;
      }
      renderShowDetailHeader(showDetailState.show);
      renderStatusPicker(null);
      renderAddToListPicker();
      renderSeasonSection();
      renderRatingWidget(null);
      renderNotesField(null);
    } catch (err) {
      console.warn("Could not load anime details", err);
      renderShowDetailHeader({ title, thumbnail: "", meta: "Failed to load anime details." });
    }
  } else if (provider === "rawg") {
    try {
      const rawgKey = state.preferences.metadataSources.builtinApiKeys?.rawg || "";
      const res = await fetch(`https://api.rawg.io/api/games/${providerId}?key=${encodeURIComponent(rawgKey)}`);
      const game = res.ok ? await res.json() : null;
      const genres = (game?.genres || []).map(g => g.name).slice(0, 3);
      const releaseYear = game?.released ? game.released.slice(0, 4) : "";
      showDetailState.show = {
        title: game?.name || title,
        thumbnail: game?.background_image || "",
        meta: [releaseYear, genres.join(", "), game?.metacritic ? `Metacritic ${game.metacritic}` : ""].filter(Boolean).join(" · "),
        summary: game?.description_raw || "",
        genres,
        providerId
      };
      renderShowDetailHeader(showDetailState.show);
      renderStatusPicker(null);
      renderAddToListPicker();
      renderRatingWidget(null);
      renderNotesField(null);
    } catch (err) {
      console.warn("Could not load game details", err);
      renderShowDetailHeader({ title, thumbnail: "", meta: "Failed to load game details." });
    }
  } else if (provider === "freetogame") {
    try {
      const games = await fetchJsonPortable("https://www.freetogame.com/api/games");
      const game = (Array.isArray(games) ? games : []).find(g => String(g.id) === String(providerId)) || null;
      const genres = [game?.genre, game?.platform, game?.publisher].filter(Boolean).slice(0, 3);
      showDetailState.show = {
        title: game?.title || title,
        thumbnail: game?.thumbnail || "",
        meta: [game?.release_date || "", genres.join(", "), game?.developer || ""].filter(Boolean).join(" · "),
        summary: game?.short_description || "",
        genres,
        providerId
      };
      renderSimpleShowDetail();
    } catch (err) {
      console.warn("Could not load FreeToGame details", err);
      renderShowDetailHeader({ title, thumbnail: "", meta: "Failed to load game details." });
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
  } else if (provider === "anilist") {
    try {
      const isManga = category === "manga";
      const query = `query($id:Int){Media(id:$id){title{romaji english} coverImage{large} description(asHtml:false) genres startDate{year} status episodes chapters volumes}}`;
      const res = await fetch("https://graphql.anilist.co", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query, variables: { id: parseInt(providerId, 10) } })
      });
      const data = res.ok ? await res.json() : null;
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
      renderShowDetailHeader({ title, thumbnail: "", meta: "Failed to load details." });
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
      renderShowDetailHeader({ title, thumbnail: "", meta: "Failed to load details." });
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
      renderShowDetailHeader({ title, thumbnail: "", meta: "Failed to load details." });
    }
  } else if (provider === "googlebooks") {
    try {
      const res = await fetch(`https://www.googleapis.com/books/v1/volumes/${providerId}`);
      const data = res.ok ? await res.json() : null;
      const info = data?.volumeInfo;
      showDetailState.show = {
        title: info?.title || title,
        thumbnail: (info?.imageLinks?.thumbnail || info?.imageLinks?.smallThumbnail || "").replace("http://", "https://"),
        meta: [info?.publishedDate ? info.publishedDate.slice(0, 4) : "", info?.authors?.[0] || "", info?.pageCount ? `${info.pageCount} pages` : ""].filter(Boolean).join(" · "),
        summary: info?.description || "",
        genres: (info?.categories || []).slice(0, 3),
        providerId
      };
      renderSimpleShowDetail();
    } catch (err) {
      console.warn("Could not load Google Books details", err);
      renderShowDetailHeader({ title, thumbnail: "", meta: "Failed to load details." });
    }
  } else if (provider === "omdb") {
    try {
      const omdbKey = state.preferences.metadataSources.builtinApiKeys?.omdb || "";
      const res = await fetch(`https://www.omdbapi.com/?i=${encodeURIComponent(providerId)}&plot=full&apikey=${encodeURIComponent(omdbKey)}`);
      const data = res.ok ? await res.json() : null;
      const genres = (data?.Genre || "").split(",").map(g => g.trim()).filter(Boolean).slice(0, 3);
      showDetailState.show = {
        title: data?.Title || title,
        thumbnail: data?.Poster && data.Poster !== "N/A" ? data.Poster : "",
        meta: [data?.Year, genres.join(", "), data?.Runtime && data.Runtime !== "N/A" ? data.Runtime : "", data?.imdbRating && data.imdbRating !== "N/A" ? `IMDb ${data.imdbRating}` : ""].filter(Boolean).join(" · "),
        summary: data?.Plot && data.Plot !== "N/A" ? data.Plot : "",
        genres,
        providerId
      };
      renderSimpleShowDetail();
    } catch (err) {
      console.warn("Could not load OMDb details", err);
      renderShowDetailHeader({ title, thumbnail: "", meta: "Failed to load details." });
    }
  } else if (provider === "tmdb") {
    try {
      const tmdbKey = state.preferences.metadataSources.builtinApiKeys?.tmdb || "";
      const mediaType = EPISODE_TRACKED_CATEGORIES.includes(category) ? "tv" : "movie";
      const res = await fetch(`https://api.themoviedb.org/3/${mediaType}/${providerId}?api_key=${encodeURIComponent(tmdbKey)}`);
      const data = res.ok ? await res.json() : null;
      const genres = (data?.genres || []).map(g => g.name).slice(0, 3);
      const releaseDate = mediaType === "tv" ? data?.first_air_date : data?.release_date;
      const runtime = mediaType === "tv" ? (data?.episode_run_time?.[0] || 0) : (data?.runtime || 0);
      showDetailState.show = {
        title: (mediaType === "tv" ? data?.name : data?.title) || title,
        thumbnail: data?.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : "",
        meta: [releaseDate ? releaseDate.slice(0, 4) : "", genres.join(", "), runtime ? formatRuntimeHM(runtime) : "", data?.vote_average ? `★ ${data.vote_average.toFixed(1)}` : ""].filter(Boolean).join(" · "),
        summary: data?.overview || "",
        genres,
        providerId
      };
      renderSimpleShowDetail();
    } catch (err) {
      console.warn("Could not load TMDB details", err);
      renderShowDetailHeader({ title, thumbnail: "", meta: "Failed to load details." });
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
async function refreshTvmazeItemMetadata(item) {
  try {
    const res = await fetch(`https://api.tvmaze.com/shows/${item.tvmazeShowId}`);
    if (!res.ok) return;
    const show = await res.json();
    const runtime = Math.round(show.averageRuntime || show.runtime || 0);
    item.productionStatus = show.status || item.productionStatus || "";
    item.network = show.webChannel?.name || show.network?.name || item.network || "";
    if (Array.isArray(show.genres) && show.genres.length) item.genres = show.genres.slice(0, 3);
    const summary = stripHtml(show.summary || "");
    if (summary) item.summary = summary;
    if (runtime) item.episodeRuntime = runtime;
    if (thumbnailsEnabled()) {
      const thumbnail = show.image?.original || show.image?.medium || "";
      if (thumbnail) item.thumbnail = thumbnail;
    }
    saveData();
  } catch (err) {
    console.warn("Could not refresh show metadata", err);
    queueMetadataUpdate(item.category, item.title, item.id);
  }
}

async function fetchAndCacheEpisodes(tvmazeShowId, existingItem) {
  try {
    const res = await fetch(`https://api.tvmaze.com/shows/${tvmazeShowId}/episodes`);
    if (!res.ok) {
      console.warn(`TVmaze episodes fetch failed: ${res.status} ${res.statusText}`);
      return;
    }
    const episodes = await res.json();
    applyEpisodesToState(episodes, existingItem);

    // Keep the local cache fresh so it still works next time we're offline.
    if (existingItem) {
      const itemIndex = state.items.findIndex(i => i.id === existingItem.id);
      if (itemIndex !== -1) {
        state.items[itemIndex].episodesCache = episodes;
        saveData();
      }
    } else {
      showDetailState.pendingEpisodesCache = episodes;
    }
  } catch (err) {
    console.warn("Error fetching episodes:", err);
    if (existingItem) queueMetadataUpdate(existingItem.category, existingItem.title, existingItem.id);
  }
}

function applyEpisodesToState(episodes, existingItem) {
  showDetailState.episodes = episodes;
  const seasonSet = new Set(episodes.map(ep => parseInt(ep.season) || 0).filter(Boolean));
  showDetailState.seasons = Array.from(seasonSet).sort((a, b) => a - b);
  if (existingItem) {
    showDetailState.watchedEpisodeIds = existingItem.watchedEpisodeIds || [];
  }
  if (showDetailState.activeSeason === null || !showDetailState.seasons.includes(showDetailState.activeSeason)) {
    // Open on the first season that still has something unwatched, so a show
    // with 7 finished seasons lands on season 8 instead of season 1. Fully
    // watched shows fall back to the last season.
    const watched = new Set(showDetailState.watchedEpisodeIds);
    const firstUnfinished = showDetailState.seasons.find(s =>
      episodes.some(ep => (parseInt(ep.season) || 0) === s && !watched.has(ep.id))
    );
    showDetailState.activeSeason = firstUnfinished ?? showDetailState.seasons[showDetailState.seasons.length - 1] ?? null;
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
    const offline = typeof squashDbIsOffline === "function" ? squashDbIsOffline() : navigator.onLine === false;
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
  const progress = showDetailProgress(localItem || show);
  if (bar) bar.style.width = `${progress}%`;
  if (label) label.textContent = localItem ? `${progress}% complete` : "Not tracked yet";
}

function nextDetailEpisode() {
  const watched = new Set(showDetailState.watchedEpisodeIds || []);
  return [...showDetailState.episodes]
    .filter(episode => !watched.has(episode.id))
    .sort((a, b) => {
      const season = (parseInt(a.season) || 0) - (parseInt(b.season) || 0);
      return season || ((parseInt(a.number) || 0) - (parseInt(b.number) || 0));
    })[0] || null;
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
    showDetailState.activeSeason = parseInt(next.season) || showDetailState.activeSeason;
    const seasonLabel = document.getElementById("show-detail-season-btn-label");
    if (seasonLabel) seasonLabel.textContent = `Season ${showDetailState.activeSeason}`;
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
      const season = (parseInt(a.season) || 0) - (parseInt(b.season) || 0);
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
  if (typeof squashDbIsOffline === "function" ? squashDbIsOffline() : navigator.onLine === false) {
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
      const genres = Array.isArray(current.genres) && current.genres.length ? current.genres.slice(0, 3) : [current.title || ""];
      const responses = await Promise.all(genres.map(genre => fetchJsonPortable(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(genre)}`)));
      const shows = responses.flatMap(response => Array.isArray(response) ? response.map(entry => entry.show || entry) : []);
      recommendations = shows.map(show => ({
          title: show.name || "Untitled",
          thumbnail: show.image?.medium || show.image?.original || "",
          meta: [show.type, show.premiered?.slice(0, 4)].filter(Boolean).join(" · "),
          url: `static/pages/main/show-detail.html?category=${encodeURIComponent(showDetailState.category)}&provider=tvmaze&providerId=${encodeURIComponent(show.id)}&title=${encodeURIComponent(show.name || "")}`
        }));
    } else if (provider === "jikan") {
      const response = await fetchJsonPortable(`https://api.jikan.moe/v4/anime/${encodeURIComponent(providerId)}/recommendations`);
      recommendations = (response?.data || []).map(entry => entry.entry || entry).map(show => ({
        title: show.title || "Untitled",
        thumbnail: show.images?.jpg?.image_url || "",
        meta: "MyAnimeList recommendation",
        url: `static/pages/main/show-detail.html?category=${encodeURIComponent(showDetailState.category)}&provider=jikan&providerId=${encodeURIComponent(show.mal_id)}&title=${encodeURIComponent(show.title || "")}`
      }));
    } else if (provider === "anilist") {
      const response = await fetchJsonPortable("https://graphql.anilist.co", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: `query($id:Int){Media(id:$id){recommendations(sort:RATING_DESC,perPage:6){nodes{mediaRecommendation{id title{romaji english} coverImage{medium} genres}}}}}`, variables: { id: Number(providerId) } })
      });
      recommendations = (response?.data?.Media?.recommendations?.nodes || []).map(node => node.mediaRecommendation).filter(Boolean).map(show => ({
        title: show.title?.english || show.title?.romaji || "Untitled",
        thumbnail: show.coverImage?.medium || "",
        meta: "AniList recommendation",
        url: `static/pages/main/show-detail.html?category=${encodeURIComponent(showDetailState.category)}&provider=anilist&providerId=${encodeURIComponent(show.id)}&title=${encodeURIComponent(show.title?.english || show.title?.romaji || "")}`
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
  seasonBtnLabel.textContent = `Season ${showDetailState.activeSeason}`;

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
      btn.innerHTML = `<i data-lucide="check" class="picker-option-check"></i><span>Season ${s}</span>`;
      btn.addEventListener("click", () => {
        closeSettingsPicker();
        showDetailState.activeSeason = s;
        seasonBtnLabel.textContent = `Season ${s}`;
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
    episodeRuntime: show.episodeRuntime || "",
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

document.addEventListener("DOMContentLoaded", () => {
  if (document.getElementById("show-detail-topbar-title")) {
    const waitForState = () => {
      if (typeof state === "undefined") {
        setTimeout(waitForState, 10);
      } else {
        // app.js declares state before restoring the encrypted/local database.
        // Wait for that restore to finish or a local item can appear missing
        // briefly and incorrectly redirect this page to Dashboard.
        Promise.resolve(window.squashDbAppReady)
          .then(() => initShowDetail())
          .catch(err => {
            console.error("Could not initialize show details", err);
            initShowDetail();
          });
      }
    };
    waitForState();
  }
});
