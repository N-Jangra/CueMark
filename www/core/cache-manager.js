// CueMark temporary cache management.
// User data lives in localStorage/backup files and is never touched here.

const CUEMARK_METADATA_CACHE = "cuemark-metadata-v1";
const CUEMARK_IMAGE_CACHE = "cuemark-images-v1";
const CUEMARK_FONT_CACHE = "cuemark-fonts-v1";
const CUEMARK_CACHE_TIMESTAMPS_KEY = "cuemark_metadata_cache_timestamps";
const CUEMARK_METADATA_CACHE_TTL = 6 * 60 * 60 * 1000;
const CUEMARK_IMAGE_CACHE_MAX_ENTRIES = 250;

const nativeFetch = window.fetch.bind(window);
const metadataHosts = [
  "api.tvmaze.com", "wikidata.org", "openlibrary.org", "covers.openlibrary.org",
  "api.jikan.moe", "kitsu.io", "graphql.anilist.co", "api.rawg.io",
  "googleapis.com", "omdbapi.com", "themoviedb.org", "mangadex.org",
  "shikimori.one", "freetogame.com", "wikipedia.org"
];

function cacheUrlString(input) {
  return typeof input === "string" ? input : input?.url || String(input || "");
}

function isMetadataUrl(input) {
  try {
    const url = new URL(cacheUrlString(input));
    return metadataHosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

function isSensitiveUrl(input) {
  try {
    const params = new URL(cacheUrlString(input)).searchParams;
    return ["key", "api_key", "apikey", "apiKey"].some(key => params.has(key));
  } catch {
    return true;
  }
}

function isImageUrl(input) {
  try {
    const url = new URL(cacheUrlString(input));
    return /\.(avif|gif|jpe?g|png|webp)(\?|$)/i.test(url.pathname)
      || /image|thumbnail|cover/i.test(url.pathname);
  } catch {
    return false;
  }
}

function readCacheTimestamps() {
  try {
    return JSON.parse(localStorage.getItem(CUEMARK_CACHE_TIMESTAMPS_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeCacheTimestamps(timestamps) {
  try {
    localStorage.setItem(CUEMARK_CACHE_TIMESTAMPS_KEY, JSON.stringify(timestamps));
  } catch {
    // Cache management must never break the app when storage is unavailable.
  }
}

function cacheTimestampKey(url) {
  return url.slice(0, 500);
}

async function cuemarkCachedFetch(input, init = {}) {
  const method = String(init.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
  const url = cacheUrlString(input);
  const imageRequest = method === "GET" && isImageUrl(url);
  const metadataRequest = method === "GET" && isMetadataUrl(url) && !imageRequest;
  if ((!metadataRequest && !imageRequest) || isSensitiveUrl(url) || !window.caches) {
    return nativeFetch(input, init);
  }

  const cache = await caches.open(imageRequest ? CUEMARK_IMAGE_CACHE : CUEMARK_METADATA_CACHE);
  const request = new Request(url, { method: "GET" });
  const timestamps = readCacheTimestamps();
  const timestampKey = cacheTimestampKey(url);
  const cached = await cache.match(request);
  const cachedAt = Number(timestamps[timestampKey] || 0);

  if (cached && (imageRequest || (cachedAt && Date.now() - cachedAt < CUEMARK_METADATA_CACHE_TTL))) {
    return cached;
  }

  let response = null;
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await nativeFetch(input, init);
      if (response.ok || response.status < 500) break;
    } catch (err) {
      lastError = err;
    }
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
  }
  if (response?.ok && response.type !== "opaque") {
    await cache.put(request, response.clone());
    if (!imageRequest) timestamps[timestampKey] = Date.now();
    writeCacheTimestamps(timestamps);
  }
  if (response?.ok || (response && response.status < 500)) return response;
  if (cached) return cached;
  throw lastError || new Error("Network request failed");
}

// Covers metadata fetches in all current feature files without changing the
// network behavior of local assets, fonts, or user-configured non-metadata URLs.
window.fetch = (input, init) => cuemarkCachedFetch(input, init);

async function clearCueMarkMetadataCache() {
  if (window.caches) await caches.delete(CUEMARK_METADATA_CACHE);
  localStorage.removeItem(CUEMARK_CACHE_TIMESTAMPS_KEY);
}

async function clearCueMarkImageCache() {
  const errors = [];
  if (window.caches) {
    try { await caches.delete(CUEMARK_IMAGE_CACHE); } catch (err) { errors.push(err); }
    try { await caches.delete(CUEMARK_FONT_CACHE); } catch (err) { errors.push(err); }
  }

  const nativeCache = window.Capacitor?.Plugins?.CacheManager;
  if (nativeCache?.clearWebViewCache) {
    try { await nativeCache.clearWebViewCache(); } catch (err) { errors.push(err); }
  }
  // Cache storage is best-effort on Android WebView. Do not make pull-to-
  // refresh fail just because one cache backend is unavailable.
  if (errors.length) console.warn("Some temporary image caches could not be cleared", errors);
}

async function trimCueMarkImageCache(maxEntries = CUEMARK_IMAGE_CACHE_MAX_ENTRIES) {
  if (!window.caches) return;
  if (Number(maxEntries) === 0) return;
  const cache = await caches.open(CUEMARK_IMAGE_CACHE);
  const requests = await cache.keys();
  for (const request of requests.slice(0, Math.max(0, requests.length - maxEntries))) {
    try { await cache.delete(request); } catch (err) { console.warn("Could not trim cached image", err); }
  }
}

async function cuemarkCacheDetails() {
  const stats = await cuemarkCacheStats();
  return { ...stats, maxImageEntries: CUEMARK_IMAGE_CACHE_MAX_ENTRIES };
}

async function clearCueMarkTemporaryCaches() {
  await clearCueMarkMetadataCache();
  await clearCueMarkImageCache();
}

async function cuemarkCacheStats() {
  const result = { metadataEntries: 0, imageEntries: 0, metadataBytes: 0, imageBytes: 0 };
  if (!window.caches) return result;

  const metadata = await caches.open(CUEMARK_METADATA_CACHE);
  const images = await caches.open(CUEMARK_IMAGE_CACHE);
  const measure = async cache => {
    let bytes = 0;
    const keys = await cache.keys();
    for (const key of keys) {
      const response = await cache.match(key);
      const headerSize = Number(response?.headers.get("content-length") || 0);
      bytes += headerSize || (response ? (await response.clone().arrayBuffer()).byteLength : 0);
    }
    return { entries: keys.length, bytes };
  };
  const [metadataStats, imageStats] = await Promise.all([measure(metadata), measure(images)]);
  result.metadataEntries = metadataStats.entries;
  result.metadataBytes = metadataStats.bytes;
  result.imageEntries = imageStats.entries;
  result.imageBytes = imageStats.bytes;
  return result;
}

window.CueMarkCache = {
  clearMetadata: clearCueMarkMetadataCache,
  clearImages: clearCueMarkImageCache,
  clearTemporary: clearCueMarkTemporaryCaches,
  stats: cuemarkCacheStats,
  details: cuemarkCacheDetails,
  trimImages: trimCueMarkImageCache
};
