// Mangadex provider adapter for the shared show detail page.

let mangaDexRequestQueue = Promise.resolve();

let mangaDexLastRequestAt = 0;

function fetchMangaDexJson(url) {
  const run = async () => {
    const delay = Math.max(0, 250 - (Date.now() - mangaDexLastRequestAt));
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    mangaDexLastRequestAt = Date.now();
    return fetchJsonPortable(url, { headers: { Accept: "application/json" } });
  };
  const request = mangaDexRequestQueue.then(run, run);
  mangaDexRequestQueue = request.catch(() => {});
  return request;
}

function mangaDexCoverUrl(mangaId, filename, size = "256") {
  return filename ? `https://uploads.mangadex.org/covers/${encodeURIComponent(mangaId)}/${encodeURIComponent(filename)}.${size}.jpg` : "";
}

function mangaDexLocalized(value, language = "en") {
  if (typeof value === "string") return value;
  return value?.[language] || value?.en || Object.values(value || {}).find(Boolean) || "";
}

async function fetchMangaDexAniListFallback(title, providerId) {
  if (!title) throw new Error("A title is needed to look up a backup manga record");
  const query = `query($search:String){Media(search:$search,type:MANGA,sort:SEARCH_MATCH){id title{romaji english native userPreferred} description(asHtml:false) status startDate{year} chapters volumes coverImage{extraLarge large medium} averageScore meanScore popularity favourites countryOfOrigin genres tags{name category rank} staff(perPage:20){edges{role node{name{full}}}} siteUrl}}`;
  const directFetch = window.cuemarkNativeFetch || fetch.bind(window);
  const response = await directFetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables: { search: title } })
  });
  const payload = await parseDetailResponse(response);
  const media = payload?.data?.Media;
  if (!media?.id) throw new Error("AniList could not find a backup record");
  const romaji = media.title?.romaji || media.title?.userPreferred || title;
  const tags = [
    ...(media.genres || []).map(name => ({ attributes: { name: { en: name }, group: "genre" } })),
    ...(media.tags || []).map(tag => ({ attributes: { name: { en: tag.name }, group: String(tag.category || "theme").toLowerCase().includes("genre") ? "genre" : "theme", version: `${tag.rank}%` } }))
  ];
  const authors = (media.staff?.edges || []).map(edge => ({
    role: /art|illustrat|draw/i.test(edge.role || "") ? "artist" : "author",
    person: { attributes: { name: edge.node?.name?.full || "Unknown" } }
  }));
  const manga = {
    id: providerId,
    attributes: {
      title: { en: romaji, ja: media.title?.native || "" },
      description: { en: media.description || "" },
      status: String(media.status || "").toLowerCase(),
      year: media.startDate?.year || null,
      lastChapter: media.chapters || "",
      lastVolume: media.volumes || "",
      publicationDemographic: "",
      contentRating: "",
      originalLanguage: media.countryOfOrigin === "JP" ? "ja" : "",
      availableTranslatedLanguages: [],
      version: "",
      createdAt: "",
      updatedAt: ""
    },
    relationships: []
  };
  const average = Number(media.meanScore || media.averageScore || 0);
  return {
    manga,
    included: [],
    statistics: { rating: average ? { average: average / 10, users: Number(media.popularity || 0), distribution: {} } : {} },
    aggregate: [],
    relations: [],
    chapters: [],
    covers: [],
    primaryCover: "",
    coverUrl: media.coverImage?.extraLarge || media.coverImage?.large || media.coverImage?.medium || "",
    tags,
    authors,
    recommendations: [],
    fallbackSource: "AniList",
    fallbackSourceUrl: media.siteUrl || `https://anilist.co/manga/${media.id}`,
    fetchedAt: Date.now()
  };
}

