// Compatibility loader for pages that still reference the old controller URL.
// The provider implementations and current controller now live in separate
// files; load them in order so cached/older HTML gets the same implementation.
(function loadShowDetailModules() {
  const currentScript = document.currentScript;
  const scriptDirectory = new URL("./", currentScript?.src || window.location.href);
  const providers = [
    "steam", "howlongtobeat", "howlongtoread", "viz", "jikan", "kitsu", "rawg", "omdb", "tmdb",
    "googlebooks", "mangadex", "tvmaze", "freetogame", "anilist",
    "wikidata", "openlibrary"
  ];
  const version = "providers-20261007-9";
  const loadScript = src => new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Could not load show detail script: ${src}`));
    document.head.appendChild(script);
  });
  providers.reduce((chain, provider) => chain.then(() => loadScript(
    new URL(`show-detail-plugins/${provider}.js?v=${version}`, scriptDirectory).href
  )), Promise.resolve())
    .then(() => loadScript(new URL("show-detail-controller.js?v=controller-5", scriptDirectory).href))
    .catch(error => console.error("Could not load show detail providers", error));
})();
