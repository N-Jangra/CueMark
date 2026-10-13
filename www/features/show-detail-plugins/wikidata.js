// Wikidata provider adapter for the shared show detail page.

const WIKIDATA_MOVIE_PROPERTIES = {
  P31: "Instance of", P136: "Genres", P495: "Country of origin", P364: "Original language",
  P57: "Director", P58: "Screenwriter", P161: "Cast", P162: "Producer", P86: "Composer",
  P344: "Cinematography", P1040: "Film editor", P272: "Production company", P750: "Distributor",
  P840: "Narrative location", P144: "Based on", P179: "Part of series", P166: "Awards",
  P1411: "Award nominations", P155: "Preceded by", P156: "Followed by", P361: "Part of",
  P527: "Has parts", P793: "Significant event", P1657: "MPAA rating", P444: "Review scores",
  P2047: "Runtime", P577: "Release date", P18: "Image", P856: "Official website",
  P345: "IMDb ID", P4947: "TMDb movie ID", P2130: "Production budget", P2142: "Box office",
  P2437: "Number of seasons", P453: "Character", P1545: "Series ordinal", P580: "Start time",
  P582: "End time", P585: "Point in time", P518: "Applies to part", P854: "Reference URL",
  P248: "Stated in", P813: "Retrieved"
};

function wikidataClaimStatements(claims, propertyId) {
  return (claims?.[propertyId] || []).filter(statement => statement?.rank !== "deprecated" && statement?.mainsnak?.datavalue);
}

function wikidataClaimValues(claims, propertyId) {
  return wikidataClaimStatements(claims, propertyId).map(statement => statement.mainsnak.datavalue.value);
}

function wikidataEntityIdFromUri(value) {
  return typeof value === "string" ? value.match(/(?:^|\/)(Q\d+)$/)?.[1] || "" : "";
}

function wikidataValueText(value, labels = {}) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value.id) return labels[value.id] || value.id;
  if (value.amount != null) {
    const unit = value.unit && value.unit !== "1" ? ` ${labels[wikidataEntityIdFromUri(value.unit)] || ""}` : "";
    return `${String(value.amount).replace(/^\+/, "")}${unit}`.trim();
  }
  if (value.time) return value.time.replace(/^\+/, "").replace(/T00:00:00Z$/, "");
  if (value.text) return value.text;
  if (value.latitude != null && value.longitude != null) return `${value.latitude}, ${value.longitude}`;
  return "";
}

function wikidataClaimEntityIds(claims) {
  const ids = new Set();
  const collect = value => {
    if (value?.id) ids.add(value.id);
    const unitId = wikidataEntityIdFromUri(value?.unit);
    if (unitId) ids.add(unitId);
  };
  Object.values(claims || {}).forEach(statements => (statements || []).forEach(statement => {
    collect(statement.mainsnak?.datavalue?.value);
    Object.values(statement.qualifiers || {}).forEach(qualifiers => (qualifiers || []).forEach(snak => collect(snak.datavalue?.value)));
    (statement.references || []).forEach(reference => Object.values(reference.snaks || {}).forEach(snaks => (snaks || []).forEach(snak => collect(snak.datavalue?.value))));
  }));
  return Array.from(ids);
}

