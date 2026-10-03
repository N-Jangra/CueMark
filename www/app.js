// SquashDB - App logic

// Feature modules are loaded separately so the large application file does not
// own navigation and backup implementation. The promise is awaited before
// initialization because the legacy multi-page app exposes these functions as
// globals between classic scripts.
function loadAppFeatureModule(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(script);
  });
}

// Feature modules are included as ordinary script tags in each HTML page.
// Static loading works in Android WebViews and CSP-constrained desktop hosts,
// where dynamically injected scripts may be rejected before app initialization.
const appFeatureModulesReady = Promise.resolve();

// Full-page detail screens load their own scripts while this app bootstrap is
// still restoring encrypted/local data. Expose the restore promise so those
// screens never inspect an empty state and redirect back to Dashboard.
window.squashDbAppReady = Promise.resolve();

function nativePlugin(name) {
  return window.Capacitor?.Plugins?.[name] || null;
}

async function updateProgressWidget() {
  const widget = nativePlugin("Widget");
  if (!widget?.update) return;
  const enabled = state.items.filter(item => state.preferences[item.category]);
  await widget.update({
    total: enabled.length,
    completed: enabled.filter(item => item.status === "Completed").length,
    inProgress: enabled.filter(item => ["Playing", "In Progress", "Reading"].includes(item.status)).length
  }).catch(err => console.warn("Could not update progress widget", err));
}

async function handleIncomingShareIntent() {
  const share = nativePlugin("ShareIntent");
  if (!share?.getInitialShare || getCurrentPageTab() !== "tab-dashboard") return;
  try {
    const result = await share.getInitialShare();
    const text = String(result?.text || "").trim();
    if (!text || sessionStorage.getItem(`squashdb_shared_${text}`) === "true") return;
    sessionStorage.setItem(`squashdb_shared_${text}`, "true");
    openModal();
    const titleInput = document.getElementById("entry-title");
    const notesInput = document.getElementById("entry-notes");
    const sharedTitle = text.split("\n")[0].trim();
    if (titleInput) titleInput.value = sharedTitle.slice(0, 200);
    if (notesInput && text.includes("\n")) notesInput.value = text;
    if (state.preferences.metadataMode === "online" && titleInput) {
      setTimeout(() => fetchAndApplyMetadataFromTitle().catch(err => console.warn("Shared metadata lookup failed", err)), 150);
    }
  } catch (err) {
    console.warn("Could not read shared content", err);
  }
}

async function handleNotificationAction() {
  const notifications = nativePlugin("Notifications");
  if (!notifications?.getPendingAction) return;
  try {
    const result = await notifications.getPendingAction();
    if (!result?.action) return;
    const item = state.items.find(entry => entry.id === result.itemId);
    if (result.action === "mark_watched" && item) {
      const episodes = Array.isArray(item.episodesCache) ? item.episodesCache : [];
      const watched = new Set(item.watchedEpisodeIds || []);
      const next = episodes.find(episode => !watched.has(episode.id));
      if (next) {
        watched.add(next.id);
        item.watchedEpisodeIds = Array.from(watched);
        item.episodesDone = item.watchedEpisodeIds.length;
        if (episodes.length && item.episodesDone >= episodes.length) item.status = "Completed";
        saveData();
      } else if (!episodes.length) {
        item.status = "Completed";
        item.completionDate = new Date().toISOString().split("T")[0];
        saveData();
      }
      if (getCurrentPageTab() === "tab-dashboard") renderDashboard();
    }
    if (result.action === "open" && result.actionUrl && getCurrentPageTab() === "tab-dashboard") {
      window.location.href = result.actionUrl;
    }
  } catch (err) {
    console.warn("Could not handle notification action", err);
  }
}

// Icon choices offered when creating a custom tracking category
const CATEGORY_ICON_CHOICES = [
  "list", "star", "bookmark", "heart", "tag", "package", "layers",
  "gamepad-2", "film", "tv", "book-open", "clapperboard", "book",
  "music", "camera", "palette", "shirt", "utensils", "dumbbell", "map"
];

// Default status set used for custom categories
const DEFAULT_CUSTOM_STATUSES = ["Backlog", "In Progress", "On Hold", "Dropped", "Completed"];

// Categories tracked by season/episode (TVmaze-backed) rather than volumes/chapters/playtime
const EPISODE_TRACKED_CATEGORIES = ["series", "kdrama", "cdrama", "anime"];

// Built-in category configuration
const BUILTIN_CATEGORIES = {
  game: {
    label: "Game",
    color: "#10b981",
    icon: "gamepad-2",
    statuses: ["Backlog", "Playing", "On Hold", "Dropped", "Completed"]
  },
  movie: {
    label: "Movie",
    color: "#f43f5e",
    icon: "film",
    statuses: ["Watchlist", "In Progress", "On Hold", "Dropped", "Completed"]
  },
  series: {
    label: "TV Series",
    color: "#8b5cf6",
    icon: "tv",
    statuses: ["Watchlist", "In Progress", "On Hold", "Dropped", "Completed"]
  },
  kdrama: {
    label: "K-Drama",
    color: "#a855f7",
    icon: "tv",
    statuses: ["Watchlist", "In Progress", "On Hold", "Dropped", "Completed"]
  },
  cdrama: {
    label: "C-Drama",
    color: "#22c55e",
    icon: "tv",
    statuses: ["Watchlist", "In Progress", "On Hold", "Dropped", "Completed"]
  },
  manga: {
    label: "Manga",
    color: "#f59e0b",
    icon: "book-open",
    statuses: ["Reading", "On Hold", "Dropped", "Completed", "Plan to Read"]
  },
  anime: {
    label: "Anime",
    color: "#0ea5e9",
    icon: "clapperboard",
    statuses: ["Watchlist", "In Progress", "On Hold", "Dropped", "Completed"]
  },
  novel: {
    label: "Novel",
    color: "#ec4899",
    icon: "book",
    statuses: ["Reading", "On Hold", "Dropped", "Completed", "Plan to Read"]
  }
};

// Palette cycled through when assigning a color to a new custom category
const CUSTOM_CATEGORY_COLORS = ["#14b8a6", "#f97316", "#6366f1", "#eab308", "#06b6d4", "#d946ef", "#84cc16", "#e11d48"];

// Merged map of built-in + user-created categories (rebuilt by rebuildCategories())
let CATEGORIES = { ...BUILTIN_CATEGORIES };

function rebuildCategories() {
  CATEGORIES = { ...BUILTIN_CATEGORIES, ...(state.preferences.customCategories || {}) };
}

function slugifyCategoryName(name) {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  let key = base || "list";
  let suffix = 1;
  while (CATEGORIES[key]) {
    key = `${base || "list"}-${++suffix}`;
  }
  return key;
}

function createCustomCategory({ label, icon, statuses }) {
  const key = slugifyCategoryName(label);
  const color = CUSTOM_CATEGORY_COLORS[Object.keys(state.preferences.customCategories || {}).length % CUSTOM_CATEGORY_COLORS.length];
  if (!state.preferences.customCategories) state.preferences.customCategories = {};
  state.preferences.customCategories[key] = {
    label: label.trim(),
    color,
    icon: icon || "list",
    statuses: (statuses && statuses.length) ? statuses : DEFAULT_CUSTOM_STATUSES,
    custom: true
  };
  rebuildCategories();
  state.preferences[key] = true;
  if (!state.preferences.categoryOrder.includes(key)) {
    state.preferences.categoryOrder.push(key);
  }
  saveData();
  return key;
}

function categoryHasItems(key) {
  return state.items.some(item => item.category === key);
}

function deleteCustomCategory(key) {
  if (!CATEGORIES[key] || !CATEGORIES[key].custom) return { ok: false, reason: "Only custom lists can be deleted." };
  if (categoryHasItems(key)) return { ok: false, reason: "This list still has tracked items. Remove or move them first." };
  delete state.preferences.customCategories[key];
  delete state.preferences[key];
  state.preferences.categoryOrder = state.preferences.categoryOrder.filter(k => k !== key);
  if (state.activeCategoryChip === key) state.activeCategoryChip = null;
  rebuildCategories();
  saveData();
  return { ok: true };
}

// Application State
const persistenceDirtyDomains = new Set(["items", "watchLog", "preferences"]);
const persistedJson = { items: null, watchLog: null, preferences: null };
const persistedItemJson = new Map();
let forceEncryptedItemMigration = false;

function trackStateMutations(root) {
  const proxies = new WeakMap();
  function wrap(value, domain) {
    if (!value || typeof value !== "object") return value;
    if (proxies.has(value)) return proxies.get(value);
    const proxy = new Proxy(value, {
      get(target, property, receiver) {
        const result = Reflect.get(target, property, receiver);
        return wrap(result, target === root ? String(property) : domain);
      },
      set(target, property, next, receiver) {
        const previous = target[property];
        const changed = previous !== next;
        const result = Reflect.set(target, property, next, receiver);
        if (changed) persistenceDirtyDomains.add(target === root ? String(property) : domain);
        return result;
      },
      deleteProperty(target, property) {
        const existed = property in target;
        const result = Reflect.deleteProperty(target, property);
        if (existed) persistenceDirtyDomains.add(target === root ? String(property) : domain);
        return result;
      }
    });
    proxies.set(value, proxy);
    return proxy;
  }
  return wrap(root, "state");
}

let state = {
  items: [],
  watchLog: [],
  preferences: {
    game: false,
    movie: true,
    series: true,
    kdrama: false,
    cdrama: false,
    manga: false,
    anime: true,
    novel: true,
    customCategories: {},
    categoryOrder: ["series", "movie", "anime", "novel", "game", "kdrama", "cdrama", "manga"],
    defaultStartPage: "remember-last",
    dashboardDefaultCategory: "remember-last",
    recentlyAddedLimit: 10,
    dashboardCardCorners: "rounded",
    automaticCompletion: "automatic",
    defaultEntryStatus: "watchlist",
    progressIncrement: 1,
    ratingReminders: false,
    notesTemplate: "none",
    ratingFormat: "5-stars",
    uiTheme: "dark",
    uiFont: "inter",
    mainColor: "normal",
    categoryColors: {},
    highContrast: false,
    reducedMotion: false,
    accessibilityPreset: "standard",
    accessibleTextSize: "normal",
    language: "system",
    dateFormat: "system",
    analyticsEnabled: false,
    sendErrorLogs: false,
    networkOnlyOnWifi: false,
    externalLinks: "ask",
    dashboardRowActions: "menu",
    dashboardView: "list",
    dashboardDensity: "comfortable",
    dashboardShowThumbnails: true,
    dashboardShowRatings: true,
    dashboardShowProgress: true,
    dashboardGroupBy: "status",
    oneHandedMode: "off",
    tabletTwoColumn: true,
    compactMode: false,
    metadataMode: "online",
    metadataThumbnails: true,
    thumbnailSize: "medium",
    thumbnailQuality: "balanced",
    duplicateDetector: true,
    orphanedMetadataCleanup: false,
    importHistory: true,
    exportSelectedOnly: false,
    databaseHealthCheck: false,
    debugMode: false,
    networkTimeout: 30,
    apiRateLimitDelay: 250,
    experimentalFeatures: false,
    episodeReminders: true,
    notificationsEnabled: false,
    notificationEpisodeReminders: true,
    notificationBackupReminders: false,
    notificationSound: true,
    notificationVibration: true,
    reminderDays: 1,
    notificationPerCategory: false,
    notificationGrouping: "grouped",
    notificationCloudFailures: true,
    notificationUnfinishedItems: false,
    notificationSnoozeMinutes: 60,
    notificationQuietHours: false,
    notificationQuietStart: "22:00",
    notificationQuietEnd: "07:00",
    notificationReminderTime: "09:00",
    imageCacheMaxEntries: 250,
    storageWarningLimitMb: 500,
    backupStorageLimitMb: 1000,
    backgroundBackups: false,
    autoLockTimeout: "never",
    lockOnBackground: false,
    biometricFallback: "pin",
    hideSensitiveNotes: false,
    backupSchedule: "daily",
    backupRetention: "10",
    backupBeforeDestructive: true,
    backupPasswordReminder: true,
    backupMaxSizeMb: 1000,
    backupValidateLocation: true,
    backupRestorePreview: true,
    folderSyncDelay: "30000",
    animationSpeed: "normal",
    metadataQueue: [],
    metadataQueuePaused: false,
    metadataImportConcurrency: 5,
    metadataSyncFrequency: "immediate",
    metadataRefreshInterval: "weekly",
    metadataRetryLimit: 3,
    offlineFallback: "cached",
    thumbnailCleanup: "weekly",
    importDefaultCategory: "anime",
    importDuplicatePolicy: "skip",
    exportDefaultFormat: "csv",
    exportIncludeMetadata: true,
    metadataSources: {
      builtinOrder: ["tvmaze", "wikidata", "openlibrary"],
      builtinEnabled: { tvmaze: true, wikidata: true, openlibrary: true },
      custom: []
    },
    navIcons: {
      dashboard: "layout-grid",
      timeline: "calendar",
      discover: "search",
      sources: "database",
      explore: "compass",
      stats: "pie-chart",
      settings: "settings"
    },
    navBar: {
      order: ["dashboard", "timeline", "discover", "sources", "explore", "stats", "settings"],
      visible: { dashboard: true, timeline: false, discover: true, sources: false, explore: true, stats: false, settings: true }
    },
    bottomBarTransparency: 100,
    bottomBarActiveStyle: "box",
    bottomBarSurface: "translucent",
    appLook: "default",
    appLock: {
      method: "none",           // "none" | "pin" | "pattern" | "alphanumeric" | "biometric"
      passwordHash: "",         // hex PBKDF2 hash of the PIN/pattern/password
      passwordSalt: "",         // hex random salt used for passwordHash
      securityQuestions: []     // [{ question, answerHash, answerSalt }, ...] (exactly 3 once set)
    }
  },
  theme: "dark",
  currentTab: "tab-dashboard",
  activeCategoryChip: null,
  statusFilter: "all",
  currentSort: "alphabetical-asc",
  lastEntryCategory: "game",
  searchQuery: "",
  lastEntryStatusByCategory: {},
  searchHistory: [],
  dashboardFilters: { status: "", unwatched: false, recentlyAdded: false, rated: false },
  timelineFilter: "all",
  timelineSearch: "",
  timelineMonth: "",
  timelineYear: "",
  activeRating: 0 // temp rating state for form
};
state = trackStateMutations(state);

function thumbnailsEnabled() {
  return Boolean(state.preferences.metadataThumbnails);
}

function showToast(message, type = "info", duration = 3200) {
  if (!document.body) return;
  let toast = document.getElementById("squashdb-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "squashdb-toast";
    toast.className = "squashdb-toast";
    document.body.appendChild(toast);
  }
  toast.className = `squashdb-toast ${type}`;
  toast.innerHTML = `<i data-lucide="${type === "error" ? "circle-alert" : type === "success" ? "circle-check" : "info"}"></i><span></span>`;
  toast.querySelector("span").textContent = String(message || "");
  toast.classList.add("active");
  if (window.lucide) lucide.createIcons();
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => toast.classList.remove("active"), duration);
}

function setupVisualPolish() {
  if (!window.__squashdbAlertPatched) {
    window.__squashdbAlertPatched = true;
    window.alert = message => showToast(message, "info");
  }
  document.addEventListener("click", event => {
    const target = event.target.closest("button, .btn, .settings-row, .nav-item, .chip, a");
    if (!target || target.disabled || target.closest(".modal-close")) return;
    const haptics = nativePlugin("Haptics");
    if (haptics?.impact) haptics.impact({ style: "light" }).catch(() => {});
    else if (navigator.vibrate) navigator.vibrate(8);
  }, { passive: true });
  document.getElementById("category-colors-picker")?.addEventListener("click", openCategoryColorsPicker);
}

let squashDbNetworkProbeOnline = false;

function squashDbIsOffline() {
  return typeof navigator !== "undefined" && navigator.onLine === false && !squashDbNetworkProbeOnline;
}

function setupOfflineIndicator() {
  let indicator = document.getElementById("squashdb-offline-indicator");
  if (!indicator) {
    indicator = document.createElement("div");
    indicator.id = "squashdb-offline-indicator";
    indicator.className = "squashdb-offline-indicator";
    document.body.appendChild(indicator);
  }
  const update = () => {
    const offline = squashDbIsOffline();
    const queueCount = typeof metadataQueueCount === "function" ? metadataQueueCount() : 0;
    indicator.classList.toggle("active", offline || queueCount > 0);
    indicator.innerHTML = offline
      ? `<i data-lucide="wifi-off"></i><span>Offline mode · saved data is available</span>`
      : queueCount > 0
        ? `<i data-lucide="cloud-sync"></i><span>${queueCount} metadata update${queueCount === 1 ? "" : "s"} queued</span>`
        : "";
    if (window.lucide) lucide.createIcons();
  };
  window.addEventListener("online", update);
  window.addEventListener("online", () => { squashDbNetworkProbeOnline = true; update(); });
  window.addEventListener("offline", () => { squashDbNetworkProbeOnline = false; update(); });
  window.addEventListener("metadata-queue-updated", update);
  update();

  // Android WebView can briefly report a stale navigator.onLine=false during
  // startup. Verify connectivity through the same portable request path used
  // by metadata search before displaying Offline mode.
  if (navigator.onLine === false && typeof fetchJsonPortable === "function") {
    fetchJsonPortable("https://api.tvmaze.com/shows/1")
      .then(() => { squashDbNetworkProbeOnline = true; update(); })
      .catch(() => {});
  }
}

// Every thumbnail slot is compulsory: real image if we have one and thumbnails
// are enabled, otherwise a "not found" placeholder icon — never an empty slot.
function thumbnailOrPlaceholder(thumbnailUrl, className) {
  if (thumbnailsEnabled() && thumbnailUrl) {
    return `<img class="${className}" src="${thumbnailUrl}" alt="" loading="lazy">`;
  }
  return `<span class="${className} thumb-placeholder" title="No thumbnail found"><i data-lucide="image-off"></i></span>`;
}

// Display name of the metadata source an item was tracked from. Items saved
// before the metadataSource field existed only leave a TVmaze id as a clue.
function itemSourceName(item) {
  const key = item.metadataSource || (item.tvmazeShowId ? "tvmaze" : "");
  if (!key) return "";
  return (typeof BUILTIN_METADATA_SOURCES !== "undefined" && BUILTIN_METADATA_SOURCES[key]?.name) || key;
}

// Initialize Application
document.addEventListener("DOMContentLoaded", async () => {
  await appFeatureModulesReady;
  renderDashboardSkeleton();
  window.squashDbAppReady = loadData();
  await window.squashDbAppReady;

  // If a lock method is set and this session hasn't been unlocked yet, block all
  // further rendering until a correct PIN/pattern/password (or a security-question
  // reset) unlocks the session — see applock.js.
  if (guardAppLock()) {
    document.addEventListener("app-unlocked", runAppInit, { once: true });
    return;
  }
  runAppInit();
});

function runAppInit() {
  applyTheme();
  setupEventListeners();
  setupVisualPolish();
  setupAppNavigation();
  setupPageBackButtons();
  setupHardwareBackButton();
  applyNavBarConfig();
  setupPickerModal();
  updateLayoutToggleButtons();
  initializePage();
  updateFabVisibility();
  updateSearchVisibility();
  updateCategoryChipVisibility();
  updateSettingsUI();
  applyNavIcons();
  checkBackupFolderOnStartup();
  renderNavIconPickers();
  renderAppIconPicker();
  lucide.createIcons();
  if (window.SquashDBCache?.trimImages && state.preferences.thumbnailCleanup !== "never") {
    const interval = state.preferences.thumbnailCleanup === "daily" ? 86400000 : 604800000;
    const lastCleanup = Number(localStorage.getItem("squashdb_thumbnail_cleanup_at") || 0);
    if (Date.now() - lastCleanup >= interval) {
      window.SquashDBCache.trimImages(state.preferences.imageCacheMaxEntries).then(() => {
        localStorage.setItem("squashdb_thumbnail_cleanup_at", String(Date.now()));
      }).catch(error => console.warn("Thumbnail cleanup failed", error));
    }
  }
  updateProgressWidget();
  window.dispatchEvent(new Event("squashdb-app-ready"));
  handleIncomingShareIntent();
  handleNotificationAction();
  scheduleUnfinishedItemReminder();
  setupOfflineIndicator();
  setupDashboardPullToRefresh();
}

window.addEventListener("pagehide", flushPendingSave);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushPendingSave();
});

// Load data from LocalStorage
async function loadData() {
  let encryptedState = null;
  let encryptedItems = null;
  let encryptedMeta = null;
  // The readable local mirror is intentionally the fast startup path. On
  // Android it lets the dashboard render immediately instead of waiting for
  // Keystore decryption before any cards can be shown.
  const localItems = localStorage.getItem("squashdb_items");
  const localWatchLog = localStorage.getItem("squashdb_watch_log");
  const localPrefs = localStorage.getItem("squashdb_prefs");
  const encryptedStore = nativePlugin("EncryptedStore");
  const hasLocalMirror = Boolean(localItems || localWatchLog || localPrefs);
  if (encryptedStore?.getItems && !hasLocalMirror) {
    try {
      const result = await encryptedStore.getItems();
      if (result?.exists && result.data) encryptedItems = JSON.parse(result.data);
      if (encryptedStore.getMeta) {
        const metaResult = await encryptedStore.getMeta();
        if (metaResult?.exists && metaResult.data) encryptedMeta = JSON.parse(metaResult.data);
      }
    } catch (err) {
      console.error("Encrypted item database could not be opened", err);
    }
  }
  // Older versions stored one encrypted JSON blob. Read it only when the new
  // item store has no records, then the first save migrates it item by item.
  if (encryptedStore?.getState && !hasLocalMirror && !encryptedItems) {
    try {
      const result = await encryptedStore.getState();
      if (result?.exists && result.data) {
        encryptedState = JSON.parse(result.data);
        forceEncryptedItemMigration = true;
      }
    } catch (err) {
      console.error("Encrypted local database could not be opened", err);
    }
  }

  const savedItems = encryptedItems ? JSON.stringify(encryptedItems)
    : (encryptedState?.items ? JSON.stringify(encryptedState.items) : localItems);
  if (savedItems) {
    try {
      state.items = JSON.parse(savedItems);
    } catch (e) {
      console.error("Error parsing items from local storage", e);
      state.items = [];
    }
  }

  const savedWatchLog = encryptedMeta?.watchLog ? JSON.stringify(encryptedMeta.watchLog)
    : (encryptedState?.watchLog ? JSON.stringify(encryptedState.watchLog) : localWatchLog);
  if (savedWatchLog) {
    try {
      state.watchLog = JSON.parse(savedWatchLog);
    } catch (e) {
      console.error("Error parsing watch log from local storage", e);
      state.watchLog = [];
    }
  }

  const savedPrefs = encryptedMeta?.preferences ? JSON.stringify(encryptedMeta.preferences)
    : (encryptedState?.preferences ? JSON.stringify(encryptedState.preferences) : localPrefs);
  if (savedPrefs) {
    try {
      state.preferences = { ...state.preferences, ...JSON.parse(savedPrefs) };
    } catch (e) {
      console.error("Error parsing preferences", e);
    }
  }
  if (!state.preferences.customCategories || typeof state.preferences.customCategories !== "object") {
    state.preferences.customCategories = {};
  }
  rebuildCategories();

  if (!Array.isArray(state.preferences.categoryOrder) || state.preferences.categoryOrder.length === 0) {
    state.preferences.categoryOrder = ["series", "movie", "anime", "novel", "game", "kdrama", "cdrama", "manga"];
  }
  state.preferences.categoryOrder = state.preferences.categoryOrder.filter(key => CATEGORIES[key]);
  Object.keys(CATEGORIES).forEach(key => {
    if (!state.preferences.categoryOrder.includes(key)) {
      state.preferences.categoryOrder.push(key);
    }
  });
  if (!state.preferences.defaultStartPage) {
    state.preferences.defaultStartPage = "remember-last";
  }
  if (!["default", "fire", "pinklogo", "purple", "capacitor", "calculator", "freeotp", "termux", "controller", "gear"].includes(state.preferences.appLook)) {
    state.preferences.appLook = "default";
  }
  if (state.preferences.dashboardDefaultCategory !== "remember-last"
    && !CATEGORIES[state.preferences.dashboardDefaultCategory]) state.preferences.dashboardDefaultCategory = "remember-last";
  if (![5, 10, 20, 50].includes(Number(state.preferences.recentlyAddedLimit))) state.preferences.recentlyAddedLimit = 10;
  if (!["rounded", "soft", "square"].includes(state.preferences.dashboardCardCorners)) state.preferences.dashboardCardCorners = "rounded";
  if (!["automatic", "ask", "manual"].includes(state.preferences.automaticCompletion)) state.preferences.automaticCompletion = "automatic";
  if (!["watchlist", "in-progress", "on-hold", "dropped", "completed"].includes(state.preferences.defaultEntryStatus)) state.preferences.defaultEntryStatus = "watchlist";
  if (![1, 5, 10].includes(Number(state.preferences.progressIncrement))) state.preferences.progressIncrement = 1;
  if (typeof state.preferences.ratingReminders !== "boolean") state.preferences.ratingReminders = false;
  if (!["none", "review", "journal"].includes(state.preferences.notesTemplate)) state.preferences.notesTemplate = "none";
  if (!state.preferences.ratingFormat) state.preferences.ratingFormat = "5-stars";
  if (!state.preferences.uiTheme) state.preferences.uiTheme = "dark";
  if (!state.preferences.uiFont) state.preferences.uiFont = "inter";
  if (!state.preferences.mainColor) state.preferences.mainColor = "normal";
  if (!state.preferences.categoryColors || typeof state.preferences.categoryColors !== "object") state.preferences.categoryColors = {};
  if (typeof state.preferences.highContrast !== "boolean") state.preferences.highContrast = false;
  if (typeof state.preferences.reducedMotion !== "boolean") state.preferences.reducedMotion = false;
  if (!["standard", "high-contrast", "reduced-motion", "maximum", "custom"].includes(state.preferences.accessibilityPreset)) state.preferences.accessibilityPreset = "standard";
  if (!["normal", "large", "largest"].includes(state.preferences.accessibleTextSize)) state.preferences.accessibleTextSize = "normal";
  if (!["system", "en"].includes(state.preferences.language)) state.preferences.language = "system";
  if (!["system", "short", "long", "iso"].includes(state.preferences.dateFormat)) state.preferences.dateFormat = "system";
  if (typeof state.preferences.analyticsEnabled !== "boolean") state.preferences.analyticsEnabled = false;
  if (typeof state.preferences.sendErrorLogs !== "boolean") state.preferences.sendErrorLogs = false;
  if (typeof state.preferences.networkOnlyOnWifi !== "boolean") state.preferences.networkOnlyOnWifi = false;
  if (!["ask", "always", "never"].includes(state.preferences.externalLinks)) state.preferences.externalLinks = "ask";
  if (!state.preferences.dashboardRowActions) state.preferences.dashboardRowActions = "menu";
  if (!["list", "compact-list", "grid", "compact-grid", "detailed-grid", "table", "minimal-list", "large-grid", "kanban", "timeline"].includes(state.preferences.dashboardView)) state.preferences.dashboardView = "list";
  if (!["comfortable", "compact"].includes(state.preferences.dashboardDensity)) state.preferences.dashboardDensity = "comfortable";
  if (typeof state.preferences.dashboardShowThumbnails !== "boolean") state.preferences.dashboardShowThumbnails = true;
  if (typeof state.preferences.dashboardShowRatings !== "boolean") state.preferences.dashboardShowRatings = true;
  if (typeof state.preferences.dashboardShowProgress !== "boolean") state.preferences.dashboardShowProgress = true;
  if (localStorage.getItem("squashdb_dashboard_status_groups_v2") !== "true") {
    const migratedGrouping = ["none", "category"].includes(state.preferences.dashboardGroupBy);
    if (migratedGrouping) state.preferences.dashboardGroupBy = "status";
    localStorage.setItem("squashdb_dashboard_status_groups_v2", "true");
    if (migratedGrouping) saveData();
  }
  if (!["none", "status", "release"].includes(state.preferences.dashboardGroupBy)) state.preferences.dashboardGroupBy = "status";
  if (!CATEGORIES[state.preferences.importDefaultCategory]) state.preferences.importDefaultCategory = "anime";
  if (!["skip", "update", "create"].includes(state.preferences.importDuplicatePolicy)) state.preferences.importDuplicatePolicy = "skip";
  if (!["csv", "tsv", "txt"].includes(state.preferences.exportDefaultFormat)) state.preferences.exportDefaultFormat = "csv";
  if (typeof state.preferences.exportIncludeMetadata !== "boolean") state.preferences.exportIncludeMetadata = true;
  if (!["off", "left", "right"].includes(state.preferences.oneHandedMode)) state.preferences.oneHandedMode = "off";
  if (typeof state.preferences.tabletTwoColumn !== "boolean") state.preferences.tabletTwoColumn = true;
  if (typeof state.preferences.compactMode !== "boolean") state.preferences.compactMode = false;
  // Online metadata is the default. Migrate the old implicit offline default
  // once, then preserve any explicit choice made afterward.
  if (!state.preferences.metadataMode) state.preferences.metadataMode = "online";
  if (state.preferences.metadataModeDefaultApplied !== true) {
    state.preferences.metadataMode = "online";
    state.preferences.metadataModeDefaultApplied = true;
    saveData();
  }
  if (typeof state.preferences.metadataThumbnails !== "boolean") state.preferences.metadataThumbnails = true;
  if (!["small", "medium", "large"].includes(state.preferences.thumbnailSize)) state.preferences.thumbnailSize = "medium";
  if (!["data-saver", "balanced", "best"].includes(state.preferences.thumbnailQuality)) state.preferences.thumbnailQuality = "balanced";
  if (typeof state.preferences.duplicateDetector !== "boolean") state.preferences.duplicateDetector = true;
  if (typeof state.preferences.orphanedMetadataCleanup !== "boolean") state.preferences.orphanedMetadataCleanup = false;
  if (typeof state.preferences.importHistory !== "boolean") state.preferences.importHistory = true;
  if (typeof state.preferences.exportSelectedOnly !== "boolean") state.preferences.exportSelectedOnly = false;
  if (typeof state.preferences.databaseHealthCheck !== "boolean") state.preferences.databaseHealthCheck = false;
  if (typeof state.preferences.debugMode !== "boolean") state.preferences.debugMode = false;
  if (![10, 30, 60, 120].includes(Number(state.preferences.networkTimeout))) state.preferences.networkTimeout = 30;
  if (![0, 250, 500, 1000].includes(Number(state.preferences.apiRateLimitDelay))) state.preferences.apiRateLimitDelay = 250;
  if (typeof state.preferences.experimentalFeatures !== "boolean") state.preferences.experimentalFeatures = false;
  if (typeof state.preferences.episodeReminders !== "boolean") state.preferences.episodeReminders = true;
  if (typeof state.preferences.notificationsEnabled !== "boolean") state.preferences.notificationsEnabled = false;
  if (typeof state.preferences.notificationEpisodeReminders !== "boolean") state.preferences.notificationEpisodeReminders = state.preferences.episodeReminders;
  if (typeof state.preferences.notificationBackupReminders !== "boolean") state.preferences.notificationBackupReminders = false;
  if (typeof state.preferences.notificationSound !== "boolean") state.preferences.notificationSound = true;
  if (typeof state.preferences.notificationVibration !== "boolean") state.preferences.notificationVibration = true;
  if (![1, 3, 7, 14].includes(Number(state.preferences.reminderDays))) state.preferences.reminderDays = 1;
  if (typeof state.preferences.notificationPerCategory !== "boolean") state.preferences.notificationPerCategory = false;
  if (!["grouped", "separate"].includes(state.preferences.notificationGrouping)) state.preferences.notificationGrouping = "grouped";
  if (typeof state.preferences.notificationCloudFailures !== "boolean") state.preferences.notificationCloudFailures = true;
  if (typeof state.preferences.notificationUnfinishedItems !== "boolean") state.preferences.notificationUnfinishedItems = false;
  if (![60, 180, 1440, 10080, 0].includes(Number(state.preferences.notificationSnoozeMinutes))) state.preferences.notificationSnoozeMinutes = 60;
  if (typeof state.preferences.notificationQuietHours !== "boolean") state.preferences.notificationQuietHours = false;
  if (!/^\d{2}:\d{2}$/.test(state.preferences.notificationQuietStart)) state.preferences.notificationQuietStart = "22:00";
  if (!/^\d{2}:\d{2}$/.test(state.preferences.notificationQuietEnd)) state.preferences.notificationQuietEnd = "07:00";
  if (!/^\d{2}:\d{2}$/.test(state.preferences.notificationReminderTime)) state.preferences.notificationReminderTime = "09:00";
  if (![0, 250, 500, 1000].includes(Number(state.preferences.imageCacheMaxEntries))) state.preferences.imageCacheMaxEntries = 250;
  if (![100, 500, 1000, 5000, 0].includes(Number(state.preferences.storageWarningLimitMb))) state.preferences.storageWarningLimitMb = 500;
  if (![250, 1000, 5000, 0].includes(Number(state.preferences.backupStorageLimitMb))) state.preferences.backupStorageLimitMb = 1000;
  if (!["off", "daily", "weekly"].includes(state.preferences.backupSchedule)) state.preferences.backupSchedule = "daily";
  if (!["3", "10", "30", "0"].includes(String(state.preferences.backupRetention))) state.preferences.backupRetention = "10";
  if (typeof state.preferences.backupBeforeDestructive !== "boolean") state.preferences.backupBeforeDestructive = true;
  if (typeof state.preferences.backupPasswordReminder !== "boolean") state.preferences.backupPasswordReminder = true;
  if (![250, 1000, 5000, 0].includes(Number(state.preferences.backupMaxSizeMb))) state.preferences.backupMaxSizeMb = 1000;
  if (typeof state.preferences.backupValidateLocation !== "boolean") state.preferences.backupValidateLocation = true;
  if (typeof state.preferences.backupRestorePreview !== "boolean") state.preferences.backupRestorePreview = true;
  if (typeof state.preferences.backgroundBackups !== "boolean") state.preferences.backgroundBackups = false;
  if (!["never", "5-minutes", "15-minutes", "1-hour"].includes(state.preferences.autoLockTimeout)) state.preferences.autoLockTimeout = "never";
  if (typeof state.preferences.lockOnBackground !== "boolean") state.preferences.lockOnBackground = false;
  if (!["pin", "password", "none"].includes(state.preferences.biometricFallback)) state.preferences.biometricFallback = "pin";
  if (typeof state.preferences.hideSensitiveNotes !== "boolean") state.preferences.hideSensitiveNotes = false;
  if (!["0", "5000", "10000", "30000", "60000"].includes(String(state.preferences.folderSyncDelay))) {
    state.preferences.folderSyncDelay = "30000";
  }
  if (!["off", "fast", "normal", "slow"].includes(state.preferences.animationSpeed)) {
    state.preferences.animationSpeed = "normal";
  }
  normalizeMetadataSources();
  normalizeAppLock();
  if (!Array.isArray(state.preferences.metadataQueue)) state.preferences.metadataQueue = [];
  if (typeof state.preferences.metadataQueuePaused !== "boolean") state.preferences.metadataQueuePaused = false;
  if (!Number.isFinite(Number(state.preferences.metadataImportConcurrency))) state.preferences.metadataImportConcurrency = 5;
  state.preferences.metadataImportConcurrency = Math.max(1, Math.min(10, Math.round(Number(state.preferences.metadataImportConcurrency))));
  if (!["immediate", "five-minutes", "fifteen-minutes"].includes(state.preferences.metadataSyncFrequency)) state.preferences.metadataSyncFrequency = "immediate";
  if (!["never", "daily", "weekly"].includes(state.preferences.metadataRefreshInterval)) state.preferences.metadataRefreshInterval = "weekly";
  if (![1, 3, 5].includes(Number(state.preferences.metadataRetryLimit))) state.preferences.metadataRetryLimit = 3;
  if (!["cached", "manual", "strict"].includes(state.preferences.offlineFallback)) state.preferences.offlineFallback = "cached";
  if (!["never", "daily", "weekly"].includes(state.preferences.thumbnailCleanup)) state.preferences.thumbnailCleanup = "weekly";
  if (!state.preferences.navIcons || typeof state.preferences.navIcons !== "object") {
    state.preferences.navIcons = { dashboard: "layout-grid", timeline: "calendar", discover: "search", sources: "database", explore: "compass", stats: "pie-chart", settings: "settings" };
  }
  state.preferences.navIcons = {
    dashboard: state.preferences.navIcons.dashboard || "layout-grid",
    timeline: state.preferences.navIcons.timeline || "calendar",
    discover: state.preferences.navIcons.discover || "search",
    sources: state.preferences.navIcons.sources || "database",
    explore: state.preferences.navIcons.explore || "compass",
    stats: state.preferences.navIcons.stats || "pie-chart",
    settings: state.preferences.navIcons.settings || "settings"
  };

  // Bottom bar arrangement: every destination can be enabled independently.
  // Dashboard and Settings can never be hidden.
  const navBarDefaults = { dashboard: true, timeline: false, discover: true, sources: false, explore: true, stats: false, settings: true };
  if (!state.preferences.navBar || typeof state.preferences.navBar !== "object") {
    state.preferences.navBar = { order: [...NAV_BAR_KEYS], visible: { ...navBarDefaults } };
  }
  if (!Array.isArray(state.preferences.navBar.order)) state.preferences.navBar.order = [...NAV_BAR_KEYS];
  state.preferences.navBar.order = state.preferences.navBar.order.filter(key => NAV_BAR_KEYS.includes(key));
  NAV_BAR_KEYS.forEach(key => {
    if (!state.preferences.navBar.order.includes(key)) state.preferences.navBar.order.push(key);
  });
  if (!state.preferences.navBar.visible || typeof state.preferences.navBar.visible !== "object") {
    state.preferences.navBar.visible = { ...navBarDefaults };
  }
  NAV_BAR_KEYS.forEach(key => {
    if (typeof state.preferences.navBar.visible[key] !== "boolean") {
      state.preferences.navBar.visible[key] = navBarDefaults[key];
    }
  });
  state.preferences.navBar.visible.dashboard = true;
  state.preferences.navBar.visible.settings = true;

  const savedTheme = localStorage.getItem("squashdb_theme");
  if (savedTheme) {
    state.theme = savedTheme;
  }
  state.theme = state.preferences.uiTheme || state.theme;
  state.preferences.uiTheme = localStorage.getItem("squashdb_ui_theme") || state.preferences.uiTheme;
  state.preferences.mainColor = localStorage.getItem("squashdb_main_color") || state.preferences.mainColor;
  state.preferences.ratingFormat = localStorage.getItem("squashdb_rating_format") || state.preferences.ratingFormat;
  applyPreferenceAttributes();

  const savedSort = localStorage.getItem("squashdb_sort");
  if (savedSort) {
    state.currentSort = savedSort;
  }

  try {
    const savedHistory = JSON.parse(localStorage.getItem("squashdb_search_history") || "[]");
    state.searchHistory = Array.isArray(savedHistory) ? savedHistory.filter(Boolean).slice(0, 8) : [];
  } catch (err) {
    state.searchHistory = [];
  }
  try {
    const savedDashboardFilters = JSON.parse(localStorage.getItem("squashdb_dashboard_filters") || "{}");
    state.dashboardFilters = {
      ...state.dashboardFilters,
      ...(savedDashboardFilters && typeof savedDashboardFilters === "object" ? savedDashboardFilters : {})
    };
  } catch (err) {
    state.dashboardFilters = { status: "", unwatched: false, recentlyAdded: false, rated: false };
  }
  state.dashboardFilters.status = ["", "in-progress", "completed"].includes(state.dashboardFilters.status)
    ? state.dashboardFilters.status : "";
  ["unwatched", "recentlyAdded", "rated"].forEach(key => {
    state.dashboardFilters[key] = Boolean(state.dashboardFilters[key]);
  });

  const savedChip = localStorage.getItem("squashdb_category_chip");
  if (savedChip) {
    state.activeCategoryChip = savedChip;
  }

  const savedTimelineFilter = localStorage.getItem("squashdb_timeline_filter");
  if (savedTimelineFilter) {
    state.timelineFilter = savedTimelineFilter;
  }
  if (state.timelineFilter === "today") {
    state.timelineFilter = "all";
  }

  const savedLastCategory = localStorage.getItem("squashdb_last_entry_category");
  if (savedLastCategory) {
    state.lastEntryCategory = savedLastCategory;
  }
  try {
    const savedStatuses = JSON.parse(localStorage.getItem("squashdb_last_entry_statuses") || "{}");
    if (savedStatuses && typeof savedStatuses === "object") state.lastEntryStatusByCategory = savedStatuses;
  } catch (err) {
    state.lastEntryStatusByCategory = {};
  }

  const savedLastTab = localStorage.getItem("squashdb_last_tab");
  if (savedLastTab && document.querySelector(`.nav-item[data-tab="${savedLastTab}"]`)) {
    state.currentTab = savedLastTab;
  } else if (state.preferences.defaultStartPage && state.preferences.defaultStartPage !== "remember-last") {
    state.currentTab = state.preferences.defaultStartPage;
  }

  if (!state.activeCategoryChip) {
    const preferred = state.preferences.dashboardDefaultCategory;
    state.activeCategoryChip = preferred !== "remember-last" && state.preferences[preferred]
      ? preferred : getOrderedCategories().find(key => state.preferences[key]) || "series";
  }

  rebuildSearchIndex();

  // Migrate existing records into Android Keystore-backed item storage once.
  // This also covers data created in the browser before the Android app was
  // installed. The readable mirror is intentionally retained for fast startup.
  const needsItemMigration = encryptedStore?.setItem
    && (forceEncryptedItemMigration || (!encryptedState && !encryptedItems))
    && (savedItems || savedWatchLog || savedPrefs)
    && localStorage.getItem("squashdb_encrypted_items_migrated") !== "1";
  if (needsItemMigration) {
    try {
      await Promise.all(state.items.map(item => encryptedStore.setItem({
        id: String(item.id), data: JSON.stringify(item)
      })));
      if (encryptedStore.setMeta) {
        await encryptedStore.setMeta({
          data: JSON.stringify({ watchLog: state.watchLog || [], preferences: state.preferences })
        });
      }
      if (encryptedStore.clearLegacyState) await encryptedStore.clearLegacyState();
      localStorage.setItem("squashdb_encrypted_items_migrated", "1");
      forceEncryptedItemMigration = false;
    } catch (err) {
      console.warn("Could not migrate local data into encrypted storage", err);
    }
  }

  // Keep older completed records internally consistent as well as visually
  // complete. This also repairs imported records after their metadata arrives.
  let completedProgressChanged = false;
  state.items.forEach(item => {
    if (item?.status !== "Completed") return;
    const before = [item.completionDate, item.episodesDone, item.volumesRead, item.chaptersRead, item.watchedEpisodeIds?.length].join("|");
    markItemAsCompleted(item);
    const after = [item.completionDate, item.episodesDone, item.volumesRead, item.chaptersRead, item.watchedEpisodeIds?.length].join("|");
    if (before !== after) completedProgressChanged = true;
  });
  if (completedProgressChanged) saveData();

  // Keep a readable JSON mirror for browser/local-storage users and backup
  // tools. Android still uses the encrypted store as the primary source, but
  // it must not delete the mirror because it contains item metadata and any
  // locally embedded thumbnail data URLs.
  if (encryptedState) {
    localStorage.setItem("squashdb_items", JSON.stringify(state.items));
    localStorage.setItem("squashdb_watch_log", JSON.stringify(state.watchLog || []));
    localStorage.setItem("squashdb_prefs", JSON.stringify(state.preferences));
  }
  if (encryptedItems) {
    // The item-level store is already current; use the readable mirror for
    // fast subsequent WebView starts and never run the migration again.
    localStorage.setItem("squashdb_items", JSON.stringify(state.items));
    localStorage.setItem("squashdb_watch_log", JSON.stringify(state.watchLog || []));
    localStorage.setItem("squashdb_prefs", JSON.stringify(state.preferences));
    localStorage.setItem("squashdb_encrypted_items_migrated", "1");
  }

  // Seed the in-memory comparison cache without serializing the complete
  // collection again during the first save on every page.
  state.items.forEach(item => {
    if (item?.id != null) persistedItemJson.set(String(item.id), JSON.stringify(item));
  });
  persistedJson.watchLog = JSON.stringify(state.watchLog || []);
  persistedJson.preferences = JSON.stringify(state.preferences);

}

