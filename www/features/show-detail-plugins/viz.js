// VIZ adapter for manga and book product metadata.

async function fetchVizHtml(url) {
  const request = { headers: { Accept: "text/html,application/xhtml+xml", Referer: "https://www.viz.com/" } };
  if (window.location?.origin && window.location.origin !== "null") {
    const proxy = new URL("/proxy", window.location.origin);
    proxy.searchParams.set("url", url);
    const response = await fetch(proxy.toString(), request);
    if (response.ok) return response.text();
  }
  const response = await fetch(url, request);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

function vizPageText(html) {
  const root = document.createElement("div"); root.innerHTML = html;
  return (root.textContent || "").replace(/\s+/g, " ").trim();
}

function vizMeta(html, property) {
  const match = String(html).match(new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)`, "i"));
  return match?.[1] || "";
}

function parseVizDetails(html, url, fallbackTitle) {
  const text = vizPageText(html);
  const title = vizMeta(html, "og:title") || text.match(/(?:Manga Books|VIZ)\s+(.+?)(?:\s+Paperback|\s+Digital|\s+Created by)/i)?.[1] || fallbackTitle;
  const description = vizMeta(html, "og:description") || text.match(/Description\s+(.+?)(?=\s+Story and Art|\s+Release\s+)/i)?.[1] || "";
  const image = vizMeta(html, "og:image");
  const author = text.match(/(?:Created by|Story and Art by)\s+(.+?)(?=\s+Release|\s+Paperback|\s+Digital)/i)?.[1] || "";
  const release = text.match(/Release\s+([A-Z][A-Za-z]+\s+\d{1,2},\s+\d{4})/i)?.[1] || "";
  if (!title) throw new Error("VIZ manga data unavailable");
  return { source: "viz", category: "manga", id: url, title: title.trim(), subtitle: [author, release].filter(Boolean).join(" · "), thumbnail: image, rating: null, summary: description, viz: { author, release }, url };
}

async function fetchVizDetails(providerId, title = "") {
  const url = String(providerId).startsWith("http") ? providerId : `https://www.viz.com${providerId}`;
  return { ...parseVizDetails(await fetchVizHtml(url), url, title), fetchedAt: Date.now() };
}

function renderVizDetails(details) {
  const section = document.getElementById("viz-extra-section");
  if (!section) return;
  if (!details) { section.style.display = "none"; section.innerHTML = ""; return; }
  const safe = detailText;
  const data = details.viz || {};
  const rows = [["Author", data.author], ["Release", data.release]].filter(([, value]) => value);
  section.style.display = "block";
  section.innerHTML = `<section class="tvmaze-detail-block"><h2>VIZ</h2><dl class="tvmaze-info-grid">${rows.map(([label, value]) => `<div><dt>${safe(label)}</dt><dd>${safe(value)}</dd></div>`).join("")}</dl><div class="anilist-link-row"><a href="${safe(details.url)}" target="_blank" rel="noopener">Open on VIZ</a></div></section>`;
}
