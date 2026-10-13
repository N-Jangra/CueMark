// Tvmaze provider adapter for the shared show detail page.

let tvmazeRequestQueue = Promise.resolve();

function getTvmazeNativeHttpPlugin() {
  return window.CapacitorHttp
    || window.Capacitor?.Plugins?.Http
    || window.Capacitor?.Plugins?.CapacitorHttp
    || null;
}

function parseTvmazeNativeResponse(response) {
  let payload = response?.data ?? null;
  if (typeof payload === "string") {
    try { payload = payload ? JSON.parse(payload) : null; } catch { /* retain text error body */ }
  }
  return payload;
}

async function requestTvmazeJson(url) {
  // Prefer Capacitor's native HTTP transport in the installed app. On the web,
  // use the original fetch to avoid shared cache/proxy rewriting.
  const nativeHttp = getTvmazeNativeHttpPlugin();
  const directFetch = window.cuemarkNativeFetch || fetch.bind(window);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let payload;
      let status = 200;
      if (nativeHttp?.get) {
        const nativeResponse = await nativeHttp.get({
          url,
          headers: { Accept: "application/json", "User-Agent": "CueMark/1.0 (TVmaze metadata client)" }
        });
        status = nativeResponse?.status || 200;
        payload = parseTvmazeNativeResponse(nativeResponse);
      } else {
        const response = await directFetch(url);
        status = response.status;
        if (response.ok) payload = await parseDetailResponse(response);
      }
      if (status === 403) {
        // Some browsers and networks reject TVmaze's API requests from a
        // file:// page. Try CueMark's same-origin proxy when served over HTTP,
        // or the local development server when the page was opened as a file.
        const proxyUrls = [];
        if (window.location?.protocol !== "file:" && window.location?.origin && window.location.origin !== "null") {
          const proxyUrl = new URL("/proxy", window.location.origin);
          proxyUrl.searchParams.set("url", url);
          proxyUrls.push(proxyUrl.toString());
        } else if (window.location?.protocol === "file:") {
          const proxyUrl = new URL("http://127.0.0.1:3000/proxy");
          proxyUrl.searchParams.set("url", url);
          proxyUrls.push(proxyUrl.toString());
        }
        for (const proxyUrl of proxyUrls) {
          try {
            const proxied = await directFetch(proxyUrl);
            if (proxied.ok) return await parseDetailResponse(proxied);
          } catch (proxyError) {
            console.warn("TVmaze proxy fallback failed", proxyError);
          }
        }
        if (nativeHttp?.get) {
          const browserResponse = await directFetch(url);
          if (browserResponse.ok) return await parseDetailResponse(browserResponse);
        }
      }
      if (status >= 400) throw detailHttpError(status, payload);
      return payload;
    } catch (error) {
      const canRetry = error?.status === 429 || error?.status >= 500;
      if (!canRetry || attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw new Error("TVmaze request failed");
}

function fetchTvmazeJson(url) {
  // Serialize requests so opening a detail page doesn't leave a burst of
  // concurrent TVmaze connections behind.
  const request = tvmazeRequestQueue.then(() => requestTvmazeJson(url));
  tvmazeRequestQueue = request.catch(() => {});
  return request;
}

async function refreshTvmazeItemMetadata(item) {
  try {
    const show = await fetchTvmazeJson(`https://api.tvmaze.com/shows/${encodeURIComponent(item.tvmazeShowId)}`);
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

async function fetchTvmazeFullData(tvmazeShowId, existingItem) {
  const root = `https://api.tvmaze.com/shows/${encodeURIComponent(tvmazeShowId)}`;
  const urls = [
    `${root}?embed[]=previousepisode&embed[]=nextepisode&embed[]=cast&embed[]=crew&embed[]=seasons`,
    `${root}/episodes?specials=1`,
    `${root}/akas`,
    `${root}/images`
  ];
  const results = await Promise.allSettled(urls.map(fetchTvmazeJson));
  const showResult = results[0];
  if (showResult.status !== "fulfilled" || !showResult.value) {
    throw showResult.reason || new Error("TVmaze show details unavailable");
  }
  const valueAt = (index) => results[index]?.status === "fulfilled" ? results[index].value : [];
  const embedded = showResult.value._embedded || {};
  const details = {
    show: showResult.value,
    cast: Array.isArray(embedded.cast) ? embedded.cast : [],
    crew: Array.isArray(embedded.crew) ? embedded.crew : [],
    seasons: Array.isArray(embedded.seasons) ? embedded.seasons : [],
    episodes: Array.isArray(valueAt(1)) ? valueAt(1) : Array.isArray(embedded.episodes) ? embedded.episodes : [],
    akas: Array.isArray(valueAt(2)) ? valueAt(2) : [],
    images: Array.isArray(valueAt(3)) ? valueAt(3) : [],
    fetchedAt: Date.now()
  };

  const show = details.show;
  const runtime = Math.round(show.averageRuntime || show.runtime || 0);
  const network = show.webChannel?.name || show.network?.name || "";
  const summary = stripHtml(show.summary || "");
  if (existingItem) {
    existingItem.productionStatus = show.status || existingItem.productionStatus || "";
    existingItem.network = network || existingItem.network || "";
    existingItem.genres = Array.isArray(show.genres) ? show.genres : existingItem.genres || [];
    if (summary) existingItem.summary = summary;
    if (runtime) existingItem.episodeRuntime = runtime;
    if (thumbnailsEnabled() && (show.image?.original || show.image?.medium)) {
      existingItem.thumbnail = show.image.original || show.image.medium;
    }
    existingItem.tvmazeDetailsCache = details;
    if (details.episodes.length) existingItem.episodesCache = details.episodes;
    saveData();
  }
  showDetailState.episodes = details.episodes;
  applyEpisodesToState(details.episodes, existingItem);
  if (!existingItem) showDetailState.pendingEpisodesCache = details.episodes;
  return details;
}

async function fetchAndCacheEpisodes(tvmazeShowId, existingItem) {
  try {
    const episodes = await fetchTvmazeJson(`https://api.tvmaze.com/shows/${encodeURIComponent(tvmazeShowId)}/episodes`);
    if (!Array.isArray(episodes)) throw new Error("TVmaze returned an invalid episode list");
    applyEpisodesToState(episodes, existingItem);
    if (existingItem) {
      const itemIndex = state.items.findIndex(item => item.id === existingItem.id);
      if (itemIndex !== -1) {
        state.items[itemIndex].episodesCache = episodes;
        saveData();
      }
    } else {
      showDetailState.pendingEpisodesCache = episodes;
    }
  } catch (error) {
    console.warn("Could not load TVmaze episodes", error);
    if (existingItem) queueMetadataUpdate(existingItem.category, existingItem.title, existingItem.id);
  }
}

async function fetchTvmazeRecommendations(current) {
  const genres = Array.isArray(current.genres) && current.genres.length
    ? current.genres.slice(0, 3)
    : [current.title || ""];
  const results = await Promise.allSettled(genres.map(genre =>
    fetchTvmazeJson(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(genre)}`)
  ));
  return results.flatMap(result => result.status === "fulfilled" && Array.isArray(result.value)
    ? result.value.map(entry => entry.show || entry).map(show => ({
        title: show.name || "Untitled",
        thumbnail: show.image?.medium || show.image?.original || "",
        meta: [show.type, show.premiered?.slice(0, 4)].filter(Boolean).join(" · "),
        url: `static/pages/main/show-detail.html?category=${encodeURIComponent(showDetailState.category)}&provider=tvmaze&providerId=${encodeURIComponent(show.id)}&title=${encodeURIComponent(show.name || "")}`
      }))
    : []
  );
}

function renderTvmazeDetails(details) {
  const section = document.getElementById("tvmaze-extra-section");
  if (!section) return;
  if (!details?.show) {
    section.style.display = "none";
    section.innerHTML = "";
    return;
  }
  const show = details.show;
  const safe = detailText;
  const info = [
    ["Type", show.type], ["Language", show.language], ["Country", show.network?.country?.name || show.webChannel?.country?.name],
    ["Premiered", show.premiered], ["Ended", show.ended], ["Runtime", show.averageRuntime || show.runtime ? `${show.averageRuntime || show.runtime} min` : ""],
    ["Schedule", [show.schedule?.days?.join(", "), show.schedule?.time].filter(Boolean).join(" · ")],
    ["Network", show.network?.name || show.webChannel?.name], ["Genres", show.genres?.join(", ")],
    ["TVmaze rating", show.rating?.average ? `${show.rating.average}/10` : "Not rated"],
    ["Status", show.status], ["Official site", show.officialSite ? `<a href="${safe(show.officialSite)}" target="_blank" rel="noopener">${safe(show.officialSite)}</a>` : ""],
    ["TVmaze page", show.url ? `<a href="${safe(show.url)}" target="_blank" rel="noopener">Open on TVmaze</a>` : ""],
    ["External IDs", Object.entries(show.externals || {}).filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`).join(" · ")]
  ].filter(([, value]) => value);
  const cast = (details.cast || []).slice(0, 30);
  const crew = (details.crew || []).slice(0, 30);
  const seasons = details.seasons || [];
  const aliases = details.akas || [];
  const images = details.images || [];
  const featuredEpisodes = [
    ["Previous episode", show._embedded?.previousepisode],
    ["Next episode", show._embedded?.nextepisode]
  ].filter(([, episode]) => episode);
  const personImage = person => person?.image?.medium || person?.image?.original || "";
  section.style.display = "block";
  section.innerHTML = `
    <section class="tvmaze-detail-block"><h2>TVmaze details</h2><dl class="tvmaze-info-grid">${info.map(([label, value]) => `<div><dt>${safe(label)}</dt><dd>${label === "Official site" || label === "TVmaze page" ? value : safe(value)}</dd></div>`).join("")}</dl><p class="tvmaze-api-note">TVmaze provides an aggregate rating; reviews are not available through its public API.</p></section>
    ${cast.length ? `<section class="tvmaze-detail-block"><h2>Cast <small>${details.cast.length}</small></h2><div class="tvmaze-people-grid">${cast.map(entry => `<article class="tvmaze-person-card">${personImage(entry.person) ? `<img src="${safe(personImage(entry.person))}" alt="" loading="lazy">` : `<div class="tvmaze-person-placeholder">${safe((entry.person?.name || "?").slice(0, 1))}</div>`}<div><strong>${safe(entry.person?.name || "Unknown")}</strong><span>${safe(entry.character?.name || "")}</span></div></article>`).join("")}</div></section>` : ""}
    ${featuredEpisodes.length ? `<section class="tvmaze-detail-block"><h2>Episode guide</h2><div class="tvmaze-featured-episodes">${featuredEpisodes.map(([label, episode]) => `<article><small>${safe(label)}</small><strong>${safe(episode.name || "Untitled")}</strong><span>${safe([episode.season != null && episode.number != null ? `S${episode.season} · E${episode.number}` : "", episode.airdate, episode.runtime ? `${episode.runtime} min` : "", episode.rating?.average ? `★ ${episode.rating.average}` : ""].filter(Boolean).join(" · "))}</span>${episode.summary ? `<p>${safe(stripHtml(episode.summary))}</p>` : ""}</article>`).join("")}</div></section>` : ""}
    ${crew.length ? `<section class="tvmaze-detail-block"><h2>Crew <small>${details.crew.length}</small></h2><div class="tvmaze-crew-list">${crew.map(entry => `<span><strong>${safe(entry.person?.name || "Unknown")}</strong> · ${safe(entry.type || "Crew")}</span>`).join("")}</div></section>` : ""}
    ${seasons.length ? `<section class="tvmaze-detail-block"><h2>Seasons <small>${seasons.length}</small></h2><div class="tvmaze-season-grid">${seasons.map(season => `<article><strong>${safe(season.name || `Season ${season.number}`)}</strong><span>${season.episodeOrder ? `${season.episodeOrder} episodes` : "Episode count unavailable"}</span><small>${safe([season.premiereDate, season.endDate].filter(Boolean).join(" – "))}</small>${season.summary ? `<p>${safe(stripHtml(season.summary))}</p>` : ""}</article>`).join("")}</div></section>` : ""}
    ${aliases.length ? `<details class="tvmaze-detail-block"><summary>Alternate titles <small>${aliases.length}</small></summary><div class="tvmaze-alias-list">${aliases.map(alias => `<span>${safe(alias.name)}${alias.country?.name ? ` <small>(${safe(alias.country.name)})</small>` : ""}</span>`).join("")}</div></details>` : ""}
    ${images.length ? `<details class="tvmaze-detail-block"><summary>TVmaze images <small>${images.length}</small></summary><div class="tvmaze-image-grid">${images.map((entry, index) => { const image = entry.resolutions?.original?.url || entry.resolutions?.medium?.url; return image ? `<a href="${safe(image)}" target="_blank" rel="noopener" title="${safe(entry.type || "Show image")}"><img src="${safe(entry.resolutions?.medium?.url || image)}" loading="lazy" alt="${safe(entry.type || `Show image ${index + 1}`)}"><small>${safe(entry.type || "Image")}</small></a>` : ""; }).join("")}</div></details>` : ""}
    <p class="tvmaze-data-footnote">${details.episodes.length} episodes loaded${details.episodes.some(episode => episode.number == null) ? " · includes specials" : ""}</p>`;
}
