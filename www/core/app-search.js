// In-memory full-text index for the local watchlist.
// This keeps dashboard searches off repeated full-array string scans while
// remaining compatible with the current multi-page/local-storage data model.
let cueMarkSearchIndex = new Map();

function searchIndexText(item) {
  return [
    item.title, item.notes, item.subtitle, item.description,
    item.category, item.status, item.network, item.provider, item.providerName,
    item.metadataSource, item.source, item.releaseDate, item.premiered,
    item.firstAirDate, item.notes,
    typeof itemSourceName === "function" ? itemSourceName(item) : "",
    item.genre,
    ...(Array.isArray(item.genres) ? item.genres : []),
    ...(Array.isArray(item.tags) ? item.tags : [])
  ].filter(Boolean).join(" ").toLowerCase();
}

function rebuildSearchIndex(items = state.items) {
  cueMarkSearchIndex = new Map();
  (items || []).forEach(item => cueMarkSearchIndex.set(item.id, searchIndexText(item)));
}

function searchIndexMatches(item, query) {
  if (!query) return true;
  const text = cueMarkSearchIndex.get(item.id) || searchIndexText(item);
  return query.split(/\s+/).filter(Boolean).every(term => text.includes(term));
}
