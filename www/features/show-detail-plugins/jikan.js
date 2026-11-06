// Jikan provider adapter for the shared show detail page.

let jikanRequestQueue = Promise.resolve();

let jikanLastRequestAt = 0;

function fetchJikanJson(url) {
  const run = async () => {
    const delay = Math.max(0, 1020 - (Date.now() - jikanLastRequestAt));
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    jikanLastRequestAt = Date.now();
    return fetchJsonPortable(url);
  };
  const request = jikanRequestQueue.then(run, run);
  jikanRequestQueue = request.catch(() => {});
  return request;
}

async function fetchJikanPictures(malId, mediaType = "anime") {
  if (!malId) return [];
  const type = mediaType === "manga" ? "manga" : "anime";
  const cacheKey = `cuemark:jikan:${type}:${malId}:pictures`;
  try {
    const cached = JSON.parse(sessionStorage.getItem(cacheKey) || "null");
    if (Array.isArray(cached?.pictures) && Date.now() - Number(cached.fetchedAt || 0) < 24 * 60 * 60 * 1000) return cached.pictures;
  } catch {}
  try {
    const response = await fetchJikanJson(`https://api.jikan.moe/v4/${type}/${encodeURIComponent(malId)}/pictures`);
    const pictures = Array.isArray(response?.data) ? response.data : [];
    try { sessionStorage.setItem(cacheKey, JSON.stringify({ pictures, fetchedAt: Date.now() })); } catch {}
    return pictures;
  } catch (error) {
    console.warn("Could not load Jikan pictures", error);
    return [];
  }
}

