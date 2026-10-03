// SquashDB navigation module.
// Loaded before app.js; these functions intentionally remain global so the
// existing multi-page HTML files and feature modules keep their API.

function getCurrentPageTab() {
  return document.getElementById("tab-dashboard") ? "tab-dashboard" :
    document.getElementById("tab-timeline") ? "tab-timeline" :
    document.getElementById("tab-discover") ? "tab-discover" :
    document.getElementById("tab-sources") ? "tab-sources" :
    document.getElementById("tab-explore") ? "tab-explore" :
    document.getElementById("tab-stats") ? "tab-stats" :
    document.getElementById("tab-settings") ? "tab-settings" :
    null;
}

function getCurrentPagePath() {
  const pathname = window.location.pathname.replace(/^\/+/, "");
  const filename = pathname.split("/").pop() || "index.html";
  const staticPagesIndex = pathname.indexOf("static/pages/");
  if (staticPagesIndex !== -1) return pathname.slice(staticPagesIndex);
  return normalizeAppPageHref(filename);
}

function getCurrentPagePathWithQuery() {
  return getCurrentPagePath() + window.location.search;
}

function normalizeAppPageHref(href) {
  const value = String(href || "");
  if (!value || value.startsWith("http") || value.startsWith("#")) return value;
  if (value.includes("static/pages/")) return value;
  if (value.includes("/")) {
    const filename = value.split("/").pop();
    return normalizeAppPageHref(filename);
  }
  const mainPages = new Set(["dashboard.html", "discover.html", "explore.html", "sources.html", "source-search.html", "show-detail.html", "timeline.html", "statistics.html"]);
  if (mainPages.has(value)) return `static/pages/main/${value}`;
  if (value === "settings.html" || value.startsWith("manage-")) return `static/pages/settings/${value}`;
  if (["app-info.html", "changelog.html", "logcat.html", "logcat-history.html", "usage-guide.html"].includes(value)) return `static/pages/info/${value}`;
  return value;
}

function getAppPageStack() {
  try {
    const raw = sessionStorage.getItem("squashdb_page_stack");
    const stack = raw ? JSON.parse(raw) : [];
    return Array.isArray(stack) ? stack : [];
  } catch (e) {
    return [];
  }
}

function setAppPageStack(stack) {
  sessionStorage.setItem("squashdb_page_stack", JSON.stringify(stack));
}

function getPageScrollPositions() {
  try {
    const value = JSON.parse(sessionStorage.getItem("squashdb_page_scroll") || "{}");
    return value && typeof value === "object" ? value : {};
  } catch (e) {
    return {};
  }
}

function saveCurrentPageScroll() {
  const main = document.querySelector("main");
  const positions = getPageScrollPositions();
  positions[getCurrentPagePathWithQuery()] = {
    main: main?.scrollTop || 0,
    window: window.scrollY || 0
  };
  sessionStorage.setItem("squashdb_page_scroll", JSON.stringify(positions));
}

function restoreCurrentPageScroll() {
  const saved = getPageScrollPositions()[getCurrentPagePathWithQuery()];
  if (!saved) return;
  const restore = () => {
    const main = document.querySelector("main");
    if (main) main.scrollTop = Number(saved.main) || 0;
    window.scrollTo(0, Number(saved.window) || 0);
  };
  requestAnimationFrame(() => {
    restore();
    setTimeout(restore, 80);
  });
}

function recordCurrentPage() {
  const currentWithQuery = getCurrentPagePathWithQuery();
  const stack = getAppPageStack();
  const last = stack[stack.length - 1] || "";
  // Older builds stored only the filename. Compare both forms while those
  // sessions are being migrated, but store the complete URL from now on so
  // separate detail pages and source-search queries remain distinct.
  if (last !== currentWithQuery && last !== getCurrentPagePath()) {
    stack.push(currentWithQuery);
  } else if (last === getCurrentPagePath() && last !== currentWithQuery) {
    stack[stack.length - 1] = currentWithQuery;
    setAppPageStack(stack);
  }
  if (history.state?.squashdbPage !== currentWithQuery) {
    history.replaceState({ squashdbPage: currentWithQuery }, "", currentWithQuery);
  }
}

