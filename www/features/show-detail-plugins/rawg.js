// Rawg provider adapter for the shared show detail page.

async function fetchRAWGFullData(providerId, existingItem = null) {
  const cacheKey = `cuemark:rawg:${providerId}`;
  let details = null;
  try {
    const cached = JSON.parse(sessionStorage.getItem(cacheKey) || "null");
    if (cached?.game && Date.now() - Number(cached.fetchedAt || 0) < 24 * 60 * 60 * 1000) details = cached;
  } catch {}
  if (!details) {
    const apiKey = window.CUEMARK_LOCAL_API_KEYS?.rawg
      || state.preferences.metadataSources.builtinApiKeys?.rawg
      || "";
    if (!apiKey) throw new Error("RAWG API key is not configured");
    const base = `https://api.rawg.io/api/games/${encodeURIComponent(providerId)}`;
    const get = async path => {
      const url = new URL(`${base}${path}`);
      url.searchParams.set("key", apiKey);
      return fetchJsonPortable(url.toString());
    };
    const game = await get("");
    const optional = async (name, path) => {
      try { return await get(path); }
      catch (error) { console.warn(`Could not load RAWG ${name}`, error); return null; }
    };
    const [screenshots, developmentTeam, parents, series, additions, genreSuggestions] = await Promise.all([
      optional("screenshots", "/screenshots?page_size=40"),
      optional("development team", "/development-team?page_size=40"),
      optional("parent games", "/parent-games?page_size=40"),
      optional("game series", "/game-series?page_size=40"),
      optional("additions and DLC", "/additions?page_size=40"),
      game.genres?.length ? (async () => {
        try {
          const params = new URLSearchParams({ key: apiKey, genres: game.genres.map(item => item.slug || item.id).join(","), page_size: "40", ordering: "-rating" });
          return await fetchJsonPortable(`https://api.rawg.io/api/games?${params.toString()}`);
        } catch (error) { console.warn("Could not load RAWG genre suggestions", error); return null; }
      })() : Promise.resolve(null)
    ]);
    const related = new Map();
    [parents, series, additions].forEach(payload => (payload?.results || []).forEach(item => item?.id && related.set(String(item.id), item)));
    const recommendations = (genreSuggestions?.results || []).filter(item => String(item.id) !== String(game.id)).slice(0, 30);
    details = {
      game,
      screenshots: screenshots?.results || [],
      developmentTeam: developmentTeam?.results || [],
      related: [...related.values()],
      recommendations,
      relatedCounts: { parents: parents?.count || 0, series: series?.count || 0, additions: additions?.count || 0 },
      fetchedAt: Date.now()
    };
    try { sessionStorage.setItem(cacheKey, JSON.stringify(details)); } catch {}
  }
  const game = details.game;
  if (existingItem) {
    Object.assign(existingItem, {
      summary: game.description_raw || stripHtml(game.description || "") || existingItem.summary || "",
      genres: (game.genres || []).map(item => item.name).filter(Boolean),
      rawgDetailsCache: details,
      ...(thumbnailsEnabled() && game.background_image ? { thumbnail: game.background_image } : {})
    });
    saveData();
  }
  return details;
}