function chunkValues(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

async function fetchWikidataEntities(ids, props = "labels|descriptions|claims|sitelinks") {
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  const responses = await Promise.all(chunkValues(uniqueIds, 50).map(async chunk => {
    const query = new URLSearchParams({ action: "wbgetentities", ids: chunk.join("|"), format: "json", props, languages: "en", origin: "*" });
    const response = await fetchWikidataJson(`https://www.wikidata.org/w/api.php?${query.toString()}`);
    return response?.entities || {};
  }));
  return Object.assign({}, ...responses);
}

async function fetchWikidataEntityRecord(providerId) {
  // Try the same Action API URL that the original working detail page used.
  // Keep its literal pipe separators and parameters intact.
  const actionUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(providerId)}&format=json&props=claims|descriptions|labels|sitelinks&sitefilter=enwiki&languages=en&origin=*`;
  try {
    const response = await fetchWikidataJson(actionUrl);
    const entity = response?.entities?.[providerId] || response?.entities?.[0];
    if (!entity || entity.missing !== undefined) throw new Error("Wikidata item not found");
    return entity;
  } catch (apiError) {
    const fallbackUrl = `https://www.wikidata.org/wiki/Special:EntityData/${encodeURIComponent(providerId)}.json`;
    try {
      const response = await fetchWikidataJson(fallbackUrl, { headers: { Accept: "application/json" } });
      const entity = response?.entities?.[providerId] || response?.entities?.[0];
      if (!entity || entity.missing !== undefined) throw new Error("Wikidata entity export contained no record");
      console.warn("Wikidata Action API failed; loaded the entity JSON export instead", apiError);
      return entity;
    } catch (exportError) {
      const restUrl = `https://www.wikidata.org/w/rest.php/wikibase/v0/entities/items/${encodeURIComponent(providerId)}`;
      try {
        const entity = wikidataRestEntityToActionEntity(await fetchWikidataJson(restUrl, { headers: { Accept: "application/json" } }));
        if (!entity?.id || !entity.claims) throw new Error("Wikidata REST API returned no item record");
        console.warn("Wikidata Action API and entity export failed; loaded the REST API record", { apiError, exportError });
        return entity;
      } catch (restError) {
        throw new Error(`Wikidata Action API: ${apiError?.message || "request failed"}; entity export: ${exportError?.message || "request failed"}; REST API: ${restError?.message || "request failed"}`);
      }
    }
  }
}

function wikidataRestEntityToActionEntity(restEntity) {
  const fingerprints = (values, aliases = false) => Object.fromEntries(Object.entries(values || {}).map(([language, value]) => [
    language,
    aliases
      ? (value || []).map(alias => ({ language, value: typeof alias === "string" ? alias : alias.value || "" }))
      : { language, value: typeof value === "string" ? value : value?.value || "" }
  ]));
  const normalizeContent = (content, dataType) => {
    if ((dataType === "wikibase-item" || dataType === "wikibase-property" || dataType === "wikibase-lexeme" || dataType === "wikibase-form" || dataType === "wikibase-sense") && typeof content === "string") {
      const match = content.match(/^([QLP]d+)$/);
      if (match) return { id: match[1], "entity-type": match[1][0] === "Q" ? "item" : match[1][0] === "P" ? "property" : "lexeme", "numeric-id": Number(match[1].slice(1)) };
    }
    return content;
  };
  const normalizeSnak = pair => {
    const property = pair?.property?.id || pair?.property || "";
    const dataType = pair?.property?.data_type || pair?.property?.datatype || "string";
    const value = pair?.value || {};
    return {
      snaktype: value.type || "somevalue",
      property,
      datatype: dataType,
      ...(value.type === "value" ? { datavalue: { value: normalizeContent(value.content, dataType), type: dataType } } : {})
    };
  };
  const groupSnaks = pairs => (pairs || []).reduce((groups, pair) => {
    const snak = normalizeSnak(pair);
    if (snak.property) (groups[snak.property] ||= []).push(snak);
    return groups;
  }, {});
  const claims = Object.fromEntries(Object.entries(restEntity?.statements || {}).map(([propertyId, statements]) => [
    propertyId,
    (statements || []).map(statement => {
      const property = statement.property || {};
      const main = normalizeSnak({ property: { id: property.id || propertyId, data_type: property.data_type }, value: statement.value });
      return {
        id: statement.id,
        type: "statement",
        rank: statement.rank || "normal",
        mainsnak: main,
        qualifiers: groupSnaks(statement.qualifiers),
        references: (statement.references || []).map(reference => ({ hash: reference.hash, snaks: groupSnaks(reference.parts) }))
      };
    })
  ]));
  return {
    ...restEntity,
    labels: fingerprints(restEntity?.labels),
    descriptions: fingerprints(restEntity?.descriptions),
    aliases: fingerprints(restEntity?.aliases, true),
    claims
  };
}

