/**
 * popup.js
 * ---------------------------------------------------------------------------
 * Popup controller:
 *  - Tab switching with lazy initialization (HulkTabs.initTab).
 *  - Theme toggle (storage.sync) with icon swap.
 *  - Keyboard shortcuts: Alt+1..6 to switch tabs, Esc to close.
 *  - Status bar reflecting service-worker scrape state (storage.onChanged).
 *  - "Open as window" popout (resizable/draggable window mode).
 *  - Global error boundaries -> console + toast.
 * ---------------------------------------------------------------------------
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const T = window.HulkTabs;
  const Config = window.HulkConfig;
  const Log = window.HulkLog;

  const STATE_KEY = "hulkScrapeState";

  // Payloads is a reference library — kept right before Settings. Subdomains
  // sits next to the other recon tabs (JS Files, Paths) before Scrape.
  const TAB_ORDER = ["dashboard", "jsfiles", "paths", "subdomains", "scrape", "payloads", "settings"];
  let activeTab = "dashboard";

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  async function init() {
    // Window mode (opened via popout button)
    if (new URLSearchParams(location.search).has("window")) {
      document.body.classList.add("window-mode");
    }

    const settings = await Config.getSettings();
    applyTheme(settings.theme);
    // Version stays pinned from the manifest — the status-tab label is
    // overwritten on every tab switch, the version must not be.
    const ver = $("status-version");
    if (ver) ver.textContent = "v" + chrome.runtime.getManifest().version;
    // Honor the Settings > Animations toggle (CSS hook, see popup.css).
    document.documentElement.dataset.animations = settings.animations !== false ? "on" : "off";

    wireTabs();
    wireHeader(settings);
    wireStatusBar();
    wireShortcuts();
    wireErrors();

    // Activate the initial tab (dashboard).
    activateTab("dashboard");
  }

  /* ------------------------------------------------------------------ *
   * Tabs
   * ------------------------------------------------------------------ */

  function wireTabs() {
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => activateTab(btn.dataset.tab));
    });
  }

  /**
   * Activate a tab: update ARIA state, show the pane, lazily init its module.
   * @param {string} id
   */
  function activateTab(id) {
    if (!TAB_ORDER.includes(id)) return;
    activeTab = id;

    document.querySelectorAll(".tab-btn").forEach((btn) => {
      const on = btn.dataset.tab === id;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", String(on));
      btn.tabIndex = on ? 0 : -1;
    });

    document.querySelectorAll(".pane").forEach((pane) => {
      const on = pane.id === "pane-" + id;
      pane.classList.toggle("active", on);
      pane.hidden = !on;
      if (on) pane.focus({ preventScroll: true });
    });

    T.initTab(id); // lazy, once
    updateStatusLine();
  }

  /* ------------------------------------------------------------------ *
   * Header: theme toggle + popout
   * ------------------------------------------------------------------ */

  function wireHeader(settings) {
    const themeBtn = $("theme-toggle");
    themeBtn.addEventListener("click", async () => {
      const next = settings.theme === "dark" ? "light" : "dark";
      settings = await Config.saveSettings({ theme: next });
      applyTheme(next);
      T.toast(next === "dark" ? "Dark theme" : "Light theme");
    });

    $("popout-btn").addEventListener("click", () => {
      chrome.windows.create({
        url: chrome.runtime.getURL("popup.html?window=1"),
        type: "popup",
        width: 620,
        height: 720
      });
      window.close();
    });
  }

  function applyTheme(theme) {
    Config.applyTheme(theme);
    const isDark = theme !== "light";
    $("theme-toggle").innerHTML = isDark
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  }

  /* ------------------------------------------------------------------ *
   * Status bar (service worker state)
   * ------------------------------------------------------------------ */

  function wireStatusBar() {
    // Live updates when the scrape state changes in storage.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[STATE_KEY]) {
        const state = changes[STATE_KEY].newValue;
        updateFromState(state);
      }
    });
    // Initial pull.
    chrome.runtime.sendMessage({ type: "HULK_STATUS" }).then((resp) => {
      if (resp && resp.ok && resp.state) updateFromState(resp.state);
    }).catch(() => {});
  }

  function updateFromState(state) {
    const dot = $("status-dot");
    const text = $("status-text");
    if (!dot || !text) return;
    // State removed (Clear pressed) or no run yet — reset to Ready.
    if (!state) {
      dot.className = "status-dot";
      text.textContent = "Ready";
      return;
    }

    if (state.running) {
      dot.className = "status-dot running";
      text.textContent = `Scraping page ${state.page}/${state.maxPages} · ${state.totalDomains} domains`;
    } else if (state.status === "finished" || state.status === "stopped") {
      dot.className = "status-dot" + (state.error ? " error" : "");
      text.textContent = state.error
        ? `Last run error: ${state.error}`
        : `Last run: ${state.totalDomains} domains`;
    } else if (state.status === "error") {
      dot.className = "status-dot error";
      text.textContent = "Scrape error";
    } else {
      dot.className = "status-dot";
      text.textContent = "Ready";
    }
  }

  function updateStatusLine() {
    const label = activeTab.charAt(0).toUpperCase() + activeTab.slice(1);
    const tab = $("status-tab");
    if (tab) tab.textContent = label;
  }

  /* ------------------------------------------------------------------ *
   * Keyboard shortcuts
   * ------------------------------------------------------------------ */

  function wireShortcuts() {
    document.addEventListener("keydown", (e) => {
      // Alt+1..7 switches tabs
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key >= "1" && e.key <= "7") {
        const idx = Number(e.key) - 1;
        if (TAB_ORDER[idx]) {
          e.preventDefault();
          activateTab(TAB_ORDER[idx]);
        }
        return;
      }
      // Esc closes the popup
      if (e.key === "Escape" && !e.target.closest("input, select, textarea")) {
        window.close();
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * Error boundaries
   * ------------------------------------------------------------------ */

  function wireErrors() {
    window.addEventListener("error", (ev) => {
      Log.error("Uncaught error in popup", ev.error || ev.message);
    });
    window.addEventListener("unhandledrejection", (ev) => {
      Log.error("Unhandled rejection in popup", ev.reason);
    });
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init().catch((err) => {
      Log.error("Popup init failed", err);
      T.toast("Failed to initialize: " + ((err && err.message) || err), "error");
    });
  }
})();
