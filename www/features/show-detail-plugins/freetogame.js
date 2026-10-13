// Freetogame provider adapter for the shared show detail page.

async function fetchFreeToGameProfile(profileUrl, fallbackTitle = "") {
  const url = new URL(profileUrl);
  if (url.protocol !== "https:" || !/(^|\.)freetogame\.com$/i.test(url.hostname)) {
    throw new Error("Invalid FreeToGame profile URL");
  }
  const candidates = [url.toString()];
  if (window.location?.origin && window.location.origin !== "null") {
    const proxy = new URL("/proxy", window.location.origin);
    proxy.searchParams.set("url", url.toString());
    candidates.push(proxy.toString());
  } else if (window.location?.protocol === "file:") {
    const proxy = new URL("http://127.0.0.1:3000/proxy");
    proxy.searchParams.set("url", url.toString());
    candidates.push(proxy.toString());
  }
  let html = "";
  let lastError = null;
  const directFetch = window.cuemarkNativeFetch || fetch.bind(window);
  for (const candidate of candidates) {
    try {
      const response = await directFetch(candidate, { headers: { Accept: "text/html,application/xhtml+xml" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      html = await response.text();
      break;
    } catch (error) { lastError = error; }
  }
  if (!html) throw lastError || new Error("FreeToGame profile could not be reached");

  const doc = new DOMParser().parseFromString(html, "text/html");
  const meta = name => doc.querySelector(`meta[property="${name}"],meta[name="${name}"]`)?.content?.trim() || "";
  let structured = null;
  for (const node of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(node.textContent || "null");
      structured = (Array.isArray(parsed) ? parsed : [parsed]).find(item => item && (item.name || item.description)) || structured;
    } catch { /* Ignore malformed structured metadata. */ }
  }
  const title = structured?.name || meta("og:title").replace(/\s*[|–-]\s*FreeToGame.*$/i, "") || doc.querySelector("h1")?.textContent?.trim() || fallbackTitle;
  const description = structured?.description || meta("og:description") || meta("description");
  const image = (typeof structured?.image === "string" ? structured.image : structured?.image?.url) || meta("og:image");
  const game = {
    id: Number(String(url.pathname).match(/\d+/)?.[0]) || null,
    title,
    short_description: description,
    description,
    thumbnail: image,
    freetogame_profile_url: url.toString(),
    game_url: structured?.url || "",
    genre: "",
    platform: "",
    release_date: "",
    developer: "",
    publisher: "",
    screenshots: [],
    minimum_system_requirements: {}
  };
  if (!game.title || !game.description) throw new Error("FreeToGame profile had no readable game details");
  return game;
}

async function fetchFreeToGameFullData(providerId, existingItem = null, profileUrl = "", fallbackTitle = "") {
  const gameId = String(providerId).replace(/^freetogame:/i, "");
  let game = null;
  let apiError = null;
  try {
    game = await fetchJsonPortable(`https://www.freetogame.com/api/game?id=${encodeURIComponent(gameId)}`);
  } catch (error) {
    apiError = error;
    try {
      const catalog = await fetchJsonPortable("https://www.freetogame.com/api/games");
      game = (Array.isArray(catalog) ? catalog : []).find(entry => String(entry.id) === gameId) || null;
    } catch (catalogError) { apiError = catalogError; }
  }
  // The API occasionally blocks clients with 403. The profile page is also
  // the canonical source and can provide useful details without that API.
  if (!game) {
    const knownProfile = gameId === "642" ? "https://www.freetogame.com/nte" : "";
    const candidateUrl = profileUrl || knownProfile;
    if (!candidateUrl) throw apiError || new Error("FreeToGame game not found");
    game = await fetchFreeToGameProfile(candidateUrl, fallbackTitle);
    game.id = Number(gameId) || gameId;
  }
  if (!game || String(game.id) !== gameId) throw new Error("FreeToGame game not found");

  const category = String(game.genre || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const platformText = String(game.platform || "").toLowerCase();
  const platform = platformText.includes("browser") ? "browser" : platformText.includes("windows") || platformText.includes("pc") ? "windows" : "";
  const query = new URLSearchParams();
  if (category) query.set("category", category);
  if (platform) query.set("platform", platform);
  let recommendations = [];
  if (query.toString()) {
    try {
      const related = await fetchJsonPortable(`https://www.freetogame.com/api/games?${query.toString()}`);
      recommendations = (Array.isArray(related) ? related : [])
        .filter(entry => String(entry.id) !== String(game.id))
        .slice(0, 24)
        .map(entry => ({
          id: entry.id,
          title: entry.title || "Untitled",
          thumbnail: entry.thumbnail || "",
          genre: entry.genre || "",
          platform: entry.platform || "",
          releaseDate: entry.release_date || ""
        }));
    } catch (error) {
      console.warn("Could not load FreeToGame similar games", error);
    }
  }

  const details = { game, recommendations, fetchedAt: Date.now() };
  if (existingItem) {
    existingItem.summary = game.description || game.short_description || existingItem.summary || "";
    existingItem.genres = [game.genre, game.platform, game.publisher].filter(Boolean);
    existingItem.freetogameDetailsCache = details;
    if (thumbnailsEnabled() && game.thumbnail) existingItem.thumbnail = game.thumbnail;
    saveData();
  }
  return details;
}

function renderFreeToGameDetails(details) {
  const section = document.getElementById("freetogame-extra-section");
  const game = details?.game;
  if (!section) return;
  if (!game) {
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
  const requirements = game.minimum_system_requirements || {};
  const requirementRows = [
    ["Operating system", requirements.os], ["Processor", requirements.processor], ["Memory", requirements.memory],
    ["Graphics", requirements.graphics], ["Storage", requirements.storage]
  ].filter(([, value]) => value);
  const screenshots = (game.screenshots || []).filter(image => href(image.image));
  const recommendations = details.recommendations || [];
  const info = [
    ["Game ID", game.id], ["Genre", game.genre], ["Platform", game.platform], ["Status", game.status],
    ["Release date", game.release_date], ["Developer", game.developer], ["Publisher", game.publisher],
    ["Minimum requirements", requirementRows.length ? "See system requirements below" : "Not provided"]
  ].filter(([, value]) => value !== null && value !== undefined && value !== "");
  section.style.display = "block";
  section.innerHTML = `
    <section class="tvmaze-detail-block"><h2>FreeToGame details</h2><dl class="tvmaze-info-grid">${info.map(([label, value]) => `<div><dt>${safe(label)}</dt><dd>${safe(value)}</dd></div>`).join("")}</dl><div class="anilist-link-row">${href(game.game_url) ? `<a href="${href(game.game_url)}" target="_blank" rel="noopener">Play game</a>` : ""}${href(game.freetogame_profile_url) ? `<a href="${href(game.freetogame_profile_url)}" target="_blank" rel="noopener">FreeToGame profile</a>` : ""}</div><p class="tvmaze-api-note">FreeToGame provides game details and system requirements; it does not provide ratings or review text.</p></section>
    ${game.description ? `<section class="tvmaze-detail-block"><h2>Description</h2><p class="freetogame-description">${safe(game.description)}</p></section>` : ""}
    ${requirementRows.length ? `<section class="tvmaze-detail-block"><h2>Minimum system requirements</h2><dl class="tvmaze-info-grid">${requirementRows.map(([label, value]) => `<div><dt>${safe(label)}</dt><dd>${safe(value)}</dd></div>`).join("")}</dl></section>` : ""}
    ${screenshots.length ? `<section class="tvmaze-detail-block"><h2>Screenshots <small>${screenshots.length}</small></h2><div class="steam-screenshots">${screenshots.map((image, index) => `<button type="button" class="steam-screenshot-thumb" data-freetogame-screenshot-index="${index}"><img src="${href(image.image)}" loading="lazy" alt="${safe(game.title || "Game")} screenshot ${index + 1}"></button>`).join("")}</div></section>` : ""}
    ${recommendations.length ? `<section class="tvmaze-detail-block"><h2>Similar games <small>${recommendations.length}</small></h2><div class="show-detail-related-list">${recommendations.map(entry => `<a class="show-detail-related-card" href="static/pages/main/show-detail.html?category=game&provider=freetogame&providerId=${encodeURIComponent(entry.id)}&title=${encodeURIComponent(entry.title)}">${thumbnailOrPlaceholder(entry.thumbnail, "show-detail-related-thumb")}<span>${safe(entry.title)}</span><small>${safe([entry.genre, entry.platform, entry.releaseDate].filter(Boolean).join(" · "))}</small></a>`).join("")}</div></section>` : ""}
    <div class="freetogame-attribution"><a href="https://www.freetogame.com/" target="_blank" rel="noopener">Game data provided by FreeToGame.com</a></div>`;
  const galleryImages = screenshots.map(image => ({ path_full: image.image, path_thumbnail: image.image }));
  section.querySelectorAll("[data-freetogame-screenshot-index]").forEach(button => button.addEventListener("click", () => openSteamScreenshotGallery(galleryImages, Number(button.dataset.freetogameScreenshotIndex))));
}