async function fetchWikidataJson(url, init = {}) {
  // Route browser requests through the local proxy so Wikidata's API response
  // is not blocked by the file:// origin or browser CORS policy.
  const directFetch = window.cuemarkNativeFetch || fetch.bind(window);
  if (window.location?.origin && window.location.origin !== "null") {
    const proxyUrl = new URL("/proxy", window.location.origin);
    proxyUrl.searchParams.set("url", url);
    const proxyResponse = await directFetch(proxyUrl.toString(), init);
    if (proxyResponse.ok) return parseDetailResponse(proxyResponse);
  }
  const response = await directFetch(url, init);
  return parseDetailResponse(response);
}

async function fetchWikidataSuggestions(providerId) {
  if (!/^Q\d+$/.test(String(providerId))) return [];
  const cacheKey = `cuemark:wikidata:suggestions:${providerId}`;
  try {
    const cached = JSON.parse(sessionStorage.getItem(cacheKey) || "null");
    if (cached && Date.now() - Number(cached.fetchedAt || 0) < 24 * 60 * 60 * 1000) return cached.items || [];
  } catch {}
  const sparql = `SELECT ?item ?itemLabel ?itemDescription ?image (COUNT(DISTINCT ?genre) AS ?sharedGenres) WHERE {
    wd:${providerId} wdt:P136 ?genre.
    ?item wdt:P31 wd:Q11424; wdt:P136 ?genre.
    FILTER(?item != wd:${providerId})
    OPTIONAL { ?item wdt:P18 ?image. }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
  } GROUP BY ?item ?itemLabel ?itemDescription ?image ORDER BY DESC(?sharedGenres) LIMIT 20`;
  const params = new URLSearchParams({ query: sparql, format: "json" });
  const response = await fetchWikidataJson(`https://query.wikidata.org/sparql?${params.toString()}`, { headers: { Accept: "application/sparql-results+json" } });
  const items = (response?.results?.bindings || []).map(binding => {
    const id = binding.item?.value?.match(/(Q\d+)$/)?.[1] || "";
    const imageUrl = binding.image?.value || "";
    const imageFile = imageUrl.split("/Special:FilePath/")[1] || "";
    return {
      id,
      label: binding.itemLabel?.value || id,
      description: binding.itemDescription?.value || "",
      thumbnail: imageFile ? decodeURIComponent(imageFile.split("?")[0]) : "",
      sharedGenres: Number(binding.sharedGenres?.value) || 0
    };
  }).filter(item => item.id);
  try { sessionStorage.setItem(cacheKey, JSON.stringify({ items, fetchedAt: Date.now() })); } catch {}
  return items;
}

