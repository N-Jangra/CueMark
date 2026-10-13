// Kitsu provider adapter for the shared show detail page.

async function fetchKitsuTitleFallback(title, category = "anime") {
  const type = category === "manga" || category === "novel" ? "manga" : "anime";
  const params = new URLSearchParams({ "filter[text]": title, "page[limit]": "20" });
  const search = await fetchKitsuJson(`https://kitsu.io/api/edge/${type}?${params.toString()}`);
  const normalizedTitle = normalizeProviderTitle(title);
  const media = (search?.data || []).find(result => {
    const attrs = result.attributes || {};
    return [attrs.canonicalTitle, ...Object.values(attrs.titles || {})]
      .some(candidate => normalizeProviderTitle(candidate) === normalizedTitle);
  });
  if (!media?.id) return null;
  return fetchKitsuFullData(media.id, type);
}

async function fetchKitsuJson(url) {
  const headers = { Accept: "application/vnd.api+json" };
  const plugin = getNativeHttpPlugin();
  if (plugin?.get) {
    const response = await plugin.get({ url, headers });
    const payload = parseDetailJson(response?.data);
    if (!response?.status || response.status < 400) return payload;
    if (response.status !== 403) throw detailHttpError(response.status, payload);
  } else if (plugin?.request) {
    const response = await plugin.request({ url, method: "GET", headers, responseType: "json" });
    const payload = parseDetailJson(response?.data);
    if (!response?.status || response.status < 400) return payload;
    if (response.status !== 403) throw detailHttpError(response.status, payload);
  }

  const directFetch = window.cuemarkNativeFetch || fetch.bind(window);
  let directError = null;
  try {
    const response = await directFetch(url, { headers });
    if (response.ok) return await response.json();
    directError = detailHttpError(response.status, await response.clone().json().catch(() => null));
    if (response.status !== 403 && response.status !== 404) throw directError;
  } catch (error) {
    directError = error;
  }

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
      const response = await directFetch(proxyUrl, { headers });
      if (response.ok) return await response.json();
      const proxyError = detailHttpError(response.status, await response.clone().json().catch(() => null));
      if (!directError || directError.name === "TypeError") directError = proxyError;
    } catch (error) {
      if (!directError) directError = error;
    }
  }
  throw directError || new Error("Kitsu request failed");
}

