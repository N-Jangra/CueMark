// Export tracked titles in simple formats that can be edited and re-imported.
(function () {
  "use strict";

  function escapeDelimited(value, separator) {
    const text = String(value ?? "");
    return text.includes(separator) || /["\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function download(text, extension, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const category = document.getElementById("export-category")?.value || "list";
    const now = new Date();
    const dateTime = [
      now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")
    ].join("") + "-" + [String(now.getHours()).padStart(2, "0"), String(now.getMinutes()).padStart(2, "0"), String(now.getSeconds()).padStart(2, "0")].join("");
    link.href = url; link.download = `squashdb-${category}-${dateTime}.${extension}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportList(format) {
    const category = document.getElementById("export-category")?.value || "";
    const items = state.items.filter(item => item.category === category);
    if (!items.length) { showStatus("No items found for this category."); return; }
    let text; let extension; let mime;
    if (format === "txt") {
      text = items.map(item => `${item.title} - ${item.status}`).join("\n") + "\n";
      extension = "txt"; mime = "text/plain;charset=utf-8";
    } else {
      const separator = format === "tsv" ? "\t" : ",";
      const fields = state.preferences.exportIncludeMetadata
        ? ["title", "status", "category", "rating", "notes"] : ["title", "status", "category"];
      text = [
        fields.join(separator),
        ...items.map(item => fields.map(field => escapeDelimited(item[field] || "", separator)).join(separator))
      ].join("\n") + "\n";
      extension = format; mime = format === "tsv" ? "text/tab-separated-values;charset=utf-8" : "text/csv;charset=utf-8";
    }
    download(text, extension, mime);
    showStatus(`Exported ${items.length} item${items.length === 1 ? "" : "s"}.`);
  }

  function showStatus(message) {
    const target = document.getElementById("export-list-status");
    if (target) target.textContent = message;
    if (typeof showToast === "function") showToast(message, "success");
  }

  function init() {
    const select = document.getElementById("export-category");
    if (!select) return;
    Object.keys(CATEGORIES).forEach(key => {
      const option = document.createElement("option"); option.value = key; option.textContent = CATEGORIES[key].label || key; select.appendChild(option);
    });
    if (select.options.length) select.value = select.options[0].value;
    document.querySelectorAll("[data-export-format]").forEach(button => button.addEventListener("click", () => exportList(button.dataset.exportFormat || state.preferences.exportDefaultFormat || "csv")));
    if (window.lucide) lucide.createIcons();
  }

  window.addEventListener("squashdb-app-ready", init, { once: true });
})();
