// Tmdb provider adapter for the shared show detail page.

async function fetchTMDBFullData(providerId, category, existingItem = null) {
  const mediaType = EPISODE_TRACKED_CATEGORIES.includes(category) ? "tv" : "movie";
  const apiKey = state.preferences.metadataSources.builtinApiKeys?.tmdb || "";
  if (!apiKey) throw new Error("TMDB API key is not configured");
  const cacheKey = `cuemark:tmdb:${mediaType}:${providerId}`;
  let details = null;
  try {
    const cached = JSON.parse(sessionStorage.getItem(cacheKey) || "null");
    if (cached?.media && Date.now() - Number(cached.fetchedAt || 0) < 24 * 60 * 60 * 1000) details = cached;
  } catch {}
  if (!details) {
    const append = mediaType === "tv"
      ? "aggregate_credits,content_ratings,external_ids,images,keywords,recommendations,reviews,similar,videos,watch/providers"
      : "credits,external_ids,images,keywords,recommendations,reviews,similar,videos,watch/providers,release_dates";
    const url = new URL(`https://api.themoviedb.org/3/${mediaType}/${encodeURIComponent(providerId)}`);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("append_to_response", append);
    url.searchParams.set("language", "en-US");
    const media = await fetchJsonPortable(url.toString());
    if (!media?.id) throw new Error("TMDB title details unavailable");
    details = { mediaType, media, fetchedAt: Date.now() };
    try { sessionStorage.setItem(cacheKey, JSON.stringify(details)); } catch {}
  }
  const media = details.media;
  if (existingItem) {
    const title = media.title || media.name || existingItem.title;
    Object.assign(existingItem, {
      title,
      summary: media.overview || existingItem.summary || "",
      genres: (media.genres || []).map(item => item.name).filter(Boolean),
      productionStatus: media.status || existingItem.productionStatus || "",
      tmdbDetailsCache: details,
      ...(thumbnailsEnabled() && media.poster_path ? { thumbnail: `https://image.tmdb.org/t/p/w500${media.poster_path}` } : {}),
      ...((media.runtime || media.episode_run_time?.[0]) ? { episodeRuntime: media.runtime || media.episode_run_time[0] } : {}),
      ...(media.number_of_episodes ? { totalEpisodes: media.number_of_episodes } : {})
    });
    saveData();
  }
  return details;
}

