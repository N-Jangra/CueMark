// CueMark - Logcat: captures console.log/warn/error/info and uncaught errors
// into a bounded ring buffer in localStorage, since every page here is a full
// navigation (not an SPA) — an in-memory buffer would reset on every page
// load. Must load before any other script on every page so nothing is missed.
// Read by logcat.html (Settings → App Data → Logcat).

(function () {
  const LEGACY_STORAGE_KEY = "cuemark_logcat";
  const DAYS_KEY = "cuemark_logcat_days";
  const DAILY_KEY_PREFIX = "cuemark_logcat_day_";
  const MAX_ENTRIES_PER_DAY = 500;
  const RECENT_DAYS = 3;

  function dayKey(time = Date.now()) {
    const date = new Date(time);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function dayStorageKey(day) {
    return `${DAILY_KEY_PREFIX}${day}`;
  }

  function readDays() {
    try {
      const parsed = JSON.parse(localStorage.getItem(DAYS_KEY) || "[]");
      return Array.isArray(parsed) ? parsed.filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day)).sort() : [];
    } catch (e) {
      return [];
    }
  }

  function writeDays(days) {
    try { localStorage.setItem(DAYS_KEY, JSON.stringify([...new Set(days)].sort())); } catch (e) { /* logging must never crash the app */ }
  }

  function readDay(day) {
    try {
      const parsed = JSON.parse(localStorage.getItem(dayStorageKey(day)) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function writeDay(day, entries) {
    try { localStorage.setItem(dayStorageKey(day), JSON.stringify(entries)); } catch (e) { /* storage full/unavailable */ }
  }

  function migrateLegacyEntries() {
    if (localStorage.getItem(`${DAYS_KEY}_migrated`) === "true") return;
    let legacy = [];
    try {
      const parsed = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || "[]");
      legacy = Array.isArray(parsed) ? parsed : [];
    } catch (e) { /* ignore malformed legacy logs */ }

    const grouped = new Map();
    legacy.forEach(entry => {
      const key = dayKey(entry.time);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(entry);
    });
    const days = readDays();
    grouped.forEach((entries, day) => writeDay(day, entries.slice(-MAX_ENTRIES_PER_DAY)));
    writeDays([...days, ...grouped.keys()]);
    try {
      localStorage.setItem(`${DAYS_KEY}_migrated`, "true");
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch (e) { /* ignore storage errors */ }
  }

  migrateLegacyEntries();

  function stringifyArg(arg) {
    if (typeof arg === "string") return arg;
    if (arg instanceof Error) return `${arg.name}: ${arg.message}${arg.stack ? `\n${arg.stack}` : ""}`;
    try {
      return JSON.stringify(arg);
    } catch (e) {
      return String(arg);
    }
  }

  function appendEntry(level, args) {
    const entry = {
      level,
      message: Array.from(args).map(stringifyArg).join(" "),
      page: (window.location.pathname.split("/").pop() || "").replace(".html", "") || "app",
      time: Date.now()
    };
    const day = dayKey(entry.time);
    const entries = readDay(day);
    entries.push(entry);
    writeDay(day, entries.slice(-MAX_ENTRIES_PER_DAY));
    writeDays([...readDays(), day]);
  }

  function entriesForDays(days) {
    return days.flatMap(day => readDay(day)).sort((a, b) => Number(a.time) - Number(b.time));
  }

  function recentDays(count = RECENT_DAYS) {
    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - Math.max(0, count - 1));
    const cutoffKey = dayKey(cutoff.getTime());
    return readDays().filter(day => day >= cutoffKey);
  }

  ["log", "info", "warn", "error"].forEach(level => {
    const original = console[level] ? console[level].bind(console) : () => {};
    console[level] = function (...args) {
      appendEntry(level === "log" ? "info" : level, args);
      original(...args);
    };
  });

  window.addEventListener("error", (event) => {
    appendEntry("error", [event.message || "Uncaught error", event.filename ? `(${event.filename}:${event.lineno})` : ""]);
  });

  window.addEventListener("unhandledrejection", (event) => {
    appendEntry("error", ["Unhandled promise rejection:", event.reason]);
  });

  window.cuemarkLogcat = {
    // The main Logcat page intentionally shows only today's file.
    getEntries: () => entriesForDays([dayKey()]),
    getRecentEntries: (days = RECENT_DAYS) => entriesForDays(recentDays(days)),
    getArchivedEntries: () => {
      const recent = new Set(recentDays(RECENT_DAYS));
      return entriesForDays(readDays().filter(day => !recent.has(day)));
    },
    getAvailableDays: () => readDays(),
    clear: () => {
      readDays().forEach(day => localStorage.removeItem(dayStorageKey(day)));
      writeDays([]);
    },
    clearDay: (day = dayKey()) => {
      localStorage.removeItem(dayStorageKey(day));
      writeDays(readDays().filter(value => value !== day));
    }
  };
})();
