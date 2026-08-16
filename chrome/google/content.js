/**
 * google/content.js
 * ---------------------------------------------------------------------------
 * Content script injected ON DEMAND by the service worker (google/scraper.js)
 * into the Google tab being scraped. The manifest no longer auto-registers
 * it, so nothing runs in Google tabs until a scrape starts. It does the DOM
 * scraping on request and answers back over `chrome.runtime` messaging — this
 * replaces the previous "inject a function with scripting.executeScript"
 * approach with a stable, message-driven one.
 *
 * Features:
 *  - Re-entry guard (prevents double listeners when the same file is injected
 *    both by the manifest and by `scripting.executeScript` fallback).
 *  - Safe link extraction: relative URLs resolved against the document,
 *    Google hosts skipped, `javascript:`/`data:` URLs rejected.
 *  - Bounded traversal of same-origin iframes and open shadow roots.
 *  - Configurable "next page" selector list with safe querySelector usage.
 *
 * Protocol (request -> response):
 *   { type: "HULK_SCRAPE_PAGE", page, selector }
 *   -> { ok, domains: [{domain,count,title,urls}], hasNext, url }
 *   -> { ok: false, error }
 *
 *   { type: "HULK_GO_NEXT", selector }
 *   -> { ok, clicked, url }
 * ---------------------------------------------------------------------------
 */
(() => {
  "use strict";

  if (window.__hulkContentLoaded) return;
  window.__hulkContentLoaded = true;

  const MAX_SHADOW_DEPTH = 3;
  const MAX_LINKS_PER_PAGE = 500;
  const MAX_URLS_PER_DOMAIN = 15; // full domain+path URLs kept per domain
  const HulkUtils = window.HulkUtils;

  /** Known Google pagination selectors, tried in order (custom first). */
  const NEXT_SELECTORS = [
    "a[aria-label='Next page']",
    "#pnnext",
    "a[aria-label='Next']",
    "a[rel='next']",
    "a#pnnext"
  ];

  /**
   * Collect unique domain records from a document subtree.
   * @param {Document|ShadowRoot} doc - Root to walk.
   * @param {Map<string,{domain:string,count:number,title:string,urls:string[]}>} out
   * @param {number} depth - Shadow/iframe recursion depth.
   * @param {Object} budget - Shared node/link budget {links}.
   * @param {string} baseUrl - Top-document URL used to resolve relative links
   *   (shadow roots have no `.location`, so the base must be threaded down).
   */
  function extractFromDocument(doc, out, depth, budget, baseUrl) {
    if (!doc || depth > MAX_SHADOW_DEPTH) return;
    if (budget.links >= MAX_LINKS_PER_PAGE) return;

    let anchors = [];
    try {
      anchors = doc.querySelectorAll("a[href]");
    } catch (err) {
      /* cross-origin / invalid document — skip */
    }

    for (const a of anchors) {
      if (budget.links >= MAX_LINKS_PER_PAGE) break;
      const href = a.getAttribute("href");
      if (!href || /^(javascript|data|vbscript|mailto|tel):/i.test(href.trim())) continue;

      // Resolve relative URLs against the top document (shadow roots have
      // no .location, so we use the base threaded down from the caller).
      const url = HulkUtils.parseUrl(href, baseUrl);
      if (!url || !/^https?:$/.test(url.protocol)) continue;
      const host = HulkUtils.extractHostname(url);
      if (!host || HulkUtils.isGoogleHost(host)) continue;
      const domain = HulkUtils.sanitizeDomain(host);
      if (!domain) continue;

      budget.links += 1;

      let record = out.get(domain);
      if (!record) {
        record = { domain, count: 0, title: "", urls: [] };
        out.set(domain, record);
      }
      record.count += 1;
      if (!record.title) {
        const text = (a.textContent || "").replace(/\s+/g, " ").trim();
        if (text) record.title = text.slice(0, 300);
      }
      if (record.urls.length < MAX_URLS_PER_DOMAIN) record.urls.push(url.href);
    }

    // Same-origin iframes / frames.
    let frames = [];
    try {
      frames = doc.querySelectorAll("iframe, frame");
    } catch (err) { /* ignore */ }
    for (const f of frames) {
      try {
        if (f.contentDocument) extractFromDocument(f.contentDocument, out, depth + 1, budget, f.contentDocument.location.href || baseUrl);
      } catch (err) {
        /* cross-origin frame — cannot access */
      }
    }

    // Open shadow roots (closed roots are inaccessible by design).
    let all = [];
    try {
      all = doc.querySelectorAll("*");
    } catch (err) { /* ignore */ }
    for (const el of all) {
      try {
        if (el.shadowRoot) extractFromDocument(el.shadowRoot, out, depth + 1, budget, baseUrl);
      } catch (err) { /* ignore */ }
    }
  }

  /**
   * Detect a "next results page" link using a set of known selectors.
   * @param {Document} doc
   * @param {string} [customSelector] - User-configured selector (fallback).
   * @returns {boolean}
   */
  function hasNextPage(doc, customSelector) {
    const selectors = customSelector ? [customSelector, ...NEXT_SELECTORS] : NEXT_SELECTORS;
    for (const sel of selectors) {
      try {
        if (doc.querySelector(sel)) return true;
      } catch (err) {
        /* invalid selector — try the next one */
      }
    }
    return false;
  }

  /**
   * Click the "next results page" link. Returns true when a candidate was
   * found and clicked (the actual navigation is verified by the service
   * worker, which watches the tab URL).
   * @param {string} [customSelector]
   * @returns {boolean}
   */
  function clickNextLink(customSelector) {
    const selectors = customSelector ? [customSelector, ...NEXT_SELECTORS] : NEXT_SELECTORS;
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el && typeof el.click === "function") {
          el.click();
          return true;
        }
      } catch (err) {
        /* invalid selector — try the next one */
      }
    }
    return false;
  }

  /**
   * Message handler — synchronous response via sendResponse.
   */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string") return undefined;

    if (msg.type === "HULK_SCRAPE_PAGE") {
      try {
        const out = new Map();
        const budget = { links: 0 };
        const baseUrl = document.location ? document.location.href : undefined;
        extractFromDocument(document, out, 0, budget, baseUrl);
        const domains = Array.from(out.values());
        const url = document.location ? document.location.href : "";
        sendResponse({
          ok: true,
          domains,
          hasNext: hasNextPage(document, msg.selector),
          url
        });
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
      return undefined; // response is synchronous
    }

    if (msg.type === "HULK_GO_NEXT") {
      try {
        const clicked = clickNextLink(msg.selector);
        sendResponse({
          ok: true,
          clicked,
          url: document.location ? document.location.href : ""
        });
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
      return undefined;
    }

    return undefined;
  });
})();