function renderTMDBDetails(details) {
  const section = document.getElementById("tmdb-extra-section");
  const media = details?.media;
  if (!section) return;
  if (!media) { section.style.display = "none"; section.innerHTML = ""; return; }
  const safe = detailText;
  const href = value => {
    try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? safe(url.href) : ""; }
    catch { return ""; }
  };
  const type = details.mediaType;
  const title = media.title || media.name || "Untitled";
  const credits = media.credits || media.aggregate_credits || {};
  const cast = credits.cast || [];
  const crew = credits.crew || [];
  const reviews = media.reviews?.results || [];
  const recommendations = media.recommendations?.results || [];
  const similar = media.similar?.results || [];
  const backdrops = media.images?.backdrops || [];
  const posters = media.images?.posters || [];
  const videos = media.videos?.results || [];
  const keywords = media.keywords?.keywords || media.keywords?.results || [];
  const countries = media.production_countries || [];
  const companies = media.production_companies || [];
  const certifications = media.release_dates?.results || media.content_ratings?.results || [];
  const releaseDate = type === "tv" ? media.first_air_date : media.release_date;
  const info = [
    ["TMDB ID", media.id], ["Media type", type === "tv" ? "TV series" : "Movie"], ["Original title", media.original_title || media.original_name],
    ["Original language", media.original_language], ["Release / first air date", releaseDate], ["Status", media.status],
    ["Runtime", media.runtime ? `${media.runtime} min` : ""], ["Episode runtime", (media.episode_run_time || []).length ? `${media.episode_run_time.join(", ")} min` : ""],
    ["Seasons", media.number_of_seasons], ["Episodes", media.number_of_episodes], ["Genres", (media.genres || []).map(item => item.name).join(", ")],
    ["Original country", (media.origin_country || []).join(", ")], ["Production countries", countries.map(item => item.name).join(", ")],
    ["Production companies", companies.map(item => item.name).join(", ")], ["Networks", (media.networks || []).map(item => item.name).join(", ")],
    ["TMDB user rating", media.vote_average ? `${Number(media.vote_average).toFixed(1)}/10` : "Not rated"], ["Vote count", media.vote_count],
    ["Popularity", media.popularity], ["Budget", media.budget ? `$${Number(media.budget).toLocaleString()}` : ""],
    ["Revenue", media.revenue ? `$${Number(media.revenue).toLocaleString()}` : ""], ["Tagline", media.tagline],
    ["Created by", (media.created_by || []).map(item => item.name).join(", ")], ["Homepage", media.homepage]
  ].filter(([, value]) => value !== undefined && value !== null && value !== "");
  const external = media.external_ids || {};
  const externalLinks = [
    ["IMDb", external.imdb_id ? `https://www.imdb.com/title/${external.imdb_id}/` : ""],
    ["TVDB", external.tvdb_id ? `https://thetvdb.com/?id=${external.tvdb_id}&tab=series` : ""],
    ["Facebook", external.facebook_id ? `https://www.facebook.com/${external.facebook_id}` : ""],
    ["Instagram", external.instagram_id ? `https://www.instagram.com/${external.instagram_id}` : ""],
    ["Twitter / X", external.twitter_id ? `https://x.com/${external.twitter_id}` : ""]
  ].filter(([,url]) => href(url));
  const tmdbPage = `https://www.themoviedb.org/${type}/${media.id}`;
  const imageUrl = path => path ? `https://image.tmdb.org/t/p/w780${path}` : "";
  const peopleCard = (person, role) => {
    const name = person.name || person.original_name || "Unknown";
    const image = imageUrl(person.profile_path);
    return `<article class="tvmaze-person-card">${image ? `<img src="${href(image)}" alt="" loading="lazy">` : `<div class="tvmaze-person-placeholder">${safe(name.slice(0,1))}</div>`}<div><strong>${safe(name)}</strong><span>${safe(role || person.character || person.job || "Cast and crew")}</span>${person.id ? `<a class="wikidata-person-link" href="${href(`https://www.themoviedb.org/person/${person.id}`)}" target="_blank" rel="noopener">TMDB profile</a>` : ""}</div></article>`;
  };
  const suggestionCards = items => `<div class="show-detail-related-list">${items.map(item => { const label = item.title || item.name || "Untitled"; return `<a class="show-detail-related-card" href="static/pages/main/show-detail.html?category=${encodeURIComponent(showDetailState.category || (type === "tv" ? "series" : "movie"))}&provider=tmdb&providerId=${encodeURIComponent(item.id)}&title=${encodeURIComponent(label)}">${thumbnailOrPlaceholder(imageUrl(item.poster_path), "show-detail-related-thumb")}<span>${safe(label)}</span><small>${safe([item.release_date || item.first_air_date, item.vote_average ? `★ ${Number(item.vote_average).toFixed(1)}/10` : "", item.vote_count ? `${item.vote_count} votes` : ""].filter(Boolean).join(" · "))}</small></a>`; }).join("")}</div>`;
  const countryRatings = certifications.map(country => {
    const entries = country.release_dates || country.rating && [{ certification: country.rating }];
    const ratings = (entries || []).map(item => item.certification).filter(Boolean);
    return ratings.length ? `${country.iso_3166_1}: ${[...new Set(ratings)].join(" / ")}` : "";
  }).filter(Boolean);
  const watch = media["watch/providers"]?.results || {};
  const watchRegions = Object.entries(watch).slice(0, 12);
  section.style.display = "block";
  section.innerHTML = `
    <section class="tvmaze-detail-block"><h2>TMDB details</h2><dl class="tvmaze-info-grid">${info.map(([label,value]) => `<div><dt>${safe(label)}</dt><dd>${safe(value)}</dd></div>`).join("")}${countryRatings.length ? `<div><dt>Content ratings</dt><dd>${safe(countryRatings.join(" · "))}</dd></div>` : ""}</dl><div class="anilist-link-row"><a href="${href(tmdbPage)}" target="_blank" rel="noopener">Open on TMDB</a>${externalLinks.map(([label,url]) => `<a href="${href(url)}" target="_blank" rel="noopener">${safe(label)}</a>`).join("")}</div></section>
    ${media.overview ? `<section class="tvmaze-detail-block"><h2>Overview</h2><p class="jikan-long-text">${safe(media.overview)}</p></section>` : ""}
    ${cast.length ? `<section class="tvmaze-detail-block"><h2>Cast <small>${cast.length} returned</small></h2><div class="tvmaze-people-grid">${cast.slice(0, 40).map(person => { const role = person.character || (person.roles || []).map(item => item.character).filter(Boolean).join(", ") || "Cast"; return peopleCard(person, role); }).join("")}</div></section>` : ""}
    ${crew.length ? `<details class="tvmaze-detail-block"><summary>Crew <small>${crew.length} returned</small></summary><div class="tvmaze-people-grid">${crew.slice(0, 60).map(person => { const role = person.job || (person.jobs || []).map(item => item.job).filter(Boolean).join(", ") || person.department || "Crew"; return peopleCard(person, role); }).join("")}</div></details>` : ""}
    ${media.seasons?.length ? `<section class="tvmaze-detail-block"><h2>Seasons <small>${media.seasons.length}</small></h2><div class="anilist-schedule-list">${media.seasons.map(season => `<span>${safe(season.name || `Season ${season.season_number}`)} · ${safe(season.episode_count || 0)} episodes${season.air_date ? ` · ${safe(season.air_date)}` : ""}${season.vote_average ? ` · ★ ${safe(Number(season.vote_average).toFixed(1))}` : ""}</span>`).join("")}</div></section>` : ""}
    ${reviews.length ? `<section class="tvmaze-detail-block"><h2>User reviews <small>${media.reviews.total_results || reviews.length} total · page ${media.reviews.page || 1}</small></h2><div class="jikan-review-list">${reviews.map(review => `<details><summary><strong>${safe(review.author || "TMDB user")}</strong><span>${safe(review.author_details?.rating ?? "—")}/10 · ${safe(review.created_at || "")}</span></summary><p>${safe(review.content || "")}</p>${href(review.url) ? `<a href="${href(review.url)}" target="_blank" rel="noopener">Read on TMDB</a>` : ""}</details>`).join("")}</div></section>` : ""}
    ${recommendations.length ? `<section class="tvmaze-detail-block"><h2>Recommendations <small>${recommendations.length}</small></h2>${suggestionCards(recommendations)}</section>` : ""}
    ${similar.length ? `<section class="tvmaze-detail-block"><h2>Similar titles <small>${similar.length}</small></h2>${suggestionCards(similar)}</section>` : ""}
    ${keywords.length ? `<section class="tvmaze-detail-block"><h2>Keywords <small>${keywords.length}</small></h2><div class="anilist-chip-list">${keywords.map(item => `<span class="anilist-chip">${safe(item.name || item.id)}</span>`).join("")}</div></section>` : ""}
    ${watchRegions.length ? `<details class="tvmaze-detail-block"><summary>Where to watch <small>${watchRegions.length} regions</small></summary>${watchRegions.map(([region,offers]) => `<div class="mangadex-tag-group"><h3>${safe(region)}${offers.link ? ` · <a href="${href(offers.link)}" target="_blank" rel="noopener">TMDB providers</a>` : ""}</h3><div class="anilist-chip-list">${[...(offers.flatrate || []), ...(offers.free || []), ...(offers.ads || []), ...(offers.rent || []), ...(offers.buy || [])].map(item => `<span class="anilist-chip">${safe(item.provider_name)}${offers.flatrate?.includes(item) ? " · Stream" : ""}</span>`).join("")}</div></div>`).join("")}</details>` : ""}
    ${videos.length ? `<section class="tvmaze-detail-block"><h2>Videos <small>${videos.length}</small></h2><div class="anilist-link-list">${videos.filter(video => video.site === "YouTube" && video.key).map(video => `<a href="${href(`https://www.youtube.com/watch?v=${encodeURIComponent(video.key)}`)}" target="_blank" rel="noopener">${safe(video.name || video.type || "Video")}${video.type ? ` · ${safe(video.type)}` : ""}</a>`).join("")}</div></section>` : ""}
    ${backdrops.length || posters.length ? `<section class="tvmaze-detail-block"><h2>Images <small>${backdrops.length} backdrops · ${posters.length} posters</small></h2><div class="tvmaze-image-grid">${[...backdrops.slice(0, 12), ...posters.slice(0, 12)].map((image,index) => { const url = imageUrl(image.file_path); return href(url) ? `<a href="${href(url)}" target="_blank" rel="noopener"><img src="${href(url)}" alt="${safe(title)} image ${index + 1}" loading="lazy"><small>${image.iso_639_1 ? safe(image.iso_639_1.toUpperCase()) : "Image"}</small></a>` : ""; }).join("")}</div></section>` : ""}
    ${type === "tv" && media.created_by?.length ? `<section class="tvmaze-detail-block"><h2>Creators</h2><div class="tvmaze-people-grid">${media.created_by.map(person => peopleCard(person, "Creator")).join("")}</div></section>` : ""}
    <div class="freetogame-attribution"><a href="${href(tmdbPage)}" target="_blank" rel="noopener">Movie and TV data provided by TMDB</a></div>`;
}