async function fetchMangaDexFullData(providerId, existingItem = null, fallbackTitle = "") {
  const cacheKey = `cuemark:mangadex:${providerId}`;
  let details = null;
  try {
    const cached = JSON.parse(sessionStorage.getItem(cacheKey) || "null");
    if (cached?.manga && Date.now() - Number(cached.fetchedAt || 0) < 24 * 60 * 60 * 1000) details = cached;
  } catch {}
  if (!details) {
    const base = `https://api.mangadex.org`;
    const mainParams = new URLSearchParams();
    ["author", "artist", "cover_art", "tag"].forEach(include => mainParams.append("includes[]", include));
    let main;
    try {
      main = await fetchMangaDexJson(`${base}/manga/${encodeURIComponent(providerId)}?${mainParams.toString()}`);
    } catch (error) {
      if (error?.status !== 403 && !/\b403\b/.test(String(error?.message || error))) throw error;
      console.warn("MangaDex API returned 403; loading this manga from AniList instead", error);
      details = await fetchMangaDexAniListFallback(fallbackTitle, providerId);
      try { sessionStorage.setItem(cacheKey, JSON.stringify(details)); } catch {}
    }
    if (!details) {
    const manga = main?.data;
    if (!manga?.id) throw new Error("MangaDex title not found");

    const getOptional = async (label, path) => {
      try { return await fetchMangaDexJson(`${base}${path}`); }
      catch (error) { console.warn(`Could not load MangaDex ${label}`, error); return null; }
    };
    const [statistics, aggregate, relations, feed, covers] = await Promise.all([
      getOptional("statistics", `/statistics/manga/${encodeURIComponent(providerId)}`),
      getOptional("chapter aggregate", `/manga/${encodeURIComponent(providerId)}/aggregate?translatedLanguage[]=en`),
      getOptional("related titles", `/manga/${encodeURIComponent(providerId)}/relation?includes[]=manga`),
      getOptional("chapter list", `/manga/${encodeURIComponent(providerId)}/feed?translatedLanguage[]=en&order[createdAt]=desc&limit=100&includes[]=scanlation_group`),
      getOptional("covers", `/cover?manga[]=${encodeURIComponent(providerId)}&limit=20&order[volume]=desc`)
    ]);
    const included = [...(main.included || []), ...(relations?.included || []), ...(feed?.included || [])];
    const attributes = manga.attributes || {};
    const primaryCover = (manga.relationships || []).find(rel => rel.type === "cover_art")?.attributes?.fileName
      || included.find(item => item.type === "cover_art" && item.id === (manga.relationships || []).find(rel => rel.type === "cover_art")?.id)?.attributes?.fileName;
    const aggregateVolumes = Object.entries(aggregate?.volumes || {}).map(([key, volume]) => ({
      volume: volume.volume ?? key,
      count: volume.count || 0,
      chapters: Object.entries(volume.chapters || {}).map(([chapterKey, chapter]) => ({
        chapter: chapter.chapter ?? chapterKey,
        count: chapter.count || 0,
        isUnavailable: Boolean(chapter.isUnavailable)
      }))
    }));
    const details = {
      manga, included, statistics: statistics?.statistics?.[providerId] || {},
      aggregate: aggregateVolumes,
      relations: relations?.data || [],
      chapters: feed?.data || [], chapterPagination: feed?.limit ? { limit: feed.limit, offset: feed.offset, total: feed.total } : null,
      covers: covers?.data || [],
      primaryCover,
      fetchedAt: Date.now()
    };
    const tagEntries = (manga.relationships || []).filter(rel => rel.type === "tag").map(rel => included.find(item => item.type === "tag" && item.id === rel.id)).filter(Boolean);
    details.tags = tagEntries;
    details.authors = (manga.relationships || []).filter(rel => ["author", "artist"].includes(rel.type)).map(rel => ({
      role: rel.type,
      person: included.find(item => item.type === "author" && item.id === rel.id)
    })).filter(item => item.person);
    details.recommendations = await fetchMangaDexRecommendations(base, manga, tagEntries, providerId);
    try { sessionStorage.setItem(cacheKey, JSON.stringify(details)); } catch {}
    }
  }

  if (existingItem) {
    const attrs = details.manga.attributes || {};
    const coverUrl = mangaDexCoverUrl(providerId, details.primaryCover || details.covers?.[0]?.attributes?.fileName);
    const tagNames = (details.tags || []).map(tag => mangaDexLocalized(tag.attributes?.name)).filter(Boolean);
    const totalChapters = (details.aggregate || []).reduce((sum, volume) => sum + volume.chapters.length, 0);
    Object.assign(existingItem, {
      summary: mangaDexLocalized(attrs.description) || existingItem.summary || "",
      genres: tagNames,
      mangadexDetailsCache: details,
      totalChapters: totalChapters || (parseInt(attrs.lastChapter) || existingItem.totalChapters || 0),
      totalVolumes: details.aggregate?.length || Number(attrs.lastVolume) || existingItem.totalVolumes || 0,
      ...(thumbnailsEnabled() && (details.coverUrl || coverUrl) ? { thumbnail: details.coverUrl || coverUrl } : {})
    });
    saveData();
  }
  return details;
}