function setupAppNavigation() {
  if (history.scrollRestoration) history.scrollRestoration = "manual";
  recordCurrentPage();
  restoreCurrentPageScroll();
  if (document.body.dataset.pageScrollBound !== "true") {
    document.body.dataset.pageScrollBound = "true";
    window.addEventListener("pagehide", saveCurrentPageScroll);
  }

  document.querySelectorAll(".nav-item").forEach(navItem => {
    if (navItem.dataset.boundAppNav === "true") return;
    navItem.dataset.boundAppNav = "true";
    navItem.addEventListener("click", (e) => {
      const href = navItem.getAttribute("href");
      if (!href) return;
      e.preventDefault();
      navigateToAppPage(href);
    });
  });
  // Page links outside the bottom bar (Settings subpages, About pages,
  // metadata sources, and detail links) must also become part of the app
  // stack before the browser performs the normal navigation.
  if (document.body.dataset.internalLinkHistoryBound !== "true") {
    document.body.dataset.internalLinkHistoryBound = "true";
    document.addEventListener("click", event => {
      const link = event.target.closest("a[href]");
      if (!link || link.dataset.tab || link.target === "_blank" || link.hasAttribute("download")) return;
      const href = link.getAttribute("href") || "";
      if (!href || href.startsWith("#") || /^(https?:|mailto:|tel:|data:)/i.test(href)) return;
      saveCurrentPageScroll();
      recordCurrentPage();
    }, true);
  }
  setupSwipeBackGesture();
}

function navigateToAppPage(href) {
  recordCurrentPage();
  window.location.href = normalizeAppPageHref(href);
}

function setupPageBackButtons() {
  document.querySelectorAll(".page-back-btn").forEach(btn => {
    if (btn.dataset.boundBack === "true") return;
    btn.dataset.boundBack = "true";
    btn.addEventListener("click", () => {
      navigateBackWithinApp(btn.getAttribute("data-back-fallback") || "static/pages/settings/settings.html");
    });
  });
}

function navigateBackWithinApp(fallback = "static/pages/settings/settings.html") {
  fallback = normalizeAppPageHref(fallback);
  const stack = getAppPageStack();
  const current = getCurrentPagePathWithQuery();
  const currentPath = getCurrentPagePath();
  if (stack[stack.length - 1] === current || stack[stack.length - 1] === currentPath) stack.pop();
  const previous = stack.pop();
  setAppPageStack(stack);
  animatePredictiveBack(() => {
    if (previous) {
      const [path, query = ""] = String(previous).split("?");
      window.location.href = `${normalizeAppPageHref(path)}${query ? `?${query}` : ""}`;
    } else if (window.history.length > 1) {
      window.history.back();
    } else window.location.href = fallback;
  });
  return true;
}

function animatePredictiveBack(callback) {
  // Full page reloads can flash black in mobile WebViews while composited
  // transforms are active. Keep mobile and reduced-motion back navigation direct.
  const reduce = (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)
    || document.body.classList.contains("reduced-motion")
    || document.documentElement.classList.contains("reduced-motion");
  const mobile = window.matchMedia && window.matchMedia("(max-width: 560px)").matches;
  const container = document.getElementById("app-container");
  if (reduce || mobile || !container) {
    callback();
    return;
  }

  // Mark that the NEXT page load should play the enter animation. Read on the
  // destination page in setupPageEnterAnimation().
  try { sessionStorage.setItem("app-back-enter", "1"); } catch (e) {}

  document.body.classList.add("app-predictive-back");

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    container.removeEventListener("animationend", finish);
    callback();
  };
  // Navigate exactly when the exit animation ends (not a guessed timeout), with
  // a safety fallback so navigation never stalls if animationend doesn't fire.
  container.addEventListener("animationend", finish, { once: true });
  setTimeout(finish, 260);
}

