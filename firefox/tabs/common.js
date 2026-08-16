/**
 * tabs/common.js
 * ---------------------------------------------------------------------------
 * Shared popup helpers, loaded before every tab module:
 *   window.HulkTabs
 *     .register(id, fn)            — register a lazy tab initializer
 *     .initTab(id)                 — run a registered initializer once
 *     .toast(msg, type)            — transient toast notification
 *     .copyText(text)              — clipboard write with fallback
 *     .makeCopyButton(text,label)  — DRY copy button (replaces 3 duplicate impls)
 *     .runInActiveTab(fn)          — promise wrapper for scripting.executeScript
 *     .icon(name)                  — inline SVG icon strings
 *     .renderChunked(container, items, builder) — perf-safe chunked DOM build
 * ---------------------------------------------------------------------------
 */
(() => {
  "use strict";

  const Log = window.HulkLog;
  const U = window.HulkUtils;

  const registry = {};
  const initialized = {};

  /* ------------------------------------------------------------------ *
   * Icons (Heroicons-style, stroke-based, 24x24 viewBox)
   * ------------------------------------------------------------------ */

  const ICONS = {
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
    open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
    globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
    chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>'
  };

  /** Return inline SVG markup for a named icon. */
  function icon(name) {
    return ICONS[name] || "";
  }

  /* ------------------------------------------------------------------ *
   * Tab registry (lazy initialization)
   * ------------------------------------------------------------------ */

  /**
   * Register a tab initializer. The function runs once, the first time the
   * tab is activated (lazy — no eager executeScript on popup open).
   * @param {string} id - Tab id (pane id suffix).
   * @param {Function} fn - Async or sync initializer.
   */
  function register(id, fn) {
    registry[id] = fn;
  }

  /** Run a registered tab initializer exactly once, with error boundary. */
  function initTab(id) {
    const fn = registry[id];
    if (!fn || initialized[id]) return;
    initialized[id] = true;
    try {
      const result = fn();
      if (result && typeof result.catch === "function") {
        result.catch((err) => showTabError(id, err));
      }
    } catch (err) {
      showTabError(id, err);
    }
  }

  /** Render a friendly error card inside a pane. */
  function showTabError(id, err) {
    Log.error(`Tab "${id}" failed`, err);
    const pane = document.getElementById("pane-" + id);
    if (!pane) return;
    pane.replaceChildren();
    const card = document.createElement("div");
    card.className = "error-card";
    card.setAttribute("role", "alert");
    const strong = document.createElement("strong");
    strong.textContent = "This section hit an error";
    const p = document.createElement("p");
    p.textContent = (err && err.message) ? err.message : String(err);
    card.append(strong, p);
    pane.appendChild(card);
  }

  /* ------------------------------------------------------------------ *
   * Feedback
   * ------------------------------------------------------------------ */

  let toastTimer = null;

  /** Show a transient toast in the popup (safe: textContent only). */
  function toast(msg, type) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.className = "toast show" + (type ? " " + type : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
  }

  /**
   * Copy text to the clipboard with a legacy fallback.
   * @returns {Promise<boolean>}
   */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch (err2) {
        return false;
      }
    }
  }

  /**
   * DRY copy button: replaces the three near-identical implementations that
   * previously lived in payloads.js, jsfiles.js and paths.js.
   * @param {string} text - Value to copy.
   * @param {string} [label] - Display text (defaults to `text`).
   * @returns {HTMLButtonElement}
   */
  function makeCopyButton(text, label) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy-btn";
    btn.setAttribute("aria-label", "Copy " + (label || text));
    btn.title = text;

    const iconSpan = document.createElement("span");
    iconSpan.className = "copy-btn-icon";
    iconSpan.innerHTML = icon("copy");

    const labelSpan = document.createElement("span");
    labelSpan.className = "copy-btn-label";
    labelSpan.textContent = label || text;

    btn.append(iconSpan, labelSpan);

    btn.addEventListener("click", async () => {
      const ok = await copyText(text);
      if (ok) {
        btn.classList.add("copied");
        iconSpan.innerHTML = icon("check");
        setTimeout(() => {
          btn.classList.remove("copied");
          iconSpan.innerHTML = icon("copy");
        }, 900);
      } else {
        toast("Copy failed — clipboard unavailable", "error");
      }
    });
    return btn;
  }

  /* ------------------------------------------------------------------ *
   * Active-tab scripting
   * ------------------------------------------------------------------ */

  /**
   * Run a function in the active tab via chrome.scripting (promise API).
   * @param {Function} fn - Must be self-contained (no closure over module vars).
   * @returns {Promise<*>} The injected function's return value.
   */
  async function runInActiveTab(fn) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error("No active tab found.");
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: fn
    });
    return results && results[0] ? results[0].result : undefined;
  }

  /**
   * Render items into a container in chunks (avoids jank on large datasets).
   * Each call cancels any in-flight chunked render on the same container, so a
   * newer dataset (e.g. a re-scan) can never interleave stale frames with the
   * current one.
   * @param {HTMLElement} container
   * @param {Array} items
   * @param {Function} builder - (item) => HTMLElement
   * @param {number} [chunkSize=60]
   */
  const chunkTokens = new WeakMap();
  function renderChunked(container, items, builder, chunkSize = 60) {
    const prev = chunkTokens.get(container);
    if (prev) prev.cancel();
    container.replaceChildren();
    if (!items.length) return;
    let i = 0;
    let cancelled = false;
    chunkTokens.set(container, { cancel: () => { cancelled = true; } });
    const step = () => {
      if (cancelled) return;
      const frag = document.createDocumentFragment();
      const end = Math.min(i + chunkSize, items.length);
      for (; i < end; i++) frag.appendChild(builder(items[i]));
      container.appendChild(frag);
      if (i < items.length) requestAnimationFrame(step);
      else chunkTokens.delete(container);
    };
    requestAnimationFrame(step);
  }

  /* ------------------------------------------------------------------ *
   * Public API
   * ------------------------------------------------------------------ */

  window.HulkTabs = {
    register,
    initTab,
    toast,
    copyText,
    makeCopyButton,
    runInActiveTab,
    renderChunked,
    icon
  };

  Log.info("tabs/common.js loaded");
})();
