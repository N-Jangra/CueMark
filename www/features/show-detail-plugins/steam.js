// Steam provider adapter for the shared show detail page.

async function fetchSteamJsonPortable(url) {
  const plugin = window.CapacitorHttp || window.Capacitor?.Plugins?.Http || window.Capacitor?.Plugins?.CapacitorHttp;
  if (plugin?.get) {
    const response = await plugin.get({ url, headers: { Accept: "application/json" } });
    const payload = parseDetailJson(response?.data);
    if (response?.status && response.status >= 400) throw detailHttpError(response.status, payload);
    return payload;
  }
  if (plugin?.request) {
    const response = await plugin.request({ url, method: "GET", headers: { Accept: "application/json" }, responseType: "json" });
    const payload = parseDetailJson(response?.data);
    if (response?.status && response.status >= 400) throw detailHttpError(response.status, payload);
    return payload;
  }
  if (window.location?.protocol !== "file:" && window.location?.origin && window.location.origin !== "null") {
    const proxyUrl = new URL("/proxy", window.location.origin);
    proxyUrl.searchParams.set("url", url);
    const response = await fetch(proxyUrl.toString());
    if (response.ok) return parseDetailResponse(response);
    if (response.status !== 404) await parseDetailResponse(response);
  }
  const response = await fetch(url);
  return parseDetailResponse(response);
}