// On a fresh page load, if we just came from a back navigation, play a brief
// enter transition so the new page slides in instead of snapping in after the
// load gap. Called from setupPageBackButtons()/init.
function setupPageEnterAnimation() {
  let cameFromBack = false;
  try {
    cameFromBack = sessionStorage.getItem("app-back-enter") === "1";
    if (cameFromBack) sessionStorage.removeItem("app-back-enter");
  } catch (e) {}
  const reduce = (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)
    || document.body.classList.contains("reduced-motion")
    || document.documentElement.classList.contains("reduced-motion");
  const mobile = window.matchMedia && window.matchMedia("(max-width: 560px)").matches;
  if (!cameFromBack || reduce || mobile) return;
  const container = document.getElementById("app-container");
  if (!container) return;
  document.body.classList.add("app-page-enter");
  container.addEventListener("animationend", () => {
    document.body.classList.remove("app-page-enter");
  }, { once: true });
  setTimeout(() => document.body.classList.remove("app-page-enter"), 400);
}

function setupSwipeBackGesture() {
  if (document.body.dataset.swipeBackBound === "true") return;
  document.body.dataset.swipeBackBound = "true";
  let startX = 0;
  let startY = 0;
  let tracking = false;
  document.addEventListener("touchstart", event => {
    const target = event.target;
    if (target.closest("input, textarea, select, button, a, .modal-overlay")) return;
    const touch = event.touches[0];
    tracking = touch.clientX < 28;
    startX = touch.clientX;
    startY = touch.clientY;
  }, { passive: true });
  document.addEventListener("touchmove", event => {
    if (!tracking) return;
    const touch = event.touches[0];
    const dx = touch.clientX - startX;
    const dy = Math.abs(touch.clientY - startY);
    if (dx > 0 && dy < 80) document.documentElement.style.setProperty("--back-swipe-progress", `${Math.min(1, dx / 120)}`);
  }, { passive: true });
  document.addEventListener("touchend", event => {
    if (!tracking) return;
    tracking = false;
    const dx = event.changedTouches[0].clientX - startX;
    document.documentElement.style.removeProperty("--back-swipe-progress");
    if (dx > 80) navigateBackWithinApp("static/pages/main/dashboard.html");
  }, { passive: true });
}

function closeOpenPopup() {
  // Bottom sheets and dialogs share the modal-overlay/active convention across
  // the settings, metadata, dashboard, and detail pages. Close only the top
  // visible popup so Android Back behaves like the popup's close button.
  const popups = [...document.querySelectorAll(".modal-overlay.active, .modal.active")]
    .filter(popup => getComputedStyle(popup).display !== "none" && getComputedStyle(popup).visibility !== "hidden");
  const popup = popups[popups.length - 1];
  if (!popup) return false;

  const closeButton = popup.querySelector(".modal-close, .modal-close-btn, [data-modal-close]");
  if (closeButton) closeButton.click();
  else popup.classList.remove("active");
  return true;
}

function setupHardwareBackButton() {
  const handler = (e) => {
    if (e) e.preventDefault();
    if (closeOpenPopup()) return;
    navigateBackWithinApp("static/pages/main/dashboard.html");
  };

  if (!document.body || document.body.dataset.boundHardwareBack) return;
  document.body.dataset.boundHardwareBack = "true";
  const capApp = window.Capacitor?.Plugins?.App;
  // Capacitor Android emits App.backButton. Register the legacy document event
  // only for non-Capacitor hosts; registering both makes one press navigate
  // twice and can incorrectly fall through to Dashboard.
  if (!capApp?.addListener) document.addEventListener("backbutton", handler, false);
  if (capApp?.addListener) {
    capApp.addListener("backButton", () => {
    if (closeOpenPopup()) return;
    const current = getCurrentPagePath();
    const stack = getAppPageStack();
      const atRoot = current === "static/pages/main/dashboard.html" && stack.length <= 1;
      if (atRoot) {
        if (capApp.exitApp) capApp.exitApp();
      } else {
        navigateBackWithinApp("static/pages/main/dashboard.html");
      }
    });
  }
}

// Play the enter transition as early as possible (before the unlock-gated
// runAppInit), so a page navigated to via Back slides in on first paint.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", setupPageEnterAnimation, { once: true });
} else {
  setupPageEnterAnimation();
}