function initializePage() {
  const pageTab = getCurrentPageTab();

  if (pageTab) {
    state.currentTab = pageTab;
    renderCategoryChips();
    renderCategorySelectOptions();
    switchTab(pageTab);
    if (pageTab === "tab-dashboard") {
      renderDashboard();
    }
  }

  // Standalone manage pages and shared page widgets
  renderTrackingChoicesSettings();
  renderCategoryOrderSettings();
  renderMetadataSourcesSettings();
  renderNavBarSettings();
  renderCategorySelectOptions();
  updateSettingsUI();
  updateBackupFolderStatusUI();
  lucide.createIcons();
}

// Save data to LocalStorage
let saveTimer = null;
let saveQueued = false;
let dashboardDataVersion = 0;

function flushPendingSave() {
  if (!saveQueued) return;
  saveQueued = false;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (persistenceDirtyDomains.has("items") || !persistedJson.items) {
    persistedJson.items = JSON.stringify(state.items);
    localStorage.setItem("squashdb_items", persistedJson.items);
  }
  if (persistenceDirtyDomains.has("watchLog") || !persistedJson.watchLog) {
    persistedJson.watchLog = JSON.stringify(state.watchLog || []);
    localStorage.setItem("squashdb_watch_log", persistedJson.watchLog);
  }
  if (persistenceDirtyDomains.has("preferences") || !persistedJson.preferences) {
    persistedJson.preferences = JSON.stringify(state.preferences);
    localStorage.setItem("squashdb_prefs", persistedJson.preferences);
  }
  localStorage.setItem("squashdb_theme", state.theme);
  localStorage.setItem("squashdb_sort", state.currentSort);
  localStorage.setItem("squashdb_search_history", JSON.stringify(state.searchHistory || []));
  localStorage.setItem("squashdb_dashboard_filters", JSON.stringify(state.dashboardFilters || {}));
  localStorage.setItem("squashdb_category_chip", state.activeCategoryChip);
  localStorage.setItem("squashdb_timeline_filter", state.timelineFilter);
  localStorage.setItem("squashdb_last_entry_category", state.lastEntryCategory);
  localStorage.setItem("squashdb_last_entry_statuses", JSON.stringify(state.lastEntryStatusByCategory || {}));
  localStorage.setItem("squashdb_ui_theme", state.preferences.uiTheme);
  localStorage.setItem("squashdb_main_color", state.preferences.mainColor);
  localStorage.setItem("squashdb_rating_format", state.preferences.ratingFormat);
  rebuildSearchIndex();
  const encryptedStore = nativePlugin("EncryptedStore");
  if (encryptedStore?.setItem) {
    const writes = [];
    if (persistenceDirtyDomains.has("items") || forceEncryptedItemMigration) {
      const currentIds = new Set();
      state.items.forEach(item => {
        if (item?.id == null) return;
        const id = String(item.id);
        const itemJson = JSON.stringify(item);
        currentIds.add(id);
        if (forceEncryptedItemMigration || persistedItemJson.get(id) !== itemJson) {
          writes.push(encryptedStore.setItem({ id, data: itemJson }));
          persistedItemJson.set(id, itemJson);
        }
      });
      persistedItemJson.forEach((itemJson, id) => {
        if (!currentIds.has(id) && encryptedStore.deleteItem) {
          writes.push(encryptedStore.deleteItem({ id }));
          persistedItemJson.delete(id);
        }
      });
      forceEncryptedItemMigration = false;
    }
    if (persistenceDirtyDomains.has("watchLog") || persistenceDirtyDomains.has("preferences")) {
      if (encryptedStore.setMeta) {
        writes.push(encryptedStore.setMeta({
          data: `{"watchLog":${persistedJson.watchLog},"preferences":${persistedJson.preferences}}`
        }));
      }
    }
    Promise.all(writes).catch(err => console.warn("Encrypted local database save failed", err));
  } else if (encryptedStore?.setState) {
    // Compatibility path for an older native plugin that has not yet been
    // replaced. New Android builds never take this full-state path.
    encryptedStore.setState({
      data: `{"items":${persistedJson.items},"watchLog":${persistedJson.watchLog},"preferences":${persistedJson.preferences}}`
    }).catch(err => console.warn("Encrypted local database save failed", err));
  }
  persistenceDirtyDomains.clear();
  applyPreferenceAttributes();
  updateProgressWidget();
}

function saveData() {
  dashboardDataVersion += 1;
  saveQueued = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushPendingSave, 120);
  scheduleFolderTreeAutoSync();
}

function normalizeSeasonEpisodes(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  Object.keys(raw).forEach(key => {
    const value = raw[key];
    if (value && typeof value === "object") {
      out[key] = {
        total: Math.max(0, parseInt(value.total) || 0),
        watched: Math.max(0, parseInt(value.watched) || 0),
        completed: Boolean(value.completed)
      };
      return;
    }
    const n = parseInt(value);
    if (!Number.isNaN(n) && n >= 0) {
      out[key] = { total: n, watched: n, completed: true };
    }
  });
  return out;
}

function getSeasonTotalEpisodes(item) {
  const seasonEpisodes = normalizeSeasonEpisodes(item.seasonEpisodes);
  return Object.values(seasonEpisodes).reduce((sum, season) => sum + (parseInt(season.total) || 0), 0);
}

function getSeasonWatchedEpisodes(item) {
  const seasonEpisodes = normalizeSeasonEpisodes(item.seasonEpisodes);
  return Object.values(seasonEpisodes).reduce((sum, season) => {
    const total = parseInt(season.total) || 0;
    const watched = season.completed ? total : (parseInt(season.watched) || 0);
    return sum + Math.min(total, watched);
  }, 0);
}

function getOrderedCategories() {
  return state.preferences.categoryOrder.filter(key => CATEGORIES[key]);
}

function getEnabledOrderedCategories() {
  return getOrderedCategories().filter(key => state.preferences[key]);
}

function saveCategoryOrder(newEnabledOrder) {
  const disabled = getOrderedCategories().filter(key => !state.preferences[key]);
  state.preferences.categoryOrder = [...newEnabledOrder.filter(key => CATEGORIES[key]), ...disabled];
  Object.keys(CATEGORIES).forEach(key => {
    if (!state.preferences.categoryOrder.includes(key)) {
      state.preferences.categoryOrder.push(key);
    }
  });
  saveData();
  renderCategoryChips();
  renderCategorySelectOptions();
  renderStats();
}

// Apply Theme
function applyTheme() {
  const theme = state.preferences.uiTheme || state.theme || "dark";
  document.documentElement.setAttribute("data-theme", theme);
  document.body.setAttribute("data-theme", theme);
}

function applyPreferenceAttributes() {
  const theme = state.preferences.uiTheme || state.theme || "dark";
  const accent = state.preferences.mainColor || "normal";
  document.body.setAttribute("data-theme", theme);
  document.body.setAttribute("data-accent", accent);
  document.body.setAttribute("data-one-handed", state.preferences.oneHandedMode || "off");
  document.body.setAttribute("data-tablet-layout", state.preferences.tabletTwoColumn ? "two-column" : "single-column");
  document.body.setAttribute("data-contrast", state.preferences.highContrast ? "high" : "normal");
  document.body.classList.toggle("reduced-motion", Boolean(state.preferences.reducedMotion));
  const lowEndDevice = Number(navigator.deviceMemory || 0) > 0 && Number(navigator.deviceMemory) <= 2;
  document.body.classList.toggle("low-end-device", lowEndDevice);
  Object.keys(CATEGORIES).forEach(key => {
    CATEGORIES[key].color = state.preferences.categoryColors?.[key]
      || BUILTIN_CATEGORIES[key]?.color
      || CATEGORIES[key].color;
  });
  document.body.classList.toggle("compact-mode", Boolean(state.preferences.compactMode));
  document.body.setAttribute("data-thumbnail-size", state.preferences.thumbnailSize || "medium");
  document.body.setAttribute("data-thumbnail-quality", state.preferences.thumbnailQuality || "balanced");
  document.body.setAttribute("data-text-size", state.preferences.accessibleTextSize || "normal");
  document.body.setAttribute("data-dashboard-corners", state.preferences.dashboardCardCorners || "rounded");
  const bottomBarTransparency = Math.max(0, Math.min(100, Number(state.preferences.bottomBarTransparency ?? 100)));
  document.documentElement.style.setProperty("--bottom-bar-alpha", String(bottomBarTransparency / 100));
  document.body.setAttribute("data-bottom-bar-active-style", state.preferences.bottomBarActiveStyle || "box");
  document.body.setAttribute("data-bottom-bar-surface", state.preferences.bottomBarSurface || "translucent");
  document.documentElement.setAttribute("data-bottom-bar-active-style", state.preferences.bottomBarActiveStyle || "box");
  document.documentElement.lang = state.preferences.language === "en" ? "en" : (navigator.language || "en").split("-")[0];
  document.body.setAttribute("data-date-format", state.preferences.dateFormat || "system");
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  root.setAttribute("data-accent", accent);
  root.setAttribute("data-contrast", state.preferences.highContrast ? "high" : "normal");
  root.setAttribute("data-text-size", state.preferences.accessibleTextSize || "normal");
  root.classList.toggle("reduced-motion", Boolean(state.preferences.reducedMotion));
  root.style.colorScheme = ["light", "flashbang", "sand", "mint"].includes(theme) ? "light" : "dark";
  const appShell = document.getElementById("app-container");
  if (appShell && window.matchMedia("(max-width: 560px)").matches) {
    const hand = state.preferences.oneHandedMode || "off";
    appShell.style.width = hand === "off" ? "" : "calc(100% - 24px)";
    appShell.style.marginLeft = hand === "right" ? "24px" : "";
    appShell.style.marginRight = hand === "left" ? "24px" : "";
  } else if (appShell) {
    appShell.style.width = "";
    appShell.style.marginLeft = "";
    appShell.style.marginRight = "";
  }
  applyAnimationSpeed();
  if (typeof applyUiFont === "function") applyUiFont();
}

function applyAnimationSpeed() {
  const speed = state.preferences.animationSpeed || "normal";
  const lowEndDevice = Number(navigator.deviceMemory || 0) > 0 && Number(navigator.deviceMemory) <= 2;
  const multiplier = state.preferences.reducedMotion || lowEndDevice
    ? 0.001
    : (ANIMATION_SPEED_MULTIPLIERS[speed] ?? 1);
  document.documentElement.style.setProperty("--anim-speed", multiplier);
}

document.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("bottom-bar-transparency");
  const value = document.getElementById("bottom-bar-transparency-value");
  if (!input) return;
  const update = () => {
    const next = Number(input.value);
    if (value) value.textContent = `${next}%`;
    state.preferences.bottomBarTransparency = next;
    applyPreferenceAttributes();
    saveData();
  };
  input.value = String(state.preferences.bottomBarTransparency ?? 100);
  if (value) value.textContent = `${input.value}%`;
  input.addEventListener("input", update);
});

function formatRatingValue(rating) {
  const value = Number(rating) || 0;
  const format = state.preferences.ratingFormat || "5-stars";
  if (format === "10-points") return `${Math.round(value * 2)}/10`;
  if (format === "10-decimal") return `${(value * 2).toFixed(1)}/10`;
  if (format === "100-points") return `${Math.round(value * 20)}/100`;
  return `${value}/5`;
}

function markItemAsCompleted(item) {
  if (!item) return item;
  item.status = "Completed";
  if (!item.completionDate) item.completionDate = new Date().toISOString().split("T")[0];

  if (["series", "kdrama", "cdrama", "anime"].includes(item.category)) {
    const episodes = Array.isArray(item.episodesCache) ? item.episodesCache : [];
    const seasons = normalizeSeasonEpisodes(item.seasonEpisodes);
    const seasonTotal = Object.values(seasons).reduce((sum, season) => sum + (Number(season.total) || 0), 0);
    const total = Math.max(Number(item.totalEpisodes) || 0, seasonTotal, episodes.length);
    if (total > 0) {
      item.totalEpisodes = total;
      item.episodesDone = total;
      if (episodes.length) item.watchedEpisodeIds = episodes.map(episode => episode.id);
      Object.keys(seasons).forEach(key => { seasons[key].watched = seasons[key].total; seasons[key].completed = true; });
      if (Object.keys(seasons).length) item.seasonEpisodes = seasons;
    }
  } else if (["manga", "novel"].includes(item.category)) {
    if (Number(item.totalVolumes) > 0) item.volumesRead = Number(item.totalVolumes);
    if (Number(item.totalChapters) > 0) item.chaptersRead = Number(item.totalChapters);
  }
  return item;
}

function ratingToStoredValue(value) {
  const format = state.preferences.ratingFormat || "5-stars";
  const num = Number(value) || 0;
  if (format === "10-points" || format === "10-decimal") return Math.max(0, Math.min(5, num / 2));
  if (format === "100-points") return Math.max(0, Math.min(5, num / 20));
  return Math.max(0, Math.min(5, num));
}

