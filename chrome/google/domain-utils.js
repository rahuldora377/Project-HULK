/**
 * google/domain-utils.js
 * ---------------------------------------------------------------------------
 * Pure, dependency-free helpers shared by the popup, results page, content
 * script and the Node test suite. No chrome.* APIs are used here so the
 * functions can be unit-tested in isolation.
 *
 * UMD export: browser global `HulkUtils` or CommonJS `module.exports`.
 * ---------------------------------------------------------------------------
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HulkUtils = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** Common second-level domains so `tldOf()` can group e.g. co.uk correctly. */
  const COMMON_SLD = new Set([
    "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk",
    "com.au", "net.au", "org.au", "edu.au", "gov.au",
    "co.jp", "ne.jp", "or.jp",
    "co.nz", "net.nz", "org.nz", "govt.nz",
    "com.br", "net.br", "org.br", "gov.br",
    "com.mx", "com.cn", "com.tw", "com.hk", "com.sg", "co.in", "co.za",
    "com.tr", "com.ar", "co.kr", "com.ua", "co.il", "co.id", "com.my", "com.ph",
    "com.vn", "com.eg", "com.sa", "com.pk", "com.ng", "com.gh", "com.ke", "com.ae"
  ]);

  /**
   * Parse a URL string (optionally resolving it against a base URL).
   * @param {string} href - The URL to parse (may be relative).
   * @param {string} [base] - Base URL for relative resolution.
   * @returns {URL|null} Parsed URL or null when invalid.
   */
  function parseUrl(href, base) {
    try {
      return new URL(href, base || undefined);
    } catch (err) {
      return null;
    }
  }

  /**
   * Extract a hostname from a URL object.
   * @param {URL} url
   * @returns {string|null}
   */
  function extractHostname(url) {
    return url && typeof url.hostname === "string" ? url.hostname : null;
  }

  /**
   * Resolve a raw URL against a page base URL — without ever fabricating an
   * origin. Relative references (e.g. `extract/modalbox.js`) are resolved
   * against the real page base (`document.baseURI`); when no usable http(s)
   * base is available the raw value must itself be absolute or it is
   * rejected. This replaces the old `parseUrl(raw, "https://example.invalid/")`
   * pattern, which produced bogus `https://example.invalid/...` URLs.
   * @param {string} raw - Raw URL (may be relative).
   * @param {string} [base] - Page base URL (e.g. document.baseURI).
   * @returns {URL|null} Resolved URL or null when unresolvable.
   */
  function resolveUrl(raw, base) {
    if (typeof raw !== "string" || !raw) return null;
    if (base && /^https?:/i.test(base)) {
      const u = parseUrl(raw, base);
      if (u) return u;
    }
    // No usable base: only absolute URLs parse.
    return parseUrl(raw);
  }

  /**
   * True when the hostname belongs to Google (google.com, www.google.co.uk…).
   * The regex requires a literal `google.` label followed by a Google-ish TLD,
   * so lookalikes like `notgoogle.com` or `google.evil.org` are NOT matched.
   * @param {string} hostname
   * @returns {boolean}
   */
  function isGoogleHost(hostname) {
    if (typeof hostname !== "string") return false;
    return /^([a-z0-9-]+\.)*google\.(com|org|net|co\.[a-z]{2}|com\.[a-z]{2}|[a-z]{2})$/i.test(
      hostname.toLowerCase()
    );
  }

  /**
   * Validate a domain name (labels, length, TLD).
   * @param {string} domain
   * @returns {boolean}
   */
  function isValidDomain(domain) {
    if (typeof domain !== "string") return false;
    const d = domain.toLowerCase();
    if (d.length < 4 || d.length > 253) return false;
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(d)) return false;
    const tld = d.split(".").pop();
    return tld.length >= 2 && tld.length <= 24 && /^[a-z]{2,}$/.test(tld);
  }

  /**
   * Normalize + validate a raw hostname (lowercase, strip port/userinfo/trailing dot).
   * @param {string} hostname
   * @returns {string|null} Clean domain or null when invalid.
   */
  function sanitizeDomain(hostname) {
    if (typeof hostname !== "string") return null;
    let d = hostname.toLowerCase().trim().replace(/\.$/, "");
    const colon = d.lastIndexOf(":");
    if (colon > -1 && /:\d+$/.test(d)) d = d.slice(0, colon); // strip :port
    const at = d.lastIndexOf("@");
    if (at > -1) d = d.slice(at + 1); // strip userinfo
    return isValidDomain(d) ? d : null;
  }

  /**
   * Sanitize, de-duplicate and sort a list of raw hostnames.
   * @param {string[]} domains
   * @returns {string[]} Sorted unique valid domains.
   */
  function sanitizeDomains(domains) {
    const out = [];
    const seen = new Set();
    for (const d of domains || []) {
      if (typeof d !== "string") continue;
      const clean = sanitizeDomain(d);
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      out.push(clean);
    }
    return out.sort();
  }

  /**
   * De-duplicate an array preserving order.
   * @param {Array} arr
   * @returns {Array}
   */
  function dedupe(arr) {
    return Array.from(new Set(arr || []));
  }

  /**
   * Group a domain into a public-suffix bucket (e.g. `com`, `org`, `co.uk`).
   * Honours common second-level domains so `example.co.uk` buckets as `co.uk`.
   * @param {string} domain
   * @returns {string}
   */
  function tldOf(domain) {
    const d = String(domain || "").toLowerCase();
    const parts = d.split(".");
    if (parts.length <= 1) return d;
    const lastTwo = parts.slice(-2).join(".");
    return COMMON_SLD.has(lastTwo) ? lastTwo : parts[parts.length - 1];
  }

  /**
   * True when a Google URL is an anti-automation wall (consent prompt or the
   * "unusual traffic" /sorry page) rather than search results. Starting a
   * scrape on these would silently yield nothing, so the scraper rejects
   * them with a clear message instead.
   * @param {URL} url
   * @returns {boolean}
   */
  function isGoogleWall(url) {
    if (!url) return false;
    const host = extractHostname(url) || "";
    return host === "consent.google.com" || /\/sorry\//i.test(url.pathname || "");
  }

  /**
   * True when a URL path is (or contains) a JavaScript file — including
   * versioned JS served under a `.js/` directory segment (e.g.
   * `/beacon.min.js/v4513226cdae34746b4dedf0b4dfa099e1781791509496` or
   * `/vendor/app.js/1.0/main.js`). These belong in the JS Files tab, not the
   * relative-paths list.
   * @param {string} path - URL path (may include query/hash).
   * @returns {boolean}
   */
  function isJsPath(path) {
    return /\.(?:js|mjs|cjs)(?:\/|\?|#|$)/i.test(String(path || ""));
  }

  /**
   * Compute the registrable domain (eTLD+1) of a hostname — the domain that
   * subdomains belong to. `a.b.example.co.uk` -> `example.co.uk`.
   * Honours common second-level domains (same table as tldOf).
   * @param {string} hostname
   * @returns {string|null} Registrable domain or null when invalid.
   */
  function registrableDomain(hostname) {
    const d = String(hostname || "").toLowerCase().trim().replace(/\.$/, "");
    if (!isValidDomain(d)) return null;
    const parts = d.split(".");
    if (parts.length <= 2) return d;
    const lastTwo = parts.slice(-2).join(".");
    // `a.b.example.co.uk` -> `example.co.uk` (3 labels), `x.example.com` -> `example.com`.
    return COMMON_SLD.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
  }

  /**
   * Convert a `{ domain: { count, title, urls[] } }` map into a sorted array.
   * @param {Object} map
   * @returns {Array<{domain:string, count:number, title:string, urls:string[]}>}
   */
  function recordsToArray(map) {
    return Object.keys(map || {})
      .map((domain) => ({
        domain,
        count: (map[domain] && map[domain].count) || 1,
        title: (map[domain] && map[domain].title) || "",
        urls: (map[domain] && map[domain].urls) || []
      }))
      .sort((a, b) => a.domain.localeCompare(b.domain));
  }

  /**
   * HTML-escape a string for safe interpolation into templates.
   * @param {*} str
   * @returns {string}
   */
  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  /**
   * Debounce a function.
   * @param {Function} fn
   * @param {number} wait - Milliseconds.
   * @returns {Function}
   */
  function debounce(fn, wait) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  /**
   * Throttle a function (leading edge + trailing flush).
   * @param {Function} fn
   * @param {number} wait - Milliseconds.
   * @returns {Function}
   */
  function throttle(fn, wait) {
    let last = 0;
    let t = null;
    return function (...args) {
      const now = Date.now();
      const remaining = wait - (now - last);
      if (remaining <= 0) {
        clearTimeout(t);
        t = null;
        last = now;
        fn.apply(this, args);
      } else if (!t) {
        t = setTimeout(() => {
          last = Date.now();
          t = null;
          fn.apply(this, args);
        }, remaining);
      }
    };
  }

  /** Clamp a number between min and max. */
  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  /** Format a count with thousands separators. */
  function formatCount(n) {
    try {
      return new Intl.NumberFormat("en-US").format(n || 0);
    } catch (err) {
      return String(n || 0);
    }
  }

  /** CSV-escape a single cell value. */
  function csvEscape(v) {
    const s = String(v == null ? "" : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /** Convert an array of rows to CSV text. */
  function toCSV(rows) {
    return (rows || []).map((r) => r.map(csvEscape).join(",")).join("\n");
  }

  /**
   * Trigger a browser download of a Blob (extension pages only — needs a DOM).
   * @param {string} filename
   * @param {string} content
   * @param {string} mime
   */
  function downloadBlob(filename, content, mime) {
    if (typeof document === "undefined") return;
    const blob = new Blob([content], { type: mime || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** Human-readable duration from milliseconds. */
  function formatDuration(ms) {
    const s = Math.max(0, Math.round((ms || 0) / 1000));
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m " + (s % 60) + "s";
    const h = Math.floor(m / 60);
    return h + "h " + (m % 60) + "m";
  }

  /** Relative "x ago" label from a timestamp. */
  function timeAgo(ts) {
    if (!ts) return "";
    const diff = Date.now() - ts;
    if (diff < 60000) return "just now";
    if (diff < 3600000) return Math.floor(diff / 60000) + "m ago";
    if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago";
    return Math.floor(diff / 86400000) + "d ago";
  }

  return {
    parseUrl,
    resolveUrl,
    extractHostname,
    registrableDomain,
    isJsPath,
    isGoogleWall,
    isGoogleHost,
    isValidDomain,
    sanitizeDomain,
    sanitizeDomains,
    dedupe,
    tldOf,
    recordsToArray,
    escapeHtml,
    debounce,
    throttle,
    clamp,
    formatCount,
    csvEscape,
    toCSV,
    downloadBlob,
    formatDuration,
    timeAgo
  };
});