async function fetchKitsuFullData(providerId, mediaType = "anime", existingItem = null) {
  const type = mediaType === "manga" ? "manga" : "anime";
  const cacheKey = `cuemark:kitsu:${type}:${providerId}`;
  let details = null;
  try {
    const cached = JSON.parse(sessionStorage.getItem(cacheKey) || "null");
    if (cached?.media && Date.now() - Number(cached.fetchedAt || 0) < 24 * 60 * 60 * 1000) details = cached;
  } catch {}
  if (!details) {
    const base = `https://kitsu.io/api/edge/${type}/${encodeURIComponent(providerId)}`;
    let main = null;
    try {
      main = await fetchKitsuJson(`${base}?include=categories,genres,mediaRelationships.destination`);
    } catch {
      main = await fetchKitsuJson(base);
    }
    const media = main?.data;
    if (!media) throw new Error("Kitsu details unavailable");

    const filterName = type === "manga" ? "mangaId" : "animeId";
    const collection = async (path, params = {}) => {
      const query = new URLSearchParams({ "page[limit]": "20", ...params });
      try { return await fetchKitsuJson(`https://kitsu.io/api/edge/${path}?${query.toString()}`); }
      catch (error) { console.warn(`Could not load Kitsu ${path}`, error); return { data: [], included: [], links: {} }; }
    };
    const [characters, staff, castings, reviews, relations, episodes, streaming, productions] = await Promise.all([
      collection("characters", { [`filter[${filterName}]`]: providerId, include: "character,voiceActors.person" }),
      collection(`${type}/${encodeURIComponent(providerId)}/staff`, { include: "person" }),
      collection("castings", { [`filter[${type === "manga" ? "manga_id" : "anime_id"}]`]: providerId, kind: type, include: "person,character" }),
      collection("reviews", { [`filter[${filterName}]`]: providerId, include: "user" }),
      collection("media-relationships", { "filter[sourceId]": providerId, "filter[sourceType]": type === "manga" ? "Manga" : "Anime", include: "destination" }),
      type === "anime" ? collection("anime/" + encodeURIComponent(providerId) + "/episodes") : Promise.resolve({ data: [], included: [], links: {} }),
      type === "anime" ? collection("anime/" + encodeURIComponent(providerId) + "/streaming-links") : Promise.resolve({ data: [], included: [], links: {} }),
      collection(`${type}-productions`, { [`filter[${filterName}]`]: providerId, include: "producer" })
    ]);
    details = {
      type, media, mainIncluded: main.included || [],
      characters: characters.data || [], charactersIncluded: characters.included || [],
      staff: staff.data || [], staffIncluded: staff.included || [],
      castings: castings.data || [], castingsIncluded: castings.included || [],
      reviews: reviews.data || [], reviewsIncluded: reviews.included || [], reviewsLinks: reviews.links || {},
      relationships: relations.data || [], relationshipsIncluded: relations.included || [],
      episodes: episodes.data || [], episodesLinks: episodes.links || {},
      streaming: streaming.data || [], streamingIncluded: streaming.included || [],
      productions: productions.data || [], productionsIncluded: productions.included || [],
      fetchedAt: Date.now()
    };
  }
  details.included = [...(details.mainIncluded || []), ...(details.charactersIncluded || []), ...(details.staffIncluded || []), ...(details.castingsIncluded || []), ...(details.reviewsIncluded || []), ...(details.relationshipsIncluded || []), ...(details.streamingIncluded || []), ...(details.productionsIncluded || [])];
  const findIncluded = ref => details.included.find(item => item.type === ref?.type && item.id === ref?.id);
  details.genres = (details.media.relationships?.genres?.data || []).map(findIncluded).filter(Boolean);
  details.categories = (details.media.relationships?.categories?.data || []).map(findIncluded).filter(Boolean);
  const relationResources = details.relationships?.length
    ? details.relationships
    : (details.media.relationships?.mediaRelationships?.data || []).map(findIncluded).filter(Boolean);
  details.recommendations = relationResources.map(relation => {
    const destination = findIncluded(relation.relationships?.destination?.data);
    return destination ? { relation: relation.attributes?.role || "Related", media: destination } : null;
  }).filter(Boolean);
  details.episodeItems = (details.episodes || []).map((episode, index) => {
    const attrs = episode.attributes || {};
    return {
      id: episode.id || index + 1, season: 1, number: attrs.number || index + 1,
      name: attrs.canonicalTitle || attrs.titles?.en || `Episode ${index + 1}`,
      runtime: attrs.length || null, airdate: attrs.airdate || "", summary: attrs.synopsis || "",
      image: attrs.thumbnail?.original ? { medium: attrs.thumbnail?.small || attrs.thumbnail.original, original: attrs.thumbnail.original } : null,
      rating: null
    };
  });
  try { sessionStorage.setItem(cacheKey, JSON.stringify(details)); } catch {}
  if (existingItem) {
    const media = details.media;
    Object.assign(existingItem, {
      summary: media.attributes?.synopsis || media.attributes?.description || existingItem.summary || "",
      genres: details.genres.map(item => item.attributes?.name).filter(Boolean),
      kitsuDetailsCache: details,
      totalEpisodes: media.attributes?.episodeCount || existingItem.totalEpisodes || 0,
      totalChapters: media.attributes?.chapterCount || existingItem.totalChapters || 0,
      totalVolumes: media.attributes?.volumeCount || existingItem.totalVolumes || 0,
      episodeRuntime: media.attributes?.episodeLength || existingItem.episodeRuntime || 0,
      ...(thumbnailsEnabled() && (media.attributes?.posterImage?.large || media.attributes?.posterImage?.original) ? { thumbnail: media.attributes.posterImage.large || media.attributes.posterImage.original } : {})
    });
    saveData();
  }
  return details;
}