async function fetchMangaDexRecommendations(base, manga, tags, currentId) {
  const tagIds = tags.filter(tag => ["genre", "theme"].includes(tag.attributes?.group)).slice(0, 3).map(tag => tag.id);
  if (!tagIds.length) return [];
  const params = new URLSearchParams({ limit: "15", "order[rating]": "desc", "includes[]": "cover_art" });
  tagIds.forEach(id => params.append("includedTags[]", id));
  params.set("includedTagsMode", "OR");
  try {
    const response = await fetchMangaDexJson(`${base}/manga?${params.toString()}`);
    return (response?.data || []).filter(item => item.id !== currentId).slice(0, 12);
  } catch (error) {
    console.warn("Could not load MangaDex suggested titles", error);
    return [];
  }
}

function renderMangaDexDetails(details) {
  const section = document.getElementById("mangadex-extra-section");
  const manga = details?.manga;
  if (!section) return;
  if (!manga) { section.style.display = "none"; section.innerHTML = ""; return; }
  const safe = detailText;
  const href = value => {
    try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? safe(url.href) : ""; }
    catch { return ""; }
  };
  const attrs = manga.attributes || {};
  const title = mangaDexLocalized(attrs.title) || "Untitled";
  const primaryCover = details.coverUrl || mangaDexCoverUrl(manga.id, details.primaryCover);
  const stats = details.statistics || {};
  const rating = stats.rating || {};
  const ratingDistribution = Object.entries(rating.distribution || {}).filter(([, count]) => Number(count) > 0).sort(([a], [b]) => Number(b) - Number(a));
  const tags = details.tags || [];
  const tagGroups = [...new Set(tags.map(tag => tag.attributes?.group).filter(Boolean))];
  const coverImages = (details.covers || []).map(cover => ({
    url: mangaDexCoverUrl(manga.id, cover.attributes?.fileName, "512"),
    volume: cover.attributes?.volume || ""
  })).filter(cover => cover.url);
  const related = details.relations || [];
  const relationsIncluded = details.included || [];
  const relationById = id => relationsIncluded.find(item => item.type === "manga" && item.id === id);
  const authors = details.authors || [];
  const volumes = details.aggregate || [];
  const chapters = details.chapters || [];
  const info = [
    ["MangaDex ID", manga.id], ["Status", attrs.status], ["Year", attrs.year],
    ["Publication demographic", attrs.publicationDemographic], ["Content rating", attrs.contentRating],
    ["Original language", attrs.originalLanguage], ["Last chapter", attrs.lastChapter],
    ["Latest uploaded chapter", attrs.latestUploadedChapter], ["Available translations", (attrs.availableTranslatedLanguages || []).join(", ")],
    ["Version", attrs.version], ["Created", attrs.createdAt], ["Updated", attrs.updatedAt],
    ["Follows", stats.follows], ["Average rating", rating.average ? `${Number(rating.average).toFixed(2)}/10` : "Not rated"],
    ["Bayesian rating", rating.bayesian ? `${Number(rating.bayesian).toFixed(2)}/10` : ""],
    ["Comment replies", stats.comments?.repliesCount], ["Volume groups", details.fallbackSource ? "" : volumes.length],
    ["Chapter entries", details.fallbackSource ? "" : volumes.reduce((sum, volume) => sum + volume.chapters.length, 0)]
  ].filter(([, value]) => value !== null && value !== undefined && value !== "");
  const externalLinks = Object.entries(attrs.links || {}).map(([key, value]) => {
    const urls = {
      al: `https://anilist.co/manga/${encodeURIComponent(value)}`,
      ap: `https://www.anime-planet.com/manga/${encodeURIComponent(value)}`,
      kt: /^\d+$/.test(String(value)) ? `https://kitsu.io/api/edge/manga/${encodeURIComponent(value)}` : `https://kitsu.io/manga/${encodeURIComponent(value)}`,
      mal: `https://myanimelist.net/manga/${encodeURIComponent(value)}`,
      mu: `https://www.mangaupdates.com/series.html?id=${encodeURIComponent(value)}`,
      nu: `https://www.novelupdates.com/series/${encodeURIComponent(value)}`,
      amz: value, ebj: value, engtl: value, raw: value
    };
    return urls[key] ? { key, url: urls[key] } : null;
  }).filter(Boolean);
  const mangaUrl = `https://mangadex.org/title/${encodeURIComponent(manga.id)}`;
  section.style.display = "block";
  section.innerHTML = `
    <section class="tvmaze-detail-block"><h2>${details.fallbackSource ? `${safe(details.fallbackSource)} backup details` : "MangaDex details"}</h2>${details.fallbackSource ? `<p class="tvmaze-api-note">MangaDex returned HTTP 403, so core title information below is from ${safe(details.fallbackSource)}. The MangaDex link still opens the original record.</p>` : ""}${primaryCover ? `<img class="anilist-banner" src="${href(primaryCover)}" alt="${safe(title)} cover" loading="lazy">` : ""}<dl class="tvmaze-info-grid">${info.map(([label,value]) => `<div><dt>${safe(label)}</dt><dd>${safe(value)}</dd></div>`).join("")}</dl><div class="anilist-link-row"><a href="${href(mangaUrl)}" target="_blank" rel="noopener">Open on MangaDex</a>${details.fallbackSourceUrl ? `<a href="${href(details.fallbackSourceUrl)}" target="_blank" rel="noopener">Open ${safe(details.fallbackSource)} record</a>` : ""}${externalLinks.map(link => `<a href="${href(link.url)}" target="_blank" rel="noopener">${safe(link.key.toUpperCase())} link</a>`).join("")}</div>${details.fallbackSource ? "" : `<p class="tvmaze-api-note">MangaDex supplies community rating statistics and a comment thread count, but does not provide review text through its public API.</p>`}</section>
    ${mangaDexLocalized(attrs.description) ? `<section class="tvmaze-detail-block"><h2>Description</h2><p class="jikan-long-text">${safe(mangaDexLocalized(attrs.description))}</p></section>` : ""}
    ${authors.length ? `<section class="tvmaze-detail-block"><h2>Authors and artists <small>${authors.length}</small></h2><div class="anilist-chip-list">${authors.map(({role,person}) => `<span class="anilist-chip">${safe(person.attributes?.name || "Unknown")}${role === "artist" ? " · Artist" : " · Author"}</span>`).join("")}</div></section>` : ""}
    ${tags.length ? `<section class="tvmaze-detail-block"><h2>Tags <small>${tags.length}</small></h2>${tagGroups.map(group => `<div class="mangadex-tag-group"><h3>${safe(group)}</h3><div class="anilist-chip-list">${tags.filter(tag => tag.attributes?.group === group).map(tag => `<span class="anilist-chip">${safe(mangaDexLocalized(tag.attributes?.name))}${tag.attributes?.version ? ` · v${safe(tag.attributes.version)}` : ""}</span>`).join("")}</div></div>`).join("")}</section>` : ""}
    ${ratingDistribution.length ? `<section class="tvmaze-detail-block"><h2>Rating distribution</h2><div class="jikan-score-list">${ratingDistribution.map(([score,count]) => `<div><span>${safe(score)}/10</span><span class="jikan-score-track"><i style="width:${Math.max(0, Math.min(100, Number(count) / Math.max(1, Number(rating.users)) * 100))}%"></i></span><small>${safe(count)} votes</small></div>`).join("")}</div></section>` : ""}
    ${related.length ? `<section class="tvmaze-detail-block"><h2>Related manga <small>${related.length}</small></h2><div class="anilist-related-list">${related.map(item => { const targetId = item.relationships?.manga?.id; const target = relationById(targetId); return target ? `<a href="static/pages/main/show-detail.html?category=manga&provider=mangadex&providerId=${encodeURIComponent(target.id)}&title=${encodeURIComponent(mangaDexLocalized(target.attributes?.title))}"><strong>${safe(mangaDexLocalized(target.attributes?.title) || "Untitled")}</strong><span>${safe(item.attributes?.related || "Related")}</span></a>` : ""; }).join("")}</div></section>` : ""}
    ${details.recommendations?.length ? `<section class="tvmaze-detail-block"><h2>Similar titles by tags <small>${details.recommendations.length}</small></h2><div class="show-detail-related-list">${details.recommendations.map(item => { const cover = (item.relationships || []).find(rel => rel.type === "cover_art")?.attributes?.fileName; const recommendationTitle = mangaDexLocalized(item.attributes?.title) || "Untitled"; return `<a class="show-detail-related-card" href="static/pages/main/show-detail.html?category=manga&provider=mangadex&providerId=${encodeURIComponent(item.id)}&title=${encodeURIComponent(recommendationTitle)}">${thumbnailOrPlaceholder(mangaDexCoverUrl(item.id, cover), "show-detail-related-thumb")}<span>${safe(recommendationTitle)}</span><small>${safe([item.attributes?.year, item.attributes?.status].filter(Boolean).join(" · ") || "Shared MangaDex tags")}</small></a>`; }).join("")}</div></section>` : ""}
    ${volumes.length ? `<details class="tvmaze-detail-block"><summary>Volumes and chapter counts <small>${volumes.length}</small></summary><div class="mangadex-volume-list">${volumes.map(volume => `<div><strong>${safe(volume.volume || "No volume")}</strong><span>${safe(volume.count)} chapters</span><small>${volume.chapters.map(chapter => safe(chapter.chapter)).join(", ")}</small></div>`).join("")}</div></details>` : ""}
    ${chapters.length ? `<section class="tvmaze-detail-block"><h2>Latest English chapters <small>First ${chapters.length}</small></h2><div class="mangadex-chapter-list">${chapters.slice(0, 30).map(chapter => { const chapterAttrs = chapter.attributes || {}; const groups = (chapter.relationships || []).filter(rel => rel.type === "scanlation_group").map(rel => relationsIncluded.find(item => item.type === "scanlation_group" && item.id === rel.id)?.attributes?.name).filter(Boolean); return `<a href="${href(`https://mangadex.org/chapter/${chapter.id}`)}" target="_blank" rel="noopener"><strong>${safe([chapterAttrs.volume ? `Vol. ${chapterAttrs.volume}` : "", chapterAttrs.chapter ? `Ch. ${chapterAttrs.chapter}` : "", chapterAttrs.title].filter(Boolean).join(" · ") || "Chapter")}</strong><span>${safe(groups.join(", ") || "MangaDex group unlisted")}</span><small>${safe(chapterAttrs.publishAt || chapterAttrs.readableAt || "")}</small></a>`; }).join("")}</div><p class="tvmaze-api-note">Scanlation group names are shown with chapter links, as required by MangaDex’s API policy.</p></section>` : ""}
    ${coverImages.length > 1 ? `<section class="tvmaze-detail-block"><h2>Alternate covers <small>${coverImages.length}</small></h2><div class="steam-screenshots">${coverImages.map(cover => `<a href="${href(cover.url)}" target="_blank" rel="noopener"><img src="${href(cover.url)}" loading="lazy" alt="${safe(title)} ${cover.volume ? `volume ${cover.volume}` : "alternate cover"}"></a>`).join("")}</div></section>` : ""}
    <div class="freetogame-attribution"><a href="${href(mangaUrl)}" target="_blank" rel="noopener">Manga metadata and chapter credits from MangaDex</a></div>`;
}