// Setup Event Listeners
function setupEventListeners() {
  const resetDashboard = document.getElementById("reset-dashboard-preferences");
  if (resetDashboard && resetDashboard.dataset.bound !== "true") {
    resetDashboard.dataset.bound = "true";
    resetDashboard.addEventListener("click", async () => {
      const confirmed = await requestInAppConfirmation("Reset Dashboard preferences?", "This restores the Dashboard layout, grouping, sorting, density, and display options.", "Reset Dashboard");
      if (!confirmed) return;
      Object.assign(state.preferences, {
        dashboardView: "list", dashboardDensity: "comfortable", dashboardGroupBy: "status",
        dashboardShowThumbnails: true, dashboardShowRatings: true, dashboardShowProgress: true
      });
      state.currentSort = "alphabetical-asc";
      state.statusFilter = "all";
      state.dashboardFilters = { status: "", unwatched: false, recentlyAdded: false, rated: false };
      saveData();
      renderDashboard();
      updatePickerRowValues();
      showToast("Dashboard preferences reset", "success");
    });
  }
  // Global Search
  const globalSearch = document.getElementById("global-search");
  if (globalSearch) {
    const clearButton = document.getElementById("dashboard-search-clear");
    if (clearButton) clearButton.hidden = !globalSearch.value;
    let searchRenderTimer = null;
    globalSearch.addEventListener("input", (e) => {
      state.searchQuery = e.target.value.toLowerCase().trim();
      const clearButton = document.getElementById("dashboard-search-clear");
      if (clearButton) clearButton.hidden = !e.target.value;
      if (!e.target.value) renderSearchHistory();
      else {
        const history = document.getElementById("dashboard-search-history");
        if (history) history.style.display = "none";
      }
      clearTimeout(searchRenderTimer);
      searchRenderTimer = setTimeout(() => renderDashboard(), 200);
    });
    globalSearch.addEventListener("focus", renderSearchHistory);
    globalSearch.addEventListener("keydown", (e) => {
      if (e.key === "Enter") recordSearchHistory(globalSearch.value);
      if (e.key === "Escape") {
        globalSearch.value = "";
        state.searchQuery = "";
        renderSearchHistory();
        renderDashboard();
      }
    });
  }

  // Status filter button next to the search box
  const filterBtn = document.getElementById("dashboard-filter-btn");
  if (filterBtn) {
    filterBtn.addEventListener("click", openDashboardRefineSheet);
    updateDashboardFilterButton();
  }
  const clearSearch = document.getElementById("dashboard-search-clear");
  clearSearch?.addEventListener("click", () => {
    if (!globalSearch) return;
    globalSearch.value = "";
    state.searchQuery = "";
    clearSearch.hidden = true;
    renderSearchHistory();
    renderDashboard();
    globalSearch.focus();
  });

  // Floating cross-links between Timeline and Statistics (each page carries
  // a FAB to the other, since only one of the two sits in the bottom bar)
  const statsFab = document.getElementById("stats-fab");
  if (statsFab) {
    statsFab.addEventListener("click", () => {
      recordCurrentPage();
      window.location.href = "static/pages/main/statistics.html";
    });
  }
  const timelineFab = document.getElementById("timeline-fab");
  if (timelineFab) {
    timelineFab.addEventListener("click", () => {
      recordCurrentPage();
      window.location.href = "static/pages/main/timeline.html";
    });
  }

  // Bottom Navigation tabs
  document.querySelectorAll(".nav-item").forEach(btn => {
    btn.addEventListener("click", () => {
      const tabId = btn.getAttribute("data-tab");
      switchTab(tabId);
    });
  });

  // Sort Selector
  const sortSelect = document.getElementById("sort-select");
  if (sortSelect) {
    sortSelect.addEventListener("change", (e) => {
      state.currentSort = e.target.value;
      saveData();
      renderDashboard();
    });
  }

  // Timeline filters
  document.querySelectorAll(".date-filter-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      document.querySelectorAll(".date-filter-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.timelineFilter = btn.getAttribute("data-filter");
      saveData();
      renderTimeline();
    });
  });

  setupTimelineAdvancedFilter();

  // Floating Action Button
  const addFab = document.getElementById("add-fab");
  if (addFab) {
    addFab.addEventListener("click", () => {
      openModal();
    });
  }

  const gridSelectionCancel = document.getElementById("grid-selection-cancel");
  if (gridSelectionCancel) gridSelectionCancel.addEventListener("click", clearGridSelection);

  const gridSelectionDelete = document.getElementById("grid-selection-delete");
  if (gridSelectionDelete) gridSelectionDelete.addEventListener("click", deleteSelectedGridItems);

  // Modal actions
  const modalClose = document.getElementById("modal-close-btn");
  if (modalClose) modalClose.addEventListener("click", closeModal);
  const modalCancel = document.getElementById("modal-cancel-btn");
  if (modalCancel) modalCancel.addEventListener("click", closeModal);
  const itemModal = document.getElementById("item-modal");
  if (itemModal && itemModal.dataset.bound !== "true") {
    itemModal.dataset.bound = "true";
    itemModal.addEventListener("click", (e) => {
      if (e.target === itemModal) closeModal();
    });
  }
  const trackerForm = document.getElementById("tracker-form");
  if (trackerForm) {
    trackerForm.addEventListener("submit", handleFormSubmit);
    trackerForm.addEventListener("input", scheduleFormDraftSave);
    trackerForm.addEventListener("change", scheduleFormDraftSave);
  }
  const scanCodeBtn = document.getElementById("scan-code-btn");
  if (scanCodeBtn) scanCodeBtn.addEventListener("click", scanBarcodeOrQr);

  // Category switch dynamically adjusts fields in modal
  const entryCategory = document.getElementById("entry-category");
  if (entryCategory) {
    entryCategory.addEventListener("change", (e) => {
      state.lastEntryCategory = e.target.value;
      saveData();
      renderDynamicFormFields(e.target.value);
      applyRememberedStatus(e.target.value);
      saveFormDraft();
    });
  }

  // Settings preferences switches
  Object.keys(state.preferences).forEach(cat => {
    const checkbox = document.getElementById(`pref-${cat}`);
    if (checkbox) {
      checkbox.addEventListener("change", (e) => {
        state.preferences[cat] = e.target.checked;
        if (!e.target.checked && state.activeCategoryChip === cat) {
          state.activeCategoryChip = null;
        }
        saveData();
        renderCategoryChips();
        renderCategorySelectOptions();
        renderDashboard();
        renderStats();
      });
    }
  });

  // Backup Export
  const backupExport = document.getElementById("backup-export");
  if (backupExport) backupExport.addEventListener("click", exportData);

  const encryptedExport = document.getElementById("backup-export-encrypted");
  if (encryptedExport) encryptedExport.addEventListener("click", async () => {
    try { await exportEncryptedBackup(); }
    catch (err) { console.warn("Encrypted backup export failed", err); alert(err.message || "Could not create encrypted backup."); }
  });

  // Backup Import
  const importTrigger = document.getElementById("backup-import-trigger");
  const importFileInput = document.getElementById("backup-import-file");
  if (importTrigger && importFileInput) {
    importTrigger.addEventListener("click", () => importFileInput.click());
    importFileInput.addEventListener("change", importData);
  }

  const encryptedImport = document.getElementById("backup-import-encrypted");
  if (encryptedImport && importFileInput) encryptedImport.addEventListener("click", () => importFileInput.click());

  const cloudSave = document.getElementById("cloud-sync-upload");
  const savedCloud = cloudSyncConfig();
  const cloudEndpointInput = document.getElementById("cloud-endpoint");
  const cloudUsernameInput = document.getElementById("cloud-username");
  if (cloudEndpointInput) cloudEndpointInput.value = savedCloud.endpoint;
  if (cloudUsernameInput) cloudUsernameInput.value = savedCloud.username;
  if (cloudSave) cloudSave.addEventListener("click", async () => {
    try { await syncEncryptedBackupToCloud(); }
    catch (err) { console.warn("Cloud upload failed", err); localStorage.setItem("squashdb_cloud_last_sync", "Failed"); sendConfiguredNotification("notificationCloudFailures", "Cloud sync failed", err.message || "Could not upload encrypted backup."); alert(err.message || "Could not upload encrypted backup."); }
  });

  const cloudRestore = document.getElementById("cloud-sync-download");
  if (cloudRestore) cloudRestore.addEventListener("click", async () => {
    try { await restoreEncryptedBackupFromCloud(); }
    catch (err) { console.warn("Cloud download failed", err); localStorage.setItem("squashdb_cloud_last_sync", "Failed"); sendConfiguredNotification("notificationCloudFailures", "Cloud sync failed", err.message || "Could not download encrypted backup."); alert(err.message || "Could not download encrypted backup."); }
  });

  const recoveryRefresh = document.getElementById("backup-recovery-refresh");
  if (recoveryRefresh) {
    recoveryRefresh.addEventListener("click", refreshBackupRecoveryCenter);
    refreshBackupRecoveryCenter();
    updateBackupStorageUsage();
  }
  const healthCheck = document.getElementById("backup-health-check");
  if (healthCheck) healthCheck.addEventListener("click", runBackupHealthCheck);

  // Change Backup Folder
  const chooseFolderBtn = document.getElementById("backup-choose-folder");
  if (chooseFolderBtn) {
    if (backupFolderPluginAvailable()) {
      chooseFolderBtn.addEventListener("click", chooseBackupFolder);
    } else {
      chooseFolderBtn.style.display = "none";
    }
  }

  // Sync to Folder Tree (squash-db/<category>/<item>/index.json + .thumbnail)
  const syncFolderTreeBtn = document.getElementById("backup-sync-folder-tree");
  if (syncFolderTreeBtn) {
    if (backupFolderPluginAvailable()) {
      syncFolderTreeBtn.addEventListener("click", async () => {
        syncFolderTreeBtn.disabled = true;
        try {
          const summary = await syncFolderTreeMirror();
          if (!summary) {
            alert("Sync did not run — no backup folder is selected.");
          } else if (summary.syncErrors.length > 0) {
            alert(
              `Synced ${summary.syncedCount} of ${summary.totalItems} items.\n` +
              `${summary.syncErrors.length} failed:\n` +
              summary.syncErrors.slice(0, 5).join("\n") +
              (summary.syncErrors.length > 5 ? `\n...and ${summary.syncErrors.length - 5} more (see console log)` : "")
            );
          } else {
            alert(`Folder tree synced successfully! (${summary.syncedCount} written, ${summary.skippedUnchangedCount} already up to date)`);
          }
        } catch (err) {
          console.warn("Manual folder tree sync failed", err);
          setBackupProgress("Backup failed", 0, false);
          alert("Could not sync folder tree. Please try again.");
        } finally {
          syncFolderTreeBtn.disabled = false;
        }
      });
    } else {
      syncFolderTreeBtn.style.display = "none";
    }
  }
  // Reset Database
  const dbReset = document.getElementById("db-reset");
  if (dbReset && dbReset.dataset.bound !== "true") {
    dbReset.dataset.bound = "true";
    dbReset.addEventListener("click", async () => {
      const confirmed = await requestInAppConfirmation(
        "Wipe all data?",
        "This permanently removes your tracked entries, watch history, and pending metadata imports.",
        "Wipe data"
      );
      if (confirmed) {
        state.items = [];
        state.watchLog = [];
        if (state.preferences && Array.isArray(state.preferences.metadataQueue)) {
          state.preferences.metadataQueue = [];
          state.preferences.metadataQueuePaused = false;
        }
        saveData();
        renderDashboard();
        renderTimeline();
        renderStats();
        if (typeof showToast === "function") showToast("All SquashDB data has been wiped.", "success");
        if (document.getElementById("notes-container")) {
          switchTab("tab-dashboard");
        } else {
          window.location.href = "static/pages/main/dashboard.html";
        }
      }
    });
  }

  // Temporary cache controls. These never touch localStorage user data or
  // the SAF backup folder; they only remove metadata/cache responses and the
  // Android WebView's HTTP resource cache.
  const cacheControls = [
    ["clear-metadata-cache", "metadata", "Metadata cache cleared."],
    ["clear-image-cache", "images", "Image and font cache cleared."],
    ["clear-all-cache", "temporary", "All temporary cache cleared."]
  ];
  cacheControls.forEach(([id, type, message]) => {
    const button = document.getElementById(id);
    if (!button || !window.SquashDBCache) return;
    button.addEventListener("click", () => openActionPopup(
      button.querySelector("label")?.textContent || "Clear cache",
      `${message} Your tracked items and backups will not be changed.`,
      "Clear now",
      async () => {
        if (type === "metadata") await window.SquashDBCache.clearMetadata();
        else if (type === "images") await window.SquashDBCache.clearImages();
        else await window.SquashDBCache.clearTemporary();
        const status = document.getElementById("metadata-cache-status");
        if (status) status.textContent = "Cleared";
      }
    ));
  });
  const trimImageCache = document.getElementById("trim-image-cache");
  if (trimImageCache && window.SquashDBCache?.trimImages) {
    const imageCacheLimitStatus = document.getElementById("image-cache-limit-status");
    const imageCacheLabel = value => Number(value) === 0 ? "Unlimited" : `${value} images`;
    if (imageCacheLimitStatus) imageCacheLimitStatus.textContent = imageCacheLabel(state.preferences.imageCacheMaxEntries);
    trimImageCache.addEventListener("click", () => openChoicePopup(
      "Limit Image Cache",
      "Choose the maximum number of cached images to keep on this device.",
      [
        { value: 250, label: "250 images" },
        { value: 500, label: "500 images" },
        { value: 1000, label: "1,000 images" },
        { value: 0, label: "Unlimited" }
      ],
      state.preferences.imageCacheMaxEntries,
      async value => {
        state.preferences.imageCacheMaxEntries = Number(value);
        await window.SquashDBCache.trimImages(state.preferences.imageCacheMaxEntries);
        saveData();
        if (imageCacheLimitStatus) imageCacheLimitStatus.textContent = imageCacheLabel(value);
      }
    ));
  }

  const backgroundBackups = document.getElementById("background-backups-toggle");
  const backgroundBackupStatus = document.getElementById("background-backups-status");
  const updateBackgroundBackupStatus = () => {
    if (backgroundBackupStatus) backgroundBackupStatus.textContent = state.preferences.backgroundBackups ? "On" : "Off";
    if (backgroundBackups) {
      backgroundBackups.dataset.toggleOn = state.preferences.backgroundBackups ? "true" : "false";
      backgroundBackups.setAttribute("aria-checked", state.preferences.backgroundBackups ? "true" : "false");
    }
  };
  updateBackgroundBackupStatus();
  if (backgroundBackups) backgroundBackups.addEventListener("click", async () => {
    const value = state.preferences.backgroundBackups ? "off" : "on";
    try {
      const scheduler = nativePlugin("BackupScheduler");
      if (value === "on" && (!scheduler?.schedule || !backupFolderPluginAvailable())) {
        const message = scheduler?.schedule
          ? "Select a backup folder in the Android app first."
          : "Background encrypted backups are available in the Android app after selecting a backup folder.";
        updateBackgroundBackupStatus();
        if (typeof showToast === "function") showToast(message, "error");
        return;
      }
      const previous = state.preferences.backgroundBackups;
      state.preferences.backgroundBackups = value === "on";
      try {
        if (state.preferences.backgroundBackups) await scheduler.schedule();
        else if (scheduler?.cancel) await scheduler.cancel();
        saveData();
        updateBackgroundBackupStatus();
        backgroundBackups.dataset.toggleOn = state.preferences.backgroundBackups ? "true" : "false";
      } catch (err) {
      state.preferences.backgroundBackups = previous;
      updateBackgroundBackupStatus();
      sendConfiguredNotification("notificationBackupReminders", "Backup setup needs attention", err.message || "Encrypted background backup could not be scheduled.");
      throw err;
      }
    } catch (err) {
      console.warn("Background backup toggle failed", err);
      updateBackgroundBackupStatus();
      if (typeof showToast === "function") showToast(err.message || "Background backup could not be enabled.", "error");
    }
  });

  const notificationPermission = document.getElementById("notification-permission");
  const notificationPermissionStatus = document.getElementById("notification-permission-status");
  const updateNotificationStatus = () => {
    if (notificationPermissionStatus) notificationPermissionStatus.textContent = state.preferences.notificationsEnabled ? "On" : "Off";
    if (notificationPermission) {
      notificationPermission.dataset.toggleOn = state.preferences.notificationsEnabled ? "true" : "false";
      notificationPermission.setAttribute("aria-checked", state.preferences.notificationsEnabled ? "true" : "false");
    }
  };
  updateNotificationStatus();
  const refreshNotificationPermission = async () => {
    const notifications = nativePlugin("Notifications");
    if (!notifications?.hasPermission) return;
    try {
      const result = await notifications.hasPermission();
      if (notificationPermissionStatus && !state.preferences.notificationsEnabled) {
        notificationPermissionStatus.textContent = result?.granted ? "Allowed" : "Off";
      }
    } catch (err) {
      console.warn("Could not read notification permission", err);
    }
  };
  refreshNotificationPermission();
  if (notificationPermission) {
    notificationPermission.addEventListener("click", async () => {
      const value = state.preferences.notificationsEnabled ? "off" : "on";
      try {
        if (value === "on") {
          const notifications = nativePlugin("Notifications");
          if (!notifications?.requestPermission) throw new Error("Notifications are available in the installed Android app only.");
          const result = await notifications.requestPermission();
          if (!result?.granted) throw new Error("Please allow notifications in Android settings.");
        }
        state.preferences.notificationsEnabled = value === "on";
        saveData();
        updateNotificationStatus();
        notificationPermission.dataset.toggleOn = state.preferences.notificationsEnabled ? "true" : "false";
      } catch (err) {
        console.warn("Notification toggle failed", err);
      }
    });
  }

  const notificationTest = document.getElementById("notification-test");
  if (notificationTest) {
    notificationTest.addEventListener("click", () => openActionPopup(
      "Test Notification",
      "Send a test notification to confirm Android permission is working.",
      "Send test notification",
      async () => {
      const notifications = nativePlugin("Notifications");
      if (!notifications?.notify) throw new Error("Notifications are available in the installed Android app only.");
      const permission = notifications.hasPermission ? await notifications.hasPermission() : null;
      if (permission && !permission.granted) {
        const requested = await notifications.requestPermission();
        if (!requested?.granted) throw new Error("Please allow notifications in Android settings.");
      }
      await notifications.notify({ title: "SquashDB test", body: "Notifications are working.", id: Date.now() & 0x7fffffff });
    }
    ));
  }

  const notificationToggleRows = [
    ["notification-episode-reminders", "notificationEpisodeReminders", "notification-episode-reminders-status"],
    ["notification-backup-reminders", "notificationBackupReminders", "notification-backup-reminders-status"],
    ["notification-cloud-failures", "notificationCloudFailures", "notification-cloud-failures-status"],
    ["notification-unfinished-items", "notificationUnfinishedItems", "notification-unfinished-items-status"]
  ];
  notificationToggleRows.forEach(([id, key, statusId]) => {
    const row = document.getElementById(id);
    const status = document.getElementById(statusId);
    const update = () => {
      if (status) status.textContent = state.preferences[key] ? "On" : "Off";
      if (row) {
        row.dataset.toggleOn = state.preferences[key] ? "true" : "false";
        row.setAttribute("aria-checked", state.preferences[key] ? "true" : "false");
      }
    };
    update();
    row?.addEventListener("click", () => {
      state.preferences[key] = !state.preferences[key];
      if (key === "notificationEpisodeReminders") state.preferences.episodeReminders = state.preferences[key];
      saveData();
      update();
      row.dataset.toggleOn = state.preferences[key] ? "true" : "false";
    });
  });

  const snoozeRow = document.getElementById("notification-snooze");
  const snoozeStatus = document.getElementById("notification-snooze-status");
  const snoozeLabels = { 0: "Off", 60: "1 hour", 180: "3 hours", 1440: "Tomorrow", 10080: "Next week" };
  if (snoozeStatus) snoozeStatus.textContent = snoozeLabels[state.preferences.notificationSnoozeMinutes] || "1 hour";
  snoozeRow?.addEventListener("click", () => openChoicePopup(
    "Remind me later", "Choose the default delay for notification snooze actions.",
    Object.entries(snoozeLabels).map(([value, label]) => ({ value, label })),
    String(state.preferences.notificationSnoozeMinutes),
    async value => { state.preferences.notificationSnoozeMinutes = Number(value); saveData(); if (snoozeStatus) snoozeStatus.textContent = snoozeLabels[value]; }
  ));

  const timePicker = (title, key, statusId) => {
    const modal = document.getElementById("picker-modal");
    const list = document.getElementById("picker-options-list");
    const titleEl = document.getElementById("picker-modal-title");
    if (!modal || !list || !titleEl) return;
    titleEl.textContent = title;
    list.innerHTML = `<p class="settings-row-note action-popup-message">Select a local device time.</p><input type="time" class="form-control notification-time-input" value="${state.preferences[key]}"><button type="button" class="btn btn-primary notification-time-save" data-save-notification-time>Save time</button>`;
    list.querySelector("[data-save-notification-time]").addEventListener("click", () => {
      const value = list.querySelector("input").value || state.preferences[key];
      state.preferences[key] = value;
      saveData();
      const status = document.getElementById(statusId);
      if (status) status.textContent = value;
      closeSettingsPicker();
    });
    modal.classList.add("active");
  };
  document.getElementById("notification-reminder-time")?.addEventListener("click", () => timePicker("Custom Reminder Time", "notificationReminderTime", "notification-reminder-time-status"));
  const reminderTimeStatus = document.getElementById("notification-reminder-time-status");
  if (reminderTimeStatus) reminderTimeStatus.textContent = state.preferences.notificationReminderTime;

  const quietRow = document.getElementById("notification-quiet-hours");
  const quietStatus = document.getElementById("notification-quiet-hours-status");
  const updateQuietStatus = () => {
    if (quietStatus) quietStatus.textContent = state.preferences.notificationQuietHours ? `${state.preferences.notificationQuietStart}–${state.preferences.notificationQuietEnd}` : "Off";
    if (quietRow) {
      quietRow.dataset.toggleOn = state.preferences.notificationQuietHours ? "true" : "false";
      quietRow.setAttribute("aria-checked", state.preferences.notificationQuietHours ? "true" : "false");
    }
  };
  updateQuietStatus();
  quietRow?.addEventListener("click", () => {
    state.preferences.notificationQuietHours = !state.preferences.notificationQuietHours;
    saveData();
    updateQuietStatus();
    quietRow.dataset.toggleOn = state.preferences.notificationQuietHours ? "true" : "false";
  });
}

function openNotificationQuietHoursPopup(updateStatus) {
  const modal = document.getElementById("picker-modal");
  const list = document.getElementById("picker-options-list");
  const title = document.getElementById("picker-modal-title");
  if (!modal || !list || !title) return;
  title.textContent = "Quiet Hours";
  list.innerHTML = `<p class="settings-row-note action-popup-message">Reminders will be skipped during this time window.</p><label class="notification-time-label">Quiet hours <input type="checkbox" id="quiet-hours-enabled" ${state.preferences.notificationQuietHours ? "checked" : ""}></label><div class="notification-time-pair"><label>From<input type="time" id="quiet-hours-start" class="form-control" value="${state.preferences.notificationQuietStart}"></label><label>Until<input type="time" id="quiet-hours-end" class="form-control" value="${state.preferences.notificationQuietEnd}"></label></div><button type="button" class="btn btn-primary notification-time-save" id="quiet-hours-save">Save</button>`;
  list.querySelector("#quiet-hours-save").addEventListener("click", () => {
    state.preferences.notificationQuietHours = list.querySelector("#quiet-hours-enabled").checked;
    state.preferences.notificationQuietStart = list.querySelector("#quiet-hours-start").value || "22:00";
    state.preferences.notificationQuietEnd = list.querySelector("#quiet-hours-end").value || "07:00";
    saveData();
    updateStatus();
    closeSettingsPicker();
  });
  modal.classList.add("active");
}

function isNotificationQuietHours(date = new Date()) {
  if (!state.preferences.notificationQuietHours) return false;
  const current = date.getHours() * 60 + date.getMinutes();
  const [startHour, startMinute] = state.preferences.notificationQuietStart.split(":").map(Number);
  const [endHour, endMinute] = state.preferences.notificationQuietEnd.split(":").map(Number);
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  return start === end ? false : start < end ? current >= start && current < end : current >= start || current < end;
}

function notificationFeatureEnabled(key) {
  return Boolean(state.preferences.notificationsEnabled && state.preferences[key] && !isNotificationQuietHours());
}

async function sendConfiguredNotification(key, title, body, itemId = "") {
  if (!notificationFeatureEnabled(key)) return false;
  const notifications = nativePlugin("Notifications");
  if (!notifications?.notify) return false;
  await notifications.notify({
    id: Math.abs([...`${key}:${itemId}:${title}`].reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0)) || 1,
    title, body, itemId,
    actionUrl: itemId ? `static/pages/main/show-detail.html?source=local&itemId=${encodeURIComponent(itemId)}` : "",
    snoozeMinutes: state.preferences.notificationSnoozeMinutes || 60
  });
  return true;
}

async function scheduleUnfinishedItemReminder() {
  if (!notificationFeatureEnabled("notificationUnfinishedItems")) return;
  const notifications = nativePlugin("Notifications");
  if (!notifications?.schedule) return;
  const item = state.items.find(entry => state.preferences[entry.category] && entry.status !== "Completed");
  if (!item) return;
  const [hour, minute] = state.preferences.notificationReminderTime.split(":").map(Number);
  const at = new Date();
  at.setHours(hour, minute, 0, 0);
  if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1);
  if (isNotificationQuietHours(at)) at.setDate(at.getDate() + 1);
  try {
    await notifications.schedule({
      id: Math.abs([...`unfinished:${item.id}`].reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0)) || 2,
      at: at.getTime(),
      title: "Continue your list",
      body: `${item.title} is still unfinished.`,
      itemId: item.id,
      actionUrl: `static/pages/main/show-detail.html?source=local&itemId=${encodeURIComponent(item.id)}`,
      snoozeMinutes: state.preferences.notificationSnoozeMinutes || 60
    });
  } catch (err) {
    console.warn("Could not schedule unfinished-item reminder", err);
  }
}

// Switch between active navigation tabs
function switchTab(tabId) {
  state.currentTab = tabId;
  localStorage.setItem("squashdb_last_tab", tabId);
  updateFabVisibility();
  updateSearchVisibility();
  updateCategoryChipVisibility();
  
  // Update nav item active states
  document.querySelectorAll(".nav-item").forEach(item => {
    if (item.getAttribute("data-tab") === tabId) {
      item.classList.add("active");
    } else {
      item.classList.remove("active");
    }
  });

  // Display correct content block
  document.querySelectorAll(".tab-content").forEach(content => {
    if (content.id === tabId) {
      content.classList.add("active");
    } else {
      content.classList.remove("active");
    }
  });

  // Render operations specific to tabs
  if (tabId === "tab-timeline" && document.getElementById("timeline-container")) {
    renderTimeline();
  } else if (tabId === "tab-stats" && document.getElementById("stats-total")) {
    renderStats();
  } else if (tabId === "tab-dashboard" && document.getElementById("notes-container")) {
    renderCategoryChips();
    renderDashboard();
  } else if (tabId === "tab-settings") {
    updateSettingsUI();
  }

  lucide.createIcons();

  if (state.currentTab === "tab-dashboard") {
    renderDashboard();
  }
}

function updateFabVisibility() {
  const fab = document.getElementById("add-fab");
  if (!fab) return;
  fab.style.display = state.currentTab === "tab-dashboard" ? "flex" : "none";
}

function updateSearchVisibility() {
  const search = document.getElementById("search-container");
  if (!search) return;
  search.style.display = state.currentTab === "tab-dashboard" ? "flex" : "none";
}

function updateCategoryChipVisibility() {
  const chips = document.getElementById("category-chips");
  if (!chips) return;
  chips.style.display = state.currentTab === "tab-settings" ? "none" : "flex";
}

// Sync sort-select UI to current sort state
function updateLayoutToggleButtons() {
  const sortSelect = document.getElementById("sort-select");
  if (sortSelect) {
    sortSelect.value = state.currentSort;
  }
}

// Populate Settings Switch toggles in Settings Tab
function updateSettingsUI() {
  Object.keys(state.preferences).forEach(cat => {
    const checkbox = document.getElementById(`pref-${cat}`);
    if (checkbox) {
      checkbox.checked = state.preferences[cat];
    }
  });

  const timelineButtons = document.querySelectorAll(".date-filter-btn");
  timelineButtons.forEach(btn => {
    btn.classList.toggle("active", btn.getAttribute("data-filter") === state.timelineFilter);
  });

  updatePickerRowValues();
  setupSettingsPickers();

  renderCategoryOrderSettings();
  renderSettingsCards();
  updateAppLockSettingsSummary();
}

function updateAppLockSettingsSummary() {
  const summaryEl = document.getElementById("app-lock-settings-summary");
  if (!summaryEl) return;
  normalizeAppLock();
  const labels = { none: "Off", pin: "PIN", pattern: "Pattern", alphanumeric: "Password", biometric: "Biometric" };
  summaryEl.textContent = labels[state.preferences.appLock.method] || "Off";
}

const NAV_BAR_KEYS = ["dashboard", "timeline", "discover", "sources", "explore", "stats", "settings"];
const NAV_BAR_LABELS = { dashboard: "Dashboard", timeline: "Timeline", discover: "Discover", sources: "Sources", explore: "Explore", stats: "Statistics", settings: "Settings" };
const NAV_KEY_BY_TAB = {
  "tab-dashboard": "dashboard",
  "tab-timeline": "timeline",
  "tab-discover": "discover",
  "tab-sources": "sources",
  "tab-explore": "explore",
  "tab-stats": "stats",
  "tab-settings": "settings"
};

// Reorders and hides the static bottom-nav items to match the user's
// arrangement preference (see manage-nav-bar.html).
function applyNavBarConfig() {
  const nav = document.querySelector(".bottom-nav");
  if (!nav) return;
  const cfg = state.preferences.navBar;
  if (!cfg) return;

  const itemsByKey = {};
  nav.querySelectorAll(".nav-item").forEach(item => {
    const key = NAV_KEY_BY_TAB[item.dataset.tab];
    if (key) itemsByKey[key] = item;
  });

  cfg.order.forEach(key => {
    const item = itemsByKey[key];
    if (!item) return;
    const hidden = cfg.visible[key] === false;
    item.style.display = hidden ? "none" : "";
    item.hidden = hidden;
    item.setAttribute("aria-hidden", hidden ? "true" : "false");
    item.tabIndex = hidden ? -1 : 0;
    nav.appendChild(item);
  });
}

// Settings page: drag-to-reorder rows with show/hide toggles for each tab.
function renderNavBarSettings() {
  const list = document.getElementById("nav-bar-arrangement-list");
  if (!list) return;

  list.innerHTML = "";
  state.preferences.navBar.order.forEach(key => {
    const row = document.createElement("div");
    row.className = "sortable-item metadata-source-row";
    row.draggable = true;
    row.dataset.navKey = key;
    const locked = key === "dashboard" || key === "settings";
    const visible = state.preferences.navBar.visible[key] !== false;
    const iconName = state.preferences.navIcons[key] || "circle";
    row.innerHTML = `
      <span class="drag-handle" aria-hidden="true">⋮⋮</span>
      <span class="sortable-label">
        <span class="manage-nav-row-icon"><i data-lucide="${iconName}"></i></span>
        <span class="manage-nav-row-copy"><strong>${NAV_BAR_LABELS[key]}</strong><small>${locked ? "Always shown" : visible ? "Shown in bottom bar" : "Hidden from bottom bar"}</small></span>
      </span>
      <label class="switch">
        <input type="checkbox" data-nav-visible="${key}" aria-label="Show ${NAV_BAR_LABELS[key]} in bottom bar" ${visible ? "checked" : ""} ${locked ? "disabled" : ""}>
        <span class="slider"></span>
      </label>
    `;
    list.appendChild(row);
  });

  bindMetadataSourceSorting(
    list,
    item => item.dataset.navKey,
    newOrder => {
      state.preferences.navBar.order = newOrder;
      saveData();
      applyNavBarConfig();
    }
  );

  list.querySelectorAll("input[data-nav-visible]").forEach(checkbox => {
    checkbox.addEventListener("change", (e) => {
      const key = e.target.dataset.navVisible;
      const vis = state.preferences.navBar.visible;
      vis[key] = e.target.checked;
      saveData();
      renderNavBarSettings();
      applyNavBarConfig();
    });
  });
  if (window.lucide) lucide.createIcons(list);
}

const NAV_ICON_CHOICES = {
  dashboard: ["layout-grid", "home", "grid2x2", "layout-dashboard", "square-library", "book-marked", "library", "layout-list", "list-tree", "boxes", "compass", "rows", "menu", "folder-open", "box", "archive"],
  timeline: ["calendar", "clock", "history", "calendar-days", "calendar-clock", "hourglass", "timer", "calendar-heart", "calendar-check", "calendar-range", "alarm-clock", "clock4", "clock9", "calendar-plus", "sunrise", "moon"],
  discover: ["search", "compass", "globe", "telescope", "binoculars", "sparkles", "eye", "map", "navigation", "radar", "zap", "star", "search-check", "scan-search", "earth", "satellite-dish"],
  sources: ["database", "server", "layers", "package", "plug", "cloud", "hard-drive", "library-big", "antenna", "rss", "combine", "blocks", "cable", "boxes", "network", "warehouse"],
  explore: ["compass", "map", "globe", "telescope", "rocket", "sparkles", "mountain", "ship", "milestone", "signpost", "footprints", "trees", "sailboat", "plane", "map-pinned", "orbit"],
  stats: ["pie-chart", "bar-chart2", "bar-chart3", "trending-up", "activity", "line-chart", "gauge", "chart-bar", "chart-pie", "bar-chart-horizontal", "flame", "sigma", "chart-column", "area-chart", "radar", "target"],
  settings: ["settings", "sliders-horizontal", "cog", "wrench", "settings2", "sliders", "toggle-left", "circle-user", "sparkles", "square-menu", "list-checks", "user-cog", "sliders-vertical", "user-round-cog", "shield-check", "key"]
};

function renderNavIconPickers() {
  let needsIcons = false;
  Object.keys(NAV_ICON_CHOICES).forEach(navKey => {
    const grid = document.getElementById(`nav-icon-picker-${navKey}`);
    if (!grid) return;

    grid.innerHTML = "";
    const current = state.preferences.navIcons[navKey];
    const section = grid.closest(".settings-section");
    const heading = section?.querySelector(".settings-section-title");
    if (heading) {
      let selectedLabel = heading.querySelector(".nav-icon-current-label");
      if (!selectedLabel) {
        selectedLabel = document.createElement("span");
        selectedLabel.className = "nav-icon-current-label";
        heading.appendChild(selectedLabel);
      }
      const readableCurrent = (current || "circle").replace(/-/g, " ");
      selectedLabel.textContent = `Selected · ${readableCurrent}`;
      selectedLabel.setAttribute("aria-label", `Selected icon: ${readableCurrent}`);
    }

    NAV_ICON_CHOICES[navKey].forEach(iconName => {
      const btn = document.createElement("button");
      btn.type = "button";
      const selected = iconName === current;
      btn.className = `icon-picker-option${selected ? " active" : ""}`;
      btn.setAttribute("aria-label", `Use ${iconName.replace(/-/g, " ")} icon for ${NAV_BAR_LABELS[navKey]}`);
      btn.setAttribute("aria-pressed", String(selected));
      btn.title = iconName.replace(/-/g, " ");
      btn.innerHTML = `<i data-lucide="${iconName}"></i>`;
      needsIcons = true;
      btn.addEventListener("click", () => {
        state.preferences.navIcons[navKey] = iconName;
        saveData();
        renderNavIconPickers();
        applyNavIcons();
      });
      grid.appendChild(btn);
    });

    if (grid.classList.contains("icon-picker-carousel")) {
      const spacer = document.createElement("div");
      spacer.className = "icon-picker-carousel-spacer";
      grid.appendChild(spacer);
    }
  });

  if (needsIcons && window.lucide) lucide.createIcons();
}

// App icon+name (Android home screen look, switched via native activity-alias).
// Each look bakes in both an icon and a matching name as a single pre-declared
// alias (see AndroidManifest.xml: Look_<key>), so there's one flat list to pick from.
const APP_LOOK_CHOICES = [
  { value: "default", label: "SquashDB", style: "Classic", preview: "icons/previews/ic_launcher.png" },
  { value: "fire", label: "SquashDB", style: "Flame", preview: "icons/previews/ic_launcher_fire.png" },
  { value: "pinklogo", label: "SquashDB", style: "Rose", preview: "icons/previews/ic_launcher_pinklogo.png" },
  { value: "purple", label: "SquashDB", style: "Violet", preview: "icons/previews/ic_launcher_purple.png" },
  { value: "capacitor", label: "Capacitor", preview: "icons/previews/ic_launcher_capacitor.png" },
  { value: "calculator", label: "Calculator", preview: "icons/previews/ic_launcher_calculator.png" },
  { value: "freeotp", label: "FreeOTP", preview: "icons/previews/ic_launcher_freeotp.png" },
  { value: "termux", label: "Termux", preview: "icons/previews/ic_launcher_termux.png" },
  { value: "controller", label: "Controller", preview: "icons/controller.svg" },
  { value: "gear", label: "Gear", preview: "icons/gear.svg" }
];

