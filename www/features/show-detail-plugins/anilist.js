// Anilist provider adapter for the shared show detail page.

async function fetchAniListJson(url, init = {}) {
  // AniList GraphQL uses POST. Keep its request on browser fetch so the
  // Capacitor GET transport and shared provider proxy cannot rewrite it.
  const directFetch = window.cuemarkNativeFetch || fetch.bind(window);
  const response = await directFetch(url, init);
  return parseDetailResponse(response);
}

async function fetchAniListRecommendations(providerId) {
  const query = `query($id:Int){Media(id:$id){recommendations(sort:RATING_DESC,perPage:6){nodes{mediaRecommendation{id title{romaji english} coverImage{medium} genres}}}}}`;
  const response = await fetchAniListJson("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables: { id: Number(providerId) } })
  });
  return response?.data?.Media?.recommendations?.nodes || [];
}

async function fetchAniListFullData(providerId, mediaType = "ANIME", existingItem = null) {
  const query = `query($id:Int,$type:MediaType){
    Media(id:$id,type:$type){
      id idMal type format status description(asHtml:false) startDate{year month day} endDate{year month day}
      season seasonYear episodes duration chapters volumes countryOfOrigin source(version:2) hashtag
      title{romaji english native userPreferred} coverImage{extraLarge large medium color} bannerImage
      genres synonyms averageScore meanScore popularity favourites trending updatedAt siteUrl isLicensed isAdult
      trailer{id site thumbnail}
      rankings{rank type format year season allTime context}
      tags{name description category rank isGeneralSpoiler isMediaSpoiler isAdultSpoiler}
      studios{edges{isMain node{id name isAnimationStudio siteUrl favourites}}}
      staff(sort:RELEVANCE,perPage:25){pageInfo{total} edges{role node{id name{full native} image{large medium} primaryOccupations gender dateOfBirth{year month day} dateOfDeath{year month day} homeTown siteUrl}}}
      characters(sort:ROLE,perPage:25){pageInfo{total} edges{role node{id name{full native} image{large medium} description gender age siteUrl} voiceActors(sort:RELEVANCE){id name{full native} image{large medium} languageV2 siteUrl}}}
      airingSchedule(notYetAired:true,perPage:25){pageInfo{total} nodes{episode airingAt timeUntilAiring}}
      nextAiringEpisode{episode airingAt timeUntilAiring}
      streamingEpisodes{title thumbnail url site}
      externalLinks{site url type language color icon notes isDisabled}
      relations{edges{relationType(version:2) node{id type format status title{english romaji native} coverImage{medium} startDate{year} averageScore siteUrl}}}
      recommendations(sort:RATING_DESC,perPage:25){pageInfo{total} nodes{rating mediaRecommendation{id type format title{english romaji} coverImage{medium} startDate{year} averageScore siteUrl}}}
      reviews(perPage:25){pageInfo{total} nodes{id summary body(asHtml:false) score rating ratingAmount siteUrl user{name avatar{large} siteUrl} createdAt updatedAt}}
      stats{scoreDistribution{score amount} statusDistribution{status amount}}
    }
  }`;
  const variables = { id: Number(providerId), type: mediaType };
  const request = queryText => fetchAniListJson("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query: queryText, variables })
  });
  let response = null;
  let media = null;
  let fullQueryError = "";
  try {
    response = await request(query);
    media = response?.data?.Media || null;
    if (!media) throw new Error(detailResponseMessage(response) || "AniList returned no media record");
    if (response?.errors?.length) fullQueryError = detailResponseMessage(response);
  } catch (error) {
    fullQueryError = error?.message || "Full AniList detail query failed";
    if (error?.status === 403 || error?.status === 429) throw error;
    console.warn("AniList full detail query failed; retrying with core title fields", error);
    const coreQuery = `query($id:Int,$type:MediaType){Media(id:$id,type:$type){
      id idMal type format status description(asHtml:false) startDate{year month day} endDate{year month day}
      season seasonYear episodes duration chapters volumes countryOfOrigin
      title{romaji english native userPreferred} coverImage{extraLarge large medium} bannerImage
      genres synonyms averageScore meanScore popularity favourites siteUrl
    }}`;
    try {
      response = await request(coreQuery);
      media = response?.data?.Media || null;
      if (!media) throw new Error(detailResponseMessage(response) || "AniList returned no media record");
    } catch (fallbackError) {
      throw new Error(`${fullQueryError}; core profile also failed: ${fallbackError?.message || "unknown error"}`);
    }
  }
  const details = { media, fetchedAt: Date.now(), ...(fullQueryError ? { partial: true, partialError: fullQueryError } : {}) };
  details.pictures = await fetchJikanPictures(media.idMal, mediaType === "MANGA" ? "manga" : "anime");
  if (existingItem) {
    existingItem.summary = media.description || existingItem.summary || "";
    existingItem.genres = media.genres || existingItem.genres || [];
    existingItem.anilistDetailsCache = details;
    existingItem.totalEpisodes = media.episodes || existingItem.totalEpisodes || 0;
    existingItem.totalChapters = media.chapters || existingItem.totalChapters || 0;
    existingItem.totalVolumes = media.volumes || existingItem.totalVolumes || 0;
    existingItem.episodeRuntime = media.duration || existingItem.episodeRuntime || 0;
    if (thumbnailsEnabled() && media.coverImage?.extraLarge) existingItem.thumbnail = media.coverImage.extraLarge;
    saveData();
  }
  return details;
}