async function fetchWikidataFullData(providerId, existingItem = null, onCore = null) {
  const entity = await fetchWikidataEntityRecord(providerId);
  if (onCore) onCore(entity);
  const claims = entity.claims || {};
  const linkedIds = wikidataClaimEntityIds(claims);
  const detailPropertyIds = Object.values(claims).flatMap(statements => (statements || []).flatMap(statement => [
    ...Object.keys(statement.qualifiers || {}),
    ...(statement.references || []).flatMap(reference => Object.keys(reference.snaks || {}))
  ]));
  const propertyIds = Array.from(new Set([...Object.keys(claims), ...detailPropertyIds]));
  const wikiTitle = entity.sitelinks?.enwiki?.title || "";
  const wikipediaPromise = wikiTitle
    ? fetchJsonPortable(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(wikiTitle)}`).catch(err => {
        console.warn("Could not load Wikipedia summary", err);
        return null;
      })
    : Promise.resolve(null);
  const [linkedResult, propertyResult, wikipediaResult] = await Promise.allSettled([
    fetchWikidataEntities(linkedIds),
    fetchWikidataEntities(propertyIds, "labels"),
    wikipediaPromise
  ]);
  const linkedEntities = linkedResult.status === "fulfilled" ? linkedResult.value : {};
  const propertyEntities = propertyResult.status === "fulfilled" ? propertyResult.value : {};
  if (linkedResult.status === "rejected") console.warn("Could not load linked Wikidata labels; displaying item IDs instead", linkedResult.reason);
  if (propertyResult.status === "rejected") console.warn("Could not load Wikidata property labels; using built-in labels instead", propertyResult.reason);
  const entityLabels = Object.fromEntries(Object.entries(linkedEntities).map(([id, linked]) => [id, linked.labels?.en?.value || linked.descriptions?.en?.value || id]));
  const propertyLabels = Object.fromEntries(Object.entries(propertyEntities).map(([id, property]) => [id, property.labels?.en?.value || WIKIDATA_MOVIE_PROPERTIES[id] || id]));
  const wikidataUrl = `https://www.wikidata.org/wiki/${encodeURIComponent(providerId)}`;
  const wikipedia = wikipediaResult.status === "fulfilled" ? wikipediaResult.value : null;
  const statements = propertyId => wikidataClaimStatements(claims, propertyId);
  const rows = Object.keys(claims).map(propertyId => ({
    id: propertyId,
    label: WIKIDATA_MOVIE_PROPERTIES[propertyId] || propertyLabels[propertyId] || propertyId,
    statements: statements(propertyId).map(statement => {
      const value = statement.mainsnak?.datavalue?.value;
      const qualifiers = Object.fromEntries(Object.entries(statement.qualifiers || {}).map(([key, values]) => [key, values.map(snak => wikidataValueText(snak.datavalue?.value, entityLabels)).filter(Boolean)]));
      const references = (statement.references || []).flatMap(reference => Object.entries(reference.snaks || {}).flatMap(([propertyId, snaks]) => (snaks || []).map(snak => {
        const text = wikidataValueText(snak.datavalue?.value, entityLabels);
        return text ? { label: propertyLabels[propertyId] || propertyId, text } : null;
      }).filter(Boolean)));
      return { value, text: wikidataValueText(value, entityLabels), qualifiers, references };
    }).filter(row => row.text)
  })).filter(row => row.statements.length);
  const genres = wikidataClaimValues(claims, "P136").map(value => ({ id: value.id || "", label: entityLabels[value.id] || value.id || "" })).filter(entry => entry.label);
  const runtimeValue = wikidataClaimValues(claims, "P2047")[0];
  const runtime = runtimeValue?.amount ? Math.round(parseFloat(runtimeValue.amount.replace("+", ""))) : 0;
  const releaseTime = wikidataClaimValues(claims, "P577")[0]?.time || "";
  const releaseYear = releaseTime ? releaseTime.replace(/^\+/, "").slice(0, 4) : "";
  const imageFile = wikidataClaimValues(claims, "P18")[0];
  const thumbnail = imageFile ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(imageFile)}?width=640` : wikipedia?.thumbnail?.source || wikipedia?.originalimage?.source || "";
  const reviewScores = wikidataClaimValues(claims, "P444").map(value => wikidataValueText(value)).filter(Boolean);
  const creditProperties = ["P161", "P57", "P58", "P162", "P86", "P344", "P1040", "P272", "P750"];
  const credits = creditProperties.map(propertyId => ({
    id: propertyId,
    label: WIKIDATA_MOVIE_PROPERTIES[propertyId],
    people: wikidataClaimStatements(claims, propertyId).map(statement => {
      const personId = statement.mainsnak?.datavalue?.value?.id;
      const person = linkedEntities[personId] || {};
      const characterId = statement.qualifiers?.P453?.[0]?.datavalue?.value?.id;
      return {
        id: personId,
        label: person.labels?.en?.value || person.descriptions?.en?.value || personId || "Unknown",
        description: person.descriptions?.en?.value || "",
        image: person.claims?.P18?.[0]?.mainsnak?.datavalue?.value || "",
        character: characterId ? entityLabels[characterId] || characterId : ""
      };
    }).filter(person => person.id)
  })).filter(group => group.people.length);
  const linkedByProperty = propertyIds => propertyIds.flatMap(propertyId => wikidataClaimValues(claims, propertyId).filter(value => value?.id).map(value => ({
    id: value.id, label: entityLabels[value.id] || value.id, relationship: WIKIDATA_MOVIE_PROPERTIES[propertyId] || propertyLabels[propertyId] || propertyId,
    description: linkedEntities[value.id]?.descriptions?.en?.value || "",
    thumbnail: linkedEntities[value.id]?.claims?.P18?.[0]?.mainsnak?.datavalue?.value || ""
  })));
  const related = linkedByProperty(["P179", "P155", "P156", "P361", "P527"]);
  const awards = linkedByProperty(["P166", "P1411"]);
  const mainProperties = new Set([...creditProperties, "P136", "P2047", "P577", "P18", "P856", "P345", "P4947", "P444", "P179", "P155", "P156", "P361", "P527", "P166", "P1411"]);
  const otherClaims = rows.filter(row => !mainProperties.has(row.id));
  const details = { providerId, entity, claims, linkedEntities, entityLabels, propertyLabels, rows, genres, runtime, releaseYear, thumbnail, wikipedia, wikidataUrl, credits, related, awards, reviewScores, suggestions: [], otherClaims, fetchedAt: Date.now() };
  if (existingItem) {
    existingItem.wikidataDetailsCache = details;
    existingItem.summary = wikipedia?.extract || entity.descriptions?.en?.value || existingItem.summary || "";
    existingItem.genres = genres.map(entry => entry.label);
    existingItem.playtime = runtime || existingItem.playtime || 0;
    if (thumbnailsEnabled() && thumbnail) existingItem.thumbnail = thumbnail;
    saveData();
  }
  return details;
}

function renderWikidataDetails(details) {
  const section = document.getElementById("wikidata-extra-section");
  if (!section) return;
  if (!details?.entity) {
    section.style.display = "none";
    section.innerHTML = "";
    return;
  }
  const safe = detailText;
  const externalHref = value => {
    try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? safe(url.href) : ""; }
    catch { return ""; }
  };
  const propertyValues = propertyId => wikidataClaimValues(details.claims, propertyId).map(value => wikidataValueText(value, details.entityLabels)).filter(Boolean);
  const countries = propertyValues("P495");
  const languages = propertyValues("P364");
  const info = [
    ["Wikidata ID", details.providerId], ["Release date", propertyValues("P577").join(", ")],
    ["Runtime", details.runtime ? `${details.runtime} minutes` : ""], ["Genres", details.genres.map(entry => entry.label).join(", ")],
    ["Country of origin", countries.join(", ")], ["Original language", languages.join(", ")],
    ["Review score claims", details.reviewScores.join(" · ")], ["Production budget", propertyValues("P2130").join(" · ")], ["Box office", propertyValues("P2142").join(" · ")],
    ["MPAA rating", propertyValues("P1657").join(", ")]
  ].filter(([, value]) => value);
  const aliases = details.entity.aliases?.en || [];
  const officialSites = propertyValues("P856");
  const imdbIds = propertyValues("P345");
  const tmdbIds = propertyValues("P4947");
  const wikiUrl = details.entity.sitelinks?.enwiki?.url || (details.entity.sitelinks?.enwiki?.title ? `https://en.wikipedia.org/wiki/${encodeURIComponent(details.entity.sitelinks.enwiki.title.replace(/ /g, "_"))}` : "");
  const imageFor = filename => filename ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(filename)}?width=240` : "";
  section.style.display = "block";
  section.innerHTML = `
    <section class="tvmaze-detail-block"><h2>Wikidata record</h2><dl class="tvmaze-info-grid">${info.map(([label,value]) => `<div><dt>${safe(label)}</dt><dd>${safe(value)}</dd></div>`).join("")}</dl><div class="anilist-link-row"><a href="${externalHref(details.wikidataUrl)}" target="_blank" rel="noopener">Open Wikidata item</a>${externalHref(wikiUrl) ? `<a href="${externalHref(wikiUrl)}" target="_blank" rel="noopener">Open Wikipedia article</a>` : ""}${officialSites.map(url => externalHref(url) ? `<a href="${externalHref(url)}" target="_blank" rel="noopener">Official site</a>` : "").join("")}${imdbIds.map(id => `<a href="https://www.imdb.com/title/${safe(id)}/" target="_blank" rel="noopener">IMDb ${safe(id)}</a>`).join("")}${tmdbIds.map(id => `<a href="https://www.themoviedb.org/movie/${safe(id)}" target="_blank" rel="noopener">TMDb ${safe(id)}</a>`).join("")}</div><p class="tvmaze-api-note">Wikidata is a structured knowledge base, not a review service. Review score claims are shown when the item has them.</p></section>
    ${details.credits.map(group => `<section class="tvmaze-detail-block"><h2>${safe(group.label)} <small>${group.people.length}</small></h2><div class="tvmaze-people-grid">${group.people.map(person => `<article class="tvmaze-person-card">${person.image ? `<img src="${safe(imageFor(person.image))}" alt="" loading="lazy">` : `<div class="tvmaze-person-placeholder">${safe(person.label.slice(0,1))}</div>`}<div><strong>${safe(person.label)}</strong><span>${safe(person.character || person.description || group.label)}</span><a class="wikidata-person-link" href="${externalHref(`https://www.wikidata.org/wiki/${person.id}`)}" target="_blank" rel="noopener">Wikidata</a></div></article>`).join("")}</div></section>`).join("")}
    ${details.awards.length ? `<section class="tvmaze-detail-block"><h2>Awards <small>${details.awards.length}</small></h2><div class="anilist-chip-list">${details.awards.map(award => `<span class="anilist-chip">${safe(award.label)} <small>· ${safe(award.relationship)}</small></span>`).join("")}</div></section>` : ""}
    ${details.related.length ? `<section class="tvmaze-detail-block"><h2>Related works <small>${details.related.length}</small></h2><div class="anilist-related-list">${details.related.map(item => `<a href="static/pages/main/show-detail.html?category=${encodeURIComponent(showDetailState.category)}&provider=wikidata&providerId=${encodeURIComponent(item.id)}&title=${encodeURIComponent(item.label)}"><strong>${safe(item.label)}</strong><span>${safe(item.relationship)}${item.description ? ` · ${safe(item.description)}` : ""}</span></a>`).join("")}</div></section>` : ""}
    ${details.suggestions?.length ? `<section class="tvmaze-detail-block"><h2>Similar films by shared genres <small>${details.suggestions.length}</small></h2><div class="show-detail-related-list">${details.suggestions.map(item => `<a class="show-detail-related-card" href="static/pages/main/show-detail.html?category=${encodeURIComponent(showDetailState.category)}&provider=wikidata&providerId=${encodeURIComponent(item.id)}&title=${encodeURIComponent(item.label)}">${thumbnailOrPlaceholder(imageFor(item.thumbnail), "show-detail-related-thumb")}<span>${safe(item.label)}</span><small>${safe([`${item.sharedGenres} shared genres`, item.description].filter(Boolean).join(" · "))}</small></a>`).join("")}</div></section>` : ""}
    ${aliases.length ? `<details class="tvmaze-detail-block"><summary>Alternate titles <small>${aliases.length}</small></summary><div class="tvmaze-alias-list">${aliases.map(alias => `<span>${safe(alias.value)}</span>`).join("")}</div></details>` : ""}
    ${details.rows.length ? `<details class="tvmaze-detail-block"><summary>All Wikidata statements, qualifiers, and sources <small>${details.rows.length} properties</small></summary><div class="wikidata-claims-list">${details.rows.map(row => `<div><strong>${safe(row.label)}</strong><span>${row.statements.map(statement => `${safe(statement.text)}${Object.keys(statement.qualifiers || {}).length ? `<small>${Object.entries(statement.qualifiers).map(([propertyId, values]) => `${safe(details.propertyLabels[propertyId] || WIKIDATA_MOVIE_PROPERTIES[propertyId] || propertyId)}: ${safe(values.join(", "))}`).join(" · ")}</small>` : ""}${statement.references?.length ? `<small>Sources: ${statement.references.map(reference => { const sourceUrl = externalHref(reference.text); return sourceUrl ? `${safe(reference.label)}: <a href="${sourceUrl}" target="_blank" rel="noopener">${safe(reference.text)}</a>` : `${safe(reference.label)}: ${safe(reference.text)}`; }).join(" · ")}</small>` : ""}`).join("<br>")}</span></div>`).join("")}</div></details>` : ""}
    <p class="tvmaze-data-footnote">Loaded ${details.rows.length} Wikidata properties, ${details.credits.reduce((total,group) => total + group.people.length,0)} cast and crew credits, ${details.related.length} related works, and ${details.suggestions?.length || 0} genre-based suggestions.</p>`;
}
