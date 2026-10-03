(() => {
  const HISTORY_KEY = "cuemark_settings_search_history";
  const CATEGORY_FILES = Array.from({ length: 14 }, (_, index) => `static/pages/settings/category-${index + 1}.html`);
  let indexPromise;

  function readHistory() {
    try {
      const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      return Array.isArray(value) ? value.filter(item => typeof item === "string").slice(0, 5) : [];
    } catch (_) {
      return [];
    }
  }

  function writeHistory(query) {
    const value = query.trim();
    if (!value) return;
    const history = [value, ...readHistory().filter(item => item.toLocaleLowerCase() !== value.toLocaleLowerCase())].slice(0, 5);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  }

  async function loadSearchIndex() {
    if (indexPromise) return indexPromise;
    indexPromise = Promise.all(CATEGORY_FILES.map(async href => {
      const response = await fetch(href);
      if (!response.ok) throw new Error(`Unable to load ${href}`);
      const source = await response.text();
      const page = new DOMParser().parseFromString(source, "text/html");
      const category = page.querySelector(".settings-category-title h2")?.textContent.trim() || "Settings";
      return [...page.querySelectorAll(".settings-category-page .settings-row")].map(row => {
        const title = row.querySelector(".settings-row-body label, .settings-row-body > label, label")?.textContent.trim()
          || row.textContent.trim().split(/\s+/).slice(0, 6).join(" ");
        const description = [...row.querySelectorAll(".settings-row-body span")].map(node => node.textContent.trim()).filter(Boolean).join(" ");
        const pref = row.dataset.pref;
        let choices = [];
        try {
          if (pref && typeof SETTINGS_PICKERS !== "undefined") choices = (SETTINGS_PICKERS[pref]?.options || []).map(option => option.label);
        } catch (_) { /* Search still works for rows if picker metadata is unavailable. */ }
        const extraChoices = {
          "trim-image-cache": ["250 images", "500 images", "1,000 images", "Unlimited"],
          "notification-snooze": ["Off", "1 hour", "3 hours", "Tomorrow", "Next week"],
          "notification-quiet-hours": ["Off", "On", "start time", "end time"],
          "notification-reminder-time": ["time", "local device time"]
        };
        choices = choices.concat(extraChoices[row.id] || []);
        if (row.id === "category-colors-picker") {
          try {
            if (typeof CATEGORIES !== "undefined") choices.push(...Object.values(CATEGORIES).map(category => category.label));
          } catch (_) { /* Dynamic category labels are optional search hints. */ }
        }
        return {
          title,
          description,
          category,
          choices,
          href: `${href}#${row.id}`,
          searchText: `${title} ${description} ${category} ${choices.join(" ")}`.toLocaleLowerCase()
        };
      });
    })).then(groups => groups.flat());
    return indexPromise;
  }

  function renderHistory(container, input, history) {
    container.replaceChildren();
    if (!history.length) {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    const header = document.createElement("div");
    header.className = "settings-search-history-header";
    const title = document.createElement("span");
    title.textContent = "Recent searches";
    header.append(title);
    container.append(header);
    const pills = document.createElement("div");
    pills.className = "settings-search-history-pills";
    history.forEach(query => {
      const pill = document.createElement("div");
      pill.className = "settings-search-history-pill";
      const searchAgain = document.createElement("button");
      searchAgain.type = "button";
      searchAgain.className = "settings-search-history-query";
      searchAgain.textContent = query;
      searchAgain.addEventListener("click", () => {
        input.value = query;
        input.focus();
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "settings-search-history-remove";
      remove.setAttribute("aria-label", `Remove ${query} from recent searches`);
      remove.innerHTML = '<i data-lucide="x" aria-hidden="true"></i>';
      remove.addEventListener("click", () => {
        const next = readHistory().filter(item => item !== query);
        if (next.length) localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
        else localStorage.removeItem(HISTORY_KEY);
        renderHistory(container, input, next);
      });
      pill.append(searchAgain, remove);
      pills.append(pill);
    });
    container.append(pills);
    if (window.lucide) window.lucide.createIcons({ attrs: { "aria-hidden": "true" } });
  }

  function renderResults(container, results, query, input) {
    container.replaceChildren();
    container.hidden = false;
    if (!results.length) {
      const empty = document.createElement("p");
      empty.className = "settings-search-empty";
      empty.textContent = `No settings found for “${query}”.`;
      container.append(empty);
      return;
    }
    results.slice(0, 40).forEach(item => {
      const link = document.createElement("a");
      link.className = "settings-search-result";
      link.href = item.href;
      const title = document.createElement("span");
      title.className = "settings-search-result-title";
      title.textContent = item.title;
      const matchedChoice = item.choices.find(choice => choice.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
      const detail = document.createElement("span");
      detail.className = "settings-search-result-detail";
      detail.textContent = matchedChoice ? `${item.category} · Option: ${matchedChoice}` : `${item.category}${item.description ? ` · ${item.description}` : ""}`;
      link.append(title, detail);
      link.addEventListener("click", () => writeHistory(input.value));
      container.append(link);
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("[data-settings-search-input]").forEach(input => {
      const page = input.closest(".settings-index-page, .settings-category-page");
      const results = page.querySelector("[data-settings-search-results]");
      const history = page.querySelector("[data-settings-search-history]");
      const clear = page.querySelector("[data-settings-search-clear]");
      const groups = page.querySelectorAll(".settings-index-group");
      const categoryContent = page.querySelectorAll(".settings-category-page > .settings-section, .settings-category-page > .settings-page-header:not(.settings-category-title)");
      let requestId = 0;

      function resetPage() {
        results.hidden = true;
        groups.forEach(group => { group.hidden = false; });
        categoryContent.forEach(section => { section.hidden = false; });
        clear.hidden = true;
        history.hidden = true;
      }

      input.addEventListener("focus", () => {
        if (!input.value.trim()) renderHistory(history, input, readHistory());
      });
      input.addEventListener("input", async () => {
        const query = input.value.trim();
        clear.hidden = !query;
        history.hidden = Boolean(query);
        groups.forEach(group => { group.hidden = Boolean(query); });
        categoryContent.forEach(section => { section.hidden = Boolean(query); });
        if (!query) {
          requestId += 1;
          resetPage();
          if (document.activeElement === input) renderHistory(history, input, readHistory());
          return;
        }
        const currentRequest = ++requestId;
        results.hidden = false;
        results.innerHTML = '<p class="settings-search-empty">Searching all settings…</p>';
        try {
          const entries = await loadSearchIndex();
          if (currentRequest !== requestId) return;
          const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
          const matches = entries.filter(entry => words.every(word => entry.searchText.includes(word)));
          matches.sort((a, b) => {
            const aExact = a.title.toLocaleLowerCase().startsWith(query.toLocaleLowerCase()) ? 0 : 1;
            const bExact = b.title.toLocaleLowerCase().startsWith(query.toLocaleLowerCase()) ? 0 : 1;
            return aExact - bExact || a.title.localeCompare(b.title);
          });
          renderResults(results, matches, query, input);
        } catch (error) {
          console.warn("Settings search failed", error);
          results.innerHTML = '<p class="settings-search-empty">Settings search is temporarily unavailable.</p>';
        }
      });
      input.addEventListener("keydown", event => {
        if (event.key === "Enter" && input.value.trim()) writeHistory(input.value);
        if (event.key === "Escape") {
          input.value = "";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.blur();
        }
      });
      clear.addEventListener("click", () => {
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.focus();
      });
      input.addEventListener("blur", () => setTimeout(() => { if (!input.value.trim()) history.hidden = true; }, 180));
      resetPage();
    });
  });
})();