function isNativeApp() {
  return Boolean(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}

function appIconPluginAvailable() {
  return isNativeApp() && window.Capacitor.Plugins && window.Capacitor.Plugins.AppIcon;
}

async function getCurrentAppLook() {
  let look = state.preferences.appLook || "default";

  if (appIconPluginAvailable()) {
    try {
      const result = await window.Capacitor.Plugins.AppIcon.getLook();
      if (result && result.look) look = result.look;
    } catch (err) {
      console.warn("Could not read current app look", err);
    }
  }
  return look;
}

async function applyAppLook(look) {
  state.preferences.appLook = look;
  saveData();

  if (!appIconPluginAvailable()) return;

  try {
    await window.Capacitor.Plugins.AppIcon.setLook({ look });
  } catch (err) {
    console.warn("Failed to switch app look", err);
    alert("Could not update the app icon/name. Please try again.");
  }
}

async function renderAppIconPicker() {
  const grid = document.getElementById("app-icon-picker");
  if (!grid) return;

  const note = document.getElementById("app-icon-native-note");
  if (note) note.style.display = appIconPluginAvailable() ? "none" : "block";

  const current = await getCurrentAppLook();

  grid.innerHTML = "";
  APP_LOOK_CHOICES.forEach(choice => {
    const btn = document.createElement("button");
    btn.type = "button";
    const selected = choice.value === current;
    btn.className = `app-icon-option${selected ? " active" : ""}`;
    btn.setAttribute("aria-pressed", String(selected));
    btn.setAttribute("aria-label", `${choice.label}${choice.style ? `, ${choice.style}` : ""}${selected ? ", selected" : ""}`);
    btn.innerHTML = `
      <img src="${choice.preview}" alt="">
      <span class="app-icon-name">${choice.label}</span>
      ${choice.style ? `<small class="app-icon-style">${choice.style}</small>` : ""}
    `;
    btn.addEventListener("click", () => selectAppLook(choice.value));
    grid.appendChild(btn);
  });
}

async function selectAppLook(look) {
  await applyAppLook(look);
  renderAppIconPicker();
}

// Apply the saved nav icons to whichever bottom-nav is present on this page
function applyNavIcons() {
  const map = {
    "tab-dashboard": "dashboard",
    "tab-timeline": "timeline",
    "tab-discover": "discover",
    "tab-sources": "sources",
    "tab-explore": "explore",
    "tab-stats": "stats",
    "tab-settings": "settings"
  };
  document.querySelectorAll(".bottom-nav .nav-item").forEach(navItem => {
    const navKey = map[navItem.dataset.tab];
    if (!navKey) return;
    const iconName = state.preferences.navIcons[navKey];
    if (!iconName) return;
    // Icon may already be a rendered <svg> (lucide.createIcons replaces <i>),
    // so replace whatever icon element is there with a fresh placeholder.
    const existingIcon = navItem.querySelector("i, svg");
    if (existingIcon) existingIcon.remove();
    navItem.insertAdjacentHTML("beforeend", `<i data-lucide="${iconName}"></i>`);
  });
  if (window.lucide) lucide.createIcons();
}

const SETTINGS_PICKERS = {
  ratingFormat: {
    default: "5-stars",
    options: [
      { value: "5-stars", label: "5 stars" },
      { value: "10-points", label: "10 points" },
      { value: "10-decimal", label: "10 points decimals" },
      { value: "100-points", label: "100 points" }
    ]
  },
  uiTheme: {
    default: "dark",
    options: [
      { value: "light", label: "Light", description: "Clean white surfaces with indigo accents.", colors: ["#f8fafc", "#4f46e5", "#0f172a"] },
      { value: "dark", label: "Dark", description: "Deep navy surfaces with violet accents.", colors: ["#0b0f19", "#6366f1", "#f8fafc"] },
      { value: "grey", label: "Grey", description: "Soft graphite surfaces with slate accents.", colors: ["#111827", "#64748b", "#f9fafb"] },
      { value: "amoled", label: "AMOLED", description: "True black surfaces with vivid violet accents.", colors: ["#000000", "#8b5cf6", "#f8fafc"] },
      { value: "flashbang", label: "Flashbang", description: "Bright white surfaces with bold charcoal accents.", colors: ["#f8fafc", "#111827", "#0f172a"] },
      { value: "material-you", label: "Material You", description: "Layered charcoal surfaces with purple accents.", colors: ["#10131d", "#8b5cf6", "#f8fafc"] },
      { value: "ocean", label: "Ocean", description: "Midnight blue surfaces with clear aqua accents.", colors: ["#081b2b", "#38bdf8", "#e0f2fe"] },
      { value: "forest", label: "Forest", description: "Deep evergreen surfaces with fresh mint accents.", colors: ["#10221b", "#4ade80", "#ecfdf5"] },
      { value: "sunset", label: "Sunset", description: "Warm espresso surfaces with golden orange accents.", colors: ["#261714", "#fb923c", "#fff7ed"] },
      { value: "rose", label: "Rose", description: "Dark plum surfaces with soft rose accents.", colors: ["#251722", "#fb7185", "#fff1f2"] },
      { value: "lavender", label: "Lavender", description: "Smoky violet surfaces with lilac accents.", colors: ["#211d35", "#c4b5fd", "#f5f3ff"] },
      { value: "nord", label: "Nord", description: "Cool blue-grey surfaces with icy blue accents.", colors: ["#242d3b", "#88c0d0", "#eceff4"] },
      { value: "sand", label: "Sand", description: "Warm paper surfaces with terracotta accents.", colors: ["#faf4e8", "#c2410c", "#29231d"] },
      { value: "mint", label: "Mint", description: "Pale green surfaces with deep teal accents.", colors: ["#effaf5", "#0f766e", "#12352d"] }
    ]
  },
  uiFont: {
    default: "inter",
    options: [
      { value: "system", label: "System Default" },
      { value: "inter", label: "Inter (default)" },
      { value: "outfit", label: "Outfit" },
      { value: "serif", label: "Serif" },
      { value: "monospace", label: "Monospace" },
      { value: "rounded", label: "Rounded" },
      { value: "poppins", label: "Poppins (online)" },
      { value: "roboto", label: "Roboto (online)" },
      { value: "nunito", label: "Nunito (online)" },
      { value: "lato", label: "Lato (online)" },
      { value: "merriweather", label: "Merriweather (online)" },
      { value: "jetbrains-mono", label: "JetBrains Mono (online)" }
    ]
  },
  bottomBarActiveStyle: {
    default: "box",
    options: [{ value: "box", label: "Selected box" }, { value: "icon", label: "Icon color" }]
  },
  bottomBarSurface: {
    default: "translucent",
    options: [{ value: "translucent", label: "Translucent" }, { value: "solid", label: "Solid" }]
  },
  mainColor: {
    default: "normal",
    options: [
      { value: "normal", label: "Normal" },
      { value: "carnation-pink", label: "Carnation Pink" },
      { value: "dark-green", label: "Dark Green" },
      { value: "maroon", label: "Maroon" },
      { value: "navy-blue", label: "Navy Blue" },
      { value: "grey", label: "Grey" },
      { value: "white", label: "White" },
      { value: "brown", label: "Brown" },
      { value: "cool", label: "Cool" },
      { value: "fire", label: "Fire" },
      { value: "burple", label: "Burple" },
      { value: "gren", label: "Gren" },
      { value: "apple", label: "Apple" },
      { value: "banan", label: "Banan" },
      { value: "party", label: "Party" },
      { value: "pink-pain", label: "Pink Pain" },
      { value: "material-you", label: "Material You" }
    ]
  },
  highContrast: {
    default: "false",
    options: [
      { value: "false", label: "Standard contrast" },
      { value: "true", label: "High contrast" }
    ]
  },
  accessibilityPreset: {
    default: "standard",
    options: [
      { value: "standard", label: "Standard" },
      { value: "high-contrast", label: "High contrast" },
      { value: "reduced-motion", label: "Reduced motion" },
      { value: "maximum", label: "Maximum accessibility" }
    ]
  },
  ratingReminders: {
    default: "false",
    options: [{ value: "true", label: "On" }, { value: "false", label: "Off" }]
  },
  accessibleTextSize: {
    default: "normal",
    options: [{ value: "normal", label: "Normal" }, { value: "large", label: "Large" }, { value: "largest", label: "Largest" }]
  },
  language: {
    default: "system",
    options: [{ value: "system", label: "System default" }, { value: "en", label: "English" }]
  },
  dateFormat: {
    default: "system",
    options: [
      { value: "system", label: "System default" }, { value: "short", label: "Short dates" },
      { value: "long", label: "Long dates" }, { value: "iso", label: "YYYY-MM-DD" }
    ]
  },
  externalLinks: {
    default: "ask",
    options: [{ value: "ask", label: "Ask every time" }, { value: "always", label: "Open automatically" }, { value: "never", label: "Block external links" }]
  },
  analyticsEnabled: { default: "false", options: [{ value: "true", label: "On" }, { value: "false", label: "Off" }] },
  sendErrorLogs: { default: "false", options: [{ value: "true", label: "On" }, { value: "false", label: "Off" }] },
  networkOnlyOnWifi: { default: "false", options: [{ value: "true", label: "On" }, { value: "false", label: "Off" }] },
  reducedMotion: {
    default: "false",
    options: [
      { value: "false", label: "Allow motion" },
      { value: "true", label: "Reduce motion" }
    ]
  },
  dashboardRowActions: {
    default: "menu",
    options: [
      { value: "menu", label: "3-dot menu" },
      { value: "tap-hold", label: "Tap + hold" },
      { value: "swipe", label: "Swipe to edit/delete" }
    ]
  },
  dashboardView: {
    default: "list",
    options: [
      { value: "list", label: "List" },
      { value: "compact-list", label: "Compact List" },
      { value: "grid", label: "Poster Grid" },
      { value: "compact-grid", label: "Compact Grid" },
      { value: "detailed-grid", label: "Detailed Grid" },
      { value: "table", label: "Table" },
      { value: "minimal-list", label: "Minimal List" },
      { value: "large-grid", label: "Large Poster Grid" },
      { value: "kanban", label: "Kanban Board" },
      { value: "timeline", label: "Timeline" }
    ]
  },
  dashboardDensity: {
    default: "comfortable",
    options: [
      { value: "comfortable", label: "Comfortable" },
      { value: "compact", label: "Compact" }
    ]
  },
  dashboardDefaultCategory: {
    default: "remember-last",
    options: [
      { value: "remember-last", label: "Remember last" },
      { value: "series", label: "TV Series" }, { value: "movie", label: "Movies" },
      { value: "anime", label: "Anime" }, { value: "manga", label: "Manga" },
      { value: "novel", label: "Novels" }, { value: "game", label: "Games" }
    ]
  },
  recentlyAddedLimit: {
    default: 10,
    options: [5, 10, 20, 50].map(value => ({ value, label: `${value} items` }))
  },
  dashboardCardCorners: {
    default: "rounded",
    options: [{ value: "rounded", label: "Rounded" }, { value: "soft", label: "Soft" }, { value: "square", label: "Square" }]
  },
  automaticCompletion: {
    default: "automatic",
    options: [{ value: "automatic", label: "Automatic" }, { value: "ask", label: "Ask first" }, { value: "manual", label: "Manual" }]
  },
  defaultEntryStatus: {
    default: "watchlist",
    options: [
      { value: "watchlist", label: "Watchlist" },
      { value: "in-progress", label: "In Progress" },
      { value: "on-hold", label: "On Hold" },
      { value: "dropped", label: "Dropped" },
      { value: "completed", label: "Completed" }
    ]
  },
  progressIncrement: {
    default: 1,
    options: [{ value: 1, label: "1 episode/chapter" }, { value: 5, label: "5 episodes/chapters" }, { value: 10, label: "10 episodes/chapters" }]
  },
  notesTemplate: {
    default: "none",
    options: [{ value: "none", label: "None" }, { value: "review", label: "Review" }, { value: "journal", label: "Journal" }]
  },
  dashboardGroupBy: {
    default: "status",
    options: [
      { value: "none", label: "No grouping" },
      { value: "status", label: "Status" },
      { value: "release", label: "Release date" }
    ]
  },
  dashboardSort: {
    default: "alphabetical-asc",
    stateKey: "currentSort",
    options: [
      { value: "updated-desc", label: "Recently updated" },
      { value: "created-desc", label: "Recently added" },
      { value: "progress-desc", label: "Most progress" },
      { value: "progress-asc", label: "Least progress" },
      { value: "rating-desc", label: "Highest rated" },
      { value: "release-desc", label: "Newest release" },
      { value: "alphabetical-asc", label: "Title A–Z" },
      { value: "alphabetical-desc", label: "Title Z–A" }
    ]
  },
  oneHandedMode: {
    default: "off",
    options: [
      { value: "off", label: "Off" },
      { value: "left", label: "Left-handed" },
      { value: "right", label: "Right-handed" }
    ]
  },
  tabletTwoColumn: {
    default: "true",
    options: [
      { value: "true", label: "Two columns" },
      { value: "false", label: "Single column" }
    ]
  },
  compactMode: {
    default: "false",
    options: [
      { value: "false", label: "Off" },
      { value: "true", label: "On" }
    ]
  },
  metadataMode: {
    default: "offline",
    options: [
      { value: "offline", label: "Offline" },
      { value: "online", label: "Online" }
    ]
  },
  metadataThumbnails: {
    default: "true",
    stateKey: "metadataThumbnails",
    options: [
      { value: "true", label: "On" },
      { value: "false", label: "Off" }
    ]
  },
  thumbnailSize: {
    default: "medium",
    options: [
      { value: "small", label: "Small" },
      { value: "medium", label: "Medium" },
      { value: "large", label: "Large" }
    ]
  },
  thumbnailQuality: {
    default: "balanced",
    options: [
      { value: "data-saver", label: "Data saver" },
      { value: "balanced", label: "Balanced" },
      { value: "best", label: "Best quality" }
    ]
  },
  importDefaultCategory: {
    default: "anime",
    options: [
      { value: "anime", label: "Anime" }, { value: "movie", label: "Movies" },
      { value: "series", label: "TV Series" }, { value: "manga", label: "Manga" },
      { value: "novel", label: "Novels" }, { value: "game", label: "Games" }
    ]
  },
  importDuplicatePolicy: {
    default: "skip",
    options: [
      { value: "skip", label: "Skip existing" }, { value: "update", label: "Update existing" },
      { value: "create", label: "Create duplicate" }
    ]
  },
  exportDefaultFormat: {
    default: "csv",
    options: [{ value: "csv", label: "CSV" }, { value: "tsv", label: "TSV" }, { value: "txt", label: "TXT" }]
  },
  exportIncludeMetadata: {
    default: "true",
    options: [{ value: "true", label: "Include metadata" }, { value: "false", label: "Titles and status only" }]
  },
  metadataSyncFrequency: {
    default: "immediate",
    options: [
      { value: "immediate", label: "Immediately" },
      { value: "five-minutes", label: "Every 5 minutes" },
      { value: "fifteen-minutes", label: "Every 15 minutes" }
    ]
  },
  metadataRefreshInterval: {
    default: "weekly",
    options: [{ value: "never", label: "Never" }, { value: "daily", label: "Daily" }, { value: "weekly", label: "Weekly" }]
  },
  metadataRetryLimit: {
    default: 3,
    options: [1, 3, 5].map(value => ({ value, label: `${value} attempt${value === 1 ? "" : "s"}` }))
  },
  offlineFallback: {
    default: "cached",
    options: [{ value: "cached", label: "Use cached metadata" }, { value: "manual", label: "Keep manual data" }, { value: "strict", label: "Do not use fallback" }]
  },
  thumbnailCleanup: {
    default: "weekly",
    options: [{ value: "never", label: "Never" }, { value: "daily", label: "Daily" }, { value: "weekly", label: "Weekly" }]
  },
  metadataImportConcurrency: {
    default: 5,
    options: [1, 2, 3, 5, 8, 10].map(value => ({ value, label: `${value} workers` }))
  },
  storageWarningLimitMb: {
    default: 500,
    options: [100, 500, 1000, 5000, 0].map(value => ({ value, label: value ? `${value} MB` : "No warning" }))
  },
  backupStorageLimitMb: {
    default: 1000,
    options: [250, 1000, 5000, 0].map(value => ({ value, label: value ? `${value} MB` : "Unlimited" }))
  },
  backupSchedule: {
    default: "daily",
    options: [
      { value: "off", label: "Off" },
      { value: "daily", label: "Daily" },
      { value: "weekly", label: "Weekly" }
    ]
  },
  backupRetention: {
    default: "10",
    options: [
      { value: "3", label: "Keep 3 backups" },
      { value: "10", label: "Keep 10 backups" },
      { value: "30", label: "Keep 30 backups" },
      { value: "0", label: "Keep all backups" }
    ]
  },
  backupBeforeDestructive: {
    default: true,
    options: [{ value: "true", label: "On" }, { value: "false", label: "Off" }]
  },
  backupPasswordReminder: { default: true, options: [{ value: "true", label: "On" }, { value: "false", label: "Off" }] },
  backupMaxSizeMb: { default: 1000, options: [250, 1000, 5000, 0].map(value => ({ value, label: value ? `${value} MB` : "Unlimited" })) },
  backupValidateLocation: { default: true, options: [{ value: "true", label: "On" }, { value: "false", label: "Off" }] },
  backupRestorePreview: { default: true, options: [{ value: "true", label: "On" }, { value: "false", label: "Off" }] },
  notificationSound: { default: true, options: [{ value: "true", label: "On" }, { value: "false", label: "Off" }] },
  notificationVibration: { default: true, options: [{ value: "true", label: "On" }, { value: "false", label: "Off" }] },
  reminderDays: { default: 1, options: [1, 3, 7, 14].map(value => ({ value, label: `${value} day${value === 1 ? "" : "s"}` })) },
  notificationPerCategory: { default: false, options: [{ value: "true", label: "On" }, { value: "false", label: "Off" }] },
  notificationGrouping: { default: "grouped", options: [{ value: "grouped", label: "Grouped" }, { value: "separate", label: "Separate" }] },
  autoLockTimeout: { default: "never", options: [{ value: "never", label: "Never" }, { value: "5-minutes", label: "5 minutes" }, { value: "15-minutes", label: "15 minutes" }, { value: "1-hour", label: "1 hour" }] },
  lockOnBackground: { default: false, options: [{ value: "true", label: "On" }, { value: "false", label: "Off" }] },
  biometricFallback: { default: "pin", options: [{ value: "pin", label: "PIN" }, { value: "password", label: "Password" }, { value: "none", label: "No fallback" }] },
  hideSensitiveNotes: { default: false, options: [{ value: "true", label: "On" }, { value: "false", label: "Off" }] },
  duplicateDetector: { default: true, options: [{ value: "true", label: "On" }, { value: "false", label: "Off" }] },
  orphanedMetadataCleanup: { default: false, options: [{ value: "true", label: "On" }, { value: "false", label: "Off" }] },
  importHistory: { default: true, options: [{ value: "true", label: "On" }, { value: "false", label: "Off" }] },
  exportSelectedOnly: { default: false, options: [{ value: "true", label: "On" }, { value: "false", label: "Off" }] },
  databaseHealthCheck: { default: false, options: [{ value: "true", label: "On" }, { value: "false", label: "Off" }] },
  debugMode: { default: false, options: [{ value: "true", label: "On" }, { value: "false", label: "Off" }] },
  networkTimeout: { default: 30, options: [10, 30, 60, 120].map(value => ({ value, label: `${value} seconds` })) },
  apiRateLimitDelay: { default: 250, options: [0, 250, 500, 1000].map(value => ({ value, label: `${value} ms` })) },
  experimentalFeatures: { default: false, options: [{ value: "true", label: "On" }, { value: "false", label: "Off" }] },
  dashboardShowThumbnails: {
    default: "true",
    options: [{ value: "true", label: "Shown" }, { value: "false", label: "Hidden" }]
  },
  dashboardShowRatings: {
    default: "true",
    options: [{ value: "true", label: "Shown" }, { value: "false", label: "Hidden" }]
  },
  dashboardShowProgress: {
    default: "true",
    options: [{ value: "true", label: "Shown" }, { value: "false", label: "Hidden" }]
  },
  folderSyncDelay: {
    default: "30000",
    options: [
      { value: "0", label: "Immediately" },
      { value: "5000", label: "5 seconds" },
      { value: "10000", label: "10 seconds" },
      { value: "30000", label: "30 seconds" },
      { value: "60000", label: "1 minute" }
    ]
  },
  animationSpeed: {
    default: "normal",
    options: [
      { value: "off", label: "Off" },
      { value: "fast", label: "Fast" },
      { value: "normal", label: "Normal" },
      { value: "slow", label: "Slow" }
    ]
  }
};

// Multiplier applied to every CSS transition/animation duration via --anim-speed.
const ANIMATION_SPEED_MULTIPLIERS = { off: 0.001, fast: 0.5, normal: 1, slow: 1.75 };

function getPickerValue(pref) {
  const picker = SETTINGS_PICKERS[pref];
  const source = picker.stateKey ? state : state.preferences;
  const value = source[picker.stateKey || pref];
  if (typeof value === "boolean") return value ? "true" : "false";
  return value || picker.default;
}

function setPickerValue(pref, value) {
  const picker = SETTINGS_PICKERS[pref];
  const source = picker.stateKey ? state : state.preferences;
  source[picker.stateKey || pref] = value === "true" ? true : value === "false" ? false : value;
}

function updatePickerRowValues() {
  Object.keys(SETTINGS_PICKERS).forEach(pref => {
    const picker = SETTINGS_PICKERS[pref];
    const row = document.querySelector(`[data-pref="${pref}"]`);
    if (!row) return;
    const valueEl = row.querySelector(".settings-row-value span");
    const current = getPickerValue(pref);
    const match = picker.options.find(o => o.value === current);
    if (valueEl) {
      const label = match ? match.label : current;
      valueEl.textContent = pref === "highContrast" ? (current === "true" ? "High contrast" : "Standard") : label;
    }
    if (row.dataset.directToggle === "true") {
      row.dataset.toggleOn = current === "true" ? "true" : "false";
      if (row.getAttribute("role") === "switch") row.setAttribute("aria-checked", current === "true" ? "true" : "false");
    }
  });

  // Keep the preset summary accurate when a user changes one of its component
  // controls individually after applying a preset.
  const { highContrast, reducedMotion, accessibleTextSize } = state.preferences;
  const preset = highContrast && reducedMotion && accessibleTextSize === "largest" ? "maximum"
    : highContrast && !reducedMotion && accessibleTextSize === "large" ? "high-contrast"
      : !highContrast && reducedMotion && accessibleTextSize === "normal" ? "reduced-motion"
        : !highContrast && !reducedMotion && accessibleTextSize === "normal" ? "standard" : "custom";
  state.preferences.accessibilityPreset = preset;
  const presetRow = document.querySelector('[data-pref="accessibilityPreset"]');
  const presetValue = presetRow?.querySelector(".settings-row-value span");
  const presetLabel = SETTINGS_PICKERS.accessibilityPreset.options.find(option => option.value === preset)?.label;
  if (presetValue && presetLabel) presetValue.textContent = presetLabel;
}

function setupSettingsPickers() {
  document.querySelectorAll(".settings-row-picker").forEach(row => {
    // Action rows (cache, notifications, background backups) use their own
    // click handlers. Only rows with a data-pref belong to the picker sheet.
    if (!row.dataset.pref) return;
    if (row.dataset.bound === "true") return;
    row.dataset.bound = "true";
    if (row.dataset.directToggle === "true") {
      row.addEventListener("click", () => {
        const current = getPickerValue(row.dataset.pref) === "true";
        setPickerValue(row.dataset.pref, String(!current));
        saveData();
        applyPreferenceAttributes();
        updatePickerRowValues();
      });
      return;
    }
    row.addEventListener("click", () => {
      openSettingsPicker(row.dataset.pref, row.closest(".settings-row-picker").querySelector("label").textContent);
    });
  });
}

// Bind the shared picker bottom-sheet's close/backdrop handlers (used by both
// settings pickers and the dashboard row-action menu)
function setupPickerModal() {
  const pickerClose = document.getElementById("picker-modal-close");
  if (pickerClose && pickerClose.dataset.bound !== "true") {
    pickerClose.dataset.bound = "true";
    pickerClose.addEventListener("click", closeSettingsPicker);
  }

  const pickerModal = document.getElementById("picker-modal");
  if (pickerModal && pickerModal.dataset.bound !== "true") {
    pickerModal.dataset.bound = "true";
    pickerModal.addEventListener("click", (e) => {
      if (e.target === pickerModal) closeSettingsPicker();
    });
  }
}

function openSettingsPicker(pref, title) {
  const picker = SETTINGS_PICKERS[pref];
  if (!picker) return;

  const modal = document.getElementById("picker-modal");
  const list = document.getElementById("picker-options-list");
  const titleEl = document.getElementById("picker-modal-title");
  if (!modal || !list) return;

  titleEl.textContent = title;
  const current = getPickerValue(pref);

  list.innerHTML = "";
  picker.options.forEach(opt => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `picker-option${opt.value === current ? " active" : ""}`;
    btn.setAttribute("aria-pressed", String(opt.value === current));
    if (pref === "uiTheme") {
      btn.classList.add("theme-picker-option");
      btn.dataset.themeOption = opt.value;
      const radio = document.createElement("span");
      radio.className = "choice-radio";
      radio.setAttribute("aria-hidden", "true");
      const preview = document.createElement("span");
      preview.className = "theme-picker-preview";
      preview.style.setProperty("--theme-preview-bg", opt.colors[0]);
      preview.style.setProperty("--theme-preview-accent", opt.colors[1]);
      preview.style.setProperty("--theme-preview-text", opt.colors[2]);
      preview.innerHTML = '<span class="theme-picker-preview-accent"></span><span class="theme-picker-preview-lines"><i></i><i></i></span>';
      const copy = document.createElement("span");
      copy.className = "theme-picker-copy";
      const name = document.createElement("strong");
      name.textContent = opt.label;
      const description = document.createElement("small");
      description.textContent = opt.description;
      copy.append(name, description);
      btn.append(radio, preview, copy);
    } else {
      btn.innerHTML = `<span class="choice-radio" aria-hidden="true"></span><span>${opt.label}</span>`;
    }
    btn.addEventListener("click", () => {
      setPickerValue(pref, opt.value);
      if (pref === "accessibilityPreset") {
        state.preferences.highContrast = ["high-contrast", "maximum"].includes(opt.value);
        state.preferences.reducedMotion = ["reduced-motion", "maximum"].includes(opt.value);
        state.preferences.accessibleTextSize = opt.value === "maximum" ? "largest" : opt.value === "high-contrast" ? "large" : "normal";
      }
      saveData();
      applyTheme();
      applyPreferenceAttributes();
      if (pref === "uiFont" && typeof applyUiFont === "function") applyUiFont();
      updateLayoutToggleButtons();
      renderDashboard();
      renderTimeline();
      renderStats();
      updatePickerRowValues();
      closeSettingsPicker();
    });
    list.appendChild(btn);
  });

  modal.classList.add("active");
  if (window.lucide && list.childElementCount > 0) lucide.createIcons();
}

function openCategoryColorsPicker() {
  const modal = document.getElementById("picker-modal");
  const list = document.getElementById("picker-options-list");
  const title = document.getElementById("picker-modal-title");
  if (!modal || !list || !title) return;
  title.textContent = "Category Colors";
  const draft = { ...(state.preferences.categoryColors || {}) };
  list.innerHTML = `<p class="settings-row-note action-popup-message">Choose a separate accent color for each tracking category.</p>`;
  Object.keys(CATEGORIES).forEach(key => {
    const row = document.createElement("label");
    row.className = "category-color-option";
    row.innerHTML = `<span><i data-lucide="${CATEGORIES[key].icon || "circle"}"></i>${CATEGORIES[key].label}</span><input type="color" value="${draft[key] || CATEGORIES[key].color}" aria-label="${CATEGORIES[key].label} color">`;
    row.querySelector("input").addEventListener("input", event => { draft[key] = event.target.value; });
    list.appendChild(row);
  });
  const save = document.createElement("button");
  save.type = "button";
  save.className = "picker-option active category-color-save";
  save.innerHTML = `<i data-lucide="check"></i><span>Save colors</span>`;
  save.addEventListener("click", () => {
    state.preferences.categoryColors = draft;
    saveData();
    applyPreferenceAttributes();
    renderDashboard();
    renderStats();
    closeSettingsPicker();
    showToast("Category colors updated", "success");
  });
  list.appendChild(save);
  modal.classList.add("active");
  if (window.lucide) lucide.createIcons();
}

function openActionPopup(title, message, actionLabel, action) {
  const modal = document.getElementById("picker-modal");
  const list = document.getElementById("picker-options-list");
  const titleEl = document.getElementById("picker-modal-title");
  if (!modal || !list || !titleEl) return;

  titleEl.textContent = title;
  list.innerHTML = "";

  const description = document.createElement("p");
  description.className = "settings-row-note action-popup-message";
  description.textContent = message;
  list.appendChild(description);

  const actionButton = document.createElement("button");
  actionButton.type = "button";
  actionButton.className = "picker-option active";
  actionButton.innerHTML = `<i data-lucide="check" class="picker-option-check"></i><span>${actionLabel}</span>`;
  actionButton.addEventListener("click", async () => {
    actionButton.disabled = true;
    try {
      await action();
      closeSettingsPicker();
      showToast(`${title} completed`, "success");
    } catch (err) {
      console.warn(`${title} action failed`, err);
      showToast(err?.message || `${title} failed`, "error");
      description.textContent = err?.message || "This action could not be completed. Please try again.";
      description.style.color = "var(--danger)";
    } finally {
      actionButton.disabled = false;
    }
  });
  list.appendChild(actionButton);

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "picker-option";
  cancelButton.innerHTML = `<i data-lucide="x" class="picker-option-check" style="visibility:visible;color:var(--text-muted);"></i><span>Cancel</span>`;
  cancelButton.addEventListener("click", closeSettingsPicker);
  list.appendChild(cancelButton);

  modal.classList.add("active");
  if (window.lucide) lucide.createIcons();
}

function requestInAppConfirmation(title, message, actionLabel = "Continue") {
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay active squashdb-confirm-modal";
    overlay.innerHTML = `
      <div class="modal-content" role="dialog" aria-modal="true">
        <div class="modal-header"><h3 class="modal-title"></h3><button type="button" class="modal-close" aria-label="Close">&times;</button></div>
        <p class="settings-row-note"></p>
        <div class="form-actions"><button type="button" class="btn btn-secondary" data-confirm-cancel>Cancel</button><button type="button" class="btn btn-primary" data-confirm-action></button></div>
      </div>`;
    overlay.querySelector(".modal-title").textContent = title;
    overlay.querySelector(".settings-row-note").textContent = message;
    overlay.querySelector("[data-confirm-action]").textContent = actionLabel;
    const finish = result => { overlay.remove(); resolve(result); };
    overlay.querySelector("[data-confirm-cancel]").addEventListener("click", () => finish(false));
    overlay.querySelector(".modal-close").addEventListener("click", () => finish(false));
    overlay.addEventListener("click", event => { if (event.target === overlay) finish(false); });
    overlay.querySelector("[data-confirm-action]").addEventListener("click", () => finish(true));
    document.body.appendChild(overlay);
  });
}

async function clearSquashDbData({ factoryReset = false } = {}) {
  const title = factoryReset ? "Factory reset SquashDB?" : "Clear all tracked data?";
  const message = factoryReset
    ? "This removes tracked items, watch history, preferences, pending imports, and temporary caches. This cannot be undone."
    : "This removes all tracked items, watch history, and pending imports. Preferences and backups will be kept.";
  const confirmed = await requestInAppConfirmation(title, message, factoryReset ? "Factory reset" : "Clear data");
  if (!confirmed) return false;

  const encryptedStore = nativePlugin("EncryptedStore");
  const writes = [];
  if (encryptedStore?.deleteItem) state.items.forEach(item => { if (item?.id) writes.push(encryptedStore.deleteItem({ id: String(item.id) })); });
  if (encryptedStore?.setMeta) writes.push(encryptedStore.setMeta({ data: "{\"watchLog\":[],\"preferences\":{}}" }));
  state.items = [];
  state.watchLog = [];
  if (state.preferences) {
    state.preferences.metadataQueue = [];
    state.preferences.metadataQueuePaused = false;
  }
  saveData();
  await Promise.allSettled(writes);

  if (window.SquashDBCache) await window.SquashDBCache.clearTemporary();
  if (factoryReset) {
    Object.keys(localStorage).filter(key => key.startsWith("squashdb_")).forEach(key => localStorage.removeItem(key));
  }
  if (typeof showToast === "function") showToast(factoryReset ? "SquashDB was reset." : "All tracked data was cleared.", "success");
  setTimeout(() => window.location.reload(), 350);
  return true;
}

window.clearSquashDbData = clearSquashDbData;

function openChoicePopup(title, message, options, currentValue, onSelect) {
  const modal = document.getElementById("picker-modal");
  const list = document.getElementById("picker-options-list");
  const titleEl = document.getElementById("picker-modal-title");
  if (!modal || !list || !titleEl) return;

  titleEl.textContent = title;
  list.innerHTML = "";
  const description = document.createElement("p");
  description.className = "settings-row-note action-popup-message";
  description.textContent = message;
  list.appendChild(description);

  options.forEach(option => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `picker-option${String(option.value) === String(currentValue) ? " active" : ""}`;
    button.innerHTML = `<span class="choice-radio" aria-hidden="true"></span><span>${option.label}</span>`;
    button.addEventListener("click", async () => {
      list.querySelectorAll(".picker-option").forEach(row => row.classList.remove("active"));
      button.classList.add("active");
      try {
        await onSelect(option.value);
        closeSettingsPicker();
      } catch (err) {
        console.warn(`${title} selection failed`, err);
        description.textContent = err?.message || "This option could not be selected.";
        description.style.color = "var(--danger)";
      }
    });
    list.appendChild(button);
  });

  modal.classList.add("active");
  if (window.lucide) lucide.createIcons();
}

function closeSettingsPicker() {
  const modal = document.getElementById("picker-modal");
  if (modal) modal.classList.remove("active");
}

function renderCategoryOrderSettings() {
  const list = document.getElementById("category-order-list");
  if (!list) return;

  list.innerHTML = "";
  getEnabledOrderedCategories().forEach(key => {
    const item = document.createElement("div");
    item.className = "sortable-item";
    item.draggable = true;
    item.dataset.category = key;
    item.innerHTML = `
      <span class="drag-handle" aria-hidden="true">⋮⋮</span>
      <span class="sortable-label">${CATEGORIES[key].label}</span>
    `;
    list.appendChild(item);
  });

  let dragged = null;
  let pointerId = null;
  let captureTarget = null;
  let moved = false;
  const saveOrder = () => saveCategoryOrder(Array.from(list.querySelectorAll(".sortable-item")).map(el => el.dataset.category));
  const finishPointerDrag = (event) => {
    if (!dragged || (event?.pointerId !== undefined && event.pointerId !== pointerId)) return;
    dragged.classList.remove("dragging");
    if (moved) saveOrder();
    if (pointerId !== null && captureTarget?.hasPointerCapture?.(pointerId)) captureTarget.releasePointerCapture(pointerId);
    dragged = null;
    pointerId = null;
    captureTarget = null;
    moved = false;
  };
  document.addEventListener("pointerup", finishPointerDrag, true);
  document.addEventListener("pointercancel", finishPointerDrag, true);
  list.querySelectorAll(".sortable-item").forEach(item => {
    item.draggable = !window.matchMedia("(pointer: coarse)").matches;
    item.addEventListener("dragstart", () => {
      dragged = item;
      item.classList.add("dragging");
    });
    item.addEventListener("dragend", () => {
      item.classList.remove("dragging");
      dragged = null;
      const newOrder = Array.from(list.querySelectorAll(".sortable-item")).map(el => el.dataset.category);
      saveCategoryOrder(newOrder);
    });
    item.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (!dragged || dragged === item) return;
      const rect = item.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      list.insertBefore(dragged, after ? item.nextSibling : item);
    });
    const handle = item.querySelector(".drag-handle");
    handle?.addEventListener("pointerdown", (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      dragged = item;
      pointerId = event.pointerId;
      captureTarget = handle;
      moved = false;
      item.classList.add("dragging");
      handle.setPointerCapture?.(pointerId);
      event.preventDefault();
    });
    handle?.addEventListener("pointermove", (event) => {
      if (!dragged || event.pointerId !== pointerId) return;
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".sortable-item");
      if (!target || target.parentElement !== list || target === dragged) return;
      moved = true;
      const rect = target.getBoundingClientRect();
      list.insertBefore(dragged, event.clientY > rect.top + rect.height / 2 ? target.nextSibling : target);
      event.preventDefault();
    });
    handle?.addEventListener("pointerup", finishPointerDrag);
    handle?.addEventListener("pointercancel", finishPointerDrag);
  });

}

