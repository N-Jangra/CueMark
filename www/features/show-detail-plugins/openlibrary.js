// Openlibrary provider adapter for the shared show detail page.

let openLibraryLastRequestAt = 0;

async function fetchOpenLibraryJson(url) {
  const wait = Math.max(0, 1000 - (Date.now() - openLibraryLastRequestAt));
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  openLibraryLastRequestAt = Date.now();
  const headers = { Accept: "application/json" };
  const plugin = getNativeHttpPlugin();
  if (plugin?.get) {
    const response = await plugin.get({ url, headers });
    const payload = parseDetailJson(response?.data);
    if (response?.status && response.status < 400) return payload;
    if (response?.status && response.status !== 403) throw detailHttpError(response.status, payload);
  }
  else if (plugin?.request) {
    const response = await plugin.request({ url, method: "GET", headers, responseType: "json" });
    const payload = parseDetailJson(response?.data);
    if (response?.status && response.status < 400) return payload;
    if (response?.status && response.status !== 403) throw detailHttpError(response.status, payload);
  }

  const directFetch = window.cuemarkNativeFetch || fetch.bind(window);
  let directError = null;
  try {
    const response = await directFetch(url, { headers });
    if (response.ok) return await response.json();
    directError = detailHttpError(response.status, await response.clone().json().catch(() => null));
    if (response.status !== 403 && response.status !== 404) throw directError;
  } catch (error) {
    directError = error;
  }

  const proxyUrls = [];
  if (window.location?.protocol !== "file:" && window.location?.origin && window.location.origin !== "null") {
    const proxyUrl = new URL("/proxy", window.location.origin);
    proxyUrl.searchParams.set("url", url);
    proxyUrls.push(proxyUrl.toString());
  } else if (window.location?.protocol === "file:") {
    const proxyUrl = new URL("http://127.0.0.1:3000/proxy");
    proxyUrl.searchParams.set("url", url);
    proxyUrls.push(proxyUrl.toString());
  }
  for (const proxyUrl of proxyUrls) {
    try {
      const response = await directFetch(proxyUrl, { headers });
      if (response.ok) return await response.json();
      const proxyError = detailHttpError(response.status, await response.clone().json().catch(() => null));
      if (!directError || directError.name === "TypeError") directError = proxyError;
    } catch (error) {
      if (!directError) directError = error;
    }
  }
  throw directError || new Error("Open Library request failed");
}

async function fetchOpenLibraryReadMatches(editions) {
  const requests = (editions || []).slice(0, 50).map(edition => {
    const olid = String(edition.key || "").split("/").pop();
    const ids = [olid ? `olid:${olid}` : "", ...(edition.isbn_13 || []).map(isbn => `isbn:${isbn}`), ...(edition.isbn_10 || []).map(isbn => `isbn:${isbn}`)].filter(Boolean);
    return olid && ids.length ? `id:${olid};${ids.join(";")}` : "";
  }).filter(Boolean);
  if (!requests.length) return [];
  const response = await fetchOpenLibraryJson(`https://openlibrary.org/api/volumes/brief/json/${encodeURIComponent(requests.join("|"))}`);
  return Object.entries(response || {}).flatMap(([recordId, record]) => (record.items || []).map(item => ({
    recordId,
    match: item.match || "",
    status: item.status || "",
    url: item.itemURL || "",
    publishDate: item.publishDate || "",
    editionId: item["ol-edition-id"] || "",
    workId: item["ol-work-id"] || "",
    cover: item.cover?.medium || item.cover?.small || ""
  }))).filter(item => item.url);
}

