/**
 * google/config.js
 * ---------------------------------------------------------------------------
 * Centralized settings: defaults + chrome.storage.sync persistence.
 * Shared by the service worker and all extension pages.
 * Exposes global `HulkConfig` (or CommonJS export).
 * ---------------------------------------------------------------------------
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HulkConfig = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** Default settings. All values are plain JSON (safe for storage.sync). */
  const DEFAULTS = Object.freeze({
    theme: "dark",            // "dark" | "light"
    animations: true,         // UI motion on/off
    debugLogging: false,      // verbose HulkLog output
    autoOpenResults: true,    // open results tab when a scrape finishes
    maxPages: 10,             // max Google result pages per run
    pageDelayMs: 1500,        // delay between page scrapes (rate limiting)
    nextSelector: "a[aria-label='Next page'], #pnnext, a[aria-label='Next']",
    resultsPageSize: 50       // results per page in the dashboard
  });

  const KEY = "hulkSettings";

  /** True when chrome.storage.sync is available. */
  function hasStorage() {
    return typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync;
  }

  /**
   * Load settings merged over defaults.
   * @returns {Promise<Object>}
   */
  async function getSettings() {
    const base = { ...DEFAULTS };
    if (!hasStorage()) return base;
    try {
      const data = await chrome.storage.sync.get(KEY);
      const saved = (data && data[KEY]) || {};
      for (const k of Object.keys(DEFAULTS)) {
        if (k in saved) base[k] = saved[k];
      }
    } catch (err) {
      // storage failures fall back to defaults
    }
    return base;
  }

  /**
   * Merge a patch into persisted settings and return the new full object.
   * @param {Object} patch
   * @returns {Promise<Object>}
   */
  async function saveSettings(patch) {
    const current = await getSettings();
    const next = { ...current, ...patch };
    if (hasStorage()) {
      try {
        await chrome.storage.sync.set({ [KEY]: next });
      } catch (err) {
        /* sync quota / transient errors: keep in-memory copy */
      }
    }
    return next;
  }

  /**
   * Apply a theme to <html data-theme> (no-op outside a document).
   * @param {string} theme - "dark" | "light"
   */
  function applyTheme(theme) {
    if (typeof document === "undefined") return;
    document.documentElement.setAttribute("data-theme", theme || "dark");
  }

  return { DEFAULTS, KEY, getSettings, saveSettings, applyTheme };
});
