// Omdb provider adapter for the shared show detail page.

async function fetchOMDbFullData(providerId, existingItem = null) {
  const apiKey = state.preferences.metadataSources.builtinApiKeys?.omdb || "";
  if (!apiKey) throw new Error("OMDb API key is not configured");
  const cacheKey = `cuemark:omdb:${providerId}`;
  let details = null;
  try {
    const cached = JSON.parse(sessionStorage.getItem(cacheKey) || "null");
    if (cached?.title && Date.now() - Number(cached.fetchedAt || 0) < 24 * 60 * 60 * 1000) details = cached;
  } catch {}
  if (!details) {
    const url = new URL("https://www.omdbapi.com/");
    url.searchParams.set("i", providerId);
    url.searchParams.set("plot", "full");
    url.searchParams.set("apikey", apiKey);
    const data = await fetchJsonPortable(url.toString());
    if (data?.Response === "False" || !data?.Title) throw new Error(data?.Error || "OMDb details unavailable");
    const seasonCount = data.Type === "series" ? Math.min(100, parseInt(data.totalSeasons, 10) || 0) : 0;
    const seasons = [];
    let nextSeason = 1;
    const worker = async () => {
      while (nextSeason <= seasonCount) {
        const seasonNumber = nextSeason++;
        const seasonUrl = new URL("https://www.omdbapi.com/");
        seasonUrl.searchParams.set("i", providerId);
        seasonUrl.searchParams.set("Season", String(seasonNumber));
        seasonUrl.searchParams.set("apikey", apiKey);
        try {
          const season = await fetchJsonPortable(seasonUrl.toString());
          if (season?.Response !== "False") seasons[seasonNumber - 1] = season;
        } catch (error) { console.warn(`Could not load OMDb season ${seasonNumber}`, error); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, seasonCount) }, worker));
    details = { title: data, seasons: seasons.filter(Boolean), fetchedAt: Date.now() };
    try { sessionStorage.setItem(cacheKey, JSON.stringify(details)); } catch {}
  }
  const data = details.title;
  if (existingItem) {
    Object.assign(existingItem, {
      summary: data.Plot && data.Plot !== "N/A" ? data.Plot : existingItem.summary || "",
      genres: data.Genre && data.Genre !== "N/A" ? data.Genre.split(",").map(value => value.trim()).filter(Boolean) : existingItem.genres || [],
      omdbDetailsCache: details,
      ...(thumbnailsEnabled() && data.Poster && data.Poster !== "N/A" ? { thumbnail: data.Poster } : {})
    });
    saveData();
  }
  return details;
}

