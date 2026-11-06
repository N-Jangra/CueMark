// HowLongToBeat provider adapter for game completion-time metadata.

let howLongToBeatToken = null;

function howLongToBeatPayload(terms, token, page = 1, size = 15) {
  const payload = {
    searchType: "games", searchTerms: terms.trim().split(/\s+/).filter(Boolean), searchPage: page, size,
    searchOptions: {
      games: { userId: 0, platform: "", sortCategory: "popular", rangeCategory: "main", rangeTime: { min: null, max: null }, gameplay: { perspective: "", flow: "", genre: "", difficulty: "" }, rangeYear: { min: "", max: "" }, modifier: "" },
      users: { sortCategory: "postcount" }, lists: { sortCategory: "follows" }, filter: "", sort: 0, randomizer: 0
    }, useCache: true
  };
  if (token.hpKey && token.hpVal != null) payload[token.hpKey] = token.hpVal;
  return payload;
}

async function fetchHowLongToBeatJson(url, init = {}) {
  const proxyUrl = window.location?.protocol === "file:"
    ? "http://127.0.0.1:3000/proxy"
    : window.location?.origin && window.location.origin !== "null" ? new URL("/proxy", window.location.origin).toString() : "";
  if (proxyUrl) {
    const target = new URL(proxyUrl);
    target.searchParams.set("url", url);
    try {
      const response = await (window.cuemarkNativeFetch || fetch.bind(window))(target.toString(), init);
      if (response.ok) return response.json();
      if (response.status !== 404 && response.status !== 405) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      if (error?.message?.startsWith("HTTP ")) throw error;
    }
  }
  return fetchJsonPortable(url, init);
}

async function fetchHowLongToBeatToken() {
  if (howLongToBeatToken && Date.now() - howLongToBeatToken.fetchedAt < 10 * 60 * 1000) return howLongToBeatToken;
  const token = await fetchHowLongToBeatJson(`https://howlongtobeat.com/api/search/site/init?t=${Date.now()}`, { headers: { Accept: "application/json", Referer: "https://howlongtobeat.com/" } });
  if (!token?.token) throw new Error("HowLongToBeat session unavailable");
  howLongToBeatToken = { ...token, fetchedAt: Date.now() };
  return howLongToBeatToken;
}

function hltbHours(seconds) {
  const value = Number(seconds);
  return value > 0 ? Math.round(value / 360) / 10 : null;
}

function howLongToBeatResult(game) {
  return {
    source: "howlongtobeat", category: "game", id: String(game.game_id), title: game.game_name || "Untitled",
    subtitle: [game.release_world, game.comp_main ? `${hltbHours(game.comp_main)}h main` : "", game.comp_plus ? `${hltbHours(game.comp_plus)}h +extras` : ""].filter(Boolean).join(" · "),
    thumbnail: game.game_image ? `https://howlongtobeat.com/games/${game.game_image}` : "",
    rating: Number(game.review_score) ? Number(game.review_score) / 10 : null,
    summary: game.profile_summary || "",
    howLongToBeat: { main: hltbHours(game.comp_main), mainPlus: hltbHours(game.comp_plus), completionist: hltbHours(game.comp_100), platforms: game.profile_platform || "", type: game.game_type || "game" }
  };
}

async function fetchHowLongToBeatPage(gameId) {
  const url = `https://howlongtobeat.com/game/${encodeURIComponent(gameId)}`;
  const request = { headers: { Accept: "text/html,application/xhtml+xml", Referer: "https://howlongtobeat.com/" } };
  if (typeof window !== "undefined" && window.location?.origin && window.location.origin !== "null") {
    const proxyUrl = new URL("/proxy", window.location.origin);
    proxyUrl.searchParams.set("url", url);
    const response = await fetch(proxyUrl.toString(), request);
    if (response.ok) return response.text();
  }
  const response = await fetch(url, request);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

function parseHowLongToBeatPage(html, providerId) {
  const match = String(html || "").match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error("HowLongToBeat game data unavailable");
  const payload = JSON.parse(match[1]);
  const game = payload?.props?.pageProps?.game?.data?.game?.[0];
  if (!game || String(game.game_id) !== String(providerId)) throw new Error("HowLongToBeat game not found");
  return howLongToBeatResult(game);
}

async function searchHowLongToBeat(query) {
  const token = await fetchHowLongToBeatToken();
  const headers = { Accept: "application/json", "Content-Type": "application/json", Origin: "https://howlongtobeat.com", Referer: "https://howlongtobeat.com/", "x-auth-token": token.token };
  if (token.hpKey && token.hpVal != null) {
    headers["x-hp-key"] = token.hpKey;
    headers["x-hp-val"] = token.hpVal;
  }
  const json = await fetchHowLongToBeatJson("https://howlongtobeat.com/api/search/site", { method: "POST", headers, body: JSON.stringify(howLongToBeatPayload(query, token)) });
  return (Array.isArray(json?.data) ? json.data : []).filter(game => game.game_type === "game").map(howLongToBeatResult);
}

async function fetchHowLongToBeatDetails(providerId, title = "") {
  try {
    const details = parseHowLongToBeatPage(await fetchHowLongToBeatPage(providerId), providerId);
    return { ...details, fetchedAt: Date.now() };
  } catch (pageError) {
    const query = title || `game ${providerId}`;
    const results = await searchHowLongToBeat(query);
    const id = String(providerId);
    const match = results.find(result => String(result.id) === id) || results[0];
    if (!match) throw pageError;
    return { ...match, fetchedAt: Date.now() };
  }
}

function renderHowLongToBeatDetails(details) {
  const section = document.getElementById("howlongtobeat-extra-section");
  if (!section) return;
  if (!details) {
    section.style.display = "none";
    section.innerHTML = "";
    return;
  }
  const safe = detailText;
  const times = details.howLongToBeat || {};
  const rows = [
    ["Main story", times.main ? `${times.main} hours` : "Not available"],
    ["Main + extras", times.mainPlus ? `${times.mainPlus} hours` : "Not available"],
    ["Completionist", times.completionist ? `${times.completionist} hours` : "Not available"],
    ["Platforms", times.platforms], ["Type", times.type]
  ].filter(([, value]) => value);
  const hltbUrl = `https://howlongtobeat.com/game/${encodeURIComponent(details.id)}`;
  section.style.display = "block";
  section.innerHTML = `<section class="tvmaze-detail-block"><h2>HowLongToBeat</h2><dl class="tvmaze-info-grid">${rows.map(([label, value]) => `<div><dt>${safe(label)}</dt><dd>${safe(value)}</dd></div>`).join("")}</dl><div class="anilist-link-row"><a href="${safe(hltbUrl)}" target="_blank" rel="noopener">Open on HowLongToBeat</a></div><p class="tvmaze-api-note">Completion times are community averages from HowLongToBeat.</p></section>`;
}