function renderRAWGDetails(details) {
  const section = document.getElementById("rawg-extra-section");
  const game = details?.game;
  if (!section) return;
  if (!game) { section.style.display = "none"; section.innerHTML = ""; return; }
  const safe = detailText;
  const href = value => {
    try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? safe(url.href) : ""; }
    catch { return ""; }
  };
  const platforms = game.platforms || [];
  const genres = game.genres || [];
  const tags = game.tags || [];
  const developers = game.developers || [];
  const publishers = game.publishers || [];
  const ratings = Object.values(game.ratings || {}).sort((a,b) => Number(b.id || b.title) - Number(a.id || a.title));
  const ratingMax = Math.max(1, ...ratings.map(item => Number(item.count) || 0));
  const related = details.related || [];
  const suggestions = details.recommendations || [];
  const screenshots = details.screenshots || [];
  const crew = details.developmentTeam || [];
  const systems = platforms.map(({platform, released_at, requirements}) => [platform?.name, released_at && `Released ${released_at}`, requirements?.minimum && `Minimum: ${requirements.minimum}`, requirements?.recommended && `Recommended: ${requirements.recommended}`].filter(Boolean).join(" · ")).filter(Boolean);
  const rows = [
    ["RAWG ID", game.id], ["Slug", game.slug], ["Released", game.released], ["Release date", game.tba ? "To be announced" : ""],
    ["Metacritic", game.metacritic], ["RAWG rating", game.rating ? `${game.rating}/5` : "Not rated"], ["Ratings count", game.ratings_count],
    ["Text reviews", game.reviews_text_count], ["Average playtime", game.playtime ? `${game.playtime} hours` : ""],
    ["ESRB rating", game.esrb_rating?.name], ["Genres", genres.map(item => item.name).join(", ")],
    ["Developers", developers.map(item => item.name).join(", ")], ["Publishers", publishers.map(item => item.name).join(", ")],
    ["Platforms and requirements", systems.join("\n")], ["Alternative names", (game.alternative_names || []).join(", ")],
    ["Player library counts", Object.entries(game.added_by_status || {}).map(([status,count]) => `${status.replaceAll("_", " ")}: ${count}`).join(" · ")],
    ["Community counts", [`${game.added || 0} libraries`, `${game.suggestions_count || 0} suggestions`, `${game.screenshots_count || 0} screenshots`, `${game.movies_count || 0} videos`, `${game.achievements_count || 0} achievements`].join(" · ")],
    ["Last updated", game.updated], ["Tags", tags.map(item => item.name).join(", ")]
  ].filter(([, value]) => value !== null && value !== undefined && value !== "");
  const ratingUrl = `https://rawg.io/games/${encodeURIComponent(game.slug || game.id)}/reviews`;
  const gameUrl = `https://rawg.io/games/${encodeURIComponent(game.slug || game.id)}`;
  const cardList = items => `<div class="show-detail-related-list">${items.map(item => { const label = item.name || "Untitled"; return `<a class="show-detail-related-card" href="static/pages/main/show-detail.html?category=game&provider=rawg&providerId=${encodeURIComponent(item.id)}&title=${encodeURIComponent(label)}">${thumbnailOrPlaceholder(item.background_image || "", "show-detail-related-thumb")}<span>${safe(label)}</span><small>${safe([item.released, item.rating ? `★ ${item.rating}/5` : "", item.metacritic ? `Metacritic ${item.metacritic}` : ""].filter(Boolean).join(" · ") || "RAWG game")}</small></a>`; }).join("")}</div>`;
  section.style.display = "block";
  section.innerHTML = `
    <section class="tvmaze-detail-block"><h2>RAWG game details</h2><dl class="tvmaze-info-grid">${rows.map(([label,value]) => `<div><dt>${safe(label)}</dt><dd>${safe(value)}</dd></div>`).join("")}</dl><div class="anilist-link-row"><a href="${href(gameUrl)}" target="_blank" rel="noopener">Open on RAWG</a>${href(game.website) ? `<a href="${href(game.website)}" target="_blank" rel="noopener">Official website</a>` : ""}${game.metacritic_url && href(game.metacritic_url) ? `<a href="${href(game.metacritic_url)}" target="_blank" rel="noopener">Metacritic</a>` : ""}<a href="${href(ratingUrl)}" target="_blank" rel="noopener">RAWG reviews (${safe(game.reviews_text_count || 0)})</a></div><p class="tvmaze-api-note">RAWG provides player rating totals and review counts. Review text is available on the RAWG title page; the public API response does not include a review listing.</p></section>
    ${game.description_raw || game.description ? `<section class="tvmaze-detail-block"><h2>Description</h2><div class="jikan-long-text">${safe(game.description_raw || stripHtml(game.description))}</div></section>` : ""}
    ${ratings.length ? `<section class="tvmaze-detail-block"><h2>Player rating distribution</h2><div class="jikan-score-list">${ratings.map(row => `<div><span>${safe(row.title || row.name || row.id)}</span><span class="jikan-score-track"><i style="width:${Math.max(0, Math.min(100, (Number(row.count) || 0) / ratingMax * 100))}%"></i></span><small>${safe(row.count || 0)} · ${safe(row.percent || 0)}%</small></div>`).join("")}</div></section>` : ""}
    ${crew.length ? `<section class="tvmaze-detail-block"><h2>Development credits <small>${crew.length}</small></h2><div class="anilist-chip-list">${crew.map(item => `<span class="anilist-chip">${safe(item.name || item.person?.name || "Creator")}${item.positions?.length ? ` · ${safe(item.positions.map(pos => pos.name || pos).join(", "))}` : item.position?.name ? ` · ${safe(item.position.name)}` : ""}</span>`).join("")}</div></section>` : ""}
    ${related.length ? `<section class="tvmaze-detail-block"><h2>Parent, series and DLC titles <small>${related.length}</small></h2>${cardList(related)}</section>` : ""}
    ${suggestions.length ? `<section class="tvmaze-detail-block"><h2>Related games by genre <small>${suggestions.length}</small></h2>${cardList(suggestions)}</section>` : ""}
    ${screenshots.length ? `<section class="tvmaze-detail-block"><h2>Screenshots <small>${screenshots.length}</small></h2><div class="tvmaze-image-grid">${screenshots.map((item,index) => href(item.image) ? `<a href="${href(item.image)}" target="_blank" rel="noopener"><img src="${href(item.image)}" alt="${safe(game.name)} screenshot ${index + 1}" loading="lazy"><small>Screenshot ${index + 1}</small></a>` : "").join("")}</div></section>` : ""}
    <p class="tvmaze-data-footnote">Loaded ${rows.length} game metadata fields, ${ratings.length} rating buckets, ${crew.length} development credits, ${related.length} family titles, ${suggestions.length} genre-related games, and ${screenshots.length} screenshots.</p>
    <div class="freetogame-attribution"><a href="${href(gameUrl)}" target="_blank" rel="noopener">Game metadata from RAWG</a></div>`;
}
