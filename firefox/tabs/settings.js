/**
 * tabs/settings.js
 * ---------------------------------------------------------------------------
 * Settings tab: theme toggle, animation toggle, scrape tuning (max pages,
 * page delay, next selector), debug logging, results page size, and
 * export / import / reset of the settings JSON.
 * Persistence: chrome.storage.sync via HulkConfig.
 * ---------------------------------------------------------------------------
 */
(() => {
  "use strict";

  const T = window.HulkTabs;
  const U = window.HulkUtils;
  const Config = window.HulkConfig;
  const Log = window.HulkLog;

  let current = null;

  async function init() {
    const pane = document.getElementById("pane-settings");
    pane.replaceChildren();
    current = await Config.getSettings();
    render(pane);
  }

  function render(pane) {
    pane.replaceChildren();

    // ---- Appearance ----
    const appearance = section("Appearance");
    appearance.appendChild(toggleRow(
      "Dark theme",
      "Use the dark color scheme (light theme for daytime use).",
      "theme",
      current.theme !== "light",
      (checked) => save({ theme: checked ? "dark" : "light" })
    ));
    appearance.appendChild(toggleRow(
      "Animations",
      "Enable transitions and motion effects.",
      "animations",
      !!current.animations,
      (checked) => save({ animations: checked })
    ));
    pane.appendChild(appearance);

    // ---- Scraping ----
    const scraping = section("Scraping");
    scraping.appendChild(numberRow(
      "Max pages",
      "Stop after this many result pages — 0 crawls until the last page.",
      "maxPages",
      current.maxPages,
      0, 50,
      (val) => save({ maxPages: val })
    ));
    scraping.appendChild(numberRow(
      "Page delay (ms)",
      "Delay between page scrapes — higher is gentler on Google.",
      "pageDelayMs",
      current.pageDelayMs,
      500, 15000,
      (val) => save({ pageDelayMs: val })
    ));
    scraping.appendChild(textRow(
      "Next-page selector",
      "CSS selector for the “next” pagination link.",
      "nextSelector",
      current.nextSelector,
      (val) => save({ nextSelector: val })
    ));
    pane.appendChild(scraping);

    // ---- Results ----
    const results = section("Results");
    results.appendChild(toggleRow(
      "Auto-open results",
      "Open the results dashboard when a scrape finishes.",
      "autoOpenResults",
      !!current.autoOpenResults,
      (checked) => save({ autoOpenResults: checked })
    ));
    results.appendChild(numberRow(
      "Results per page",
      "How many domains the dashboard shows per page.",
      "resultsPageSize",
      current.resultsPageSize,
      10, 200,
      (val) => save({ resultsPageSize: val })
    ));
    pane.appendChild(results);

    // ---- Advanced ----
    const advanced = section("Advanced");
    advanced.appendChild(toggleRow(
      "Debug logging",
      "Write verbose logs to the console (HULK prefix).",
      "debugLogging",
      !!current.debugLogging,
      (checked) => save({ debugLogging: checked })
    ));

    const btnRow = document.createElement("div");
    btnRow.className = "btn-row";

    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.className = "btn ghost";
    exportBtn.innerHTML = T.icon("download") + '<span class="btn-label">Export</span>';
    exportBtn.addEventListener("click", exportSettings);

    const importBtn = document.createElement("button");
    importBtn.type = "button";
    importBtn.className = "btn ghost";
    importBtn.innerHTML = T.icon("upload") + '<span class="btn-label">Import</span>';

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "application/json,.json";
    fileInput.hidden = true;
    importBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", importSettings);

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "btn danger";
    resetBtn.innerHTML = T.icon("trash") + '<span class="btn-label">Reset</span>';
    resetBtn.addEventListener("click", resetSettings);

    btnRow.append(exportBtn, importBtn, resetBtn, fileInput);
    advanced.appendChild(btnRow);
    pane.appendChild(advanced);
  }

  /* ------------------------------------------------------------------ *
   * Form builders (all text via textContent — XSS-safe)
   * ------------------------------------------------------------------ */

  function section(titleText) {
    const sec = document.createElement("section");
    sec.className = "settings-section";
    const h = document.createElement("h2");
    h.textContent = titleText;
    sec.appendChild(h);
    return sec;
  }

  function toggleRow(labelText, desc, key, checked, onChange) {
    const row = document.createElement("label");
    row.className = "set-row";
    const textWrap = document.createElement("span");
    textWrap.className = "set-text";
    const label = document.createElement("span");
    label.className = "set-label";
    label.textContent = labelText;
    const descEl = document.createElement("span");
    descEl.className = "set-desc";
    descEl.textContent = desc;
    textWrap.append(label, descEl);

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    input.setAttribute("aria-label", labelText);
    const track = document.createElement("span");
    track.className = "switch-track";
    track.setAttribute("aria-hidden", "true");
    input.addEventListener("change", () => onChange(input.checked));

    const wrap = document.createElement("span");
    wrap.className = "switch";
    wrap.append(input, track);

    row.append(textWrap, wrap);
    return row;
  }

  function numberRow(labelText, desc, key, value, min, max, onChange) {
    const row = document.createElement("div");
    row.className = "set-row";
    const textWrap = document.createElement("span");
    textWrap.className = "set-text";
    const label = document.createElement("span");
    label.className = "set-label";
    label.textContent = labelText;
    const descEl = document.createElement("span");
    descEl.className = "set-desc";
    descEl.textContent = desc;
    textWrap.append(label, descEl);

    const input = document.createElement("input");
    input.type = "number";
    input.className = "field num";
    input.min = String(min);
    input.max = String(max);
    input.value = String(value);
    input.setAttribute("aria-label", labelText);
    input.addEventListener("change", () => {
      // Preserve 0 (meaningful for maxPages = unlimited); revert empty/garbage
      // input to the previously saved value instead of silently coercing it.
      const parsed = parseInt(input.value, 10);
      const v = Number.isFinite(parsed) ? U.clamp(parsed, min, max) : current[key];
      input.value = String(v);
      onChange(v);
    });

    row.append(textWrap, input);
    return row;
  }

  function textRow(labelText, desc, key, value, onChange) {
    const row = document.createElement("div");
    row.className = "set-row";
    const textWrap = document.createElement("span");
    textWrap.className = "set-text";
    const label = document.createElement("span");
    label.className = "set-label";
    label.textContent = labelText;
    const descEl = document.createElement("span");
    descEl.className = "set-desc";
    descEl.textContent = desc;
    textWrap.append(label, descEl);

    const input = document.createElement("input");
    input.type = "text";
    input.className = "field";
    input.value = value || "";
    input.setAttribute("aria-label", labelText);
    input.addEventListener("change", () => onChange(input.value.trim()));

    row.append(textWrap, input);
    return row;
  }

  /* ------------------------------------------------------------------ *
   * Actions
   * ------------------------------------------------------------------ */

  /** Keep the CSS animations hook in sync with the saved setting. */
  function applyAnimations() {
    document.documentElement.dataset.animations = current.animations !== false ? "on" : "off";
  }

  async function save(patch) {
    current = await Config.saveSettings(patch);
    Config.applyTheme(current.theme);
    applyAnimations();
    if (window.HulkLog) window.HulkLog.setEnabled(true);
    T.toast("Settings saved", "success");
  }

  function exportSettings() {
    const payload = { exportedAt: new Date().toISOString(), settings: current };
    U.downloadBlob("hulk-settings.json", JSON.stringify(payload, null, 2), "application/json");
    T.toast("Settings exported");
  }

  async function importSettings(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const incoming = parsed && parsed.settings ? parsed.settings : parsed;
      if (!incoming || typeof incoming !== "object") throw new Error("Invalid settings file");

      // Validate: only accept known keys with the right primitive types.
      const patch = {};
      for (const [key, def] of Object.entries(Config.DEFAULTS)) {
        if (key in incoming && typeof incoming[key] === typeof def) {
          patch[key] = incoming[key];
        }
      }
      current = await Config.saveSettings(patch);
      Config.applyTheme(current.theme);
      applyAnimations();
      render(document.getElementById("pane-settings"));
      T.toast("Settings imported", "success");
    } catch (err) {
      T.toast("Import failed: " + ((err && err.message) || err), "error");
    } finally {
      event.target.value = "";
    }
  }

  async function resetSettings() {
    const defaults = { ...Config.DEFAULTS };
    current = await Config.saveSettings(defaults);
    Config.applyTheme(current.theme);
    applyAnimations();
    render(document.getElementById("pane-settings"));
    T.toast("Settings reset to defaults", "success");
  }

  T.register("settings", init);
})();
