/**
 * tabs/subdomains.js
 * ---------------------------------------------------------------------------
 * Subdomains tab: discovers subdomains of the current tab's registrable
 * domain — with NO external services. Everything comes from the current
 * page itself:
 *
 *   1. DOM attributes — hostnames referenced by links, scripts, stylesheets,
 *      images, iframes, forms… (`href`/`src`/`action`/`data`).
 *   2. Inline JS — hardcoded URLs inside <script> blocks (API endpoints etc.),
 *      pulled from the page's own script text.
 *
 * UX: the registrable domain (e.g. `example.com`) is the visible scope at the
 * top; the apex domain comes first, then each subdomain is a mono row with a
 * copy button. Clicking a row copies it; "Copy all" copies the whole list.
 * ---------------------------------------------------------------------------
 */
(() => {
  "use strict";

  const T = window.HulkTabs;
  const U = window.HulkUtils;
  const Log = window.HulkLog;

  /** Cache of the last scan so re-renders don't re-inject into the tab. */
  let cached = { rows: [], reg: "" };

  /**
   * Runs inside the active page (isolated world). Self-contained only.
   * Collects every distinct hostname the page references — from DOM
   * attributes AND hardcoded URLs in inline scripts.
   * @returns {{baseUrl: string, pageHost: string, hosts: string[]}}
   */
  function collectPageHosts() {
    const hosts = new Set();

    const bump = (host) => {
      hosts.add(host);
    };

    // 1) DOM attributes: links, scripts, styles, images, iframes, forms…
    const SELECTOR =
      "a[href], script[src], link[href], img[src], iframe[src], " +
      "source[src], video[src], audio[src], form[action], embed[src], object[data]";
    try {
      for (const el of document.querySelectorAll(SELECTOR)) {
        const raw = el.getAttribute("href") || el.getAttribute("src") ||
          el.getAttribute("action") || el.getAttribute("data");
        if (!raw) continue;
        let url;
        try {
          url = new URL(raw, document.baseURI);
        } catch (err) {
          continue;
        }
        if (url.protocol === "http:" || url.protocol === "https:") {
          bump(url.hostname.toLowerCase());
        }
      }
    } catch (err) { /* restricted document — ignore */ }

    // 2) Hardcoded URLs inside inline <script> blocks (API endpoints etc.).
    // Accepts http(s)://host and protocol-relative //host (common in bundles).
    const JS_URL_RE = /(?:https?:)?\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?/gi;
    try {
      for (const s of document.querySelectorAll("script:not([src])")) {
        const text = s.textContent || "";
        let m;
        while ((m = JS_URL_RE.exec(text)) !== null) {
          try {
            const abs = m[0].startsWith("//") ? "https:" + m[0] : m[0];
            bump(new URL(abs).hostname.toLowerCase());
          } catch (err) { /* malformed — skip */ }
        }
      }
    } catch (err) { /* ignore */ }

    const own = (document.location && document.location.hostname || "").toLowerCase();
    if (own) hosts.add(own);

    return {
      baseUrl: document.baseURI || document.location.href || "",
      pageHost: own,
      hosts: Array.from(hosts)
    };
  }

  /** True when `host` is `domain` itself or a subdomain of it. */
  function inScope(host, domain) {
    return host === domain || host.endsWith("." + domain);
  }

  /** Row DOM: hostname + copy. Clicking the row copies too. */
  function buildRow(host, isApex) {
    const row = document.createElement("div");
    row.className = "sub-row" + (isApex ? " sub-apex" : "");
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    row.setAttribute("aria-label", "Copy " + host);
    row.title = "Click to copy " + host;

    const icon = document.createElement("span");
    icon.className = "sub-icon";
    icon.innerHTML = T.icon(isApex ? "shield" : "globe");

    const hostEl = document.createElement("span");
    hostEl.className = "sub-host";
    hostEl.textContent = host;

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "icon-btn sub-copy";
    copy.setAttribute("aria-label", "Copy " + host);
    copy.dataset.tooltip = "Copy";
    copy.innerHTML = T.icon("copy");
    copy.addEventListener("click", (ev) => {
      ev.stopPropagation();
      copyHost(host);
    });

    row.append(icon, hostEl, copy);
    row.addEventListener("click", () => copyHost(host));
    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        copyHost(host);
      }
    });
    return row;
  }

  async function copyHost(host) {
    const ok = await T.copyText(host);
    if (ok) T.toast("Copied " + host, "success");
    else T.toast("Copy failed — clipboard unavailable", "error");
  }

  async function copyAll() {
    const list = cached.rows.map((r) => r.host);
    if (!list.length) { T.toast("Nothing to copy", "error"); return; }
    const ok = await T.copyText(list.join("\n"));
    if (ok) T.toast(`Copied ${U.formatCount(list.length)} subdomains`, "success");
    else T.toast("Copy failed — clipboard unavailable", "error");
  }

  function init() {
    const pane = document.getElementById("pane-subdomains");
    pane.replaceChildren();

    // Header
    const header = document.createElement("div");
    header.className = "pane-header";
    const title = document.createElement("h2");
    title.textContent = "Subdomains";
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "icon-btn";
    refresh.setAttribute("aria-label", "Re-scan the active tab");
    refresh.dataset.tooltip = "Re-scan the active tab";
    refresh.innerHTML = T.icon("refresh");
    header.append(title, refresh);
    pane.appendChild(header);

    // Scope card — the domain everything is grouped under.
    const scopeCard = document.createElement("div");
    scopeCard.className = "card sub-scope";
    const scopeTitle = document.createElement("h2");
    scopeTitle.className = "card-title";
    scopeTitle.textContent = "Scope";
    const scopeRow = document.createElement("div");
    scopeRow.className = "tab-row";
    const scopeFavicon = document.createElement("span");
    scopeFavicon.className = "favicon";
    const scopeHost = document.createElement("span");
    scopeHost.className = "tab-text sub-scope-host";
    scopeHost.id = "sub-scope-host";
    scopeHost.textContent = "…";
    const scopeNote = document.createElement("p");
    scopeNote.className = "muted";
    scopeNote.textContent = "Hostnames referenced by this page (links, scripts, styles, images, inline JS…). No external services — everything comes from the page you are viewing. Click a row to copy it.";
    scopeRow.append(scopeFavicon, scopeHost);
    scopeCard.append(scopeTitle, scopeRow, scopeNote);
    pane.appendChild(scopeCard);

    // Toolbar: copy all
    const toolbar = document.createElement("div");
    toolbar.className = "scan-toolbar";
    const toolbarLabel = document.createElement("span");
    toolbarLabel.className = "scan-toggle";
    toolbarLabel.textContent = "Subdomains found in this page's DOM & scripts";
    const spacer = document.createElement("span");
    spacer.className = "status-spacer";
    const copyAllBtn = document.createElement("button");
    copyAllBtn.type = "button";
    copyAllBtn.className = "btn ghost sub-copy-all";
    copyAllBtn.textContent = "Copy all";
    copyAllBtn.setAttribute("aria-label", "Copy all subdomains");
    copyAllBtn.addEventListener("click", copyAll);
    toolbar.append(toolbarLabel, spacer, copyAllBtn);
    pane.appendChild(toolbar);

    const list = document.createElement("div");
    list.className = "item-list";
    list.setAttribute("aria-live", "polite");
    pane.appendChild(list);

    const loading = document.createElement("div");
    loading.className = "loading-ring";
    loading.setAttribute("role", "status");
    loading.setAttribute("aria-label", "Scanning…");

    function render() {
      const { rows, reg } = cached;

      list.replaceChildren();
      const scopeEl = document.getElementById("sub-scope-host");
      if (scopeEl) scopeEl.textContent = reg || "No valid domain";

      if (!rows.length) {
        const empty = document.createElement("p");
        empty.className = "empty";
        empty.textContent = "No subdomains found on this page. Try a page with more links/scripts.";
        list.appendChild(empty);
        return;
      }

      const count = document.createElement("p");
      count.className = "count-line";
      const subN = rows.filter((r) => !r.isApex).length;
      count.textContent = `${U.formatCount(rows.length)} host(s) · ${U.formatCount(subN)} subdomain(s) of ${reg}`;
      list.appendChild(count);

      T.renderChunked(list, rows, (r) => buildRow(r.host, r.isApex));
    }

    async function scan() {
      list.replaceChildren(loading);
      try {
        // The scope comes from the active tab's own URL.
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.url || !/^https?:\/\//i.test(tab.url)) {
          list.replaceChildren();
          const card = document.createElement("div");
          card.className = "error-card";
          card.setAttribute("role", "alert");
          const strong = document.createElement("strong");
          strong.textContent = "Open a normal website first";
          const p = document.createElement("p");
          p.textContent = "This tab scans the domain of the page you are viewing (e.g. example.com). chrome:// pages and the Web Store have no domain to scan.";
          card.append(strong, p);
          list.appendChild(card);
          const scopeEl = document.getElementById("sub-scope-host");
          if (scopeEl) scopeEl.textContent = "—";
          return;
        }
        const host = U.extractHostname(U.parseUrl(tab.url)) || "";
        const reg = U.registrableDomain(host);
        if (!reg) {
          list.replaceChildren();
          const card = document.createElement("div");
          card.className = "error-card";
          card.setAttribute("role", "alert");
          const strong = document.createElement("strong");
          strong.textContent = "Could not determine a domain for this page";
          const p = document.createElement("p");
          p.textContent = `Host "${host}" does not look like a normal domain.`;
          card.append(strong, p);
          list.appendChild(card);
          const scopeEl = document.getElementById("sub-scope-host");
          if (scopeEl) scopeEl.textContent = "—";
          return;
        }
        const scopeEl = document.getElementById("sub-scope-host");
        if (scopeEl) scopeEl.textContent = reg;

        // Collect hostnames from the page itself (DOM attributes + JS).
        const data = await T.runInActiveTab(collectPageHosts);
        const pageHosts = (data && data.hosts) || [];

        const rows = pageHosts
          .filter((h) => inScope(h, reg))
          .map((h) => ({ host: h, isApex: h === reg }))
          .sort((a, b) => {
            if (a.isApex !== b.isApex) return a.isApex ? -1 : 1; // apex first
            return a.host.localeCompare(b.host);
          });

        cached = { rows, reg };
        render();
      } catch (err) {
        list.replaceChildren();
        const card = document.createElement("div");
        card.className = "error-card";
        card.setAttribute("role", "alert");
        const strong = document.createElement("strong");
        strong.textContent = "Could not scan this page";
        const p = document.createElement("p");
        p.textContent = (err && err.message) ? err.message : String(err);
        card.append(strong, p);
        list.appendChild(card);
        Log.warn("Subdomain scan failed", err);
      }
    }

    refresh.addEventListener("click", scan);
    scan();
  }

  T.register("subdomains", init);
})();