function renderKitsuDetails(details) {
  const section = document.getElementById("kitsu-extra-section");
  const media = details?.media;
  if (!section) return;
  if (!media) { section.style.display = "none"; section.innerHTML = ""; return; }
  const safe = detailText;
  const href = value => {
    try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? safe(url.href) : ""; }
    catch { return ""; }
  };
  const attrs = media.attributes || {};
  const included = details.included || [];
  const resolve = ref => included.find(item => item.type === ref?.type && item.id === ref?.id);
  const entries = (list, key) => list.map(item => resolve(item.relationships?.[key]?.data)).filter(Boolean);
  const genres = details.genres || entries(media.relationships?.genres?.data || [], "genres");
  const categories = details.categories || entries(media.relationships?.categories?.data || [], "categories");
  const dateRange = attrs.startDate || attrs.endDate ? [attrs.startDate, attrs.endDate].filter(Boolean).join(" – ") : "";
  const info = [
    ["Kitsu ID", media.id], ["Type", details.type], ["Format", attrs.showType || attrs.subtype], ["Status", attrs.status],
    ["Start / end", dateRange], ["Age rating", attrs.ageRating], ["Age rating guide", attrs.ageRatingGuide],
    ["Episodes", attrs.episodeCount], ["Episode length", attrs.episodeLength ? `${attrs.episodeLength} min` : ""],
    ["Chapters", attrs.chapterCount], ["Volumes", attrs.volumeCount], ["Average rating", attrs.averageRating ? `${(Number(attrs.averageRating) / 10).toFixed(2)}/10` : "Not rated"],
    ["Rating count", attrs.userCount || attrs.ratingsCount], ["Reviews", attrs.reviewsCount], ["Favorites", attrs.favoritesCount], ["Popularity rank", attrs.popularityRank],
    ["Rating rank", attrs.ratingRank], ["Genres", genres.map(item => item.attributes?.name).filter(Boolean).join(", ")],
    ["Categories", categories.map(item => item.attributes?.title).filter(Boolean).join(", ")],
    ["Titles", Object.values(attrs.titles || {}).filter(Boolean).join(", ")]
  ].filter(([, value]) => value !== null && value !== undefined && value !== "");
  const characters = details.characters || [];
  const castings = details.castings || [];
  const staff = details.staff || [];
  const reviews = details.reviews || [];
  const recommendations = details.recommendations || [];
  const mappingLinks = media.relationships?.mappings?.links?.related;
  const videos = attrs.youtubeVideoId ? [`https://www.youtube.com/watch?v=${encodeURIComponent(attrs.youtubeVideoId)}`] : [];
  const ratingFrequencies = Object.entries(attrs.ratingFrequencies || {}).filter(([, count]) => Number(count) > 0).sort(([a], [b]) => Number(b) - Number(a));
  const outgoing = [...(attrs.siteLinks || []).map(item => ({ title: item.title || item.siteName || "External site", url: item.url }))];
  const providerPage = `https://kitsu.io/${details.type}/${attrs.slug || media.id}`;
  section.style.display = "block";
  section.innerHTML = `
    <section class="tvmaze-detail-block"><h2>Kitsu details</h2>${attrs.coverImage?.original ? `<img class="anilist-banner" src="${href(attrs.coverImage.original)}" alt="" loading="lazy">` : ""}<dl class="tvmaze-info-grid">${info.map(([label,value]) => `<div><dt>${safe(label)}</dt><dd>${safe(value)}</dd></div>`).join("")}</dl><div class="anilist-link-row">${href(providerPage) ? `<a href="${href(providerPage)}" target="_blank" rel="noopener">Open on Kitsu</a>` : ""}${mappingLinks && href(mappingLinks) ? `<a href="${href(mappingLinks)}" target="_blank" rel="noopener">External mappings</a>` : ""}</div><p class="tvmaze-api-note">Kitsu average ratings and rating counts are community data. Review text is shown when Kitsu exposes reviews for the title.</p></section>
    ${attrs.synopsis || attrs.description ? `<section class="tvmaze-detail-block"><h2>Synopsis</h2><p class="jikan-long-text">${safe(attrs.synopsis || attrs.description)}</p></section>` : ""}
    ${attrs.background ? `<section class="tvmaze-detail-block"><h2>Background</h2><p class="jikan-long-text">${safe(attrs.background)}</p></section>` : ""}
    ${ratingFrequencies.length ? `<section class="tvmaze-detail-block"><h2>Rating distribution</h2><div class="jikan-score-list">${ratingFrequencies.map(([rating,count]) => `<div><span>${safe((Number(rating) / 2).toFixed(1))}/10</span><span class="jikan-score-track"><i style="width:${Math.max(0, Math.min(100, Number(count) / Math.max(1, Number(attrs.userCount)) * 100))}%"></i></span><small>${safe(count)} users</small></div>`).join("")}</div></section>` : ""}
    ${characters.length ? `<section class="tvmaze-detail-block"><h2>Characters and cast <small>First ${characters.length}</small></h2><div class="tvmaze-people-grid">${characters.map(item => { const character = resolve(item.relationships?.character?.data); const name = character?.attributes?.name || character?.attributes?.canonicalName || "Character"; const image = character?.attributes?.image?.original || character?.attributes?.image?.large; const voiceActors = (item.relationships?.voiceActors?.data || []).map(ref => resolve(ref)).filter(Boolean); return `<article class="tvmaze-person-card">${href(image) ? `<img src="${href(image)}" alt="" loading="lazy">` : `<div class="tvmaze-person-placeholder">${safe(name.slice(0,1))}</div>`}<div><strong>${safe(name)}</strong><span>${safe(item.attributes?.role || "Character")}</span>${voiceActors.map(actor => { const person = resolve(actor.relationships?.person?.data); return `<small>${safe(actor.attributes?.language || "Voice")}: ${safe(person?.attributes?.name || "")}</small>`; }).join("")}</div></article>`; }).join("")}</div><a class="kitsu-provider-more" href="${href(providerPage)}" target="_blank" rel="noopener">Open full cast data on Kitsu</a></section>` : ""}
    ${castings.length ? `<section class="tvmaze-detail-block"><h2>Castings <small>${castings.length}</small></h2><div class="anilist-chip-list">${castings.map(item => { const person = resolve(item.relationships?.person?.data); const character = resolve(item.relationships?.character?.data); return `<span class="anilist-chip">${safe(person?.attributes?.name || "Cast member")}${character?.attributes?.name ? ` · ${safe(character.attributes.name)}` : ""}${item.attributes?.language ? ` · ${safe(item.attributes.language)}` : ""}${item.attributes?.role ? ` · ${safe(item.attributes.role)}` : ""}</span>`; }).join("")}</div></section>` : ""}
    ${staff.length ? `<section class="tvmaze-detail-block"><h2>Staff and production <small>${staff.length + (details.productions || []).length}</small></h2><div class="anilist-chip-list">${staff.map(item => { const person = resolve(item.relationships?.person?.data); return `<span class="anilist-chip">${safe(person?.attributes?.name || "Staff")}${item.attributes?.role ? ` · ${safe(item.attributes.role)}` : ""}</span>`; }).join("")}${(details.productions || []).map(item => { const producer = resolve(item.relationships?.producer?.data); return `<span class="anilist-chip">${safe(producer?.attributes?.name || "Producer")}${item.attributes?.role ? ` · ${safe(item.attributes.role)}` : ""}</span>`; }).join("")}</div></section>` : ""}
    ${reviews.length ? `<section class="tvmaze-detail-block"><h2>User reviews <small>${attrs.reviewsCount || reviews.length} total · first ${reviews.length}</small></h2><div class="jikan-review-list">${reviews.map(review => { const user = resolve(review.relationships?.user?.data); return `<details><summary><strong>${safe(user?.attributes?.name || "Kitsu user")}</strong><span>${safe(review.attributes?.rating || "—")}/100 · ${safe(review.attributes?.createdAt || "")}${review.attributes?.spoiler ? " · Spoiler" : ""}</span></summary><p>${safe(review.attributes?.content || review.attributes?.contentFormatted || "")}</p></details>`; }).join("")}</div><div class="anilist-link-row"><a href="${href(`https://kitsu.io/${details.type}/${attrs.slug || media.id}/reviews`)}" target="_blank" rel="noopener">View reviews on Kitsu</a></div></section>` : ""}
    ${recommendations.length ? `<section class="tvmaze-detail-block"><h2>Related Kitsu titles <small>${recommendations.length}</small></h2><div class="anilist-related-list">${recommendations.map(({relation,media:related}) => `<a href="${href(`https://kitsu.io/${related.type}/${related.attributes?.slug || related.id}`)}" target="_blank" rel="noopener"><strong>${safe(related.attributes?.canonicalTitle || related.attributes?.titles?.en || related.attributes?.titles?.en_jp || "Untitled")}</strong><span>${safe(relation)}</span></a>`).join("")}</div></section>` : ""}
    ${details.episodeItems?.length ? `<section class="tvmaze-detail-block"><h2>Episodes <small>First ${details.episodeItems.length}</small></h2><div class="anilist-schedule-list">${details.episodeItems.map(episode => `<span>Episode ${safe(episode.number)} · ${safe(episode.name)}${episode.airdate ? ` · ${safe(episode.airdate)}` : ""}${episode.runtime ? ` · ${safe(episode.runtime)} min` : ""}</span>`).join("")}</div><a class="kitsu-provider-more" href="${href(`${providerPage}/episodes`)}" target="_blank" rel="noopener">Open full episode list on Kitsu</a></section>` : ""}
    ${details.streaming?.length ? `<details class="tvmaze-detail-block"><summary>Streaming sources <small>${details.streaming.length}</small></summary><div class="anilist-link-list">${details.streaming.map(item => `<a href="${href(item.attributes?.url)}" target="_blank" rel="noopener">${safe(item.attributes?.siteName || item.attributes?.url || "Streaming link")}</a>`).join("")}</div></details>` : ""}
    ${outgoing.length || videos.length ? `<details class="tvmaze-detail-block"><summary>External links</summary><div class="anilist-link-list">${outgoing.map(item => href(item.url) ? `<a href="${href(item.url)}" target="_blank" rel="noopener">${safe(item.title)}</a>` : "").join("")}${videos.map(url => `<a href="${href(url)}" target="_blank" rel="noopener">Watch trailer</a>`).join("")}</div></details>` : ""}
    <p class="tvmaze-data-footnote">Kitsu returned ${characters.length} characters, ${staff.length} staff entries, ${reviews.length} reviews, and ${recommendations.length} related titles for ${details.type}. Collection results show the first page (up to 20 items).</p>`;
}
