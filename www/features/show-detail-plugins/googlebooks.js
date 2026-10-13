// Googlebooks provider adapter for the shared show detail page.

async function fetchGoogleBooksFullData(providerId, existingItem = null) {
  const cacheKey = `cuemark:googlebooks:${providerId}`;
  let details = null;
  try {
    const cached = JSON.parse(sessionStorage.getItem(cacheKey) || "null");
    if (cached?.volume && Date.now() - Number(cached.fetchedAt || 0) < 24 * 60 * 60 * 1000) details = cached;
  } catch {}
  if (!details) {
    const volume = await fetchJsonPortable(`https://www.googleapis.com/books/v1/volumes/${encodeURIComponent(providerId)}?projection=full`);
    if (!volume?.volumeInfo) throw new Error("Google Books details unavailable");
    const info = volume.volumeInfo;
    const queries = [];
    if (info.authors?.length) queries.push(`inauthor:${info.authors[0]}`);
    if (info.categories?.length) queries.push(`subject:${info.categories[0]}`);
    const results = await Promise.all(queries.map(async query => {
      try {
        const search = await fetchJsonPortable(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=40&projection=full`);
        return search.items || [];
      } catch (error) { console.warn("Could not load Google Books suggestions", error); return []; }
    }));
    const seen = new Set([String(volume.id || providerId)]);
    details = {
      volume,
      recommendations: results.flat().filter(item => {
        const id = String(item.id || "");
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      }).slice(0, 60),
      fetchedAt: Date.now()
    };
    try { sessionStorage.setItem(cacheKey, JSON.stringify(details)); } catch {}
  }
  const info = details.volume.volumeInfo || {};
  if (existingItem) {
    Object.assign(existingItem, {
      summary: info.description || existingItem.summary || "",
      genres: info.categories || [],
      googlebooksDetailsCache: details,
      ...(thumbnailsEnabled() && (info.imageLinks?.extraLarge || info.imageLinks?.large || info.imageLinks?.thumbnail)
        ? { thumbnail: (info.imageLinks.extraLarge || info.imageLinks.large || info.imageLinks.thumbnail).replace("http://", "https://") }
        : {})
    });
    saveData();
  }
  return details;
}

function renderGoogleBooksDetails(details) {
  const section = document.getElementById("googlebooks-extra-section");
  const volume = details?.volume;
  const info = volume?.volumeInfo;
  if (!section) return;
  if (!info) { section.style.display = "none"; section.innerHTML = ""; return; }
  const safe = detailText;
  const href = value => {
    try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? safe(url.href) : ""; }
    catch { return ""; }
  };
  const identifiers = info.industryIdentifiers || [];
  const access = volume.accessInfo || {};
  const sale = volume.saleInfo || {};
  const links = [["Google Books page", info.infoLink], ["Preview", info.previewLink], ["Buy this book", sale.buyLink], ["Web reader", access.webReaderLink], ["EPUB download", access.epub?.downloadLink], ["PDF download", access.pdf?.downloadLink]].filter(([, url]) => href(url));
  const rows = [
    ["Subtitle", info.subtitle], ["Authors", (info.authors || []).join(", ")], ["Publisher", info.publisher],
    ["Published", info.publishedDate], ["Print type", info.printType], ["Language", info.language], ["Page count", info.pageCount],
    ["Categories", (info.categories || []).join(", ")], ["Maturity rating", info.maturityRating],
    ["Average rating", info.averageRating ? `${info.averageRating}/5` : "Not rated"], ["Ratings count", info.ratingsCount],
    ["Content version", info.contentVersion], ["Reading modes", Object.entries(info.readingModes || {}).filter(([, enabled]) => enabled).map(([key]) => key.toUpperCase()).join(", ")],
    ["Dimensions", Object.entries(info.dimensions || {}).map(([key,value]) => `${key}: ${value}`).join(" · ")],
    ["ISBN / identifiers", identifiers.map(item => `${item.type}: ${item.identifier}`).join(" · ")],
    ["Availability", [access.viewability, access.textToSpeechPermission, access.publicDomain ? "Public domain" : "", access.epub?.isAvailable ? "EPUB available" : "", access.pdf?.isAvailable ? "PDF available" : ""].filter(Boolean).join(" · ")],
    ["Sale", [sale.saleability, sale.isEbook ? "eBook" : "", sale.listPrice && `${sale.listPrice.amount} ${sale.listPrice.currencyCode}`, sale.retailPrice && `Retail ${sale.retailPrice.amount} ${sale.retailPrice.currencyCode}`].filter(Boolean).join(" · ")]
  ].filter(([, value]) => value !== undefined && value !== null && value !== "");
  const suggestions = (details.recommendations || []).filter(item => item.volumeInfo);
  const cover = info.imageLinks?.extraLarge || info.imageLinks?.large || info.imageLinks?.medium || info.imageLinks?.thumbnail || "";
  section.style.display = "block";
  section.innerHTML = `
    <section class="tvmaze-detail-block"><h2>Google Books details</h2><dl class="tvmaze-info-grid">${rows.map(([label,value]) => `<div><dt>${safe(label)}</dt><dd>${safe(value)}</dd></div>`).join("")}</dl>${links.length ? `<div class="anilist-link-row">${links.map(([label,url]) => `<a href="${href(url)}" target="_blank" rel="noopener">${safe(label)}</a>`).join("")}</div>` : ""}<p class="tvmaze-api-note">Google Books provides an average star rating and count, but its public Volumes API does not return individual review text or reviewer profiles.</p></section>
    ${info.description ? `<section class="tvmaze-detail-block"><h2>Description</h2><div class="jikan-long-text">${safe(info.description)}</div></section>` : ""}
    ${cover ? `<section class="tvmaze-detail-block"><h2>Cover</h2><div class="tvmaze-image-grid"><a href="${href(cover)}" target="_blank" rel="noopener"><img src="${href(cover)}" alt="${safe(info.title || "Book")} cover" loading="lazy"><small>Cover image</small></a></div></section>` : ""}
    ${suggestions.length ? `<section class="tvmaze-detail-block"><h2>Related books <small>${suggestions.length}</small></h2><div class="show-detail-related-list">${suggestions.map(item => { const itemInfo = item.volumeInfo || {}; const image = (itemInfo.imageLinks?.thumbnail || itemInfo.imageLinks?.smallThumbnail || "").replace("http://", "https://"); const label = itemInfo.title || "Untitled"; return `<a class="show-detail-related-card" href="static/pages/main/show-detail.html?category=${encodeURIComponent(showDetailState.category || "novel")}&provider=googlebooks&providerId=${encodeURIComponent(item.id)}&title=${encodeURIComponent(label)}">${thumbnailOrPlaceholder(image, "show-detail-related-thumb")}<span>${safe(label)}</span><small>${safe([itemInfo.authors?.join(", "), itemInfo.publishedDate, itemInfo.averageRating ? `★ ${itemInfo.averageRating}/5` : ""].filter(Boolean).join(" · "))}</small></a>`; }).join("")}</div></section>` : ""}
    <p class="tvmaze-data-footnote">Loaded ${rows.length} metadata fields and ${suggestions.length} related volumes based on the listed author and subject. Google Books does not expose cast data or a public per-title review feed.</p>`;
}