function renderTrackingChoicesSettings() {
  const container = document.getElementById("tracking-choices-list");
  if (!container) return;

  container.innerHTML = "";
  getOrderedCategories().forEach(cat => {
    const row = document.createElement("div");
    row.className = "setting-row";
    const deleteBtnHTML = CATEGORIES[cat].custom
      ? `<button type="button" class="note-action-btn delete-list-btn" data-cat="${cat}" title="Delete list"><i data-lucide="trash-2"></i></button>`
      : "";
    row.innerHTML = `
      <div class="setting-info">
        <span class="setting-label">${CATEGORIES[cat].label} Tracker</span>
        <span class="setting-desc">Track ${CATEGORIES[cat].label.toLowerCase()} progress</span>
      </div>
      ${deleteBtnHTML}
      <label class="switch">
        <input type="checkbox" id="pref-${cat}" ${state.preferences[cat] ? "checked" : ""}>
        <span class="slider"></span>
      </label>
    `;
    container.appendChild(row);
  });

  const createRow = document.createElement("button");
  createRow.type = "button";
  createRow.id = "create-list-btn";
  createRow.className = "btn btn-secondary";
  createRow.style.width = "100%";
  createRow.style.marginTop = "8px";
  createRow.innerHTML = `<i data-lucide="plus"></i> Create new list`;
  createRow.addEventListener("click", openCreateListModal);
  container.appendChild(createRow);

  container.querySelectorAll("input[type='checkbox']").forEach(checkbox => {
    const cat = checkbox.id.replace("pref-", "");
    checkbox.addEventListener("change", (e) => {
      state.preferences[cat] = e.target.checked;
      if (!e.target.checked && state.activeCategoryChip === cat) {
        state.activeCategoryChip = null;
      }
      saveData();
    });
  });

  container.querySelectorAll(".delete-list-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const cat = btn.dataset.cat;
      if (categoryHasItems(cat)) {
        alert("This list still has tracked items. Remove or move them first.");
        return;
      }
      if (!confirm(`Delete the "${CATEGORIES[cat].label}" list? This cannot be undone.`)) return;
      const result = deleteCustomCategory(cat);
      if (!result.ok) {
        alert(result.reason);
        return;
      }
      renderTrackingChoicesSettings();
      renderCategoryOrderSettings();
      lucide.createIcons();
    });
  });

  if (window.lucide) lucide.createIcons();
}

// Modal for creating a new custom tracking list
function openCreateListModal() {
  let modal = document.getElementById("create-list-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "create-list-modal";
    modal.className = "modal-overlay";
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3>Create New List</h3>
          <button type="button" class="modal-close-btn" id="create-list-close"><i data-lucide="x"></i></button>
        </div>
        <div class="form-group">
          <label for="new-list-name">List Name</label>
          <input type="text" id="new-list-name" class="form-control" placeholder="e.g. Board Games" maxlength="30">
        </div>
        <div class="form-group">
          <label>Icon</label>
          <div class="icon-picker-carousel-wrap"><div id="new-list-icon-picker" class="icon-picker-carousel"></div></div>
        </div>
        <div class="form-group">
          <label for="new-list-statuses">Statuses (comma separated)</label>
          <input type="text" id="new-list-statuses" class="form-control" value="${DEFAULT_CUSTOM_STATUSES.join(", ")}">
        </div>
        <button type="button" class="btn btn-primary" id="create-list-submit" style="width: 100%; margin-top: 8px;">Create List</button>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector("#create-list-close").addEventListener("click", () => modal.classList.remove("active"));
  }

  const iconPicker = modal.querySelector("#new-list-icon-picker");
  let selectedIcon = CATEGORY_ICON_CHOICES[0];
  iconPicker.innerHTML = "";
  CATEGORY_ICON_CHOICES.forEach((icon, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `icon-picker-option ${idx === 0 ? "active" : ""}`;
    btn.dataset.icon = icon;
    btn.innerHTML = `<i data-lucide="${icon}"></i>`;
    btn.addEventListener("click", () => {
      selectedIcon = icon;
      iconPicker.querySelectorAll(".icon-picker-option").forEach(b => b.classList.toggle("active", b === btn));
    });
    iconPicker.appendChild(btn);
  });
  const spacer = document.createElement("div");
  spacer.className = "icon-picker-carousel-spacer";
  iconPicker.appendChild(spacer);

  modal.querySelector("#new-list-name").value = "";
  modal.querySelector("#new-list-statuses").value = DEFAULT_CUSTOM_STATUSES.join(", ");

  const submitBtn = modal.querySelector("#create-list-submit");
  const newSubmitBtn = submitBtn.cloneNode(true);
  submitBtn.parentNode.replaceChild(newSubmitBtn, submitBtn);
  newSubmitBtn.addEventListener("click", () => {
    const name = modal.querySelector("#new-list-name").value.trim();
    if (!name) {
      alert("Please enter a list name.");
      return;
    }
    const statuses = modal.querySelector("#new-list-statuses").value
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
    createCustomCategory({ label: name, icon: selectedIcon, statuses });
    modal.classList.remove("active");
    renderTrackingChoicesSettings();
    renderCategoryOrderSettings();
  });

  modal.classList.add("active");
  lucide.createIcons();
}

function renderSettingsCards() {
  // Keep this lightweight on the standalone manage pages.
}

// Render dynamic quick filter category chips on dashboard top
function renderCategoryChips() {
  const container = document.getElementById("category-chips");
  if (!container) return;

  // Clear original contents
  container.innerHTML = "";

  // Render enabled chips
  getOrderedCategories().forEach(key => {
    if (state.preferences[key]) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `chip ${state.activeCategoryChip === key ? "active" : ""}`;
      chip.dataset.category = key;
      chip.setAttribute("aria-pressed", String(state.activeCategoryChip === key));
      chip.style.setProperty("--theme-color", CATEGORIES[key].color);
      chip.innerHTML = `<i data-lucide="${CATEGORIES[key].icon}"></i> ${CATEGORIES[key].label}`;
      chip.addEventListener("click", () => {
        state.activeCategoryChip = key;
        saveData();
        updateActiveChipUI();
        renderDashboard();
        renderTimeline();
        renderStats();
      });
      container.appendChild(chip);
    }
  });

  lucide.createIcons();
}

// Update UI active styles for selected category chip
function updateActiveChipUI() {
  const chips = document.querySelectorAll("#category-chips .chip");
  chips.forEach(chip => {
    chip.classList.toggle("active", chip.dataset.category === state.activeCategoryChip);
    chip.setAttribute("aria-pressed", String(chip.dataset.category === state.activeCategoryChip));
  });
}

// Render category select options inside Add Modal
function renderCategorySelectOptions() {
  const select = document.getElementById("entry-category");
  if (!select || select.tagName !== "SELECT") return;

  select.innerHTML = "";

  getOrderedCategories().forEach(key => {
    if (state.preferences[key]) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = CATEGORIES[key].label;
      select.appendChild(opt);
    }
  });

  if (select.options.length > 0) {
    if (select.querySelector(`option[value="${state.lastEntryCategory}"]`)) {
      select.value = state.lastEntryCategory;
    } else {
      select.value = select.options[0].value;
      state.lastEntryCategory = select.value;
      saveData();
    }
  }
}

const progressCache = new WeakMap();

// Compute progress percentage, reusing the result while progress inputs are unchanged.
function calculateProgress(item) {
  if (!item || typeof item !== "object") return 0;
  const signature = [item.category, item.status, item.seasonsDone, item.totalSeasons,
    item.episodesDone, item.totalEpisodes, item.seasonEpisodes, item.chaptersRead,
    item.totalChapters, item.volumesRead, item.totalVolumes].join("|");
  const cached = progressCache.get(item);
  if (cached?.signature === signature) return cached.value;
  const { category, status, seasonsDone, totalSeasons, episodesDone, totalEpisodes, chaptersRead, totalChapters } = item;
  let result = 0;
  
  if (status === "Completed") result = 100;

  if (!result && (category === "series" || category === "kdrama" || category === "cdrama" || category === "anime")) {
    // Prefer the true per-season episode counts (watched vs total across all
    // seasons); they reflect where the user actually is. Fall back to the flat
    // episodesDone/totalEpisodes counters, and only use the coarse
    // seasons-done/total-seasons ratio when there is no episode data at all.
    const seasonTotalEp = getSeasonTotalEpisodes(item);
    const seasonWatchedEp = getSeasonWatchedEpisodes(item);

    if (seasonTotalEp > 0) {
      result = Math.min(100, Math.round((seasonWatchedEp / seasonTotalEp) * 100));
    } else {
      const totalEp = parseInt(totalEpisodes) || 0;
      const doneEp = parseInt(episodesDone) || 0;
      if (totalEp > 0) {
        result = Math.min(100, Math.round((doneEp / totalEp) * 100));
      } else {
        const totalS = parseInt(totalSeasons) || 0;
        const doneS = parseInt(seasonsDone) || 0;
        if (totalS > 0) {
          result = Math.min(100, Math.round((doneS / totalS) * 100));
        }
      }
    }
  } else if (category === "manga" || category === "novel") {
    const totalCh = parseInt(totalChapters) || 0;
    const doneCh = parseInt(chaptersRead) || 0;
    const totalVol = parseInt(item.totalVolumes) || 0;
    const doneVol = parseInt(item.volumesRead) || 0;
    if (totalCh > 0) {
      result = Math.min(100, Math.round((doneCh / totalCh) * 100));
    } else if (totalVol > 0) {
      result = Math.min(100, Math.round((doneVol / totalVol) * 100));
    }
  }

  // A status-only estimate is useful for games and movies, but episodic
  // titles have exact watched/total counts and must remain at 0% until watched.
  const episodicCategory = category === "series" || category === "kdrama" || category === "cdrama" || category === "anime";
  if (!result && !episodicCategory && (status === "Playing" || status === "In Progress" || status === "Reading")) result = 50;
  progressCache.set(item, { signature, value: result });
  return result;
}

// Estimated time to finish an item, in minutes. Returns { total, remaining } or
// null if the category/item doesn't have enough data to estimate (e.g. no runtime
// set). "remaining" accounts for progress already made; "total" ignores it.
function calculateTimeToComplete(item) {
  const { category } = item;

  if (category === "series" || category === "kdrama" || category === "cdrama" || category === "anime") {
    const cachedRuntimes = Array.isArray(item.episodesCache)
      ? item.episodesCache.map(episode => Number(episode.runtime)).filter(runtime => runtime > 0)
      : [];
    const averageRuntime = cachedRuntimes.length
      ? Math.round(cachedRuntimes.reduce((sum, runtime) => sum + runtime, 0) / cachedRuntimes.length)
      : 0;
    const runtime = parseInt(item.episodeRuntime) || averageRuntime;
    if (runtime <= 0) return null;
    const totalEp = parseInt(item.totalEpisodes) || getSeasonTotalEpisodes(item) || 0;
    if (totalEp <= 0) return null;
    const doneEp = Math.min(totalEp, Math.max(
      parseInt(item.episodesDone) || 0,
      getSeasonWatchedEpisodes(item),
      Array.isArray(item.watchedEpisodeIds) ? item.watchedEpisodeIds.length : 0
    ));
    return {
      total: runtime * totalEp,
      remaining: item.status === "Completed" ? 0 : runtime * (totalEp - doneEp)
    };
  }

  if (category === "novel") {
    const minutesPerChapter = parseInt(item.minutesPerChapter) || 0;
    const totalCh = parseInt(item.totalChapters) || 0;
    if (minutesPerChapter <= 0 || totalCh <= 0) return null;
    const doneCh = Math.min(totalCh, parseInt(item.chaptersRead) || 0);
    return {
      total: minutesPerChapter * totalCh,
      remaining: item.status === "Completed" ? 0 : minutesPerChapter * (totalCh - doneCh)
    };
  }

  if (category === "movie") {
    const runtime = parseInt(item.playtime) || 0;
    if (runtime <= 0) return null;
    return {
      total: runtime,
      remaining: item.status === "Completed" ? 0 : runtime
    };
  }

  return null;
}

// Formats a minute count as e.g. "2h 15m", "45m", or "3h" for display.
function formatMinutesAsDuration(minutes) {
  const totalMinutes = Math.max(0, Math.round(minutes));
  const mins = totalMinutes % 60;
  let totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    return mins === 0 ? `${totalHours}h` : `${totalHours}h ${mins}m`;
  }

  const hours = totalHours % 24;
  let totalDays = Math.floor(totalHours / 24);
  if (totalDays < 30) {
    return hours === 0 ? `${totalDays}d` : `${totalDays}d ${hours}h`;
  }

  const days = totalDays % 30;
  let totalMonths = Math.floor(totalDays / 30);
  if (totalMonths < 12) {
    const parts = [`${totalMonths}mo`];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    return parts.join(" ");
  }

  const months = totalMonths % 12;
  const years = Math.floor(totalMonths / 12);
  const parts = [`${years}y`];
  if (months) parts.push(`${months}mo`);
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  return parts.join(" ");
}

// Render Dashboard Note Cards
// True when the status filter actually applies to the active category —
// a leftover filter from another category's status set is treated as off.
function dashboardStatusFilterActive() {
  return Boolean(state.statusFilter && state.statusFilter !== "all"
    && (CATEGORIES[state.activeCategoryChip]?.statuses || []).includes(state.statusFilter));
}

function updateDashboardFilterButton() {
  const btn = document.getElementById("dashboard-filter-btn");
  if (!btn) return;
  const count = Number(Boolean(dashboardStatusFilterActive()))
    + Number(Boolean(state.dashboardFilters?.status))
    + Number(Boolean(state.dashboardFilters?.unwatched))
    + Number(Boolean(state.dashboardFilters?.recentlyAdded))
    + Number(Boolean(state.dashboardFilters?.rated));
  btn.classList.toggle("active", count > 0);
  const badge = document.getElementById("dashboard-filter-count");
  if (badge) {
    badge.textContent = String(count);
    badge.hidden = count === 0;
  }
  btn.setAttribute("aria-label", count ? `Sort and filter your library, ${count} active` : "Sort and filter your library");
}

function dashboardFiltersActive() {
  return Boolean(state.dashboardFilters?.status || state.dashboardFilters?.unwatched
    || state.dashboardFilters?.recentlyAdded || state.dashboardFilters?.rated);
}

function saveDashboardViewState() {
  localStorage.setItem("squashdb_dashboard_filters", JSON.stringify(state.dashboardFilters));
  localStorage.setItem("squashdb_sort", state.currentSort);
}

function recordSearchHistory(value) {
  const query = String(value || "").trim().toLowerCase();
  if (query.length < 2) return;
  state.searchHistory = [query, ...(state.searchHistory || []).filter(entry => entry !== query)].slice(0, 8);
  localStorage.setItem("squashdb_search_history", JSON.stringify(state.searchHistory));
  renderSearchHistory();
}

function escapeSearchHistoryText(value) {
  return String(value || "").replace(/[&<>\"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
  }[character]));
}

function renderSearchHistory() {
  const root = document.getElementById("dashboard-search-history");
  const input = document.getElementById("global-search");
  if (!root || !input) return;
  const entries = (state.searchHistory || []).filter(entry => !state.searchQuery || entry.includes(state.searchQuery));
  if (document.activeElement !== input || !entries.length || state.searchQuery) {
    root.style.display = "none";
    root.innerHTML = "";
    return;
  }
  root.innerHTML = `<div class="dashboard-search-history-header"><span>Recent searches</span><button type="button" data-clear-history>Clear</button></div>${entries.map(entry => `<button type="button" class="dashboard-search-history-item" data-search-history="${escapeSearchHistoryText(entry)}"><i data-lucide="history"></i><span>${escapeSearchHistoryText(entry)}</span></button>`).join("")}`;
  root.style.display = "block";
  root.querySelectorAll("[data-search-history]").forEach(button => button.addEventListener("click", () => {
    input.value = button.dataset.searchHistory;
    state.searchQuery = input.value.toLowerCase().trim();
    const clearButton = document.getElementById("dashboard-search-clear");
    if (clearButton) clearButton.hidden = !input.value;
    root.style.display = "none";
    renderDashboard();
  }));
  root.querySelector("[data-clear-history]")?.addEventListener("click", () => {
    state.searchHistory = [];
    localStorage.removeItem("squashdb_search_history");
    renderSearchHistory();
  });
  if (window.lucide) lucide.createIcons();
}

function dashboardReleaseTime(item) {
  const value = item.releaseDate || item.premiered || item.firstAirDate || item.release_date || item.publishedDate;
  const time = value ? Date.parse(value) : 0;
  return Number.isNaN(time) ? 0 : time;
}

function dashboardHasUnwatched(item) {
  if (item.status === "Completed") return false;
  if (Array.isArray(item.episodesCache) && item.episodesCache.length) {
    return item.episodesCache.some(episode => !(item.watchedEpisodeIds || []).includes(episode.id));
  }
  const total = parseInt(item.totalEpisodes || item.totalChapters || item.totalVolumes, 10) || 0;
  const done = parseInt(item.episodesDone || item.chaptersRead || item.volumesRead, 10) || 0;
  return total > done || ["In Progress", "Playing", "Reading"].includes(item.status);
}

function dashboardGroupKey(item, groupBy = state.preferences.dashboardGroupBy) {
  if (groupBy === "status") return item.status || "Uncategorized";
  if (groupBy === "category") return CATEGORIES[item.category]?.label || item.category || "Uncategorized";
  if (groupBy === "release") {
    const release = dashboardReleaseTime(item);
    return release
      ? new Date(release).toLocaleDateString(undefined, { year: "numeric", month: "long" })
      : "No release date";
  }
  return "All items";
}

function dashboardStatusGroupRank(status) {
  if (["In Progress", "Playing", "Reading"].includes(status)) return 0;
  if (["Watchlist", "Backlog", "Playlist", "Plan to Read", "Plan to Watch", "Want to Play"].includes(status)) return 1;
  if (status === "On Hold") return 2;
  if (status === "Dropped") return 3;
  if (status === "Completed") return 4;
  return 5;
}

function compareDashboardGroups(a, b, groupBy) {
  const aKey = dashboardGroupKey(a, groupBy);
  const bKey = dashboardGroupKey(b, groupBy);
  if (aKey === bKey) return 0;
  if (groupBy === "status") {
    const rank = dashboardStatusGroupRank(aKey) - dashboardStatusGroupRank(bKey);
    return rank || aKey.localeCompare(bKey);
  }
  if (groupBy === "release") {
    const releaseOrder = dashboardReleaseTime(b) - dashboardReleaseTime(a);
    return releaseOrder || aKey.localeCompare(bKey);
  }
  return aKey.localeCompare(bKey);
}

function compareDashboardItemsBySort(a, b) {
  if (state.currentSort === "alphabetical-asc") return a.title.localeCompare(b.title);
  if (state.currentSort === "alphabetical-desc") return b.title.localeCompare(a.title);
  if (state.currentSort === "created-desc") {
    return (Number(b.created) || 0) - (Number(a.created) || 0);
  }
  if (state.currentSort === "updated-desc") {
    return (Number(b.updated || b.lastUpdated || b.created) || 0) - (Number(a.updated || a.lastUpdated || a.created) || 0);
  }
  if (state.currentSort === "created-asc") return (Number(a.created) || 0) - (Number(b.created) || 0);
  if (state.currentSort === "progress-desc") return calculateProgress(b) - calculateProgress(a);
  if (state.currentSort === "progress-asc") return calculateProgress(a) - calculateProgress(b);
  if (state.currentSort === "rating-desc") return (Number(b.rating) || 0) - (Number(a.rating) || 0);
  if (state.currentSort === "release-desc") return dashboardReleaseTime(b) - dashboardReleaseTime(a);
  return 0;
}

function renderDashboardFilterChips() {
  const root = document.getElementById("dashboard-filter-chips");
  if (!root) return;
  const active = [];
  const statusLabels = { "in-progress": "In progress", completed: "Completed" };
  if (state.dashboardFilters.status) active.push([state.dashboardFilters.status, statusLabels[state.dashboardFilters.status]]);
  if (state.dashboardFilters.unwatched) active.push(["unwatched", "Unfinished"]);
  if (state.dashboardFilters.recentlyAdded) active.push(["recentlyAdded", "Recently added"]);
  if (state.dashboardFilters.rated) active.push(["rated", "Rated"]);
  if (dashboardStatusFilterActive()) active.push(["category-status", state.statusFilter]);
  root.innerHTML = active.map(([key, label]) => `<button type="button" class="dashboard-filter-chip" data-remove-dashboard-filter="${key}" aria-label="Remove ${label} filter">${label}<i data-lucide="x"></i></button>`).join("");
  root.querySelectorAll("[data-remove-dashboard-filter]").forEach(button => button.addEventListener("click", () => {
    const key = button.dataset.removeDashboardFilter;
    if (key === "category-status") state.statusFilter = "all";
    else if (key === "in-progress" || key === "completed") state.dashboardFilters.status = "";
    else state.dashboardFilters[key] = false;
    saveDashboardViewState();
    renderDashboard();
  }));
  if (window.lucide) lucide.createIcons();
}

function openDashboardRefineSheet(openSection = "") {
  const modal = document.getElementById("picker-modal");
  const list = document.getElementById("picker-options-list");
  const titleEl = document.getElementById("picker-modal-title");
  if (!modal || !list) return;
  const savedScrollTop = modal.classList.contains("active") ? list.scrollTop : 0;
  if (titleEl) titleEl.textContent = "Refine collection";
  const close = document.getElementById("picker-modal-close");
  if (close) close.innerHTML = '<i data-lucide="x"></i>';
  const sortOptions = [
    ["updated-desc", "Recently updated"], ["created-desc", "Recently added"],
    ["progress-desc", "Most progress"], ["progress-asc", "Least progress"],
    ["rating-desc", "Highest rated"], ["release-desc", "Newest release"],
    ["alphabetical-asc", "Title A–Z"], ["alphabetical-desc", "Title Z–A"]
  ];
  const sortSection = document.createElement("div");
  sortSection.className = "picker-section-label";
  sortSection.textContent = "Sort by";
  list.replaceChildren(sortSection);
  const sortRow = document.createElement("div");
  sortRow.className = "dashboard-sort-options";
  sortRow.innerHTML = sortOptions.map(([value, label]) => `<button type="button" class="dashboard-sort-option${state.currentSort === value ? " active" : ""}" data-sort-value="${value}" aria-pressed="${state.currentSort === value}">${label}</button>`).join("");
  list.appendChild(sortRow);
  sortRow.querySelectorAll("[data-sort-value]").forEach(button => button.addEventListener("click", () => {
    state.currentSort = button.dataset.sortValue;
    saveDashboardViewState();
    renderDashboard();
    openDashboardRefineSheet();
  }));
  const filterSection = document.createElement("div");
  filterSection.className = "picker-section-label";
  filterSection.textContent = "Show me";
  list.appendChild(filterSection);
  [["in-progress", "In progress"], ["completed", "Completed"], ["unwatched", "Unfinished"], ["recentlyAdded", "Recently added"], ["rated", "Rated"]].forEach(([key, label]) => {
    const active = key === "in-progress" || key === "completed"
      ? state.dashboardFilters.status === key : Boolean(state.dashboardFilters[key]);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `dashboard-refine-toggle${active ? " active" : ""}`;
    button.setAttribute("aria-pressed", String(active));
    button.innerHTML = `<span>${label}</span><span class="dashboard-refine-check"><i data-lucide="check"></i></span>`;
    button.addEventListener("click", () => {
      if (key === "in-progress" || key === "completed") {
        state.dashboardFilters.status = state.dashboardFilters.status === key ? "" : key;
        state.statusFilter = "all";
      }
      else state.dashboardFilters[key] = !state.dashboardFilters[key];
      saveDashboardViewState();
      renderDashboard();
      openDashboardRefineSheet();
    });
    list.appendChild(button);
  });
  const statuses = CATEGORIES[state.activeCategoryChip]?.statuses || [];
  if (statuses.length) {
    const label = document.createElement("div");
    label.className = "picker-section-label";
    label.textContent = "Category status";
    list.appendChild(label);
    const select = document.createElement("select");
    select.className = "dashboard-status-select";
    select.setAttribute("aria-label", "Filter by category status");
    const specificStatuses = statuses.filter(status => !["Completed", "In Progress", "Playing", "Reading"].includes(status)
      || (dashboardStatusFilterActive() && status === state.statusFilter));
    select.innerHTML = `<option value="all">All statuses</option>` + specificStatuses.map(status => `<option value="${status.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")}">${status.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</option>`).join("");
    select.value = dashboardStatusFilterActive() ? state.statusFilter : "all";
    select.addEventListener("change", () => {
      state.statusFilter = select.value;
      state.dashboardFilters.status = "";
      renderDashboard();
      openDashboardRefineSheet();
    });
    list.appendChild(select);
  }

  if (dashboardFiltersActive() || dashboardStatusFilterActive()) {
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "dashboard-refine-clear";
    clear.textContent = "Clear all filters";
    clear.addEventListener("click", () => {
      state.dashboardFilters = { status: "", unwatched: false, recentlyAdded: false, rated: false };
      state.statusFilter = "all";
      saveDashboardViewState();
      renderDashboard();
      openDashboardRefineSheet();
    });
    list.appendChild(clear);
  }

  const viewLabels = {
    list: "List", "compact-list": "Compact list", grid: "Poster grid",
    "compact-grid": "Compact grid", "detailed-grid": "Detailed grid", table: "Table",
    "minimal-list": "Minimal list", "large-grid": "Large poster grid",
    kanban: "Kanban board", timeline: "Timeline"
  };
  const viewDescriptions = {
    list: "Cover, title and progress", "compact-list": "Short rows with the essentials",
    grid: "Browse your collection by poster", "detailed-grid": "Poster, full title and item details",
    "compact-grid": "Fit more labeled posters on screen", table: "Compare titles, status and progress",
    "minimal-list": "A clean, text-first list", "large-grid": "Larger posters with readable titles",
    kanban: "Status lanes stack on phones", timeline: "Browse by release date"
  };
  const viewIcons = {
    list: "list", "compact-list": "list-filter", grid: "layout-grid",
    "detailed-grid": "gallery-vertical-end", "compact-grid": "grid-2x2",
    table: "table-2", "minimal-list": "align-left", "large-grid": "images",
    kanban: "columns-3", timeline: "calendar-range"
  };
  const viewDetails = document.createElement("details");
  viewDetails.className = "dashboard-refine-group";
  viewDetails.open = openSection === "view";
  viewDetails.innerHTML = `<summary><span>View &amp; layout</span><small>${viewLabels[state.preferences.dashboardView] || "List"}</small></summary>`;
  const viewBody = document.createElement("div");
  viewBody.className = "dashboard-refine-group-body";
  const commonViews = [["list", "List"], ["compact-list", "Compact list"], ["grid", "Poster grid"], ["detailed-grid", "Detailed grid"]];
  const addViewChoice = ([value, label], parent) => {
    const button = document.createElement("button");
    const selected = state.preferences.dashboardView === value;
    button.type = "button";
    button.className = `dashboard-view-choice${selected ? " active" : ""}`;
    button.setAttribute("aria-pressed", String(selected));
    const title = document.createElement("strong");
    title.textContent = label;
    const description = document.createElement("small");
    description.textContent = viewDescriptions[value];
    const icon = document.createElement("i");
    icon.dataset.lucide = viewIcons[value] || "layout-grid";
    button.append(icon, Object.assign(document.createElement("span"), { className: "dashboard-view-copy" }));
    button.querySelector(".dashboard-view-copy").append(title, description);
    const check = document.createElement("span");
    check.className = "dashboard-view-check";
    check.innerHTML = '<i data-lucide="check"></i>';
    button.appendChild(check);
    button.addEventListener("click", () => {
      state.preferences.dashboardView = value;
      saveData();
      renderDashboard();
      openDashboardRefineSheet("view");
    });
    parent.appendChild(button);
  };
  const commonGrid = document.createElement("div");
  commonGrid.className = "dashboard-view-grid";
  commonViews.forEach(option => addViewChoice(option, commonGrid));
  viewBody.appendChild(commonGrid);
  const advancedViews = [["compact-grid", "Compact grid"], ["table", "Table"], ["minimal-list", "Minimal list"], ["large-grid", "Large poster grid"], ["kanban", "Kanban board"], ["timeline", "Timeline"]];
  const moreViews = document.createElement("details");
  moreViews.className = "dashboard-more-layouts";
  moreViews.open = ["compact-grid", "table", "minimal-list", "large-grid", "kanban", "timeline"].includes(state.preferences.dashboardView);
  moreViews.innerHTML = `<summary><span>More layouts</span><small>Table, board &amp; more</small></summary>`;
  const moreGrid = document.createElement("div");
  moreGrid.className = "dashboard-view-grid";
  advancedViews.forEach(option => addViewChoice(option, moreGrid));
  moreViews.appendChild(moreGrid);
  viewBody.appendChild(moreViews);
  viewDetails.appendChild(viewBody);
  list.appendChild(viewDetails);

  const themeLabels = {
    light: "Light", dark: "Dark", grey: "Grey", amoled: "AMOLED", flashbang: "Flashbang", "material-you": "Material You",
    ocean: "Ocean", forest: "Forest", sunset: "Sunset", rose: "Rose", lavender: "Lavender", nord: "Nord", sand: "Sand", mint: "Mint"
  };
  const appearanceDetails = document.createElement("details");
  appearanceDetails.className = "dashboard-refine-group";
  appearanceDetails.open = openSection === "appearance";
  appearanceDetails.innerHTML = `<summary><span>Appearance &amp; display</span><small>${themeLabels[state.preferences.uiTheme] || "Dark"}</small></summary>`;
  const appearanceBody = document.createElement("div");
  appearanceBody.className = "dashboard-refine-group-body dashboard-appearance-options";
  const addSelectSetting = (label, value, options, onChange) => {
    const row = document.createElement("label");
    row.className = "dashboard-refine-setting";
    const name = document.createElement("span");
    name.textContent = label;
    const setting = document.createElement("select");
    setting.setAttribute("aria-label", label);
    options.forEach(([optionValue, optionLabel]) => {
      const option = document.createElement("option");
      option.value = optionValue;
      option.textContent = optionLabel;
      setting.appendChild(option);
    });
    setting.value = value;
    setting.addEventListener("change", () => onChange(setting.value));
    row.append(name, setting);
    appearanceBody.appendChild(row);
  };
  addSelectSetting("Theme", state.preferences.uiTheme || "dark", Object.entries(themeLabels), value => {
    state.preferences.uiTheme = value;
    state.theme = value;
    saveData();
    applyTheme();
    applyPreferenceAttributes();
    renderDashboard();
    openDashboardRefineSheet("appearance");
  });
  addSelectSetting("Density", state.preferences.dashboardDensity, [["comfortable", "Comfortable"], ["compact", "Compact"]], value => {
    state.preferences.dashboardDensity = value;
    saveData();
    renderDashboard();
    openDashboardRefineSheet("appearance");
  });
  addSelectSetting("Group by", state.preferences.dashboardGroupBy, [["none", "No grouping"], ["status", "Status"], ["release", "Release date"]], value => {
    state.preferences.dashboardGroupBy = value;
    saveData();
    renderDashboard();
    openDashboardRefineSheet("appearance");
  });
  [["dashboardShowRatings", "Show ratings"], ["dashboardShowProgress", "Show progress"], ["dashboardShowThumbnails", "Show thumbnails"]].forEach(([key, label]) => {
    const row = document.createElement("button");
    const enabled = Boolean(state.preferences[key]);
    row.type = "button";
    row.className = `dashboard-refine-toggle dashboard-display-toggle${enabled ? " active" : ""}`;
    row.setAttribute("aria-pressed", String(enabled));
    row.innerHTML = `<span>${label}</span><span class="dashboard-refine-check"><i data-lucide="check"></i></span>`;
    row.addEventListener("click", () => {
      state.preferences[key] = !state.preferences[key];
      saveData();
      renderDashboard();
      openDashboardRefineSheet("appearance");
    });
    appearanceBody.appendChild(row);
  });
  appearanceDetails.appendChild(appearanceBody);
  list.appendChild(appearanceDetails);

  modal.classList.add("active");
  list.scrollTop = Math.min(savedScrollTop, Math.max(0, list.scrollHeight - list.clientHeight));
  if (window.lucide) lucide.createIcons();
}

function renderDashboardSkeleton() {
  const container = document.getElementById("notes-container");
  const emptyState = document.getElementById("dashboard-empty");
  if (!container) return;
  if (emptyState) emptyState.style.display = "none";
  container.style.display = "flex";
  container.classList.remove("notes-grid-view");
  container.innerHTML = Array.from({ length: 5 }, () => `
    <div class="dashboard-skeleton-card" aria-hidden="true">
      <span class="dashboard-skeleton-thumb"></span>
      <span class="dashboard-skeleton-lines"><i></i><i></i><i></i></span>
    </div>
  `).join("");
}

function dashboardUsesGridView() {
  return ["grid", "compact-grid", "detailed-grid", "large-grid"].includes(state.preferences.dashboardView);
}

function dashboardCategoryItems() {
  return state.items.filter(item => item.category === state.activeCategoryChip && state.preferences[item.category]);
}

function nextEpisodeForDashboardItem(item) {
  const episodes = Array.isArray(item.episodesCache) ? item.episodesCache : [];
  if (!episodes.length) return null;
  const watched = new Set(item.watchedEpisodeIds || []);
  return episodes
    .filter(episode => !watched.has(episode.id))
    .sort((a, b) => {
      const season = (parseInt(a.season) || 0) - (parseInt(b.season) || 0);
      return season || ((parseInt(a.number) || 0) - (parseInt(b.number) || 0));
    })[0] || null;
}

function progressRingHTML(progress, className = "") {
  const value = Math.max(0, Math.min(100, Number(progress) || 0));
  return `<span class="dashboard-progress-ring ${className}" style="--progress:${value}%" aria-label="${value}% complete"><span>${value}%</span></span>`;
}

function dashboardThumbnail(item, className) {
  return state.preferences.dashboardShowThumbnails
    ? thumbnailOrPlaceholder(item.thumbnail, className)
    : `<span class="${className} dashboard-thumb-hidden" aria-hidden="true"></span>`;
}