function renderOMDbDetails(details) {
  const section = document.getElementById("omdb-extra-section");
  const data = details?.title;
  if (!section) return;
  if (!data) { section.style.display = "none"; section.innerHTML = ""; return; }
  const safe = detailText;
  const people = (value, role) => value && value !== "N/A" ? value.split(",").map(name => ({ name: name.trim(), role })) : [];
  const peopleList = [...people(data.Director, "Director"), ...people(data.Writer, "Writer"), ...people(data.Actors, "Cast")];
  const ratings = (data.Ratings || []).filter(item => item.Value && item.Value !== "N/A");
  const seasons = details.seasons || [];
  const links = [];
  if (data.imdbID && data.imdbID !== "N/A") links.push(["IMDb title", `https://www.imdb.com/title/${data.imdbID}/`]);
  if (data.Website && data.Website !== "N/A" && /^https?:/i.test(data.Website)) links.push(["Official website", data.Website]);
  const rows = [
    ["IMDb ID", data.imdbID], ["Type", data.Type], ["Year", data.Year], ["Rated", data.Rated], ["Released", data.Released],
    ["Runtime", data.Runtime], ["Genre", data.Genre], ["Language", data.Language], ["Country", data.Country],
    ["Awards", data.Awards], ["IMDb rating", data.imdbRating !== "N/A" ? `${data.imdbRating}/10` : ""], ["IMDb votes", data.imdbVotes],
    ["Metascore", data.Metascore !== "N/A" ? data.Metascore : ""], ["Box office", data.BoxOffice], ["DVD", data.DVD],
    ["Production", data.Production], ["Total seasons", data.totalSeasons], ["Series ID", data.seriesID]
  ].filter(([, value]) => value !== undefined && value !== null && value !== "" && value !== "N/A");
  const imdbUrl = data.imdbID && data.imdbID !== "N/A" ? `https://www.imdb.com/title/${data.imdbID}/` : "";
  section.style.display = "block";
  section.innerHTML = `
    <section class="tvmaze-detail-block"><h2>OMDb details</h2><dl class="tvmaze-info-grid">${rows.map(([label,value]) => `<div><dt>${safe(label)}</dt><dd>${safe(value)}</dd></div>`).join("")}</dl><div class="anilist-link-row">${links.map(([label,url]) => `<a href="${safe(url)}" target="_blank" rel="noopener">${safe(label)}</a>`).join("")}</div><p class="tvmaze-api-note">OMDb returns aggregated source ratings, but its public title endpoint does not include individual review text or reviewer profiles.</p></section>
    ${data.Plot && data.Plot !== "N/A" ? `<section class="tvmaze-detail-block"><h2>Plot</h2><p class="jikan-long-text">${safe(data.Plot)}</p></section>` : ""}
    ${ratings.length ? `<section class="tvmaze-detail-block"><h2>Ratings <small>${ratings.length} sources</small></h2><div class="anilist-chip-list">${ratings.map(item => `<span class="anilist-chip">${safe(item.Source)} · ${safe(item.Value)}</span>`).join("")}</div></section>` : ""}
    ${peopleList.length ? `<section class="tvmaze-detail-block"><h2>Cast and crew <small>${peopleList.length}</small></h2><div class="anilist-chip-list">${peopleList.map(item => `<span class="anilist-chip">${safe(item.name)} · ${safe(item.role)}</span>`).join("")}</div></section>` : ""}
    ${seasons.length ? `<details class="tvmaze-detail-block"><summary>Seasons and episodes <small>${seasons.length} seasons · ${seasons.reduce((sum, season) => sum + (season.Episodes || []).length, 0)} episodes</small></summary>${seasons.map(season => `<details class="mangadex-tag-group"><summary>Season ${safe(season.Season)} · ${safe(season.Episodes?.length || 0)} episodes${season.totalSeasons ? ` of ${safe(season.totalSeasons)}` : ""}</summary><div class="anilist-schedule-list">${(season.Episodes || []).map(episode => `<span>${safe(episode.Episode)}. ${safe(episode.Title)}${episode.Released && episode.Released !== "N/A" ? ` · ${safe(episode.Released)}` : ""}${episode.imdbRating && episode.imdbRating !== "N/A" ? ` · ★ ${safe(episode.imdbRating)}/10` : ""}${episode.imdbID && episode.imdbID !== "N/A" ? ` · <a href="${safe(`https://www.imdb.com/title/${episode.imdbID}/`)}" target="_blank" rel="noopener">IMDb</a>` : ""}</span>`).join("")}</div></details>`).join("")}</details>` : data.Type === "series" ? `<section class="tvmaze-detail-block"><h2>Series episodes</h2><p class="tvmaze-api-note">${data.totalSeasons && data.totalSeasons !== "N/A" ? `${safe(data.totalSeasons)} seasons are listed, but season episode data was unavailable.` : "Season count is not available."}</p>${imdbUrl ? `<a href="${safe(imdbUrl)}episodes/" target="_blank" rel="noopener">Browse episodes on IMDb</a>` : ""}</section>` : ""}
    ${imdbUrl ? `<div class="freetogame-attribution"><a href="${safe(imdbUrl)}" target="_blank" rel="noopener">OMDb metadata; see IMDb for title reviews and full episode listings</a></div>` : ""}`;
}