async function fetchJikanAnimeEpisodes(malId, fallbackThumbnail = "") {
  const episodes = [];
  let page = 1;
  let hasNextPage = true;

  while (hasNextPage && page <= 5) {
    let data;
    try {
      data = await fetchJikanJson(`https://api.jikan.moe/v4/anime/${encodeURIComponent(malId)}/episodes?page=${page}`);
    } catch { break; }
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

async function fetchJikanFullData(providerId, mediaType = "anime", existingItem = null) {
  const type = mediaType === "manga" ? "manga" : "anime";
  const cacheKey = `cuemark:jikan:${type}:${providerId}`;
  let details = null;
  try {
    const cached = JSON.parse(sessionStorage.getItem(cacheKey) || "null");
    if (cached?.entry && Date.now() - Number(cached.fetchedAt || 0) < 24 * 60 * 60 * 1000) details = cached;
  } catch {}
  if (!details) {
    const base = `https://api.jikan.moe/v4/${type}/${encodeURIComponent(providerId)}`;
    const mainResponse = await fetchJikanJson(`${base}/full`);
    const entry = mainResponse?.data;
    if (!entry) throw new Error("Jikan details unavailable");

    const endpointNames = type === "anime"
      ? ["characters", "staff", "reviews", "recommendations", "statistics", "videos", "pictures"]
      : ["characters", "reviews", "recommendations", "statistics", "pictures"];
    const extra = {};
    await Promise.all(endpointNames.map(async name => {
      try {
        const response = await fetchJikanJson(`${base}/${name}${["reviews", "recommendations"].includes(name) ? "?page=1&limit=25" : ""}`);
        extra[name] = response?.data ?? [];
        extra[`${name}Pagination`] = response?.pagination || null;
      } catch (error) {
        console.warn(`Could not load Jikan ${type} ${name}`, error);
        extra[name] = [];
      }
    }));
    details = { type, entry, ...extra, fetchedAt: Date.now() };
    try { sessionStorage.setItem(cacheKey, JSON.stringify(details)); } catch {}
  }
  const entry = details.entry;
  if (existingItem) {
    existingItem.summary = entry.synopsis || existingItem.summary || "";
    existingItem.genres = (entry.genres || []).map(genre => genre.name);
    existingItem.jikanDetailsCache = details;
    existingItem.totalEpisodes = entry.episodes || existingItem.totalEpisodes || 0;
    existingItem.totalChapters = entry.chapters || existingItem.totalChapters || 0;
    existingItem.totalVolumes = entry.volumes || existingItem.totalVolumes || 0;
    existingItem.episodeRuntime = parseInt(String(entry.duration || "").match(/\d+/)?.[0] || "") || existingItem.episodeRuntime || 0;
    if (thumbnailsEnabled() && (entry.images?.jpg?.large_image_url || entry.images?.jpg?.image_url)) {
      existingItem.thumbnail = entry.images.jpg.large_image_url || entry.images.jpg.image_url;
    }
    saveData();
  }
  return details;
}

async function fetchJikanTitleFallback(title, category = "anime", fallbackError = "") {
  const isManga = category === "manga" || category === "novel";
  const type = isManga ? "manga" : "anime";
  const params = new URLSearchParams({ q: title, limit: "10", sfw: "true" });
  if (!isManga && category === "series") params.set("type", "tv");
  const search = await fetchJikanJson(`https://api.jikan.moe/v4/${type}?${params.toString()}`);
  const normalizedTitle = normalizeProviderTitle(title);
  const entry = (search?.data || []).find(result => [
    result.title, result.title_english, result.title_japanese, ...(result.titles || []).map(item => item.title)
  ].some(candidate => normalizeProviderTitle(candidate) === normalizedTitle));
  if (!entry?.mal_id) return null;

  let fullEntry = entry;
  try {
    const full = await fetchJikanJson(`https://api.jikan.moe/v4/${type}/${encodeURIComponent(entry.mal_id)}/full`);
    fullEntry = full?.data || entry;
  } catch (error) { console.warn("Could not load full Jikan fallback record", error); }
  return {
    type,
    entry: fullEntry,
    characters: [], staff: [], reviews: [], recommendations: [],
    pictures: await fetchJikanPictures(fullEntry.mal_id || entry.mal_id, type),
    statistics: {}, videos: {},
    fallbackFrom: "AniList",
    fallbackError,
    fetchedAt: Date.now()
  };
}

function renderJikanDetails(details) {
  const section = document.getElementById("jikan-extra-section");
  const entry = details?.entry;
  if (!section) return;
  if (!entry) {
    section.style.display = "none";
    section.innerHTML = "";
    return;
  }
  const safe = detailText;
  const href = value => {
    try {
      const url = new URL(value);
      return ["https:", "http:"].includes(url.protocol) ? safe(url.href) : "";
    } catch { return ""; }
  };
  const people = details.characters || [];
  const staff = details.staff || [];
  const reviews = details.reviews || [];
  const recommendations = details.recommendations || [];
  const pictures = details.pictures || [];
  const stats = details.statistics || {};
  const genres = [...(entry.genres || []), ...(entry.explicit_genres || []), ...(entry.themes || []), ...(entry.demographics || [])];
  const year = entry.aired?.from?.slice(0, 4) || entry.published?.from?.slice(0, 4) || "";
  const info = [
    ["MyAnimeList ID", entry.mal_id], ["Media type", entry.type], ["Source", entry.source], ["Status", entry.status],
    ["Season", [entry.season, entry.year].filter(Boolean).join(" ")], ["Released / published", year],
    ["Episodes", entry.episodes], ["Chapters", entry.chapters], ["Volumes", entry.volumes],
    ["Episode duration", entry.duration], ["Rating category", entry.rating],
    ["Score", entry.score ? `${entry.score}/10` : "Not rated"], ["Rank", entry.rank], ["Popularity", entry.popularity],
    ["Members", entry.members], ["Favorites", entry.favorites], ["Scored by", entry.scored_by],
    ["Broadcast", [entry.broadcast?.day, entry.broadcast?.time, entry.broadcast?.timezone].filter(Boolean).join(" · ")],
    ["Genres and themes", genres.map(item => item.name).filter(Boolean).join(", ")],
    ["Authors", (entry.authors || []).map(item => item.name).filter(Boolean).join(", ")],
    ["Studios", (entry.studios || []).map(item => item.name).filter(Boolean).join(", ")],
    ["Producers", (entry.producers || []).map(item => item.name).filter(Boolean).join(", ")],
    ["Serialization", (entry.serializations || []).map(item => item.name).filter(Boolean).join(", ")]
  ].filter(([, value]) => value !== null && value !== undefined && value !== "");
  const statRows = [
    [details.type === "manga" ? "Reading" : "Watching", stats.reading ?? stats.watching], ["Completed", stats.completed],
    ["On hold", stats.on_hold], ["Dropped", stats.dropped],
    [details.type === "manga" ? "Plan to read" : "Plan to watch", stats.plan_to_read ?? stats.plan_to_watch], ["Total users", stats.total]
  ].filter(([, value]) => value !== null && value !== undefined);
  const scoreRows = (stats.scores || []).filter(score => score.score).sort((a, b) => b.score - a.score);
  const entryUrl = href(entry.url);
  const links = [...(entry.external || []), ...(entry.streaming || [])].filter(item => href(item.url));
  const relations = entry.relations || [];
  const promos = [...(details.videos?.promo || []), ...(details.videos?.music_videos || [])];
  const videoEpisodes = details.videos?.episodes || [];
  section.style.display = "block";
  section.innerHTML = `
    <section class="tvmaze-detail-block"><h2>Jikan / MyAnimeList details</h2><dl class="tvmaze-info-grid">${info.map(([label, value]) => `<div><dt>${safe(label)}</dt><dd>${safe(value)}</dd></div>`).join("")}</dl><div class="anilist-link-row">${entryUrl ? `<a href="${entryUrl}" target="_blank" rel="noopener">Open on MyAnimeList</a>` : ""}${href(entry.trailer?.url) ? `<a href="${href(entry.trailer.url)}" target="_blank" rel="noopener">Watch trailer</a>` : ""}</div><p class="tvmaze-api-note">${details.fallbackFrom ? `${safe(details.fallbackFrom)} could not return this title; showing the exact-title Jikan fallback. ` : ""}Scores, user statistics, reviews, and recommendations are sourced from MyAnimeList through Jikan.${details.fallbackError ? ` Original error: ${safe(details.fallbackError)}` : ""}</p></section>
    ${entry.background ? `<section class="tvmaze-detail-block"><h2>Background</h2><p class="jikan-long-text">${safe(entry.background)}</p></section>` : ""}
    ${statRows.length || scoreRows.length ? `<section class="tvmaze-detail-block"><h2>MyAnimeList statistics</h2>${statRows.length ? `<dl class="tvmaze-info-grid">${statRows.map(([label,value]) => `<div><dt>${safe(label)}</dt><dd>${safe(value.toLocaleString?.() ?? value)}</dd></div>`).join("")}</dl>` : ""}${scoreRows.length ? `<div class="jikan-score-list">${scoreRows.map(score => `<div><span>${safe(score.score)}/10</span><span class="jikan-score-track"><i style="width:${Math.max(0, Math.min(100, Number(score.percentage) || 0))}%"></i></span><small>${safe(score.votes?.toLocaleString?.() ?? score.votes ?? 0)} · ${safe(score.percentage || 0)}%</small></div>`).join("")}</div>` : ""}</section>` : ""}
    ${people.length ? `<section class="tvmaze-detail-block"><h2>Characters and voice cast <small>${people.length}</small></h2><div class="tvmaze-people-grid">${people.map(item => `<article class="tvmaze-person-card">${href(item.character?.images?.jpg?.image_url) ? `<img src="${href(item.character.images.jpg.image_url)}" alt="" loading="lazy">` : `<div class="tvmaze-person-placeholder">${safe((item.character?.name || "?").slice(0,1))}</div>`}<div><strong>${safe(item.character?.name || "Unknown")}</strong><span>${safe(item.role || "Character")}${item.favorites ? ` · ${safe(item.favorites)} favorites` : ""}</span>${(item.voice_actors || []).map(actor => `<small>${safe(actor.language || "Voice")}: ${safe(actor.person?.name || actor.name || "")}</small>`).join("")}</div></article>`).join("")}</div></section>` : ""}
    ${staff.length ? `<section class="tvmaze-detail-block"><h2>Staff <small>${staff.length}</small></h2><div class="tvmaze-people-grid">${staff.map(item => `<article class="tvmaze-person-card">${href(item.person?.images?.jpg?.image_url) ? `<img src="${href(item.person.images.jpg.image_url)}" alt="" loading="lazy">` : `<div class="tvmaze-person-placeholder">${safe((item.person?.name || "?").slice(0,1))}</div>`}<div><strong>${safe(item.person?.name || "Unknown")}</strong><span>${safe((item.positions || []).join(", ") || "Staff")}</span></div></article>`).join("")}</div></section>` : ""}
    ${reviews.length ? `<section class="tvmaze-detail-block"><h2>User reviews <small>${details.reviewsPagination?.items?.total ?? reviews.length} total · first ${reviews.length}</small></h2><div class="jikan-review-list">${reviews.map(review => `<details><summary><strong>${safe(review.reviewer?.username || "MyAnimeList user")}</strong><span>${safe(review.score || "—")}/10 · ${review.is_spoiler ? "Spoiler" : "Review"} · ${safe(review.date || "")}</span>${review.reactions?.overall ? `<small>${safe(review.reactions.overall)} reactions</small>` : ""}</summary><p>${safe(review.review || "")}</p>${href(review.url) ? `<a href="${href(review.url)}" target="_blank" rel="noopener">Read on MyAnimeList</a>` : ""}</details>`).join("")}</div></section>` : ""}
    ${recommendations.length ? `<section class="tvmaze-detail-block"><h2>Jikan recommendations <small>${recommendations.length}</small></h2><div class="show-detail-related-list">${recommendations.map(item => item.entry ? `<a class="show-detail-related-card" href="static/pages/main/show-detail.html?category=${encodeURIComponent(showDetailState.category)}&provider=jikan&providerId=${encodeURIComponent(item.entry.mal_id)}&title=${encodeURIComponent(item.entry.title || "")}">${thumbnailOrPlaceholder(item.entry.images?.jpg?.image_url, "show-detail-related-thumb")}<span>${safe(item.entry.title || "Untitled")}</span><small>${safe(`${item.votes || 0} votes`)}</small></a>` : "").join("")}</div></section>` : ""}
    ${relations.length ? `<section class="tvmaze-detail-block"><h2>Related titles <small>${relations.length}</small></h2><div class="anilist-related-list">${relations.map(group => (group.entry || []).map(item => `<a href="${href(item.url)}" target="_blank" rel="noopener"><strong>${safe(item.name || "Untitled")}</strong><span>${safe([group.relation, item.type].filter(Boolean).join(" · "))}</span></a>`).join("")).join("")}</div></section>` : ""}
    ${pictures.length ? `<section class="tvmaze-detail-block"><h2>Pictures <small>${pictures.length}</small></h2><div class="tvmaze-image-grid">${pictures.map((picture,index) => { const src = picture.jpg?.large_image_url || picture.jpg?.image_url; return href(src) ? `<a href="${href(src)}" target="_blank" rel="noopener" title="Picture ${index + 1}"><img src="${href(picture.jpg?.small_image_url || src)}" alt="${safe(entry.title)} image ${index + 1}" loading="lazy"><small>Image ${index + 1}</small></a>` : ""; }).join("")}</div></section>` : ""}
    ${promos.length || videoEpisodes.length ? `<section class="tvmaze-detail-block"><h2>Videos</h2><div class="anilist-link-list">${promos.map(item => href(item.trailer?.url) ? `<a href="${href(item.trailer.url)}" target="_blank" rel="noopener">${safe(item.title || "Promotional video")}</a>` : "").join("")}${videoEpisodes.map(item => href(item.url) ? `<a href="${href(item.url)}" target="_blank" rel="noopener">${safe(item.title || item.episode || "Episode")}</a>` : "").join("")}</div></section>` : ""}
    ${links.length ? `<details class="tvmaze-detail-block"><summary>External and streaming links <small>${links.length}</small></summary><div class="anilist-link-list">${links.map(item => `<a href="${href(item.url)}" target="_blank" rel="noopener">${safe(item.name || "Open link")}</a>`).join("")}</div></details>` : ""}
    <p class="tvmaze-data-footnote">Jikan data loaded for ${details.type}: ${people.length} characters, ${staff.length} staff entries, ${reviews.length} reviews, and ${recommendations.length} recommendations.</p>`;
}