function dashboardInsightCard(item, label, extra = "") {
  const isStatusOnly = item.category === "movie" || item.category === "game";
  const isTable = state.preferences.dashboardView === "table";
  const progress = isStatusOnly ? 0 : calculateProgress(item);
  const movieRating = state.preferences.dashboardShowRatings
    ? (Number(item.rating) > 0 ? `Rating: ${formatRatingValue(item.rating)}` : "Unrated") : "";
  return `
    <button type="button" class="dashboard-insight-card${isStatusOnly ? " dashboard-status-only-card" : ""}${isTable ? " dashboard-table-row" : ""}" data-id="${item.id}">
      ${dashboardThumbnail(item, "dashboard-insight-thumb")}
      <span class="dashboard-insight-body"><strong>${item.title}</strong><small>${isStatusOnly ? (movieRating || item.status || "") : `${label}${extra ? ` · ${extra}` : ""}`}</small></span>
      ${isTable ? `<span class="dashboard-table-status">${item.status || "—"}</span><span class="dashboard-table-value">${isStatusOnly ? (movieRating || "—") : (state.preferences.dashboardShowProgress ? `${progress}%` : "—")}</span>` : (isStatusOnly ? `<span class="dashboard-status-pill">${item.status || "Unrated"}</span>` : (state.preferences.dashboardShowProgress ? progressRingHTML(progress) : ""))}
    </button>
  `;
}

function renderDashboardInsights() {
  const root = document.getElementById("dashboard-insights");
  if (!root) return;
  if (document.body.classList.contains("dashboard-screen")) {
    root.innerHTML = "";
    root.style.display = "none";
    return;
  }
  root.dataset.view = dashboardUsesGridView() ? "grid" : "list";
  root.dataset.layout = state.preferences.dashboardView;
  root.dataset.density = state.preferences.dashboardDensity;
  const items = dashboardCategoryItems();
  const visible = !state.searchQuery
    && !dashboardStatusFilterActive()
    && !dashboardFiltersActive()
    && !["kanban", "timeline"].includes(state.preferences.dashboardView);
  if (!visible || !items.length) {
    root.innerHTML = "";
    root.style.display = "none";
    return;
  }

  const continueItems = items
    .filter(item => item.status !== "Completed" && (calculateProgress(item) > 0 || ["In Progress", "Playing", "Reading"].includes(item.status)))
    .sort((a, b) => (b.updated || b.created || 0) - (a.updated || a.created || 0));
  const continueIds = new Set(continueItems.map(item => item.id));
  const completedItems = items
    .filter(item => item.status === "Completed")
    .sort((a, b) => String(b.completionDate || b.updated || "").localeCompare(String(a.completionDate || a.updated || "")));
  const completedIds = new Set(completedItems.map(item => item.id));
  const notStartedItems = items
    .filter(item => item.status !== "Completed"
      && calculateProgress(item) <= 0
      && !["Dropped", "On Hold"].includes(item.status)
      && !["In Progress", "Playing", "Reading"].includes(item.status))
    .sort((a, b) => (Number(b.created || b.updated) || 0) - (Number(a.created || a.updated) || 0));
  const onHoldItems = items
    .filter(item => item.status === "On Hold")
    .sort((a, b) => (Number(b.updated || b.created) || 0) - (Number(a.updated || a.created) || 0));
  const droppedItems = items
    .filter(item => item.status === "Dropped")
    .sort((a, b) => (Number(b.updated || b.created) || 0) - (Number(a.updated || a.created) || 0));
  const notStartedIds = new Set(notStartedItems.map(item => item.id));
  const onHoldIds = new Set(onHoldItems.map(item => item.id));
  const droppedIds = new Set(droppedItems.map(item => item.id));
  const staleCutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
  const staleItems = items
    .filter(item => {
      const lastUpdated = Number(item.updated || item.created || 0);
      return !continueIds.has(item.id) && !completedIds.has(item.id) && !notStartedIds.has(item.id)
        && !onHoldIds.has(item.id) && !droppedIds.has(item.id)
        && !["Dropped", "On Hold"].includes(item.status)
        && lastUpdated > 0 && lastUpdated < staleCutoff;
    })
    .sort((a, b) => (Number(a.updated || a.created) || 0) - (Number(b.updated || b.created) || 0));

  const categorizedIds = new Set([
    ...continueItems, ...completedItems, ...notStartedItems, ...onHoldItems, ...droppedItems, ...staleItems
  ].map(item => item.id));
  const otherItems = items.filter(item => !categorizedIds.has(item.id));
  const recentlyAddedItems = [...items]
    .sort((a, b) => (Number(b.created || b.updated) || 0) - (Number(a.created || a.updated) || 0))
    .slice(0, Number(state.preferences.recentlyAddedLimit) || 10);

  const staleLabel = item => {
    const days = Math.max(1, Math.floor((Date.now() - Number(item.updated || item.created || Date.now())) / (24 * 60 * 60 * 1000)));
    return `${days} days since update`;
  };

  const tableHeader = state.preferences.dashboardView === "table"
    ? '<div class="dashboard-table-header"><span>Title</span><span>Status</span><span>Rating / Progress</span></div>' : "";
  const section = (title, content, className = "") => content ? `<section class="dashboard-insight-section ${className}"><h3>${title}</h3>${tableHeader}<div class="dashboard-insight-scroller">${content}</div></section>` : "";
  root.innerHTML = [
    section("Continue watching", continueItems.map(item => dashboardInsightCard(item, item.status, `${calculateProgress(item)}%`)).join(""), "continue"),
    section("Not started yet", notStartedItems.map(item => dashboardInsightCard(item, item.status || "No progress yet", "Ready to start")).join(""), "not-started"),
    section("On hold", onHoldItems.map(item => dashboardInsightCard(item, item.status)).join(""), "on-hold"),
    section("Dropped", droppedItems.map(item => dashboardInsightCard(item, item.status)).join(""), "dropped"),
    section("Haven't updated in a long time", staleItems.map(item => dashboardInsightCard(item, item.status, staleLabel(item))).join(""), "stale"),
    section("Completed", completedItems.map(item => dashboardInsightCard(item, item.completionDate || "Completed")).join(""), "completed"),
    section("Other", otherItems.map(item => dashboardInsightCard(item, item.status || "No status")).join(""), "other"),
    section("Recently added", recentlyAddedItems.map(item => dashboardInsightCard(item, item.status || "Added recently")).join(""), "recently-added")
  ].join("");
  root.dataset.insightItemIds = JSON.stringify([...new Set([
    ...continueItems.map(item => item.id),
    ...notStartedItems.map(item => item.id),
    ...onHoldItems.map(item => item.id),
    ...droppedItems.map(item => item.id),
    ...staleItems.map(item => item.id),
    ...completedItems.map(item => item.id),
    ...otherItems.map(item => item.id),
    ...recentlyAddedItems.map(item => item.id)
  ])]);
  root.style.display = root.innerHTML ? "block" : "none";
  root.querySelectorAll(".dashboard-insight-card").forEach(card => card.addEventListener("click", () => openItemForCategory(card.dataset.id)));
  if (window.lucide) lucide.createIcons();
}

function setupDashboardPullToRefresh() {
  const dashboard = document.getElementById("tab-dashboard");
  const status = document.getElementById("dashboard-refresh-status");
  if (!dashboard || dashboard.dataset.pullBound === "true") return;
  dashboard.dataset.pullBound = "true";
  let startY = 0;
  let pulling = false;
  dashboard.addEventListener("touchstart", event => {
    const scrollTop = document.querySelector("main")?.scrollTop || window.scrollY || 0;
    if (scrollTop > 2 || document.querySelector(".modal-overlay.active")) return;
    startY = event.touches[0].clientY;
    pulling = true;
  }, { passive: true });
  dashboard.addEventListener("touchmove", event => {
    if (!pulling) return;
    const distance = Math.max(0, Math.min(90, event.touches[0].clientY - startY));
    dashboard.style.setProperty("--dashboard-pull-distance", `${distance}px`);
    dashboard.classList.toggle("dashboard-pulling", distance > 0);
  }, { passive: true });
  dashboard.addEventListener("touchend", async event => {
    if (!pulling) return;
    pulling = false;
    const distance = event.changedTouches[0].clientY - startY;
    dashboard.classList.remove("dashboard-pulling");
    dashboard.style.removeProperty("--dashboard-pull-distance");
    if (distance < 64) return;
    if (status) status.textContent = "Refreshing metadata and images…";
    try {
      // Keep metadata and image caches during normal refresh. Cache clearing is
      // an explicit Settings action so pull-to-refresh remains fast and does
      // not force every thumbnail to download and decode again.
      renderDashboard();
      if (status) status.textContent = "Dashboard refreshed";
    } catch (err) {
      if (status) status.textContent = "Refresh failed — your saved data is safe";
    }
    setTimeout(() => { if (status) status.textContent = ""; }, 1800);
  }, { passive: true });
}

function renderDashboard() {
  const container = document.getElementById("notes-container");
  const emptyState = document.getElementById("dashboard-empty");
  if (!container) return;
  updateDashboardFilterButton();
  renderDashboardFilterChips();
  renderDashboardInsights();

  container.innerHTML = "";

  if (!state.activeCategoryChip) {
    const firstEnabled = getOrderedCategories().find(key => state.preferences[key]);
    if (firstEnabled) {
      state.activeCategoryChip = firstEnabled;
      saveData();
      renderDashboardInsights();
    } else {
      emptyState.style.display = "flex";
      container.style.display = "none";
      return;
    }
  }

  const insightRoot = document.getElementById("dashboard-insights");
  let insightItemIds = new Set();
  try {
    const ids = JSON.parse(insightRoot?.dataset.insightItemIds || "[]");
    insightItemIds = new Set(Array.isArray(ids) ? ids : []);
  } catch (err) {
    insightItemIds = new Set();
  }
  const insightsAreActive = Boolean(
    insightRoot?.style.display !== "none"
    && !state.searchQuery
    && !dashboardStatusFilterActive()
    && !dashboardFiltersActive()
  );

  // 1. Filter items based on active preferences, quick filter chip, and search query
  const dashboardCacheKey = JSON.stringify([dashboardDataVersion, state.activeCategoryChip,
    state.searchQuery, state.statusFilter, state.dashboardFilters, state.currentSort,
    state.preferences.dashboardView, state.preferences.dashboardGroupBy, [...insightItemIds].sort()]);
  let filtered;
  if (renderDashboard._cache?.key === dashboardCacheKey) {
    filtered = renderDashboard._cache.items;
  } else {
    filtered = state.items.filter(item => {
    // Check if category is enabled in settings
    if (!state.preferences[item.category]) return false;
    
    // Check quick filter chip selection
    if (item.category !== state.activeCategoryChip) return false;

    // Insight cards are the primary view for these items. Keep the regular
    // list/grid for anything not represented above so dashboard data is not
    // shown twice.
    if (insightsAreActive && insightItemIds.has(item.id)) return false;
    
    // Check search query matches Title or Notes
    if (state.searchQuery) {
      if (!searchIndexMatches(item, state.searchQuery)) return false;
    }

    // Status filter from the search-bar funnel button. A filter carried over
    // from another category's status set is ignored rather than hiding everything.
    if (state.statusFilter && state.statusFilter !== "all"
      && (CATEGORIES[state.activeCategoryChip]?.statuses || []).includes(state.statusFilter)
      && item.status !== state.statusFilter) return false;

    const quick = state.dashboardFilters || {};
    if (quick.status === "in-progress" && !["In Progress", "Playing", "Reading"].includes(item.status)) return false;
    if (quick.status === "completed" && item.status !== "Completed") return false;
    if (quick.unwatched && !dashboardHasUnwatched(item)) return false;
    if (quick.recentlyAdded && (Date.now() - (Number(item.created) || 0)) > 30 * 24 * 60 * 60 * 1000) return false;
    if (quick.rated && !(Number(item.rating) > 0)) return false;

      return true;
    });

  // Keep status/category sections stable while applying the selected sort
  // within each section.
    filtered.sort((a, b) => {
      const groupBy = state.preferences.dashboardGroupBy;
      return (groupBy !== "none" ? compareDashboardGroups(a, b, groupBy) : 0)
        || compareDashboardItemsBySort(a, b);
    });
    renderDashboard._cache = { key: dashboardCacheKey, items: filtered };
  }

  // 3. Grouped layouts render complete status sections; ungrouped layouts use
  // the bounded scroll window in setupDashboardLazyLoad.
  if (filtered.length === 0) {
    if (insightsAreActive) {
      emptyState.style.display = "none";
      container.style.display = "none";
      teardownDashboardLazyLoad();
      return;
    }
    emptyState.style.display = "flex";
    container.style.display = "none";
    renderDashboardEmptyState();
    teardownDashboardLazyLoad();
  } else {
    emptyState.style.display = "none";
    const isGrid = dashboardUsesGridView();
    container.style.display = isGrid ? "grid" : "flex";
    container.classList.toggle("notes-grid-view", isGrid);
    container.classList.toggle("notes-compact-view", state.preferences.dashboardView === "compact-list");
    container.classList.toggle("notes-detailed-grid-view", state.preferences.dashboardView === "detailed-grid");
    container.classList.toggle("notes-compact-grid-view", state.preferences.dashboardView === "compact-grid");
    container.classList.toggle("notes-large-grid-view", state.preferences.dashboardView === "large-grid");
    container.classList.toggle("notes-table-view", state.preferences.dashboardView === "table");
    container.classList.toggle("notes-minimal-view", state.preferences.dashboardView === "minimal-list");
    container.classList.remove("dashboard-special-view");
    container.classList.toggle("dashboard-density-compact", state.preferences.dashboardDensity === "compact");
    container.dataset.rowActions = state.preferences.dashboardRowActions || "menu";
    if (!isGrid && dashboardSelectedIds.size > 0) {
      clearGridSelection();
    }
    updateGridSelectionBar();
    if (["kanban", "timeline"].includes(state.preferences.dashboardView)) {
      setupDashboardSpecialView(container, filtered);
    } else if (state.preferences.dashboardGroupBy !== "none") {
      setupDashboardGroupedView(container, filtered);
    } else {
      setupDashboardLazyLoad(container, filtered);
    }
  }
}

function renderDashboardEmptyState() {
  const title = document.getElementById("dashboard-empty-title");
  const message = document.getElementById("dashboard-empty-message");
  const suggestions = document.getElementById("dashboard-empty-suggestions");
  if (!title || !message || !suggestions) return;
  const search = Boolean(state.searchQuery);
  const filters = dashboardFiltersActive() || dashboardStatusFilterActive();
  title.textContent = search ? "No matching items" : filters ? "No items match these filters" : "No Items Found";
  message.textContent = search
    ? "Try a shorter search, a different spelling, or search by notes, tags, genre, or provider."
    : filters ? "Clear a filter or choose another category to see more of your library."
      : "Tap the floating \"+\" button to add games, movies, series, or books to your list.";
  const actions = [];
  if (search) actions.push(`<button type="button" class="btn btn-secondary" data-empty-action="search">Clear search</button>`);
  if (filters) actions.push(`<button type="button" class="btn btn-secondary" data-empty-action="filters">Clear filters</button>`);
  suggestions.innerHTML = actions.join("");
  suggestions.querySelector('[data-empty-action="search"]')?.addEventListener("click", () => {
    const input = document.getElementById("global-search");
    if (input) input.value = "";
    state.searchQuery = "";
    renderDashboard();
  });
  suggestions.querySelector('[data-empty-action="filters"]')?.addEventListener("click", () => {
    state.dashboardFilters = { status: "", unwatched: false, recentlyAdded: false, rated: false };
    state.statusFilter = "all";
    saveDashboardViewState();
    renderDashboard();
  });
}

const DASHBOARD_BATCH_SIZE = 30;
// Keep at most this many batches materialised in the DOM at once. Off-screen
// batches above/below the window are removed and replaced with spacer elements
// that preserve scroll height, so the live node count stays bounded no matter
// how large the library is (true windowing, not just incremental append).
const DASHBOARD_MAX_LIVE_BATCHES = 5;
let dashboardLazyLoadObserver = null;
let dashboardGridSelectionMode = false;
let dashboardSelectedIds = new Set();

function setupDashboardSpecialView(container, filtered) {
  teardownDashboardLazyLoad();
  container.innerHTML = "";
  const view = state.preferences.dashboardView;
  container.className = `notes-container dashboard-special-view ${view === "kanban" ? "dashboard-kanban-view" : "dashboard-timeline-view"}`;
  const groupBy = state.preferences.dashboardGroupBy;
  const effectiveGroupBy = groupBy === "none" ? (view === "kanban" ? "status" : view === "timeline" ? "release" : "none") : groupBy;
  container.setAttribute("role", "region");
  container.setAttribute("aria-label", view === "kanban"
    ? "Kanban board, scroll horizontally between statuses"
    : "Timeline grouped by release date");
  const groups = new Map();
  filtered.forEach(item => {
    const key = effectiveGroupBy === "none" ? "All items" : dashboardGroupKey(item, effectiveGroupBy);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  let orderedGroups = Array.from(groups.entries());
  if (view === "kanban" && effectiveGroupBy === "status") {
    orderedGroups.sort(([a], [b]) => {
      return dashboardStatusGroupRank(a) - dashboardStatusGroupRank(b) || a.localeCompare(b);
    });
  } else if (view === "timeline" && effectiveGroupBy === "release") {
    orderedGroups.sort(([a], [b]) => {
      if (a === "No release date") return 1;
      if (b === "No release date") return -1;
      return (Date.parse(b) || 0) - (Date.parse(a) || 0);
    });
  }
  orderedGroups.forEach(([title, items]) => {
    const group = document.createElement("section");
    group.className = `dashboard-special-group ${view === "kanban" ? "dashboard-kanban-column" : "dashboard-timeline-group"}`;
    group.innerHTML = `<h3>${title}<span>${items.length}</span></h3><div class="dashboard-special-items"></div>`;
    const list = group.querySelector(".dashboard-special-items");
    items.forEach(item => list.appendChild(buildNoteCard(item)));
    container.appendChild(group);
  });
  attachCardEvents();
  if (window.lucide) lucide.createIcons(container);
}

function buildDashboardCardForCurrentView(item) {
  if (["grid", "compact-grid", "large-grid"].includes(state.preferences.dashboardView)) return buildGridCard(item);
  if (state.preferences.dashboardView === "detailed-grid") return buildDetailedGridCard(item);
  if (state.preferences.dashboardView === "table") return buildTableCard(item);
  const card = buildNoteCard(item);
  if (state.preferences.dashboardView === "compact-list") card.classList.add("compact-list-card");
  return card;
}

function setupDashboardGroupedView(container, filtered) {
  teardownDashboardLazyLoad();
  container.innerHTML = "";
  const groupBy = state.preferences.dashboardGroupBy;
  const groups = new Map();
  if (groupBy === "status") {
    const statuses = [...(CATEGORIES[state.activeCategoryChip]?.statuses || [])];
    statuses.sort((a, b) => dashboardStatusGroupRank(a) - dashboardStatusGroupRank(b) || a.localeCompare(b));
    statuses.forEach(status => groups.set(status, []));
  }
  filtered.forEach(item => {
    const key = dashboardGroupKey(item, groupBy);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });

  const filtersNarrowResults = Boolean(state.searchQuery || dashboardFiltersActive() || dashboardStatusFilterActive());
  const entries = [...groups.entries()].filter(([, items]) => items.length || !filtersNarrowResults);
  if (groupBy === "status") {
    entries.sort(([a], [b]) => dashboardStatusGroupRank(a) - dashboardStatusGroupRank(b) || a.localeCompare(b));
  }

  if (state.preferences.dashboardView === "table") {
    const header = document.createElement("div");
    header.className = "dashboard-main-table-header";
    header.innerHTML = "<span></span><span>Title</span><span>Status</span><span>Rating</span><span>Progress</span>";
    container.appendChild(header);
  }

  entries.forEach(([groupKey, items]) => {
    const section = document.createElement("details");
    section.className = "dashboard-group-section";
    section.dataset.groupKey = groupKey;
    section.open = true;

    const heading = document.createElement("summary");
    heading.className = "dashboard-group-heading";
    const label = document.createElement("span");
    label.textContent = groupKey;
    const count = document.createElement("span");
    count.className = "dashboard-group-count";
    count.textContent = String(items.length);
    heading.append(label, count);

    const itemList = document.createElement("div");
    itemList.className = "dashboard-group-items";
    items.forEach(item => itemList.appendChild(buildDashboardCardForCurrentView(item)));
    section.append(heading, itemList);
    container.appendChild(section);
  });

  attachCardEvents();
  if (window.lucide) lucide.createIcons(container);
}

// Grid view: poster-only card with a progress strip along the bottom edge —
// full purple bar for completed items, green partial bar for anything the
// user has started or is actively on, no bar for untouched queue entries.
function buildGridCard(item) {
  const card = document.createElement("div");
  card.className = "grid-card";
  if (dashboardSelectedIds.has(item.id)) card.classList.add("grid-card-selected");
  card.dataset.id = item.id;

  const progress = calculateProgress(item);
  const isCompleted = item.status === "Completed";
  const activeStatuses = new Set(["In Progress", "Playing", "Reading", "On Hold"]);
  const started = progress > 0 || activeStatuses.has(item.status);
  let barHTML = "";
  if (isCompleted) {
    barHTML = `<div class="grid-card-bar grid-card-bar-complete"></div>`;
  } else if (started) {
    barHTML = `<div class="grid-card-bar grid-card-bar-progress" style="width:${Math.max(progress, 6)}%"></div>`;
  }

  card.innerHTML = `
    ${dashboardThumbnail(item, "grid-card-thumb")}
    ${state.preferences.dashboardShowProgress ? `<div class="grid-card-progress">${progressRingHTML(progress)}</div>` : ""}
    ${barHTML ? `<div class="grid-card-bar-track">${barHTML}</div>` : ""}
    <div class="grid-card-select-overlay">
      <div class="grid-card-select-check"><i data-lucide="check"></i></div>
    </div>
  `;
  const title = document.createElement("strong");
  title.className = "grid-card-title";
  title.textContent = item.title || "Untitled";
  card.setAttribute("aria-label", item.title || "Untitled");
  card.title = item.title || "Untitled";
  card.appendChild(title);
  return card;
}

function buildDetailedGridCard(item) {
  const card = document.createElement("div");
  const isStatusOnly = item.category === "movie" || item.category === "game";
  const isCompleted = item.status === "Completed";
  const progress = isStatusOnly ? 0 : calculateProgress(item);
  const subtitle = isCompleted ? (item.completionDate || "Completed") : (item.status || "No status");
  const rating = Number(item.rating) > 0 ? formatRatingValue(item.rating) : "Unrated";
  card.className = `grid-card detailed-grid-card${isCompleted ? " completed" : ""}`;
  card.dataset.id = item.id;
  card.innerHTML = `
    ${dashboardThumbnail(item, "detailed-grid-thumb")}
    <div class="detailed-grid-body">
      <strong>${item.title}</strong>
      <small>${subtitle}</small>
      <span class="detailed-grid-meta">${isStatusOnly ? (state.preferences.dashboardShowRatings ? `Rating: ${rating}` : item.status || "") : (state.preferences.dashboardShowProgress ? `${progress}% complete` : "")}</span>
    </div>
    ${isStatusOnly ? `<span class="dashboard-status-pill">${item.status || "Unrated"}</span>` : (state.preferences.dashboardShowProgress ? progressRingHTML(progress) : "")}
    <div class="grid-card-select-overlay">
      <div class="grid-card-select-check"><i data-lucide="check"></i></div>
    </div>
  `;
  return card;
}

function buildTableCard(item) {
  const card = document.createElement("div");
  const isStatusOnly = item.category === "movie" || item.category === "game";
  const progress = isStatusOnly ? 0 : calculateProgress(item);
  const rating = Number(item.rating) > 0 ? formatRatingValue(item.rating) : "—";
  card.className = "note-card table-card";
  card.dataset.id = item.id;
  card.innerHTML = `
    ${dashboardThumbnail(item, "table-card-thumb")}
    <strong class="table-card-title">${item.title}</strong>
    <span class="table-card-status">${item.status || "—"}</span>
    <span class="table-card-rating">${state.preferences.dashboardShowRatings ? rating : "—"}</span>
    <span class="table-card-progress">${isStatusOnly || !state.preferences.dashboardShowProgress ? "—" : `${progress}%`}</span>
  `;
  return card;
}

function buildNoteCard(item) {
  const card = document.createElement("div");
  const isCompleted = item.status === "Completed";
  card.className = `note-card dashboard-insight-card ${isCompleted ? "completed" : ""}`;
  if (state.preferences.dashboardView === "minimal-list") card.classList.add("minimal-list-card");
  card.dataset.id = item.id;

  const progress = calculateProgress(item);
  const subtitle = isCompleted ? (item.completionDate || "Completed") : item.status;

  card.innerHTML = `
    ${dashboardThumbnail(item, "dashboard-insight-thumb")}
    <span class="dashboard-insight-body"><strong>${item.title}</strong><small>${subtitle}</small></span>
    ${state.preferences.dashboardShowProgress ? progressRingHTML(progress) : ""}
  `;
  return card;
}

// Holds the state for the currently windowed dashboard render so scroll
// observers can add/remove batches. Reset on each renderDashboard().
let dashboardWindow = null;

function teardownDashboardLazyLoad() {
  if (dashboardLazyLoadObserver) {
    dashboardLazyLoadObserver.disconnect();
    dashboardLazyLoadObserver = null;
  }
  dashboardWindow = null;
}

// Virtualised list: only a bounded window of batches is kept in the DOM at any
// time. As the user scrolls down, the next batch is appended and, once the
// window exceeds DASHBOARD_MAX_LIVE_BATCHES, the top batch is removed and its
// height is preserved by a top spacer. Scrolling back up restores earlier
// batches. This keeps the live node count constant for arbitrarily large
// libraries instead of growing without bound.
function setupDashboardLazyLoad(container, filtered) {
  teardownDashboardLazyLoad();
  container.innerHTML = "";

  const isGrid = dashboardUsesGridView();
  const totalBatches = Math.ceil(filtered.length / DASHBOARD_BATCH_SIZE);

  if (state.preferences.dashboardView === "table") {
    const header = document.createElement("div");
    header.className = "dashboard-main-table-header";
    header.innerHTML = "<span></span><span>Title</span><span>Status</span><span>Rating</span><span>Progress</span>";
    container.appendChild(header);
  }

  // Spacers stand in for removed batches so the scrollbar height is stable.
  const topSpacer = document.createElement("div");
  topSpacer.className = "dashboard-window-spacer dashboard-window-spacer-top";
  const bottomSpacer = document.createElement("div");
  bottomSpacer.className = "dashboard-window-spacer dashboard-window-spacer-bottom";
  const topSentinel = document.createElement("div");
  topSentinel.className = "dashboard-lazy-sentinel dashboard-lazy-sentinel-top";
  const bottomSentinel = document.createElement("div");
  bottomSentinel.className = "dashboard-lazy-sentinel dashboard-lazy-sentinel-bottom";

  container.appendChild(topSpacer);
  container.appendChild(topSentinel);
  container.appendChild(bottomSentinel);
  container.appendChild(bottomSpacer);

  // firstBatch..lastBatch (inclusive) are the batch indexes currently in the DOM.
  const win = { firstBatch: 0, lastBatch: -1, batchHeights: {}, container,
    topSpacer, bottomSpacer, topSentinel, bottomSentinel, isGrid };
  dashboardWindow = win;

  const buildBatchFragment = (batchIndex) => {
    const start = batchIndex * DASHBOARD_BATCH_SIZE;
    const items = filtered.slice(start, start + DASHBOARD_BATCH_SIZE);
    const wrapper = document.createElement("div");
    wrapper.className = "dashboard-batch";
    wrapper.dataset.batch = String(batchIndex);
    // Grid needs the wrapper to participate in the grid; use display:contents
    // so batch wrappers don't break the CSS grid/flex layout of the cards.
    wrapper.style.display = "contents";
    items.forEach(item => wrapper.appendChild(buildDashboardCardForCurrentView(item)));
    return wrapper;
  };

  const afterMutate = () => {
    attachCardEvents();
    if (window.lucide) lucide.createIcons(container);
  };

  // A display:contents wrapper has no box of its own, so measure a batch by the
  // vertical span of its child cards (top of first card → bottom of last card).
  const measureBatchHeight = (batchEl) => {
    const cards = batchEl.children;
    if (!cards.length) return 0;
    const first = cards[0].getBoundingClientRect();
    const last = cards[cards.length - 1].getBoundingClientRect();
    return Math.max(0, Math.round(last.bottom - first.top));
  };

  const appendBottomBatch = () => {
    if (win.lastBatch + 1 >= totalBatches) return false;
    const batchIndex = win.lastBatch + 1;
    const wrapper = buildBatchFragment(batchIndex);
    container.insertBefore(wrapper, win.bottomSentinel);
    win.lastBatch = batchIndex;
    afterMutate();

    // Trim from the top if the window grew too large; preserve height via spacer.
    while (win.lastBatch - win.firstBatch + 1 > DASHBOARD_MAX_LIVE_BATCHES) {
      const topEl = container.querySelector(`.dashboard-batch[data-batch="${win.firstBatch}"]`);
      if (!topEl) break;
      win.batchHeights[win.firstBatch] = measureBatchHeight(topEl);
      topEl.remove();
      win.firstBatch += 1;
      const topPad = Object.keys(win.batchHeights)
        .filter(k => Number(k) < win.firstBatch)
        .reduce((sum, k) => sum + (win.batchHeights[k] || 0), 0);
      win.topSpacer.style.height = `${topPad}px`;
    }
    return true;
  };

  const prependTopBatch = () => {
    if (win.firstBatch <= 0) return false;
    const batchIndex = win.firstBatch - 1;
    const wrapper = buildBatchFragment(batchIndex);
    container.insertBefore(wrapper, win.topSentinel.nextSibling);
    win.firstBatch = batchIndex;
    // Shrink the top spacer by the height we no longer need to fake.
    const topPad = Object.keys(win.batchHeights)
      .filter(k => Number(k) < win.firstBatch)
      .reduce((sum, k) => sum + (win.batchHeights[k] || 0), 0);
    win.topSpacer.style.height = `${topPad}px`;
    afterMutate();

    // Trim from the bottom if over budget.
    while (win.lastBatch - win.firstBatch + 1 > DASHBOARD_MAX_LIVE_BATCHES) {
      const botEl = container.querySelector(`.dashboard-batch[data-batch="${win.lastBatch}"]`);
      if (!botEl) break;
      win.batchHeights[win.lastBatch] = measureBatchHeight(botEl);
      botEl.remove();
      win.lastBatch -= 1;
    }
    const bottomPad = Object.keys(win.batchHeights)
      .filter(k => Number(k) > win.lastBatch)
      .reduce((sum, k) => sum + (win.batchHeights[k] || 0), 0);
    win.bottomSpacer.style.height = `${bottomPad}px`;
    return true;
  };

  win.appendBottomBatch = appendBottomBatch;
  win.prependTopBatch = prependTopBatch;

  // Seed the first batch.
  appendBottomBatch();

  if (totalBatches > 1) {
    dashboardLazyLoadObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        if (entry.target === win.bottomSentinel) appendBottomBatch();
        else if (entry.target === win.topSentinel) prependTopBatch();
      });
    }, { root: container.closest("main"), rootMargin: "600px" });
    dashboardLazyLoadObserver.observe(win.bottomSentinel);
    dashboardLazyLoadObserver.observe(win.topSentinel);
  }
}

function setDashboardGridSelectionMode(enabled) {
  dashboardGridSelectionMode = enabled;
  const bar = document.getElementById("grid-selection-bar");
  if (bar) bar.style.display = enabled && dashboardSelectedIds.size > 0 ? "flex" : "none";
  document.querySelectorAll(".grid-card").forEach(card => {
    card.classList.toggle("grid-card-selected", dashboardSelectedIds.has(card.dataset.id));
  });
  attachCardEvents();
}

function updateGridSelectionBar() {
  const bar = document.getElementById("grid-selection-bar");
  const countEl = document.getElementById("grid-selection-count");
  const count = dashboardSelectedIds.size;
  if (countEl) countEl.textContent = `${count} selected`;
  if (bar) bar.style.display = dashboardGridSelectionMode && count > 0 ? "flex" : "none";
}

function clearGridSelection() {
  dashboardGridSelectionMode = false;
  dashboardSelectedIds.clear();
  updateGridSelectionBar();
  document.querySelectorAll(".grid-card").forEach(card => card.classList.remove("grid-card-selected"));
  attachCardEvents();
}

function toggleGridSelection(id, forceSelect = null) {
  if (forceSelect === true) dashboardSelectedIds.add(id);
  else if (forceSelect === false) dashboardSelectedIds.delete(id);
  else if (dashboardSelectedIds.has(id)) dashboardSelectedIds.delete(id);
  else dashboardSelectedIds.add(id);

  dashboardGridSelectionMode = dashboardSelectedIds.size > 0;
  updateGridSelectionBar();
  document.querySelectorAll(`.grid-card[data-id="${id}"]`).forEach(card => {
    card.classList.toggle("grid-card-selected", dashboardSelectedIds.has(id));
  });
}

function deleteSelectedGridItems() {
  if (dashboardSelectedIds.size === 0) return;
  const ids = Array.from(dashboardSelectedIds);
  if (!confirm(`Delete ${ids.length} selected item(s)? You can undo this for a short time.`)) return;
  deleteItemsWithUndo(ids);
  clearGridSelection();
}

