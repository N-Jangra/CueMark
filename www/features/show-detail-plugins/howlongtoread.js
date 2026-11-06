// HowLongToRead adapter for book reading-time metadata.

async function fetchHowLongToReadHtml(url) {
  const request = { headers: { Accept: "text/html,application/xhtml+xml", Referer: "https://howlongtoread.com/" } };
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

function hltReadText(html) {
  const root = document.createElement("div");
  root.innerHTML = html;
  return (root.textContent || "").replace(/\s+/g, " ").trim();
}

function hltReadMatch(text, pattern) { return text.match(pattern)?.[1]?.trim() || ""; }

function parseHowLongToReadDetails(html, url, fallbackTitle) {
  const text = hltReadText(html);
  const heading = String(html).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "";
  const title = heading || hltReadMatch(text, /#\s*([^#]+?)\s+By\s+/i) || fallbackTitle;
  const author = hltReadMatch(text, /\bBy\s+(.+?)(?=\s+Book\s+\d|\s+The average reader|\s+The average)/i);
  const readingTime = hltReadMatch(text, /would take\s+(.+?)\s+to read/i);
  const words = hltReadMatch(text, /Word Count \(estimated\)\s*([\d,]+)/i);
  const pages = hltReadMatch(text, /Number of pages\s*([\d,]+)/i);
  const description = hltReadMatch(text, /Description\s+(.+?)(?=\s+Data and resources retrieved from|\s+Similar Books|$)/i);
  if (!title && !readingTime) throw new Error("HowLongToRead book data unavailable");
  return { source: "howlongtoread", category: "novel", id: url, title, subtitle: [author, readingTime].filter(Boolean).join(" · "), thumbnail: "", rating: null, summary: description, howLongToRead: { author, readingTime, words, pages }, url };
}

async function fetchHowLongToReadDetails(providerId, title = "") {
  const url = String(providerId).startsWith("http") ? providerId : `https://howlongtoread.com${providerId}`;
  return { ...parseHowLongToReadDetails(await fetchHowLongToReadHtml(url), url, title), fetchedAt: Date.now() };
}

function renderHowLongToReadDetails(details) {
  const section = document.getElementById("howlongtoread-extra-section");
  if (!section) return;
  if (!details) { section.style.display = "none"; section.innerHTML = ""; return; }
  const safe = detailText;
  const data = details.howLongToRead || {};
  const rows = [["Reading time", data.readingTime], ["Word count", data.words], ["Pages", data.pages], ["Author", data.author]].filter(([, value]) => value);
  section.style.display = "block";
  section.innerHTML = `<section class="tvmaze-detail-block"><h2>HowLongToRead</h2><dl class="tvmaze-info-grid">${rows.map(([label, value]) => `<div><dt>${safe(label)}</dt><dd>${safe(value)}</dd></div>`).join("")}</dl><div class="anilist-link-row"><a href="${safe(details.url)}" target="_blank" rel="noopener">Open on HowLongToRead</a></div></section>`;
}