function renderAniListDetails(details) {
  const section = document.getElementById("anilist-extra-section");
  const media = details?.media;
  if (!section) return;
  if (!media) {
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
  const date = value => [value?.year, value?.month ? String(value.month).padStart(2, "0") : "", value?.day ? String(value.day).padStart(2, "0") : ""].filter(Boolean).join("-");
  const studios = media.studios?.edges || [];
  const characters = media.characters?.edges || [];
  const staff = media.staff?.edges || [];
  const reviews = media.reviews?.nodes || [];
  const relations = media.relations?.edges || [];
  const recommendations = media.recommendations?.nodes || [];
  const scoreDistribution = media.stats?.scoreDistribution || [];
  const statusDistribution = media.stats?.statusDistribution || [];
  const airing = media.airingSchedule?.nodes || [];
  const streaming = media.streamingEpisodes || [];
  const pictures = details.pictures || [];
  const info = [
    ["AniList ID", media.id], ["MyAnimeList ID", media.idMal], ["Format", media.format], ["Status", media.status], ["Season", [media.season, media.seasonYear].filter(Boolean).join(" ")],
    ["Released", date(media.startDate)], ["Finished", date(media.endDate)], ["Country", media.countryOfOrigin], ["Source", media.source],
    ["Episodes", media.episodes], ["Runtime", media.duration ? `${media.duration} min / episode` : ""],
    ["Chapters", media.chapters], ["Volumes", media.volumes], ["Genres", media.genres?.join(", ")],
    ["Alternative titles", media.synonyms?.join(", ")], ["Average score", media.averageScore ? `${media.averageScore}/100` : "Not rated"],
    ["Mean score", media.meanScore ? `${media.meanScore}/100` : ""], ["Popularity", media.popularity], ["Favorites", media.favourites], ["Trending", media.trending],
    ["Hashtag", media.hashtag], ["Licensed", media.isLicensed ? "Yes" : "No"], ["Adult title", media.isAdult ? "Yes" : "No"], ["Last updated", media.updatedAt ? new Date(media.updatedAt * 1000).toLocaleDateString() : ""]
  ].filter(([, value]) => value !== null && value !== undefined && value !== "");
  const tags = media.tags || [];
  const spoilerLabel = tag => tag.isAdultSpoiler ? "Adult" : tag.isMediaSpoiler ? "Spoiler" : tag.isGeneralSpoiler ? "General spoiler" : "";
  const nextAiring = media.nextAiringEpisode;
  const trailerUrl = media.trailer?.site === "youtube" ? `https://www.youtube.com/watch?v=${encodeURIComponent(media.trailer.id)}` : media.trailer?.site && media.trailer?.id ? `https://${media.trailer.site}/${encodeURIComponent(media.trailer.id)}` : "";
  section.style.display = "block";
  section.innerHTML = `
    <section class="tvmaze-detail-block"><h2>AniList details</h2>${media.bannerImage ? `<img class="anilist-banner" src="${safe(media.bannerImage)}" alt="" loading="lazy">` : ""}<dl class="tvmaze-info-grid">${info.map(([label, value]) => `<div><dt>${safe(label)}</dt><dd>${safe(value)}</dd></div>`).join("")}</dl><div class="anilist-link-row"><a href="${href(media.siteUrl)}" target="_blank" rel="noopener">Open on AniList</a>${trailerUrl && href(trailerUrl) ? `<a href="${href(trailerUrl)}" target="_blank" rel="noopener">Watch trailer</a>` : ""}</div><p class="tvmaze-api-note">AniList average and mean scores are community ratings. Reviews below are AniList user reviews.${details.partial ? ` Some extra sections could not be loaded: ${safe(details.partialError)}` : ""}</p></section>
    ${nextAiring ? `<section class="tvmaze-detail-block"><h2>Next airing</h2><p class="anilist-airing-highlight">Episode ${safe(nextAiring.episode)} · ${new Date(nextAiring.airingAt * 1000).toLocaleString()}</p></section>` : ""}
    ${studios.length ? `<section class="tvmaze-detail-block"><h2>Studios <small>${studios.length}</small></h2><div class="anilist-chip-list">${studios.map(({isMain,node}) => `<a class="anilist-chip" href="${href(node.siteUrl)}" target="_blank" rel="noopener">${safe(node.name)}${isMain ? " · Main" : ""}${node.isAnimationStudio ? " · Animation" : ""}</a>`).join("")}</div></section>` : ""}
    ${characters.length ? `<section class="tvmaze-detail-block"><h2>Characters and voice cast <small>${media.characters.pageInfo?.total || characters.length}</small></h2><div class="tvmaze-people-grid">${characters.map(edge => { const actors = edge.voiceActors || []; const actorList = actors.map(actor => `${actor.name?.full || "Unknown"}${actor.languageV2 ? ` (${actor.languageV2})` : ""}`).join(", "); return `<article class="tvmaze-person-card">${edge.node.image?.large || edge.node.image?.medium ? `<img src="${safe(edge.node.image.large || edge.node.image.medium)}" alt="" loading="lazy">` : `<div class="tvmaze-person-placeholder">${safe((edge.node.name?.full || "?").slice(0,1))}</div>`}<div><strong>${safe(edge.node.name?.full || "Unknown")}</strong><span>${safe(edge.role || "Character")}${actorList ? ` · Voice: ${safe(actorList)}` : ""}</span>${edge.node.description ? `<details class="anilist-person-bio"><summary>Character info</summary><p>${safe(edge.node.description)}</p></details>` : ""}</div></article>`; }).join("")}</div></section>` : ""}
    ${staff.length ? `<section class="tvmaze-detail-block"><h2>Staff <small>${media.staff.pageInfo?.total || staff.length}</small></h2><div class="tvmaze-people-grid">${staff.map(edge => `<article class="tvmaze-person-card">${edge.node.image?.large || edge.node.image?.medium ? `<img src="${safe(edge.node.image.large || edge.node.image.medium)}" alt="" loading="lazy">` : `<div class="tvmaze-person-placeholder">${safe((edge.node.name?.full || "?").slice(0,1))}</div>`}<div><strong>${safe(edge.node.name?.full || "Unknown")}</strong><span>${safe(edge.role || edge.node.primaryOccupations?.join(", ") || "Staff")}</span></div></article>`).join("")}</div></section>` : ""}
    ${reviews.length ? `<section class="tvmaze-detail-block"><h2>User reviews <small>${media.reviews.pageInfo?.total || reviews.length}</small></h2><div class="anilist-review-list">${reviews.map(review => `<article><div class="anilist-review-head">${review.user?.avatar?.large ? `<img src="${safe(review.user.avatar.large)}" alt="" loading="lazy">` : ""}<strong>${safe(review.user?.name || "AniList user")}</strong><span>Review rating ${review.rating ?? "—"}%</span><span>Media score ${review.score ?? "—"}</span></div>${review.summary ? `<h3>${safe(review.summary)}</h3>` : ""}<p>${safe(review.body || "")}</p><small>${review.ratingAmount ? `${review.ratingAmount} users found this helpful · ` : ""}${review.createdAt ? new Date(review.createdAt * 1000).toLocaleDateString() : ""}</small>${href(review.siteUrl) ? `<a class="anilist-review-link" href="${href(review.siteUrl)}" target="_blank" rel="noopener">Read on AniList</a>` : ""}</article>`).join("")}</div></section>` : ""}
    ${scoreDistribution.length || statusDistribution.length ? `<section class="tvmaze-detail-block"><h2>AniList community statistics</h2>${scoreDistribution.length ? `<h3>Score distribution</h3><div class="jikan-score-list">${[...scoreDistribution].sort((a,b) => b.score - a.score).map(item => { const max = Math.max(...scoreDistribution.map(value => Number(value.amount) || 0), 1); return `<div><span>${safe(item.score)}%</span><span class="jikan-score-track"><i style="width:${Math.max(0, Math.min(100, Number(item.amount) / max * 100))}%"></i></span><small>${safe(Number(item.amount).toLocaleString())} lists</small></div>`; }).join("")}</div>` : ""}${statusDistribution.length ? `<h3>List status distribution</h3><div class="anilist-chip-list">${statusDistribution.map(item => `<span class="anilist-chip">${safe(String(item.status || "").replaceAll("_", " "))} · ${safe(Number(item.amount).toLocaleString())}</span>`).join("")}</div>` : ""}</section>` : ""}
    ${tags.length ? `<details class="tvmaze-detail-block"><summary>Tags <small>${tags.length}</small></summary><div class="anilist-tag-list">${tags.map(tag => `<span title="${safe(tag.description || "")}">${safe(tag.name)}${tag.rank ? ` · ${tag.rank}%` : ""}${spoilerLabel(tag) ? ` · ${safe(spoilerLabel(tag))}` : ""}</span>`).join("")}</div></details>` : ""}
    ${relations.length ? `<section class="tvmaze-detail-block"><h2>Related titles <small>${relations.length}</small></h2><div class="anilist-related-list">${relations.map(({relationType,node}) => `<a href="${href(node.siteUrl)}" target="_blank" rel="noopener"><strong>${safe(node.title?.english || node.title?.romaji || "Untitled")}</strong><span>${safe([relationType, node.format, node.startDate?.year, node.averageScore ? `★ ${node.averageScore}` : ""].filter(Boolean).join(" · "))}</span></a>`).join("")}</div></section>` : ""}
    ${recommendations.length ? `<section class="tvmaze-detail-block"><h2>AniList recommendations <small>${recommendations.length}</small></h2><div class="show-detail-related-list">${recommendations.map(({rating,node}) => node ? `<a class="show-detail-related-card" href="${href(node.siteUrl)}" target="_blank" rel="noopener">${thumbnailOrPlaceholder(node.coverImage?.medium, "show-detail-related-thumb")}<span>${safe(node.title?.english || node.title?.romaji || "Untitled")}</span><small>${safe([node.format, node.startDate?.year, node.averageScore ? `★ ${node.averageScore}` : "", rating ? `${rating} votes` : ""].filter(Boolean).join(" · "))}</small></a>` : "").join("")}</div></section>` : ""}
    ${pictures.length ? `<section class="tvmaze-detail-block"><h2>More images <small>${pictures.length}</small></h2><div class="tvmaze-image-grid">${pictures.map((picture,index) => { const src = picture.jpg?.large_image_url || picture.jpg?.image_url; return href(src) ? `<a href="${href(src)}" target="_blank" rel="noopener" title="Image ${index + 1}"><img src="${href(picture.jpg?.small_image_url || src)}" alt="${safe(media.title?.english || media.title?.romaji || "Anime")} image ${index + 1}" loading="lazy"><small>Image ${index + 1}</small></a>` : ""; }).join("")}</div><p class="tvmaze-api-note">Additional images from MyAnimeList via Jikan.</p></section>` : ""}
    ${airing.length ? `<details class="tvmaze-detail-block"><summary>Airing schedule <small>${airing.length}</small></summary><div class="anilist-schedule-list">${airing.map(item => `<span>Episode ${safe(item.episode)} · ${new Date(item.airingAt * 1000).toLocaleString()}</span>`).join("")}</div></details>` : ""}
    ${streaming.length ? `<details class="tvmaze-detail-block"><summary>Streaming episodes <small>${streaming.length}</small></summary><div class="anilist-link-list">${streaming.map(item => `<a href="${href(item.url)}" target="_blank" rel="noopener">${safe(item.title || item.site || "Watch episode")}</a>`).join("")}</div></details>` : ""}
    ${media.externalLinks?.length ? `<details class="tvmaze-detail-block"><summary>External links <small>${media.externalLinks.length}</small></summary><div class="anilist-link-list">${media.externalLinks.filter(link => !link.isDisabled && href(link.url)).map(link => `<a href="${href(link.url)}" target="_blank" rel="noopener">${safe(link.site)}${link.type ? ` · ${safe(link.type)}` : ""}</a>`).join("")}</div></details>` : ""}
    ${media.rankings?.length ? `<details class="tvmaze-detail-block"><summary>Rankings <small>${media.rankings.length}</small></summary><div class="anilist-schedule-list">${media.rankings.map(rank => `<span>#${safe(rank.rank)} ${safe(rank.context)}${rank.allTime ? " · All time" : ""}${rank.year ? ` · ${safe(rank.year)}` : ""}</span>`).join("")}</div></details>` : ""}
    <p class="tvmaze-data-footnote">Loaded ${characters.length} characters, ${staff.length} staff entries, ${reviews.length} reviews, ${relations.length} relations, and ${recommendations.length} recommendations.</p>`;
}