// Generate stars icon HTML for note cards
function getStarsHTML(rating) {
  let stars = `<div class="detail-item" style="color: var(--color-manga);">`;
  for (let i = 1; i <= 5; i++) {
    if (i <= rating) {
      stars += `<i data-lucide="star" style="fill: currentColor; width: 12px; height: 12px;"></i>`;
    } else {
      stars += `<i data-lucide="star" style="width: 12px; height: 12px;"></i>`;
    }
  }
  stars += `</div>`;
  return stars;
}

// Render Timeline completed history items
function setupTimelineAdvancedFilter() {
  const openBtn = document.getElementById("timeline-advanced-filter-btn");
  const modal = document.getElementById("timeline-filter-modal");
  const closeBtn = document.getElementById("timeline-filter-close");
  const applyBtn = document.getElementById("timeline-filter-apply");
  const clearBtn = document.getElementById("timeline-filter-clear");
  const searchInput = document.getElementById("timeline-filter-search");
  const monthSelect = document.getElementById("timeline-filter-month");
  const yearSelect = document.getElementById("timeline-filter-year");
  if (!openBtn || !modal) return;

  const close = () => modal.classList.remove("active");

  openBtn.addEventListener("click", () => {
    // Populate years from completed items' dates
    const years = new Set(
      state.items
        .filter(item => item.completionDate)
        .map(item => new Date(item.completionDate).getFullYear())
    );
    yearSelect.innerHTML = '<option value="">Any Year</option>' +
      Array.from(years).sort((a, b) => b - a).map(y => `<option value="${y}">${y}</option>`).join("");

    searchInput.value = state.timelineSearch;
    monthSelect.value = state.timelineMonth;
    yearSelect.value = state.timelineYear;

    modal.classList.add("active");
  });

  closeBtn.addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });

  applyBtn.addEventListener("click", () => {
    state.timelineSearch = searchInput.value.trim();
    state.timelineMonth = monthSelect.value;
    state.timelineYear = yearSelect.value;
    saveData();
    renderTimeline();
    close();
  });

  clearBtn.addEventListener("click", () => {
    searchInput.value = "";
    monthSelect.value = "";
    yearSelect.value = "";
    state.timelineSearch = "";
    state.timelineMonth = "";
    state.timelineYear = "";
    saveData();
    renderTimeline();
    close();
  });
}

function renderTimeline() {
  const container = document.getElementById("timeline-container");
  const emptyState = document.getElementById("timeline-empty");
  if (!container) return;

  container.innerHTML = "";

  const activeCategory = state.activeCategoryChip || localStorage.getItem("squashdb_category_chip");

  // 1. Gather and filter only completed items with a date
  let completedItems = state.items.filter(item => {
    if (activeCategory && item.category !== activeCategory) return false;
    return item.status === "Completed" && item.completionDate && state.preferences[item.category];
  });

  // Apply Date Filter range selection
  const now = new Date();
  
  // Calculate start of current week (assuming Monday start)
  const currentDay = now.getDay();
  const distanceToMonday = currentDay === 0 ? 6 : currentDay - 1;
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - distanceToMonday).getTime();
  
  // Start of current month
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  completedItems = completedItems.filter(item => {
    const compTime = new Date(item.completionDate).getTime();

    if (state.timelineFilter === "week") {
      return compTime >= weekStart;
    } else if (state.timelineFilter === "month") {
      return compTime >= monthStart;
    }
    return true;
  });

  // Advanced filters: search by name, specific month, specific year
  if (state.timelineSearch) {
    const q = state.timelineSearch.toLowerCase();
    completedItems = completedItems.filter(item => item.title.toLowerCase().includes(q));
  }
  if (state.timelineMonth !== "" && state.timelineMonth !== null && state.timelineMonth !== undefined) {
    const month = parseInt(state.timelineMonth);
    completedItems = completedItems.filter(item => new Date(item.completionDate).getMonth() === month);
  }
  if (state.timelineYear) {
    const year = parseInt(state.timelineYear);
    completedItems = completedItems.filter(item => new Date(item.completionDate).getFullYear() === year);
  }

  // 2. Sort by completion date descending
  completedItems.sort((a, b) => {
    return new Date(b.completionDate) - new Date(a.completionDate);
  });

  if (completedItems.length === 0) {
    emptyState.style.display = "flex";
    container.style.display = "none";
    teardownTimelineLazyLoad();
    return;
  }

  emptyState.style.display = "none";
  container.style.display = "block";

  setupTimelineLazyLoad(container, completedItems);
}

const TIMELINE_BATCH_SIZE = 30;
let timelineLazyLoadObserver = null;

function teardownTimelineLazyLoad() {
  if (timelineLazyLoadObserver) {
    timelineLazyLoadObserver.disconnect();
    timelineLazyLoadObserver = null;
  }
}

// Renders completedItems in batches (grouped by month), appending more as a
// sentinel scrolls into view, instead of building every timeline entry at once.
function setupTimelineLazyLoad(container, completedItems) {
  teardownTimelineLazyLoad();
  container.innerHTML = "";

  let renderedCount = 0;
  let currentMonth = "";
  let monthGroup = null;
  const sentinel = document.createElement("div");
  sentinel.className = "dashboard-lazy-sentinel";

  function renderNextBatch() {
    const nextItems = completedItems.slice(renderedCount, renderedCount + TIMELINE_BATCH_SIZE);
    if (nextItems.length === 0) return;

    nextItems.forEach(item => {
      const monthYear = new Date(item.completionDate).toLocaleString("default", { month: "long", year: "numeric" });

      if (monthYear !== currentMonth) {
        currentMonth = monthYear;
        monthGroup = document.createElement("div");
        monthGroup.className = "timeline-month-group";
        monthGroup.innerHTML = `
          <div class="timeline-month-marker">
            <span class="timeline-month-dot" style="--theme-color: ${CATEGORIES[item.category].color}"></span>
            <span class="timeline-month-title">${currentMonth}</span>
          </div>
          <div class="timeline-month-items"></div>
        `;
        container.insertBefore(monthGroup, sentinel);
      }

      const tItem = document.createElement("div");
      tItem.className = "timeline-item";
      tItem.style.setProperty("--theme-color", CATEGORIES[item.category].color);
      tItem.innerHTML = `
        ${thumbnailOrPlaceholder(item.thumbnail, "timeline-item-thumb")}
        <div class="timeline-item-content">
          <span class="timeline-item-text">${item.title}</span>
          <span class="timeline-item-meta">Completed on ${formatDate(item.completionDate)}</span>
        </div>
      `;
      monthGroup.querySelector(".timeline-month-items").appendChild(tItem);
    });

    renderedCount += nextItems.length;
    lucide.createIcons();

    if (renderedCount >= completedItems.length) {
      teardownTimelineLazyLoad();
      sentinel.remove();
    }
  }

  container.appendChild(sentinel);
  renderNextBatch();

  if (renderedCount < completedItems.length) {
    timelineLazyLoadObserver = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) renderNextBatch();
    }, { root: null, rootMargin: "400px" });
    timelineLazyLoadObserver.observe(sentinel);
  }
}

// Render Statistics dashboard
function renderStats() {
  const totalEl = document.getElementById("stats-total");
  const completedEl = document.getElementById("stats-completed");
  const activeEl = document.getElementById("stats-active");
  const queuedEl = document.getElementById("stats-queued");
  const rateEl = document.getElementById("stats-rate");
  const timeLeftCard = document.getElementById("stats-time-left-card");
  const timeLeftEl = document.getElementById("stats-time-left");
  const timeDoneCard = document.getElementById("stats-time-done-card");
  const timeDoneEl = document.getElementById("stats-time-done");

  if (!totalEl) return;

  const activeCategory = state.activeCategoryChip || localStorage.getItem("squashdb_category_chip") || getOrderedCategories().find(key => state.preferences[key]);
  if (activeCategory && !state.activeCategoryChip) {
    state.activeCategoryChip = activeCategory;
    saveData();
  }

  // Filter items in enabled categories and selected category
  const activeItems = state.items.filter(item => state.preferences[item.category] && (!activeCategory || item.category === activeCategory));
  const completedItems = activeItems.filter(item => item.status === "Completed");
  const inProgressItems = activeItems.filter(item => item.status === "Playing" || item.status === "In Progress" || item.status === "Reading");
  const queuedStatuses = new Set(["Watchlist", "Playlist", "Backlog", "Plan to Read", "Plan to Watch", "Want to Play"]);
  const queuedItems = activeItems.filter(item => queuedStatuses.has(item.status));
  const onHoldItems = activeItems.filter(item => item.status === "On Hold");
  const droppedItems = activeItems.filter(item => item.status === "Dropped");

  const totalCount = activeItems.length;
  const completedCount = completedItems.length;
  const activeCount = inProgressItems.length;
  const queuedCount = queuedItems.length;
  const rate = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  totalEl.textContent = totalCount;
  completedEl.textContent = completedCount;
  activeEl.textContent = activeCount;
  if (queuedEl) queuedEl.textContent = queuedCount;
  const onHoldEl = document.getElementById("stats-on-hold");
  const droppedEl = document.getElementById("stats-dropped");
  if (onHoldEl) onHoldEl.textContent = onHoldItems.length;
  if (droppedEl) droppedEl.textContent = droppedItems.length;
  rateEl.textContent = `${rate}%`;

  // Time-to-complete aggregates: only shown when at least one item in the
  // active view has enough data (runtime/reading speed) to estimate from.
  let minutesLeft = 0;
  let minutesDone = 0;
  let hasEstimableItem = false;
  activeItems.forEach(item => {
    const time = calculateTimeToComplete(item);
    if (!time) return;
    hasEstimableItem = true;
    minutesLeft += time.remaining;
    minutesDone += (time.total - time.remaining);
  });

  if (timeLeftCard && timeLeftEl) {
    timeLeftCard.style.display = hasEstimableItem ? "flex" : "none";
    timeLeftEl.textContent = formatMinutesAsDuration(minutesLeft);
  }
  if (timeDoneCard && timeDoneEl) {
    timeDoneCard.style.display = hasEstimableItem ? "flex" : "none";
    timeDoneEl.textContent = formatMinutesAsDuration(minutesDone);
  }

  const activeItemIds = new Set(activeItems.map(item => item.id));
  renderStatsGenres(activeItems);
  renderStatsNetworks(activeItems);
  renderStatsRatings(activeItems);
  renderStatsWatchCharts(activeItemIds, activeItems);
}

// Top genres leaderboard, scoped to whatever category chip is active. Genres
// are only captured going forward (see show-detail.js), so older tracked
// items may simply have no genres array yet.
function renderStatsGenres(activeItems) {
  const card = document.getElementById("stats-genres-card");
  const chart = document.getElementById("stats-genres-chart");
  if (!card || !chart) return;

  const counts = {};
  activeItems.forEach(item => {
    (item.genres || []).forEach(g => {
      counts[g] = (counts[g] || 0) + 1;
    });
  });

  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (entries.length === 0) {
    card.style.display = "none";
    return;
  }

  card.style.display = "flex";
  const max = entries[0][1];
  chart.innerHTML = entries.map(([genre, count]) => `
    <div class="bar-item">
      <div class="bar-labels"><span>${genre}</span><span>${count}</span></div>
      <div class="bar-bg"><div class="bar-fill" style="width:${Math.round((count / max) * 100)}%; background: var(--primary);"></div></div>
    </div>
  `).join("");
}

function renderStatsNetworks(activeItems) {
  const card = document.getElementById("stats-networks-card");
  const chart = document.getElementById("stats-networks-chart");
  if (!card || !chart) return;

  const counts = {};
  activeItems.forEach(item => {
    if (item.network) counts[item.network] = (counts[item.network] || 0) + 1;
  });

  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (entries.length === 0) {
    card.style.display = "none";
    return;
  }

  card.style.display = "flex";
  const max = entries[0][1];
  chart.innerHTML = entries.map(([network, count]) => `
    <div class="bar-item">
      <div class="bar-labels"><span>${network}</span><span>${count}</span></div>
      <div class="bar-bg"><div class="bar-fill" style="width:${Math.round((count / max) * 100)}%; background: var(--primary);"></div></div>
    </div>
  `).join("");
}

// Local single-user equivalent of a "voted ratings" card: your own average
// rating and a top-rated leaderboard, scoped to the active category.
function renderStatsRatings(activeItems) {
  const card = document.getElementById("stats-ratings-card");
  const avgEl = document.getElementById("stats-avg-rating");
  const countEl = document.getElementById("stats-rated-count");
  const listEl = document.getElementById("stats-top-rated-list");
  if (!card || !avgEl || !countEl || !listEl) return;

  const ratedItems = activeItems.filter(item => item.rating > 0);
  if (ratedItems.length === 0) {
    card.style.display = "none";
    return;
  }

  card.style.display = "flex";
  const avg = ratedItems.reduce((sum, item) => sum + item.rating, 0) / ratedItems.length;
  avgEl.textContent = formatRatingValue(avg);
  countEl.textContent = ratedItems.length;

  const topRated = [...ratedItems].sort((a, b) => b.rating - a.rating).slice(0, 5);
  listEl.innerHTML = topRated.map(item => `
    <div class="leaderboard-row">
      <span class="leaderboard-row-title">${item.title}</span>
      <span class="leaderboard-row-meta">${formatRatingValue(item.rating)}</span>
    </div>
  `).join("");
}

// Weekly time-series (hours + episode count) built from state.watchLog, plus
// a "biggest marathons" leaderboard (most episodes of one show in a single
// day). Only reflects episodes ticked after watch-logging shipped.
function renderStatsWatchCharts(activeItemIds, activeItems = []) {
  const timeCard = document.getElementById("stats-weekly-time-card");
  const timeChart = document.getElementById("stats-weekly-time-chart");
  const epCard = document.getElementById("stats-weekly-episodes-card");
  const epChart = document.getElementById("stats-weekly-episodes-chart");
  const marathonsCard = document.getElementById("stats-marathons-card");
  const marathonsList = document.getElementById("stats-marathons-list");
  if (!timeCard || !timeChart || !epCard || !epChart || !marathonsCard || !marathonsList) return;

  const watchLog = (state.watchLog || []).filter(entry => activeItemIds.has(entry.itemId));
  // Imported and older items may not have watch-log rows. Use their last
  // update as a lightweight activity event until real watch events exist.
  const log = watchLog.length ? watchLog : activeItems
    .filter(item => activeItemIds.has(item.id) && Number(item.updated || item.created) > 0)
    .map(item => ({
      itemId: item.id,
      title: item.title,
      watchedAt: item.updated || item.created,
      runtime: Number(item.episodeRuntime || item.playtime) || 1,
      derived: true
    }));
  const hasActivity = log.length > 0;

  const dayTotals = {}; // "itemId|YYYY-MM-DD" -> { title, count }
  const now = new Date();
  log.forEach(entry => {
    const dayKey = `${entry.itemId}|${new Date(entry.watchedAt).toISOString().slice(0, 10)}`;
    if (!dayTotals[dayKey]) dayTotals[dayKey] = { title: entry.title, count: 0, minutes: 0 };
    dayTotals[dayKey].count += 1;
    dayTotals[dayKey].minutes += entry.runtime || 0;
  });

  timeCard.style.display = "flex";
  epCard.style.display = "flex";
  if (!hasActivity) {
    const emptyMessage = '<div class="stats-chart-empty">No activity recorded for this category yet.</div>';
    timeChart.innerHTML = emptyMessage;
    epChart.innerHTML = emptyMessage;
    marathonsCard.style.display = "none";
    return;
  }
  // Weekly graph: one bar per day for the current Monday-Sunday week.
  const dayOfWeek = (now.getDay() + 6) % 7;
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek);
  const weekBuckets = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + index);
    return { date, minutes: 0, episodes: 0 };
  });
  log.forEach(entry => {
    const watched = new Date(entry.watchedAt);
    const day = Math.floor((new Date(watched.getFullYear(), watched.getMonth(), watched.getDate()) - weekStart) / (24 * 60 * 60 * 1000));
    if (day >= 0 && day < 7) {
      weekBuckets[day].minutes += Number(entry.runtime) || 0;
      weekBuckets[day].episodes += 1;
    }
  });
  // The 100 below is only the CSS chart height. The data scale must always
  // follow the largest value in the current result set so one quiet day does
  // not make every bar look equally tall.
  const maxMinutes = Math.max(...weekBuckets.map(day => day.minutes), 1);
  timeChart.innerHTML = weekBuckets.map(day => `
    <div class="column-chart-col">
      <span class="column-chart-value">${day.minutes ? formatMinutesAsDuration(day.minutes) : ""}</span>
      <div class="column-chart-bar-track">
        <div class="column-chart-bar" style="height:${Math.max(day.minutes ? 8 : 2, Math.round((day.minutes / maxMinutes) * 100))}%" title="${day.episodes} episode${day.episodes === 1 ? "" : "s"}"></div>
      </div>
      <span class="column-chart-label">${day.date.toLocaleDateString(undefined, { weekday: "short" })}</span>
    </div>
  `).join("");

  // Monthly graph: selectable month, grouped into week-of-month bars.
  const monthKeys = [...new Set([
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
    ...log.map(entry => {
      const date = new Date(entry.watchedAt);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    })
  ])].sort().reverse();
  const monthSelect = document.getElementById("stats-month-select");
  const savedMonth = localStorage.getItem("squashdb_stats_month") || monthKeys[0];
  const selectedMonth = monthKeys.includes(savedMonth) ? savedMonth : monthKeys[0];
  if (monthSelect) {
    monthSelect.innerHTML = monthKeys.map(key => {
      const [year, month] = key.split("-").map(Number);
      const label = new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
      return `<option value="${key}" ${key === selectedMonth ? "selected" : ""}>${label}</option>`;
    }).join("");
    if (monthSelect.dataset.bound !== "true") {
      monthSelect.dataset.bound = "true";
      monthSelect.addEventListener("change", () => {
        localStorage.setItem("squashdb_stats_month", monthSelect.value);
        renderStats();
      });
    }
  }
  const [selectedYear, selectedMonthNumber] = selectedMonth.split("-").map(Number);
  const monthBuckets = Array.from({ length: 5 }, (_, index) => ({ week: index + 1, minutes: 0, episodes: 0 }));
  log.forEach(entry => {
    const date = new Date(entry.watchedAt);
    if (date.getFullYear() !== selectedYear || date.getMonth() + 1 !== selectedMonthNumber) return;
    const bucket = monthBuckets[Math.min(4, Math.floor((date.getDate() - 1) / 7))];
    bucket.minutes += Number(entry.runtime) || 0;
    bucket.episodes += 1;
  });
  // This chart displays episode counts, so scale it by the largest episode
  // count rather than by runtime minutes. Otherwise a long episode can make
  // a week with fewer episodes appear larger than it should.
  const maxMonthEpisodes = Math.max(...monthBuckets.map(bucket => bucket.episodes), 1);
  epChart.innerHTML = monthBuckets.map(bucket => `
    <div class="column-chart-col">
      <span class="column-chart-value">${bucket.episodes ? `${bucket.episodes} ep` : ""}</span>
      <div class="column-chart-bar-track">
        <div class="column-chart-bar monthly-chart-bar" style="height:${Math.max(bucket.episodes ? 8 : 2, Math.round((bucket.episodes / maxMonthEpisodes) * 100))}%" title="${formatMinutesAsDuration(bucket.minutes)}"></div>
      </div>
      <span class="column-chart-label">Week ${bucket.week}</span>
    </div>
  `).join("");

  const marathons = Object.values(dayTotals).sort((a, b) => b.count - a.count).slice(0, 5);
  if (!watchLog.length || marathons.length === 0) {
    marathonsCard.style.display = "none";
  } else {
    marathonsCard.style.display = "flex";
    marathonsList.innerHTML = marathons.map(m => `
      <div class="leaderboard-row">
        <span class="leaderboard-row-title">${m.title}</span>
        <span class="leaderboard-row-meta"><span>${m.count} ep</span><span>${formatMinutesAsDuration(m.minutes)}</span></span>
      </div>
    `).join("");
  }
}

// Attach listeners to note cards (checkbox click, edits, deletion, quick increments)
// Binds listeners only to elements not already bound (tracked via data-bound),
// so this can be called repeatedly as batches of cards are appended incrementally
// without stacking duplicate listeners on already-bound cards.
function attachCardEvents() {
  const rowActions = state.preferences.dashboardRowActions || "menu";

  const dashboardContainer = document.getElementById("notes-container");
  if (dashboardContainer && dashboardContainer.dataset.tapFallbackBound !== "true") {
    dashboardContainer.dataset.tapFallbackBound = "true";
    dashboardContainer.addEventListener("click", event => {
      if (event.target.closest("button, input, a, .note-quick-actions")) return;
      const card = event.target.closest(".note-card, .grid-card");
      if (!card || !card.dataset.id || event.defaultPrevented) return;
      openItemForCategory(card.dataset.id);
    });
  }

  const bindOnce = (selector, bind) => {
    document.querySelectorAll(`${selector}:not([data-bound])`).forEach(el => {
      el.dataset.bound = "true";
      bind(el);
    });
  };

  // Checkbox toggle
  bindOnce(".note-checkbox", chk => {
    chk.addEventListener("change", (e) => {
      const id = chk.getAttribute("data-id");
      toggleCompletion(id, e.target.checked);
    });
    chk.addEventListener("click", (e) => e.stopPropagation());
  });

  // Edit action
  bindOnce(".edit-btn", btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-id");
      openItemForCategory(id);
    });
  });

  // Delete action
  bindOnce(".delete-btn", btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      confirmDelete(btn.getAttribute("data-id"));
    });
  });

  // Grid action overlay
  bindOnce(".grid-card", card => {
    if (!dashboardUsesGridView()) return;

    let pressTimer = null;
    let longPressed = false;

    const start = () => {
      if (card.dataset.boundGridPress === "true") return;
      longPressed = false;
      pressTimer = setTimeout(() => {
        longPressed = true;
        toggleGridSelection(card.dataset.id, true);
      }, 450);
    };
    const cancel = () => {
      if (pressTimer) clearTimeout(pressTimer);
      pressTimer = null;
    };

    card.dataset.boundGridPress = "true";
    card.addEventListener("touchstart", start, { passive: true });
    card.addEventListener("touchend", cancel);
    card.addEventListener("touchmove", cancel);
    card.addEventListener("mousedown", start);
    card.addEventListener("mouseup", cancel);
    card.addEventListener("mouseleave", cancel);

    card.addEventListener("click", (e) => {
      if (dashboardGridSelectionMode || dashboardSelectedIds.size > 0) {
        e.preventDefault();
        e.stopPropagation();
        toggleGridSelection(card.dataset.id);
        return;
      }
      if (!longPressed) openItemForCategory(card.dataset.id);
    });
  });

  // Menu action (3-dot)
  bindOnce(".menu-btn", btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openRowActionMenu(btn.getAttribute("data-id"));
    });
  });

  // Increment Episode/Chapter progress actions
  bindOnce(".inc-btn", btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-id");
      const type = btn.getAttribute("data-type");
      incrementProgress(id, type);
    });
  });

  bindOnce(".note-card", card => {
    if (rowActions === "tap-hold") {
      bindTapHold(card);
    } else if (rowActions === "swipe" && card.querySelector(".note-row-content")) {
      bindSwipe(card);
    }
    // The row itself always opens the detail page. Edit/delete remain available
    // through the action buttons or the configured gesture/menu.
    else {
      card.addEventListener("click", event => {
        if (event.target.closest("button, input, a, .note-quick-actions")) return;
        openItemForCategory(card.dataset.id);
      });
    }
  });

  bindOnce(".grid-card", card => {
    if (!dashboardUsesGridView()) return;
    if (card.dataset.boundGridPress === "true") return;
    card.dataset.boundGridPress = "true";

    let pressTimer = null;
    let longPressed = false;

    const cancel = () => {
      if (pressTimer) clearTimeout(pressTimer);
      pressTimer = null;
    };

    const start = () => {
      longPressed = false;
      pressTimer = setTimeout(() => {
        longPressed = true;
        toggleGridSelection(card.dataset.id, true);
      }, 450);
    };

    card.addEventListener("touchstart", start, { passive: true });
    card.addEventListener("touchend", cancel);
    card.addEventListener("touchmove", cancel);
    card.addEventListener("mousedown", start);
    card.addEventListener("mouseup", cancel);
    card.addEventListener("mouseleave", cancel);
    card.addEventListener("click", (e) => {
      if (dashboardGridSelectionMode || dashboardSelectedIds.size > 0) {
        e.preventDefault();
        e.stopPropagation();
        toggleGridSelection(card.dataset.id);
        return;
      }
      if (!longPressed) openItemForCategory(card.dataset.id);
    });
  });
}

// Row action mode: tap = edit, long-press (~500ms) = delete confirm
function bindTapHold(card) {
  let pressTimer = null;
  let longPressed = false;

  const start = () => {
    longPressed = false;
    pressTimer = setTimeout(() => {
      longPressed = true;
      confirmDelete(card.dataset.id);
    }, 500);
  };
  const cancel = () => clearTimeout(pressTimer);

  card.addEventListener("mousedown", start);
  card.addEventListener("touchstart", start, { passive: true });
  card.addEventListener("mouseup", cancel);
  card.addEventListener("mouseleave", cancel);
  card.addEventListener("touchend", cancel);
  card.addEventListener("touchmove", cancel);
  card.addEventListener("click", () => {
    if (!longPressed) openItemForCategory(card.dataset.id);
  });
}

// Row action mode: swipe left reveals delete, swipe right reveals edit
function bindSwipe(card) {
  const content = card.querySelector(".note-row-content");
  let startX = 0;
  let currentX = 0;
  let dragging = false;

  const onStart = (x) => {
    startX = x;
    dragging = true;
    content.style.transition = "none";
  };
  const onMove = (x) => {
    if (!dragging) return;
    currentX = Math.max(-80, Math.min(80, x - startX));
    content.style.transform = `translateX(${currentX}px)`;
  };
  const onEnd = () => {
    if (!dragging) return;
    dragging = false;
    content.style.transition = "transform calc(0.2s * var(--anim-speed)) ease";
    if (currentX <= -40) {
      content.style.transform = "translateX(-80px)";
    } else if (currentX >= 40) {
      content.style.transform = "translateX(80px)";
    } else {
      content.style.transform = "translateX(0)";
    }
  };

  card.addEventListener("touchstart", (e) => onStart(e.touches[0].clientX), { passive: true });
  card.addEventListener("touchmove", (e) => onMove(e.touches[0].clientX), { passive: true });
  card.addEventListener("touchend", onEnd);

  card.addEventListener("mousedown", (e) => onStart(e.clientX));
  card.addEventListener("mousemove", (e) => onMove(e.clientX));
  card.addEventListener("mouseup", onEnd);
  card.addEventListener("mouseleave", () => { if (dragging) onEnd(); });

  content.addEventListener("click", () => {
    if (Math.abs(currentX) < 5) {
      openItemForCategory(card.dataset.id);
    }
  });
}

// 3-dot menu: reuse the settings picker bottom-sheet for Edit/Delete
function openRowActionMenu(id) {
  const modal = document.getElementById("picker-modal");
  const list = document.getElementById("picker-options-list");
  const titleEl = document.getElementById("picker-modal-title");
  if (!modal || !list) return;

  titleEl.textContent = "Item Actions";
  list.innerHTML = "";

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "picker-option";
  editBtn.innerHTML = `<i data-lucide="edit-2" class="picker-option-check" style="visibility:visible;"></i><span>Edit</span>`;
  editBtn.addEventListener("click", () => {
    closeSettingsPicker();
    openItemForCategory(id);
  });
  list.appendChild(editBtn);

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "picker-option";
  deleteBtn.innerHTML = `<i data-lucide="trash-2" class="picker-option-check" style="visibility:visible;"></i><span>Delete</span>`;
  deleteBtn.addEventListener("click", () => {
    confirmDelete(id);
  });
  list.appendChild(deleteBtn);

  modal.classList.add("active");
  if (window.lucide) lucide.createIcons(root);
}

// Custom in-app delete confirmation (avoids relying on window.confirm in WebViews)
function confirmDelete(id) {
  const modal = document.getElementById("picker-modal");
  const list = document.getElementById("picker-options-list");
  const titleEl = document.getElementById("picker-modal-title");
  if (!modal || !list) return;

  titleEl.textContent = "Delete this tracker?";
  list.innerHTML = "";

  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.className = "picker-option";
  confirmBtn.innerHTML = `<i data-lucide="trash-2" class="picker-option-check" style="visibility:visible; color: var(--danger);"></i><span style="color: var(--danger);">Delete</span>`;
  confirmBtn.addEventListener("click", () => {
    closeSettingsPicker();
    deleteEntry(id);
  });
  list.appendChild(confirmBtn);

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "picker-option";
  cancelBtn.innerHTML = `<i data-lucide="x" class="picker-option-check" style="visibility:visible;"></i><span>Cancel</span>`;
  cancelBtn.addEventListener("click", closeSettingsPicker);
  list.appendChild(cancelBtn);

  modal.classList.add("active");
  if (window.lucide) lucide.createIcons();
}

// Toggle Completion state
function toggleCompletion(id, isChecked) {
  const itemIndex = state.items.findIndex(item => item.id === id);
  if (itemIndex === -1) return;

  const item = state.items[itemIndex];
  
  if (isChecked) {
    markItemAsCompleted(item);
  } else {
    // Revert status to In Progress / Playing
    if (item.category === "game") {
      item.status = "Playing";
    } else if (item.category === "movie") {
      item.status = "Watchlist";
    } else if (item.category === "series" || item.category === "kdrama" || item.category === "cdrama" || item.category === "anime") {
      item.status = "In Progress";
    } else if (item.category === "manga" || item.category === "novel") {
      item.status = "Reading";
    }
    item.completionDate = null;
  }

  saveData();
  renderDashboard();
  renderTimeline();
  renderStats();
}

// Increment quick progress (Episodes / Chapters)
function incrementProgress(id, type) {
  const itemIndex = state.items.findIndex(item => item.id === id);
  if (itemIndex === -1) return;

  const item = state.items[itemIndex];
  const increment = Math.max(1, Number(state.preferences.progressIncrement) || 1);
  
  if (type === "ep") {
    let currentEp = parseInt(item.episodesDone) || 0;
    let totalEp = parseInt(item.totalEpisodes) || getSeasonTotalEpisodes(item) || 0;
    const watched = new Set(item.watchedEpisodeIds || []);
    for (let i = 0; i < increment; i += 1) {
      const nextEpisode = nextEpisodeForDashboardItem({ ...item, watchedEpisodeIds: Array.from(watched) });
      if (nextEpisode) watched.add(nextEpisode.id);
      else currentEp += 1;
    }
    if (watched.size) currentEp = watched.size;
    if (totalEp > 0 && currentEp >= totalEp) {
      currentEp = totalEp;
      toggleCompletion(id, true);
      return;
    }
    item.episodesDone = currentEp;
  } else if (type === "ch" || type === "vol") {
    const isChapter = type === "ch";
    let currentCh = parseInt(item[isChapter ? "chaptersRead" : "volumesRead"]) || 0;
    let totalCh = parseInt(item[isChapter ? "totalChapters" : "totalVolumes"]) || 0;
    
    currentCh += increment;
    if (totalCh > 0 && currentCh >= totalCh) {
      currentCh = totalCh;
      toggleCompletion(id, true);
      return;
    }
    item[isChapter ? "chaptersRead" : "volumesRead"] = currentCh;
  }

  saveData();
  renderDashboard();
  renderStats();
}

let pendingDeleteUndo = null;

function showDeleteUndoToast(count) {
  let toast = document.getElementById("app-undo-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "app-undo-toast";
    toast.className = "app-undo-toast";
    document.body.appendChild(toast);
  }
  toast.innerHTML = `<span>${count} item${count === 1 ? "" : "s"} deleted</span><button type="button" data-undo-delete>Undo</button>`;
  toast.classList.add("active");
  toast.querySelector("[data-undo-delete]").onclick = undoLastDelete;
  clearTimeout(pendingDeleteUndo?.timer);
  if (pendingDeleteUndo) pendingDeleteUndo.timer = setTimeout(() => {
    pendingDeleteUndo = null;
    toast.classList.remove("active");
  }, 7000);
}

function deleteItemsWithUndo(ids) {
  const deleted = ids.map(id => {
    const index = state.items.findIndex(entry => entry.id === id);
    return index === -1 ? null : { item: state.items[index], index };
  }).filter(Boolean);
  if (!deleted.length) return;
  clearTimeout(pendingDeleteUndo?.timer);
  pendingDeleteUndo = { deleted, timer: null };
  state.items = state.items.filter(item => !ids.includes(item.id));
  deleted.forEach(({ item }) => pruneDeletedItemFromFolderTree(item).catch(err => console.warn("Could not prune deleted item from folder tree", err)));
  saveData();
  renderDashboard();
  renderTimeline();
  renderStats();
  showDeleteUndoToast(deleted.length);
}

function undoLastDelete() {
  if (!pendingDeleteUndo?.deleted?.length) return;
  pendingDeleteUndo.deleted.sort((a, b) => a.index - b.index).forEach(({ item, index }) => {
    if (state.items.some(existing => existing.id === item.id)) return;
    state.items.splice(Math.min(index, state.items.length), 0, item);
  });
  clearTimeout(pendingDeleteUndo.timer);
  pendingDeleteUndo = null;
  document.getElementById("app-undo-toast")?.classList.remove("active");
  saveData();
  renderDashboard();
  renderTimeline();
  renderStats();
}