async function fetchOpenLibraryFullData(providerId, existingItem = null, onCore = null) {
  const workId = String(providerId).replace(/^\/works\//, "").replace(/\.json$/, "");
  const root = `https://openlibrary.org/works/${encodeURIComponent(workId)}`;
  const work = await fetchOpenLibraryJson(`${root}.json`);
  if (!work || work.error) throw new Error(work?.error || "Open Library work not found");

  const rawDescription = work.description;
  const summary = typeof rawDescription === "string" ? rawDescription : rawDescription?.value || "";
  const coverId = work.covers?.find(id => id > 0);
  const thumbnail = coverId ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` : "";
  const coreDetails = {
    workId, work, summary, thumbnail,
    publishYear: work.first_publish_date?.match(/\d{4}/)?.[0] || "",
    subjects: work.subjects || [], authors: [], ratings: null, rating: 0, ratingCount: 0,
    bookshelves: null, readableItems: [], editions: [], editionCount: Number(work.edition_count) || 0,
    editionsHaveMore: false, subjectPicks: [], recommendations: [], fetchedAt: Date.now()
  };
  if (onCore) onCore(coreDetails);

  const optionalFetch = async url => {
    try { return await fetchOpenLibraryJson(url); }
    catch (err) { console.warn("An Open Library detail endpoint failed", err); return null; }
  };
  const editionsResponse = await optionalFetch(`${root}/editions.json?limit=100`);
  const ratings = await optionalFetch(`${root}/ratings.json`);
  const bookshelves = await optionalFetch(`${root}/bookshelves.json`);
  const editions = editionsResponse?.entries || editionsResponse?.docs || [];
  let readableItems = [];
  try { readableItems = await fetchOpenLibraryReadMatches(editions); }
  catch (err) { console.warn("Open Library Read API lookup failed", err); }
  const authorKeys = (work.authors || []).map(entry => entry.author?.key || entry.key).filter(Boolean).slice(0, 20);
  let authors = [];
  if (authorKeys.length) {
    const authorQuery = `key:(${authorKeys.map(key => key.startsWith("/") ? key : `/authors/${key}`).join(" OR ")})`;
    const authorResponse = await optionalFetch(`https://openlibrary.org/search/authors.json?q=${encodeURIComponent(authorQuery)}&limit=20`);
    authors = authorResponse?.docs || [];
  }
  const subjectNames = (work.subjects || []).slice(0, 3);
  const subjectPicks = [];
  for (const subject of subjectNames) {
    const subjectSlug = String(subject).toLowerCase().trim().replace(/\s+/g, "_");
    const subjectData = await optionalFetch(`https://openlibrary.org/subjects/${encodeURIComponent(subjectSlug)}.json?details=true&limit=12&sort=rating`);
    if (subjectData) subjectPicks.push({ subject, data: subjectData });
  }

  const ratingSummary = ratings?.summary || {};
  const rating = Number(ratingSummary.average ?? ratings?.average ?? 0) || 0;
  const ratingCount = Number(ratingSummary.count ?? ratings?.count ?? 0) || 0;
  const recommendations = subjectPicks.flatMap(({subject, data}) => (data.works || []).map(candidate => ({
    ...candidate,
    subject,
    workId: String(candidate.key || "").replace(/^\/works\//, ""),
    thumbnail: candidate.cover_id ? `https://covers.openlibrary.org/b/id/${candidate.cover_id}-M.jpg` : ""
  }))).filter(candidate => candidate.workId && candidate.workId !== workId && candidate.title);
  const uniqueRecommendations = Array.from(new Map(recommendations.map(book => [book.workId, book])).values()).slice(0, 30);
  const details = {
    workId, work, summary, thumbnail,
    publishYear: work.first_publish_date?.match(/\d{4}/)?.[0] || "",
    subjects: work.subjects || [],
    authors,
    ratings,
    rating,
    ratingCount,
    bookshelves,
    readableItems,
    editions,
    editionCount: Number(editionsResponse?.size ?? editionsResponse?.numFound ?? work.edition_count ?? editions.length) || editions.length,
    editionsHaveMore: editions.length < (Number(editionsResponse?.size ?? editionsResponse?.numFound ?? work.edition_count ?? editions.length) || editions.length),
    subjectPicks,
    recommendations: uniqueRecommendations,
    fetchedAt: Date.now()
  };
  if (existingItem) {
    existingItem.openlibraryDetailsCache = details;
    existingItem.summary = summary || existingItem.summary || "";
    existingItem.genres = details.subjects.slice(0, 20);
    existingItem.totalVolumes = details.editionCount || existingItem.totalVolumes || 0;
    if (thumbnailsEnabled() && thumbnail) existingItem.thumbnail = thumbnail;
    saveData();
  }
  return details;
}

function renderOpenLibraryDetails(details) {
  const section = document.getElementById("openlibrary-extra-section");
  if (!section) return;
  if (!details?.work) {
    section.style.display = "none";
    section.innerHTML = "";
    return;
  }
  const safe = detailText;
  const externalHref = value => {
    try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? safe(url.href) : ""; }
    catch { return ""; }
  };
  const work = details.work;
  const authors = details.authors || [];
  const editions = details.editions || [];
  const shelves = details.bookshelves?.counts || {};
  const ratingCounts = details.ratings?.counts || {};
  const info = [
    ["Open Library work ID", details.workId], ["First published", work.first_publish_date],
    ["Edition count", details.editionCount], ["Open Library rating", details.rating ? `${details.rating.toFixed(2)}/5` : "Not rated"],
    ["Rating count", details.ratingCount], ["Languages", (work.languages || []).map(language => language.key?.split("/").pop()).filter(Boolean).join(", ")],
    ["Subjects", details.subjects.join(", ")], ["Places", (work.subject_places || []).join(", ")],
    ["People", (work.subject_people || []).join(", ")], ["Time periods", (work.subject_times || []).join(", ")],
    ["LC classifications", (work.lc_classifications || []).join(", ")], ["Dewey numbers", (work.dewey_number || []).join(", ")],
    ["Created", work.created?.value], ["Last modified", work.last_modified?.value], ["Revision", work.revision]
  ].filter(([, value]) => value !== null && value !== undefined && value !== "");
  const ratingStars = Object.entries(ratingCounts).sort(([a], [b]) => Number(b) - Number(a));
  const shelfCounts = Object.entries(shelves).sort(([, a], [, b]) => Number(b) - Number(a));
  const getEditionIsbn = edition => [...(edition.isbn_13 || []), ...(edition.isbn_10 || [])];
  const editionRows = editions;
  const subjectDetails = details.subjectPicks || [];
  const covers = (work.covers || []).filter(id => id > 0);
  const identifiers = Object.entries(work.identifiers || {}).flatMap(([name, values]) => (Array.isArray(values) ? values : [values]).map(value => [name, value]));
  const workLinks = work.links || [];
  section.style.display = "block";
  section.innerHTML = `
    <section class="tvmaze-detail-block"><h2>Open Library record</h2><dl class="tvmaze-info-grid">${info.map(([label,value]) => `<div><dt>${safe(label)}</dt><dd>${safe(value)}</dd></div>`).join("")}</dl><div class="anilist-link-row"><a href="https://openlibrary.org/works/${encodeURIComponent(details.workId)}" target="_blank" rel="noopener">Open Library work</a>${work.key ? `<a href="https://openlibrary.org${safe(work.key)}.json" target="_blank" rel="noopener">Raw work data</a>` : ""}${authors.map(author => author.key ? `<a href="https://openlibrary.org${safe(author.key)}" target="_blank" rel="noopener">${safe(author.name)} profile</a>` : "").join("")}</div>${identifiers.length ? `<p class="tvmaze-api-note">Identifiers: ${identifiers.map(([name,value]) => `${safe(name)}: ${safe(value)}`).join(" · ")}</p>` : ""}<p class="tvmaze-api-note">Open Library provides community ratings and bookshelf counts. It does not expose review text for a work.</p></section>
    ${authors.length ? `<section class="tvmaze-detail-block"><h2>Authors <small>${authors.length}</small></h2><div class="tvmaze-people-grid">${authors.map(author => { const authorId = String(author.key || "").split("/").pop(); return `<article class="tvmaze-person-card"><img src="https://covers.openlibrary.org/a/olid/${encodeURIComponent(authorId)}-M.jpg?default=false" alt="" loading="lazy" onerror="this.style.display='none'"><div><strong>${safe(author.name || "Unknown author")}</strong><span>${safe([author.birth_date, author.death_date ? `– ${author.death_date}` : "", author.work_count ? `${author.work_count} works` : "", author.top_work].filter(Boolean).join(" · "))}</span>${author.top_subjects?.length ? `<small>${safe(author.top_subjects.slice(0, 5).join(", "))}</small>` : ""}</div></article>`; }).join("")}</div></section>` : ""}
    ${details.ratingCount || ratingStars.length ? `<section class="tvmaze-detail-block"><h2>Ratings</h2><div class="openlibrary-rating-summary"><strong>${details.rating ? details.rating.toFixed(2) : "—"}<small>/5</small></strong><span>${details.ratingCount} community ratings</span></div>${ratingStars.length ? `<div class="openlibrary-rating-distribution">${ratingStars.map(([stars,count]) => `<div><span>${safe(stars)} stars</span><span class="openlibrary-rating-track"><i style="width:${details.ratingCount ? Math.min(100, Number(count) / details.ratingCount * 100) : 0}%"></i></span><small>${safe(count)}</small></div>`).join("")}</div>` : ""}</section>` : ""}
    ${shelfCounts.length ? `<section class="tvmaze-detail-block"><h2>Bookshelves</h2><div class="anilist-chip-list">${shelfCounts.map(([name,count]) => `<span class="anilist-chip">${safe(name.replace(/[-_]/g, " "))}: ${safe(count)}</span>`).join("")}</div></section>` : ""}
    ${details.readableItems?.length ? `<section class="tvmaze-detail-block"><h2>Read or borrow online <small>${details.readableItems.length} matches</small></h2><div class="anilist-link-list">${details.readableItems.map(item => `<a href="${externalHref(item.url)}" target="_blank" rel="noopener">${safe(item.status || "Open Library reader")}${item.match ? ` · ${safe(item.match)} match` : ""}${item.publishDate ? ` · ${safe(item.publishDate)}` : ""}${item.editionId ? ` · edition ${safe(item.editionId)}` : ""}</a>`).join("")}</div><p class="tvmaze-api-note">Availability is based on Open Library’s Read API and can vary by edition and location.</p></section>` : ""}
    ${work.excerpts?.length ? `<section class="tvmaze-detail-block"><h2>Excerpts</h2><div class="openlibrary-excerpts">${work.excerpts.map(entry => `<blockquote>${safe(typeof entry === "string" ? entry : entry.excerpt || "")}${entry.comment ? `<cite>${safe(entry.comment)}</cite>` : ""}</blockquote>`).join("")}</div></section>` : ""}
    ${editionRows.length ? `<details class="tvmaze-detail-block"><summary>Editions <small>${details.editionCount} total · showing ${editionRows.length} loaded${details.editionsHaveMore ? ", more available" : ""}</small></summary><div class="openlibrary-editions">${editionRows.map(edition => { const contributors = (edition.contributors || []).map(item => typeof item === "string" ? item : item.name || item.key || ""); const editionAuthors = (edition.authors || []).map(item => item.name || item.key || ""); const editionUrl = edition.key ? `https://openlibrary.org${edition.key}` : ""; return `<article>${edition.covers?.[0] ? `<img src="https://covers.openlibrary.org/b/id/${edition.covers[0]}-M.jpg" alt="" loading="lazy">` : ""}<div><strong>${editionUrl ? `<a href="${externalHref(editionUrl)}" target="_blank" rel="noopener">${safe(edition.title || work.title || "Untitled edition")}</a>` : safe(edition.title || work.title || "Untitled edition")}</strong><span>${safe([edition.publish_date, ...(edition.publishers || []), edition.physical_format, edition.number_of_pages ? `${edition.number_of_pages} pages` : "", ...(edition.publish_places || [])].filter(Boolean).join(" · "))}</span>${editionAuthors.length ? `<small>Authors: ${safe(editionAuthors.join(", "))}</small>` : ""}${contributors.length ? `<small>Contributors: ${safe(contributors.join(", "))}</small>` : ""}${getEditionIsbn(edition).length ? `<small>ISBN ${safe(getEditionIsbn(edition).join(" · "))}</small>` : ""}${edition.languages?.length ? `<small>Language IDs: ${safe(edition.languages.map(lang => lang.key?.split("/").pop()).join(", "))}</small>` : ""}</div></article>`; }).join("")}</div>${details.editionsHaveMore ? `<button type="button" class="btn btn-secondary openlibrary-load-more" id="openlibrary-load-more-editions">Load more editions</button>` : ""}</details>` : ""}
    ${covers.length ? `<details class="tvmaze-detail-block"><summary>Work covers <small>${covers.length}</small></summary><div class="tvmaze-image-grid">${covers.map(id => `<a href="https://covers.openlibrary.org/b/id/${id}-L.jpg" target="_blank" rel="noopener"><img src="https://covers.openlibrary.org/b/id/${id}-M.jpg" loading="lazy" alt="Book cover"><small>Cover ${safe(id)}</small></a>`).join("")}</div></details>` : ""}
    ${workLinks.length ? `<details class="tvmaze-detail-block"><summary>Work links <small>${workLinks.length}</small></summary><div class="anilist-link-list">${workLinks.map(link => externalHref(link.url) ? `<a href="${externalHref(link.url)}" target="_blank" rel="noopener">${safe(link.title || link.url)}${link.type?.key ? ` · ${safe(link.type.key.split("/").pop())}` : ""}</a>` : "").join("")}</div></details>` : ""}
    ${details.recommendations.length ? `<section class="tvmaze-detail-block"><h2>Similar books <small>${details.recommendations.length}</small></h2><div class="show-detail-related-list">${details.recommendations.map(book => `<a class="show-detail-related-card" href="static/pages/main/show-detail.html?category=${encodeURIComponent(showDetailState.category)}&provider=openlibrary&providerId=${encodeURIComponent(book.workId)}&title=${encodeURIComponent(book.title)}">${thumbnailOrPlaceholder(book.thumbnail, "show-detail-related-thumb")}<span>${safe(book.title)}</span><small>${safe([book.subject, book.edition_count ? `${book.edition_count} editions` : "", book.authors?.map(author => author.name).join(", ")].filter(Boolean).join(" · "))}</small></a>`).join("")}</div></section>` : ""}
    ${subjectDetails.length ? `<details class="tvmaze-detail-block"><summary>Subject discovery details</summary>${subjectDetails.map(({subject,data}) => `<div class="openlibrary-subject-detail"><strong>${safe(subject)}</strong><span>${safe(data.work_count || 0)} works in this subject${data.ebook_count ? ` · ${safe(data.ebook_count)} ebooks` : ""}</span>${data.related_subjects?.length ? `<small>Related subjects: ${safe(data.related_subjects.slice(0, 10).map(entry => entry.name).join(", "))}</small>` : ""}</div>`).join("")}</details>` : ""}
    <p class="tvmaze-data-footnote">Loaded ${authors.length} author profiles, ${editionRows.length} edition records, ${details.readableItems?.length || 0} read or borrow matches, and ${details.recommendations.length} similar titles from ${subjectDetails.length} subjects.</p>`;
  const loadMoreButton = section.querySelector("#openlibrary-load-more-editions");
  if (loadMoreButton) loadMoreButton.addEventListener("click", async () => {
    loadMoreButton.disabled = true;
    loadMoreButton.textContent = "Loading editions…";
    try {
      const next = await fetchOpenLibraryJson(`https://openlibrary.org/works/${encodeURIComponent(details.workId)}/editions.json?limit=100&offset=${details.editions.length}`);
      const nextEditions = next?.entries || next?.docs || [];
      if (!nextEditions.length) {
        details.editionsHaveMore = false;
      } else {
        const existingKeys = new Set(details.editions.map(edition => edition.key));
        const newEditions = nextEditions.filter(edition => edition.key && !existingKeys.has(edition.key));
        details.editions.push(...newEditions);
        try {
          const moreReadable = await fetchOpenLibraryReadMatches(newEditions);
          const knownUrls = new Set((details.readableItems || []).map(item => item.url));
          details.readableItems.push(...moreReadable.filter(item => !knownUrls.has(item.url)));
        } catch (err) { console.warn("Open Library Read API lookup failed", err); }
        details.editionCount = Number(next?.size ?? next?.numFound ?? details.editionCount) || details.editionCount;
        details.editionsHaveMore = details.editions.length < details.editionCount && newEditions.length > 0;
      }
      const localItem = state.items.find(item => item.id === showDetailState.itemId);
      if (localItem) { localItem.openlibraryDetailsCache = details; saveData(); }
      renderOpenLibraryDetails(details);
      const editionsSection = section.querySelector(".openlibrary-editions")?.closest("details");
      if (editionsSection) editionsSection.open = true;
    } catch (err) {
      console.warn("Could not load more Open Library editions", err);
      loadMoreButton.disabled = false;
      loadMoreButton.textContent = "Could not load more editions · Retry";
    }
  });
}
