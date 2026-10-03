// Apply the saved appearance before the stylesheet paints a newly opened page.
(() => {
  const root = document.documentElement;
  const speed = { off: 0.001, fast: 0.5, normal: 1, slow: 1.75 };
  try {
    const preferences = JSON.parse(localStorage.getItem("cuemark_prefs") || "{}");
    const theme = localStorage.getItem("cuemark_ui_theme") || preferences.uiTheme || localStorage.getItem("cuemark_theme") || "dark";
    const accent = localStorage.getItem("cuemark_main_color") || preferences.mainColor || "normal";
    root.setAttribute("data-theme", theme);
    root.setAttribute("data-accent", accent);
    root.setAttribute("data-contrast", preferences.highContrast ? "high" : "normal");
    root.setAttribute("data-text-size", preferences.accessibleTextSize || "normal");
    root.classList.toggle("reduced-motion", Boolean(preferences.reducedMotion));
    root.style.setProperty("--anim-speed", speed[preferences.animationSpeed] ?? 1);
    root.style.colorScheme = ["light", "flashbang", "sand", "mint"].includes(theme) ? "light" : "dark";
  } catch (_) {
    root.setAttribute("data-theme", "dark");
    root.setAttribute("data-accent", "normal");
  }
})();