// Delete Tracking Entry
function deleteEntry(id) {
  deleteItemsWithUndo([id]);
}

// Opens the right editor for an existing item: the shared detail page for all
// media types that have richer metadata, or the classic edit modal only for
// simple legacy entries.
const SHOW_DETAIL_PAGE_CATEGORIES = [...EPISODE_TRACKED_CATEGORIES, "movie", "game", "manga", "novel"];

function openItemForCategory(id) {
  const item = state.items.find(i => i.id === id);
  if (item && SHOW_DETAIL_PAGE_CATEGORIES.includes(item.category)) {
    const detailUrl = `static/pages/main/show-detail.html?source=local&itemId=${encodeURIComponent(id)}`;
    if (typeof navigateToAppPage === "function") navigateToAppPage(detailUrl);
    else window.location.href = detailUrl;
    return;
  }
  // Cards can be tapped while encrypted state is still being restored. Keep
  // the tap useful for detail-page categories instead of opening an empty
  // editor modal when the in-memory lookup briefly has no item.
  if (!item && id) {
    const detailUrl = `static/pages/main/show-detail.html?source=local&itemId=${encodeURIComponent(id)}`;
    if (typeof navigateToAppPage === "function") navigateToAppPage(detailUrl);
    else window.location.href = detailUrl;
    return;
  }
  openModal(id);
}

// Open Form Modal (Add / Edit)
const SQUASHDB_FORM_DRAFT_KEY = "squashdb_form_draft";
let formDraftTimer = null;

function readFormDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(SQUASHDB_FORM_DRAFT_KEY) || "null");
    return draft && Date.now() - Number(draft.savedAt || 0) < 7 * 24 * 60 * 60 * 1000 ? draft : null;
  } catch (err) {
    return null;
  }
}

function saveFormDraft() {
  const modal = document.getElementById("item-modal");
  const id = document.getElementById("entry-id")?.value;
  if (!modal?.classList.contains("active") || id) return;
  const title = document.getElementById("entry-title")?.value || "";
  const notes = document.getElementById("entry-notes")?.value || "";
  const category = document.getElementById("entry-category")?.value || "";
  const status = document.getElementById("field-status")?.value || "";
  if (!title.trim() && !notes.trim()) return;
  localStorage.setItem(SQUASHDB_FORM_DRAFT_KEY, JSON.stringify({ title, notes, category, status, savedAt: Date.now() }));
}

function scheduleFormDraftSave() {
  clearTimeout(formDraftTimer);
  formDraftTimer = setTimeout(saveFormDraft, 350);
}

function clearFormDraft() {
  clearTimeout(formDraftTimer);
  localStorage.removeItem(SQUASHDB_FORM_DRAFT_KEY);
}

function getNotesTemplate() {
  if (state.preferences.notesTemplate === "review") return "What I liked:\n\nWhat to remember:\n";
  if (state.preferences.notesTemplate === "journal") return "Date:\n\nThoughts:\n";
  return "";
}

function applyRememberedStatus(category) {
  const select = document.getElementById("field-status");
  if (!select) return;
  const remembered = state.lastEntryStatusByCategory?.[category] || state.preferences.defaultEntryStatus;
  if (remembered && Array.from(select.options).some(option => option.value === remembered)) {
    select.value = remembered;
  }
  toggleCompletionDateVisibility(select.value);
}

async function scanBarcodeOrQr() {
  const titleInput = document.getElementById("entry-title");
  if (!titleInput) return;
  const scanner = nativePlugin("BarcodeScanner") || nativePlugin("BarcodeReader");
  try {
    const result = scanner?.scan ? await scanner.scan() : scanner?.startScan ? await scanner.startScan() : null;
    const value = String(result?.content || result?.text || result?.barcode?.rawValue || "").trim();
    if (!value) {
      if (!scanner) alert("Barcode scanning needs the Android Barcode Scanner plugin. You can still enter an ISBN or game code manually.");
      return;
    }
    titleInput.value = value;
    let category = document.getElementById("entry-category")?.value;
    if (/^97[89]\d{10,13}$/.test(value)) {
      const bookCategory = state.preferences.novel ? "novel" : (state.preferences.manga ? "manga" : category);
      if (bookCategory && bookCategory !== category) {
        category = bookCategory;
        document.getElementById("entry-category").value = category;
        document.getElementById("entry-category-label").textContent = CATEGORIES[category].label;
        renderDynamicFormFields(category);
        applyRememberedStatus(category);
      }
    } else if (category !== "game" && state.preferences.game && window.confirm("Use the scanned code for a game entry? Choose Cancel to keep the current category.")) {
      category = "game";
      document.getElementById("entry-category").value = category;
      document.getElementById("entry-category-label").textContent = CATEGORIES[category].label;
      renderDynamicFormFields(category);
      applyRememberedStatus(category);
    }
    if (category === "manga" || category === "novel" || category === "game") {
      if (state.preferences.metadataMode === "online") await fetchAndApplyMetadataFromTitle();
    } else {
      alert("Code captured. Choose Books or Games to use it for metadata lookup.");
    }
  } catch (err) {
    console.warn("Barcode/QR scan failed", err);
  }
}

function openModal(editId = null) {
  const modal = document.getElementById("item-modal");
  const modalTitle = document.getElementById("modal-title");
  const form = document.getElementById("tracker-form");
  
  form.reset();
  state.activeRating = 0;
  fetchedMetadataDraft = null;
  hideMetadataResults();

  // Clear inputs
  document.getElementById("entry-id").value = "";
  const categoryField = document.getElementById("entry-category");
  const categoryLabel = document.getElementById("entry-category-label");
  
  // Make sure at least one active category is selected
  const activeCats = Object.keys(CATEGORIES).filter(k => state.preferences[k]);
  if (activeCats.length === 0) {
    alert("Please enable at least one Tracking Category in the Settings tab first!");
    switchTab("tab-settings");
    return;
  }

  if (editId) {
    modalTitle.textContent = "Edit Tracking Entry";
    const item = state.items.find(i => i.id === editId);
    if (!item) return;

    document.getElementById("entry-id").value = item.id;
    document.getElementById("entry-title").value = item.title;
    if (categoryField) categoryField.value = item.category;
    if (categoryLabel) categoryLabel.textContent = CATEGORIES[item.category].label;
    state.lastEntryCategory = item.category;
    document.getElementById("entry-notes").value = item.notes || "";
    
    state.activeRating = item.rating || 0;

    // Render category fields first
    renderDynamicFormFields(item.category);

    // Populate dynamic fields
    const statusSelect = document.getElementById("field-status");
    if (statusSelect) {
      statusSelect.value = item.status;
      statusSelect.dispatchEvent(new Event("change", { bubbles: true }));
    }

    const ratingVal = document.getElementById("field-rating-val");
    if (ratingVal) ratingVal.value = item.rating || 0;
    updateStarsUI(item.rating || 0);

    const compDate = document.getElementById("field-completion-date");
    if (compDate) {
      compDate.value = item.completionDate || "";
      toggleCompletionDateVisibility(item.status);
    }

    if (item.thumbnail) {
      if (!thumbnailsEnabled()) {
        clearMetadataPreview();
      } else {
        applyMetadataPreview({
          title: item.title,
          meta: item.status || "",
          image: item.thumbnail
        });
      }
    } else {
      clearMetadataPreview();
    }

    if (item.category === "series" || item.category === "kdrama" || item.category === "cdrama" || item.category === "anime") {
      document.getElementById("field-total-seasons").value = item.totalSeasons || "";
      renderSeasonEpisodeFields(item.totalSeasons || Object.keys(item.seasonEpisodes || {}).length || 1);
      const seasonEpisodes = normalizeSeasonEpisodes(item.seasonEpisodes);
      Object.keys(seasonEpisodes).forEach(seasonKey => {
        const seasonNum = seasonKey.replace("season", "");
        const totalInput = document.getElementById(`field-season-total-${seasonNum}`);
        const watchedInput = document.getElementById(`field-season-watched-${seasonNum}`);
        const completeInput = document.getElementById(`field-season-complete-${seasonNum}`);
        const season = seasonEpisodes[seasonKey];
        if (totalInput) totalInput.value = season.total || 0;
        if (watchedInput) watchedInput.value = season.completed ? (season.total || 0) : (season.watched || 0);
        if (completeInput) {
          completeInput.checked = Boolean(season.completed);
          completeInput.closest(".season-episode-row")?.classList.toggle("season-done", completeInput.checked);
        }
      });
      const watchedCount = Object.values(seasonEpisodes).filter(s => s.completed).length;
      const seasonsWatchedInput = document.getElementById("field-seasons-watched");
      if (seasonsWatchedInput) seasonsWatchedInput.value = watchedCount || "";
      const episodeRuntimeInput = document.getElementById("field-episode-runtime");
      if (episodeRuntimeInput) episodeRuntimeInput.value = item.episodeRuntime || "";
    } else if (item.category === "manga") {
      document.getElementById("field-total-volumes").value = item.totalVolumes || "";
      document.getElementById("field-volumes-read").value = item.volumesRead || 0;
    } else if (item.category === "novel") {
      document.getElementById("field-total-volumes").value = item.totalVolumes || "";
      document.getElementById("field-volumes-read").value = item.volumesRead || 0;
      document.getElementById("field-total-chapters").value = item.totalChapters || "";
      document.getElementById("field-chapters-read").value = item.chaptersRead || 0;
      document.getElementById("field-minutes-per-chapter").value = item.minutesPerChapter || 15;
    } else if (item.category === "movie") {
      const totalMinutes = parseInt(item.playtime) || 0;
      document.getElementById("field-playtime").value = totalMinutes || "";
      document.getElementById("field-playtime-hours").value = totalMinutes ? Math.floor(totalMinutes / 60) : "";
      document.getElementById("field-playtime-minutes").value = totalMinutes ? totalMinutes % 60 : "";
    }

  } else {
    modalTitle.textContent = "Add Tracking Entry";
    const preferredCat = state.activeCategoryChip && state.preferences[state.activeCategoryChip]
      ? state.activeCategoryChip
      : (state.preferences[state.lastEntryCategory] ? state.lastEntryCategory : activeCats[0]);
    if (categoryField) categoryField.value = preferredCat;
    if (categoryLabel) categoryLabel.textContent = CATEGORIES[preferredCat].label;
    state.lastEntryCategory = preferredCat;
    renderDynamicFormFields(preferredCat);
    applyRememberedStatus(preferredCat);
    document.getElementById("entry-notes").value = getNotesTemplate();
    clearMetadataPreview();
    const draft = readFormDraft();
    if (draft && window.confirm("Restore your unfinished add-item draft?")) {
      const draftCategory = state.preferences[draft.category] ? draft.category : preferredCat;
      if (categoryField) categoryField.value = draftCategory;
      if (categoryLabel) categoryLabel.textContent = CATEGORIES[draftCategory].label;
      renderDynamicFormFields(draftCategory);
      applyRememberedStatus(draftCategory);
      document.getElementById("entry-title").value = draft.title || "";
      document.getElementById("entry-notes").value = draft.notes || "";
      if (draft.status && document.getElementById("field-status")?.querySelector(`option[value="${draft.status}"]`)) {
        const draftStatusSelect = document.getElementById("field-status");
        draftStatusSelect.value = draft.status;
        draftStatusSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
    } else if (draft) {
      clearFormDraft();
    }
  }

  modal.classList.add("active");
}

// Close Modal
function closeModal() {
  const modal = document.getElementById("item-modal");
  modal.classList.remove("active");
}

// Render dynamic fields inside modal depending on category
function renderDynamicFormFields(category) {
  const container = document.getElementById("dynamic-fields");
  if (!container) return;

  container.innerHTML = "";
  hideMetadataResults();

  const config = CATEGORIES[category];
  
  // Status options: a visible pill row driving a hidden <select> so every
  // existing read/write of #field-status keeps working unchanged.
  let statusOptions = "";
  let statusPills = "";
  config.statuses.forEach((st, index) => {
    statusOptions += `<option value="${st}">${st}</option>`;
    statusPills += `<button type="button" class="status-pill${index === 0 ? " active" : ""}" data-status-value="${st}">${st}</button>`;
  });

  // Compile Dynamic HTML
  let fieldsHTML = `
    <div class="form-group">
      <label for="field-status">Status</label>
      <select id="field-status" class="form-control" required hidden>
        ${statusOptions}
      </select>
      <div class="status-pill-row" id="field-status-pills" role="radiogroup" aria-label="Status">
        ${statusPills}
      </div>
    </div>
  `;

  if ((category === "series" || category === "kdrama" || category === "cdrama" || category === "anime" || category === "movie") && state.preferences.metadataMode === "online") {
    fieldsHTML += `
      <div class="form-group" id="metadata-hint" style="margin-top: 8px;">
        <div class="metadata-fetch-toggle">
          <div class="metadata-fetch-toggle-body">
            <label for="metadata-fetch-toggle-input">Fetch metadata</label>
            <p>Online mode will try to fill counts and show a thumbnail from public metadata sources.</p>
          </div>
          <label class="switch">
            <input type="checkbox" id="metadata-fetch-toggle-input" checked>
            <span class="slider"></span>
          </label>
        </div>
        <button type="button" id="metadata-fetch-btn" hidden aria-hidden="true"></button>
      </div>
    `;
  }

  fieldsHTML += `
    <div class="metadata-preview" id="metadata-preview" style="display:none;">
      <img id="metadata-preview-thumb" alt="" />
      <div class="metadata-preview-body">
        <div class="metadata-preview-title" id="metadata-preview-title"></div>
        <div class="metadata-preview-meta" id="metadata-preview-meta"></div>
      </div>
    </div>
  `;

  fieldsHTML += `
    <div class="metadata-results" id="metadata-results" style="display:none;">
      <div class="metadata-results-title">Select a match</div>
      <div id="metadata-results-list" class="metadata-results-list"></div>
    </div>
  `;

  fieldsHTML += `
    <div class="form-group" id="comp-date-group" style="display: none;">
      <label for="field-completion-date">Completion Date</label>
      <input type="date" id="field-completion-date" class="form-control">
    </div>
  `;

  if (category === "series" || category === "kdrama" || category === "cdrama" || category === "anime") {
    fieldsHTML += `
      <div class="form-row">
        <div class="form-group">
          <label for="field-total-seasons">Total Seasons</label>
          <input type="number" id="field-total-seasons" class="form-control" min="0" placeholder="e.g. 5">
        </div>
        <div class="form-group">
          <label for="field-seasons-watched">Seasons Watched</label>
          <input type="number" id="field-seasons-watched" class="form-control" min="0" placeholder="e.g. 2">
        </div>
      </div>
      <div class="season-episodes-wrap">
        <label class="season-episodes-title">Episodes per Season</label>
        <div id="season-episodes-fields" class="season-episodes-fields"></div>
      </div>
      <div class="form-group">
        <label for="field-episode-runtime">Avg. Episode Runtime (minutes)</label>
        <input type="number" id="field-episode-runtime" class="form-control" min="0" placeholder="e.g. 24">
      </div>
    `;
  } else if (category === "manga") {
    fieldsHTML += `
      <div class="form-row">
        <div class="form-group">
          <label for="field-total-volumes">Total Volumes</label>
          <input type="number" id="field-total-volumes" class="form-control" min="0" placeholder="e.g. 12">
        </div>
        <div class="form-group">
          <label for="field-volumes-read">Volumes Read</label>
          <input type="number" id="field-volumes-read" class="form-control" min="0" value="0">
        </div>
      </div>
    `;
  } else if (category === "novel") {
    fieldsHTML += `
      <div class="form-row">
        <div class="form-group">
          <label for="field-total-volumes">Total Volumes</label>
          <input type="number" id="field-total-volumes" class="form-control" min="0" placeholder="e.g. 12">
        </div>
        <div class="form-group">
          <label for="field-volumes-read">Volumes Read</label>
          <input type="number" id="field-volumes-read" class="form-control" min="0" value="0">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="field-total-chapters">Total Chapters</label>
          <input type="number" id="field-total-chapters" class="form-control" min="0" placeholder="e.g. 150">
        </div>
        <div class="form-group">
          <label for="field-chapters-read">Chapters Read</label>
          <input type="number" id="field-chapters-read" class="form-control" min="0" value="0">
        </div>
      </div>
      <div class="form-group">
        <label for="field-minutes-per-chapter">Avg. Reading Time per Chapter (minutes)</label>
        <input type="number" id="field-minutes-per-chapter" class="form-control" min="0" placeholder="e.g. 15" value="15">
      </div>
    `;
  } else if (category === "movie") {
    fieldsHTML += `
      <input type="hidden" id="field-playtime">
      <div class="form-row">
        <div class="form-group">
          <label for="field-playtime-hours">Runtime (hours)</label>
          <input type="number" id="field-playtime-hours" class="form-control" min="0" placeholder="e.g. 2">
        </div>
        <div class="form-group">
          <label for="field-playtime-minutes">Runtime (minutes)</label>
          <input type="number" id="field-playtime-minutes" class="form-control" min="0" max="59" placeholder="e.g. 32">
        </div>
      </div>
    `;
  }

  const ratingFormat = state.preferences.ratingFormat || "5-stars";
  if (ratingFormat === "5-stars") {
    fieldsHTML += `
      <div class="form-group" style="margin-top: 10px;">
        <label>Rating</label>
        <input type="hidden" id="field-rating-val" value="0">
        <div class="rating-container" id="stars-picker">
          <i class="star" data-rating="1" data-lucide="star"></i>
          <i class="star" data-rating="2" data-lucide="star"></i>
          <i class="star" data-rating="3" data-lucide="star"></i>
          <i class="star" data-rating="4" data-lucide="star"></i>
          <i class="star" data-rating="5" data-lucide="star"></i>
        </div>
      </div>
    `;
  } else {
    const maxRating = ratingFormat === "100-points" ? 100 : 10;
    const step = ratingFormat === "10-decimal" ? "0.1" : "1";
    const currentValue = ratingFormat === "100-points"
      ? Math.round((state.activeRating || 0) * 20)
      : Math.round((state.activeRating || 0) * 2);
    fieldsHTML += `
      <div class="form-group" style="margin-top: 10px;">
        <label for="field-rating-score">Rating</label>
        <input type="number" id="field-rating-score" class="form-control" min="0" max="${maxRating}" step="${step}" value="${currentValue}">
        <input type="hidden" id="field-rating-val" value="${state.activeRating || 0}">
      </div>
    `;
  }

  container.innerHTML = fieldsHTML;
  lucide.createIcons();

  const totalSeasonsInput = document.getElementById("field-total-seasons");
  if (totalSeasonsInput) {
    totalSeasonsInput.addEventListener("input", (e) => {
      renderSeasonEpisodeFields(parseInt(e.target.value) || 0);
    });
  }

  const seasonsWatchedInput = document.getElementById("field-seasons-watched");
  if (seasonsWatchedInput) {
    seasonsWatchedInput.addEventListener("input", (e) => {
      const watchedCount = parseInt(e.target.value) || 0;
      const totalSeasons = parseInt(totalSeasonsInput?.value) || 0;
      for (let i = 1; i <= totalSeasons; i++) {
        const completeInput = document.getElementById(`field-season-complete-${i}`);
        if (!completeInput) continue;
        completeInput.checked = i <= watchedCount;
        completeInput.dispatchEvent(new Event("change"));
      }
    });
  }

  const playtimeHoursInput = document.getElementById("field-playtime-hours");
  const playtimeMinutesInput = document.getElementById("field-playtime-minutes");
  const playtimeHiddenInput = document.getElementById("field-playtime");
  if (playtimeHoursInput && playtimeMinutesInput && playtimeHiddenInput) {
    const syncPlaytime = () => {
      const hours = parseInt(playtimeHoursInput.value) || 0;
      const minutes = parseInt(playtimeMinutesInput.value) || 0;
      const total = hours * 60 + minutes;
      playtimeHiddenInput.value = total || "";
    };
    playtimeHoursInput.addEventListener("input", syncPlaytime);
    playtimeMinutesInput.addEventListener("input", syncPlaytime);
  }

  // Attach status change watcher to toggle completion date input
  const statusSelect = document.getElementById("field-status");
  applyRememberedStatus(category);
  statusSelect.addEventListener("change", (e) => {
    state.lastEntryStatusByCategory[category] = e.target.value;
    localStorage.setItem("squashdb_last_entry_statuses", JSON.stringify(state.lastEntryStatusByCategory));
    toggleCompletionDateVisibility(e.target.value);
    syncStatusPills();
    scheduleFormDraftSave();
  });

  // Visible status pills mirror the hidden <select>. Clicking a pill sets the
  // select's value and dispatches its change event so all existing logic runs.
  const statusPillRow = document.getElementById("field-status-pills");
  function syncStatusPills() {
    if (!statusPillRow) return;
    statusPillRow.querySelectorAll(".status-pill").forEach(pill => {
      pill.classList.toggle("active", pill.dataset.statusValue === statusSelect.value);
    });
  }
  if (statusPillRow) {
    statusPillRow.addEventListener("click", (e) => {
      const pill = e.target.closest(".status-pill");
      if (!pill) return;
      statusSelect.value = pill.dataset.statusValue;
      statusSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    syncStatusPills();
  }

  // "Fetch metadata" toggle: when on, title typing/blur looks up metadata; the
  // hidden #metadata-fetch-btn keeps its (guarded) legacy listener a no-op.
  const metadataFetchBtn = document.getElementById("metadata-fetch-btn");
  if (metadataFetchBtn) {
    metadataFetchBtn.addEventListener("click", async () => {
      await fetchAndApplyMetadataFromTitle();
    });
  }
  const metadataFetchToggle = document.getElementById("metadata-fetch-toggle-input");
  if (metadataFetchToggle) {
    metadataFetchToggle.addEventListener("change", () => {
      if (metadataFetchToggle.checked) fetchAndApplyMetadataFromTitle();
      else hideMetadataResults();
    });
  }

  const titleInput = document.getElementById("entry-title");
  if (titleInput && !titleInput.dataset.boundMetadataLookup) {
    titleInput.dataset.boundMetadataLookup = "true";
    let titleLookupTimer = null;
    const scheduleLookup = () => {
      if (state.preferences.metadataMode !== "online") return;
      const toggle = document.getElementById("metadata-fetch-toggle-input");
      if (toggle && !toggle.checked) return;
      clearTimeout(titleLookupTimer);
      titleLookupTimer = setTimeout(() => {
        fetchAndApplyMetadataFromTitle();
      }, 700);
    };
    titleInput.addEventListener("blur", scheduleLookup);
    titleInput.addEventListener("input", scheduleLookup);
  }

  if (ratingFormat === "5-stars") {
    const stars = document.querySelectorAll("#stars-picker .star");
    stars.forEach(star => {
      star.addEventListener("click", () => {
        const val = parseInt(star.getAttribute("data-rating"));
        state.activeRating = val;
        document.getElementById("field-rating-val").value = val;
        updateStarsUI(val);
      });
    });
    updateStarsUI(state.activeRating);
  } else {
    const ratingInput = document.getElementById("field-rating-score");
    if (ratingInput) {
      ratingInput.addEventListener("input", (e) => {
        state.activeRating = ratingToStoredValue(e.target.value);
        const ratingVal = document.getElementById("field-rating-val");
        if (ratingVal) ratingVal.value = state.activeRating;
      });
    }
  }

  const metadataResultsList = document.getElementById("metadata-results-list");
  if (metadataResultsList && !metadataResultsList.dataset.boundPick) {
    metadataResultsList.dataset.boundPick = "true";
    const handlePick = (e) => {
      const btn = e.target.closest("[data-metadata-index]");
      if (!btn) return;
      e.preventDefault();
      const idx = parseInt(btn.dataset.metadataIndex);
      selectMetadataResult(idx);
    };
    metadataResultsList.addEventListener("pointerdown", handlePick);
    metadataResultsList.addEventListener("click", handlePick);
  }
}

function applySeriesMetadata(meta) {
  const totalSeasonsInput = document.getElementById("field-total-seasons");
  if (!totalSeasonsInput || !meta) return;

  const totalSeasons = parseInt(meta.totalSeasons) || 0;
  if (totalSeasons <= 0) return;

  totalSeasonsInput.value = totalSeasons;
  renderSeasonEpisodeFields(totalSeasons);

  const perSeason = Array.isArray(meta.seasons) ? meta.seasons : [];
  for (let i = 1; i <= totalSeasons; i++) {
    const totalInput = document.getElementById(`field-season-total-${i}`);
    const watchedInput = document.getElementById(`field-season-watched-${i}`);
    const completeInput = document.getElementById(`field-season-complete-${i}`);
    const seasonTotal = parseInt(perSeason[i - 1]) || 0;
    if (totalInput) totalInput.value = seasonTotal;
    if (watchedInput) watchedInput.value = 0;
    if (completeInput) completeInput.checked = false;
  }

  const totalEpisodes = parseInt(meta.totalEpisodes) || 0;
  if (totalEpisodes > 0) {
    const statusSelect = document.getElementById("field-status");
    if (statusSelect && statusSelect.value === "Watchlist") {
      statusSelect.value = "In Progress";
      // Fire change so the completion-date toggle and status pills both update.
      statusSelect.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
}

function renderSeasonEpisodeFields(totalSeasons) {
  const container = document.getElementById("season-episodes-fields");
  if (!container) return;

  const count = Math.max(0, parseInt(totalSeasons) || 0);
  container.innerHTML = "";
  for (let i = 1; i <= count; i++) {
    const row = document.createElement("div");
    row.className = "season-episode-row";
    row.innerHTML = `
      <label class="season-row-label">
        <input type="checkbox" id="field-season-complete-${i}" class="season-complete-checkbox">
        <span>Season ${i}</span>
      </label>
      <div class="season-row-controls">
        <div class="season-mini-field">
          <label for="field-season-total-${i}">Total</label>
          <input type="number" id="field-season-total-${i}" class="form-control" min="0" value="0" placeholder="20">
        </div>
        <div class="season-mini-field">
          <label for="field-season-watched-${i}">Watched</label>
          <input type="number" id="field-season-watched-${i}" class="form-control" min="0" value="0" placeholder="0">
        </div>
      </div>
    `;
    container.appendChild(row);

    const totalInput = row.querySelector(`#field-season-total-${i}`);
    const watchedInput = row.querySelector(`#field-season-watched-${i}`);
    const completeInput = row.querySelector(`#field-season-complete-${i}`);

    const syncRow = () => {
      const total = parseInt(totalInput.value) || 0;
      if (completeInput.checked) {
        watchedInput.value = total;
        watchedInput.readOnly = true;
      } else {
        watchedInput.readOnly = false;
      }
      if (parseInt(watchedInput.value) > total && total > 0) {
        watchedInput.value = total;
      }
      row.classList.toggle("season-done", completeInput.checked);
    };

    totalInput.addEventListener("input", syncRow);
    watchedInput.addEventListener("input", () => {
      completeInput.checked = false;
      watchedInput.readOnly = false;
      syncRow();
    });
    completeInput.addEventListener("change", syncRow);
    syncRow();
  }
}

// Toggle completion date field visibility
function toggleCompletionDateVisibility(status) {
  const dateGroup = document.getElementById("comp-date-group");
  const dateInput = document.getElementById("field-completion-date");
  if (!dateGroup) return;

  if (status === "Completed") {
    dateGroup.style.display = "flex";
    if (!dateInput.value) {
      // Set to today's date in local system time
      const now = new Date();
      const offset = now.getTimezoneOffset();
      const localDateStr = new Date(now.getTime() - (offset * 60 * 1000)).toISOString().split("T")[0];
      dateInput.value = localDateStr;
    }
  } else {
    dateGroup.style.display = "none";
    dateInput.value = "";
  }
}

// Update stars outline/fill classes in Modal picker
function updateStarsUI(rating) {
  const stars = document.querySelectorAll("#stars-picker .star");
  stars.forEach(star => {
    const rVal = parseInt(star.getAttribute("data-rating"));
    if (rVal <= rating) {
      star.classList.add("active");
      star.style.fill = "currentColor";
    } else {
      star.classList.remove("active");
      star.style.fill = "none";
    }
  });
}

// Handle Form Submission for Tracker (Create / Update)
function handleFormSubmit(e) {
  e.preventDefault();
  
  const id = document.getElementById("entry-id").value;
  const title = document.getElementById("entry-title").value.trim();
  const category = document.getElementById("entry-category").value;
  const notes = document.getElementById("entry-notes").value.trim();

  const status = document.getElementById("field-status").value;
  const rating = parseInt(document.getElementById("field-rating-val").value) || 0;
  const completionDate = document.getElementById("field-completion-date") ? document.getElementById("field-completion-date").value : null;

  const normalizedTitle = title.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const duplicate = state.items.find(item => item.id !== id
    && item.category === category
    && String(item.title || "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() === normalizedTitle);
  if (duplicate && !window.confirm(`“${duplicate.title}” is already in your ${CATEGORIES[category]?.label || category} list. Save another copy anyway?`)) {
    return;
  }

  let extraData = {};

  if (category === "series" || category === "anime") {
    const totalSeasons = parseInt(document.getElementById("field-total-seasons").value) || 0;
    const seasonEpisodes = {};
    for (let i = 1; i <= totalSeasons; i++) {
      const total = parseInt(document.getElementById(`field-season-total-${i}`)?.value) || 0;
      const complete = document.getElementById(`field-season-complete-${i}`)?.checked || false;
      const watchedInput = parseInt(document.getElementById(`field-season-watched-${i}`)?.value) || 0;
      seasonEpisodes[`season${i}`] = {
        total,
        watched: complete ? total : watchedInput,
        completed: complete
      };
    }
    const totalEpisodesFromSeasons = Object.values(seasonEpisodes).reduce((sum, season) => sum + (parseInt(season.total) || 0), 0);
    const watchedEpisodesFromSeasons = Object.values(seasonEpisodes).reduce((sum, season) => sum + ((season.completed ? (parseInt(season.total) || 0) : (parseInt(season.watched) || 0))), 0);
    extraData = {
      totalSeasons,
      episodesDone: watchedEpisodesFromSeasons,
      totalEpisodes: totalEpisodesFromSeasons,
      seasonEpisodes,
      episodeRuntime: parseInt(document.getElementById("field-episode-runtime").value) || ""
    };

    // If progress shows complete, force status
    if (extraData.totalEpisodes > 0 && extraData.episodesDone >= extraData.totalEpisodes && status !== "Completed") {
      alert("Episode count matches or exceeds total episodes. Setting status to Completed.");
      return; // let user adjust or re-submit
    }
  } else if (category === "manga" || category === "novel") {
    extraData = {
      volumesRead: parseInt(document.getElementById("field-volumes-read").value) || 0,
      totalVolumes: parseInt(document.getElementById("field-total-volumes").value) || ""
    };

    if (category === "novel") {
      extraData.totalChapters = parseInt(document.getElementById("field-total-chapters").value) || "";
      extraData.chaptersRead = parseInt(document.getElementById("field-chapters-read").value) || 0;
      extraData.minutesPerChapter = parseInt(document.getElementById("field-minutes-per-chapter").value) || 15;
    }

    if (extraData.totalVolumes > 0 && extraData.volumesRead >= extraData.totalVolumes && status !== "Completed") {
      alert("Volumes read count matches or exceeds total volumes. Setting status to Completed.");
      return;
    }
  } else if (category === "movie") {
    extraData = {
      playtime: parseInt(document.getElementById("field-playtime").value) || ""
    };
  }

  if (id) {
    // Edit existing item
    const itemIndex = state.items.findIndex(item => item.id === id);
    if (itemIndex !== -1) {
      state.items[itemIndex] = {
        ...state.items[itemIndex],
        title,
        category,
        status,
        rating,
        completionDate,
        notes,
        updated: Date.now(),
        thumbnail: thumbnailsEnabled() ? (fetchedMetadataDraft?.thumbnail || state.items[itemIndex].thumbnail || "") : "",
        ...extraData
      };
      if (status === "Completed") markItemAsCompleted(state.items[itemIndex]);
    }
  } else {
    // Create new item
    const newItem = {
      id: crypto.randomUUID(),
      title,
      category,
      status,
      rating,
      completionDate,
      notes,
      created: Date.now(),
      updated: Date.now(),
      thumbnail: thumbnailsEnabled() ? (fetchedMetadataDraft?.thumbnail || "") : "",
      ...extraData
    };
    if (status === "Completed") markItemAsCompleted(newItem);
    state.items.push(newItem);
  }

  state.lastEntryCategory = category;
  state.lastEntryStatusByCategory[category] = status;
  localStorage.setItem("squashdb_last_entry_statuses", JSON.stringify(state.lastEntryStatusByCategory));
  clearFormDraft();
  saveData();
  closeModal();
  renderDashboard();
  renderTimeline();
  renderStats();
}

// Format date into human readable form
function formatDate(dateStr) {
  if (!dateStr) return "";
  const parts = dateStr.split("-");
  if (parts.length !== 3) return dateStr;
  
  // Format nicely (e.g., Jul 8, 2026) without local offset shift issues
  const date = new Date(parts[0], parts[1] - 1, parts[2]);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
