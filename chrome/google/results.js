/**
 * google/results.js
 * ---------------------------------------------------------------------------
 * Results dashboard controller: renders scrape results with statistics,
 * a dependency-free TLD bar chart, live filtering, sorting, pagination,
 * grid/list views, CSV/JSON export and print-to-PDF.
 *
 * All dynamic text is written with textContent (XSS-safe); the only
 * innerHTML usage is the static icon markup in the toolbar.
 * ---------------------------------------------------------------------------
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const U = window.HulkUtils;
  const Log = window.HulkLog;

  const RESULTS_KEY = "hulkResults";
  const CHART_COLORS = [
    "var(--chart-0)", "var(--chart-1)", "var(--chart-2)", "var(--chart-3)",
    "var(--chart-4)", "var(--chart-5)", "var(--chart-6)", "var(--chart-7)"
  ];

  const state = {
    records: [],      // { domain, count, title, urls }
    haystack: [],     // precomputed lowercase search text per record (see loadData)
    run: null,        // metadata from storage
    derived: null,    // cached aggregates (see computeDerived)
    query: "",
    sort: "name",
    view: "grid",
    page: 1,
    pageSize: 50,
    pageCount: 1,
    animations: true
  };

  /* ------------------------------------------------------------------ *
   * Bootstrap
   * ------------------------------------------------------------------ */

  async function init() {
    const settings = await window.HulkConfig.getSettings();
    state.pageSize = Math.max(10, Number(settings.resultsPageSize) || 50);
    state.animations = settings.animations !== false;
    applyTheme(settings.theme);
    window.HulkConfig.applyTheme(settings.theme);
    document.documentElement.dataset.animations = state.animations ? "on" : "off";

    await loadData();
    wireUI();
    renderAll();
    Log.info("Results dashboard ready", state.records.length);
  }

  /** Load results from storage.local. */
  async function loadData() {
    try {
      const data = await chrome.storage.local.get(RESULTS_KEY);
      const results = data[RESULTS_KEY];
      if (results && Array.isArray(results.domains)) {
        state.records = results.domains;
        state.run = results;
      } else {
        state.records = [];
        state.run = null;
      }
    } catch (err) {
      Log.error("loadData failed", err);
      state.records = [];
      state.run = null;
    }
    state.derived = computeDerived(state.records);
    // Search haystack built once, so filtering never re-lowercases URLs.
    state.haystack = state.records.map((r) =>
      [r.domain, r.title || "", (r.urls || []).join(" ")].join(" ").toLowerCase()
    );
  }

  /* ------------------------------------------------------------------ *
   * UI wiring
   * ------------------------------------------------------------------ */

  function wireUI() {
    // Theme toggle
    $("theme-toggle").addEventListener("click", async () => {
      const settings = await window.HulkConfig.getSettings();
      const next = settings.theme === "dark" ? "light" : "dark";
      applyTheme(next);
      window.HulkConfig.applyTheme(next);
      window.HulkConfig.saveSettings({ theme: next });
    });

    $("back-to-tabs").addEventListener("click", () => window.close());

    // Search (debounced). Stats and chart are dataset-wide and rendered once
    // at init, so only the list re-renders here.
    $("search").addEventListener("input", U.debounce((e) => {
      state.query = e.target.value.trim().toLowerCase();
      state.page = 1;
      renderList();
    }, 180));

    // Sort
    $("sort").addEventListener("change", (e) => {
      state.sort = e.target.value;
      state.page = 1;
      renderList();
    });

    // View toggle
    $("view-grid").addEventListener("click", () => setView("grid"));
    $("view-list").addEventListener("click", () => setView("list"));

    // Pagination
    $("prev").addEventListener("click", () => {
      if (state.page > 1) { state.page -= 1; renderList(); scrollToList(); }
    });
    $("next").addEventListener("click", () => {
      if (state.page < state.pageCount) { state.page += 1; renderList(); scrollToList(); }
    });

    // Exports
    $("copy-all").addEventListener("click", copyAll);
    $("copy-urls").addEventListener("click", copyUrls);
    $("export-csv").addEventListener("click", exportCSV);
    $("export-json").addEventListener("click", exportJSON);
    $("print").addEventListener("click", () => window.print());

    // Keyboard: "/" focuses search, Escape clears it.
    document.addEventListener("keydown", (e) => {
      const tag = (e.target.tagName || "").toLowerCase();
      if (e.key === "/" && tag !== "input" && tag !== "textarea") {
        e.preventDefault();
        $("search").focus();
      } else if (e.key === "Escape" && tag === "input") {
        $("search").value = "";
        state.query = "";
        state.page = 1;
        renderList();
        $("search").blur();
      }
    });
  }

  /** Keep the results card in view after a page turn. */
  function scrollToList() {
    const card = document.querySelector(".results-card");
    if (card) card.scrollIntoView({ block: "start" });
  }

  function setView(view) {
    state.view = view;
    $("list").classList.toggle("grid", view === "grid");
    $("list").classList.toggle("list", view === "list");
    $("view-grid").classList.toggle("active", view === "grid");
    $("view-list").classList.toggle("active", view === "list");
    $("view-grid").setAttribute("aria-pressed", view === "grid");
    $("view-list").setAttribute("aria-pressed", view === "list");
  }

  function applyTheme(theme) {
    const isDark = theme !== "light";
    document.documentElement.setAttribute("data-theme", theme || "dark");
    $("theme-toggle").innerHTML = isDark
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  }

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */

  /**
   * Filter + sort the records. Filtering scans the precomputed lowercase
   * haystack (built once at load) instead of re-lowercasing every URL on each
   * keystroke. Records and haystack share index positions.
   */
  function filteredSorted() {
    let items = state.records;
    if (state.query) {
      const q = state.query;
      items = state.records.filter((r, i) => state.haystack[i].includes(q));
    }
    const dir = state.sort.endsWith("-desc") ? -1 : 1;
    const key = state.sort.startsWith("count") ? "count" : "name";
    const sorted = items.slice();
    if (key === "count") {
      sorted.sort((a, b) => {
        if (a.count !== b.count) return (a.count - b.count) * dir;
        return a.domain.localeCompare(b.domain);
      });
    } else {
      sorted.sort((a, b) => a.domain.localeCompare(b.domain) * dir);
    }
    return sorted;
  }

  /**
   * One-pass aggregates over the whole dataset (TLD histogram, total
   * occurrences, top domain). Computed once at load and reused by
   * renderStats / renderChart, so searching, sorting and paginating never
   * rescan every record.
   * @param {Array} records
   * @returns {{tlds: Object<string,number>, totalOccurrences: number, topDomain: Object|null}}
   */
  function computeDerived(records) {
    const tlds = {};
    let totalOccurrences = 0;
    let topDomain = null;
    for (const r of records || []) {
      const count = r.count || 0;
      totalOccurrences += count;
      const t = U.tldOf(r.domain);
      tlds[t] = (tlds[t] || 0) + count;
      if (!topDomain || count > (topDomain.count || 0)) topDomain = r;
    }
    return { tlds, totalOccurrences, topDomain };
  }

  function renderAll() {
    renderStats();
    renderChart();
    renderList();
  }

  function renderStats() {
    const wrap = $("stats");
    wrap.replaceChildren();

    const derived = state.derived || computeDerived(state.records);
    const tldEntries = Object.entries(derived.tlds).sort((a, b) => b[1] - a[1]);
    const totalOccurrences = derived.totalOccurrences;
    const topDomain = derived.topDomain;
    const statusLabel = statusText(state.run);

    const cards = [
      { num: U.formatCount(state.records.length), label: "Unique domains" },
      { num: U.formatCount(tldEntries.length), label: "Top-level domains" },
      { num: topDomain ? U.formatCount(topDomain.count) : "0", label: "Top domain count" },
      { num: U.formatCount(totalOccurrences), label: "Total occurrences" }
    ];

    for (const c of cards) {
      const el = document.createElement("div");
      el.className = "stat-card";
      const num = document.createElement("span");
      num.className = "stat-num";
      num.textContent = c.num;
      const label = document.createElement("span");
      label.className = "stat-label";
      label.textContent = c.label;
      el.append(num, label);
      wrap.appendChild(el);
    }

    // Run metadata in the header
    const meta = $("run-meta");
    meta.textContent = state.run
      ? `${statusLabel} · ${state.run.pages} pages · ${U.formatDuration((state.run.finishedAt || Date.now()) - (state.run.startedAt || Date.now()))}`
      : "No run yet — open the popup and start a scrape";
  }

  function statusText(run) {
    if (!run) return "—";
    switch (run.status) {
      case "finished": return run.error ? "Finished with errors" : "Complete";
      case "stopped": return "Stopped";
      case "timeout": return "Timed out";
      case "tab_closed": return "Tab closed";
      case "nav_failed": return "Navigation failed";
      case "error": return "Error";
      default: return run.status || "Done";
    }
  }

  function renderChart() {
    const wrap = $("chart");
    wrap.replaceChildren();

    const derived = state.derived || computeDerived(state.records);
    const top = Object.entries(derived.tlds).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (!top.length) {
      const p = document.createElement("p");
      p.className = "count-info";
      p.textContent = "No data to chart yet.";
      wrap.appendChild(p);
      return;
    }
    const max = top[0][1];

    top.forEach(([tld, count], i) => {
      const row = document.createElement("div");
      row.className = "bar-row";
      const label = document.createElement("span");
      label.className = "bar-label";
      label.textContent = "." + tld;
      const track = document.createElement("div");
      track.className = "bar-track";
      const fill = document.createElement("div");
      fill.className = "bar-fill";
      fill.style.background = `linear-gradient(90deg, ${CHART_COLORS[i % CHART_COLORS.length]}, ${CHART_COLORS[(i + 1) % CHART_COLORS.length]})`;
      fill.style.width = "0%";
      track.appendChild(fill);
      const value = document.createElement("span");
      value.className = "bar-value";
      value.textContent = U.formatCount(count);
      row.append(label, track, value);
      wrap.appendChild(row);

      // Set width immediately when animations are off; otherwise ease in on
      // the next frame.
      const width = `${Math.max(3, (count / max) * 100)}%`;
      if (state.animations) {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          fill.style.width = width;
        }));
      } else {
        fill.style.width = width;
      }
    });
  }

  function buildItem(rec) {
    const li = document.createElement("li");
    li.className = "d-item";

    const main = document.createElement("div");
    main.className = "d-main";

    const head = document.createElement("div");
    head.className = "d-head";
    const domain = document.createElement("span");
    domain.className = "d-domain";
    domain.textContent = rec.domain;
    domain.title = rec.domain;
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = U.formatCount(rec.count);
    head.append(domain, badge);

    main.appendChild(head);

    if (rec.title) {
      const title = document.createElement("div");
      title.className = "d-title";
      title.textContent = rec.title;
      main.appendChild(title);
    }

    const urls = (rec.urls || []).filter(Boolean);
    const url = urls[0] || "";
    if (url) {
      const a = document.createElement("a");
      a.className = "d-url";
      a.href = url;
      a.textContent = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      main.appendChild(a);
    }

    // Every scraped domain+path URL for this domain — collapsed by default so
    // the card stays scannable. The first URL is already shown above, so the
    // expander lists the remaining ones (no duplication).
    if (urls.length > 1) {
      const details = document.createElement("details");
      details.className = "d-urls";
      const summary = document.createElement("summary");
      summary.textContent = `More URLs (${U.formatCount(urls.length - 1)})`;
      const ul = document.createElement("ul");
      for (const u of urls.slice(1)) {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = u;
        a.textContent = u;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        li.appendChild(a);
        ul.appendChild(li);
      }
      details.append(summary, ul);
      main.appendChild(details);
    }

    li.appendChild(main);

    const actions = document.createElement("div");
    actions.className = "d-actions";

    // Copy button
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "icon-btn";
    copyBtn.setAttribute("aria-label", `Copy ${rec.domain}`);
    copyBtn.dataset.tooltip = "Copy domain";
    copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    copyBtn.addEventListener("click", async () => {
      const ok = await copyText(rec.domain);
      if (ok) toast(`Copied ${rec.domain}`, "success");
      else toast("Copy failed", "error");
    });
    actions.appendChild(copyBtn);

    // Open button
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "icon-btn";
    openBtn.setAttribute("aria-label", `Open ${rec.domain}`);
    openBtn.dataset.tooltip = "Open domain";
    openBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
    openBtn.addEventListener("click", () => {
      const target = url || `https://${rec.domain}`;
      chrome.tabs.create({ url: target });
    });
    actions.appendChild(openBtn);

    li.appendChild(actions);
    return li;
  }

  function renderList() {
    const list = $("list");
    const items = filteredSorted();
    state.pageCount = Math.max(1, Math.ceil(items.length / state.pageSize));
    state.page = Math.min(state.page, state.pageCount);

    const start = (state.page - 1) * state.pageSize;
    const pageItems = items.slice(start, start + state.pageSize);

    // Empty state
    const empty = $("empty");
    const hasData = items.length > 0;
    empty.hidden = hasData;
    list.hidden = !hasData;
    if (!hasData) {
      $("empty-text").textContent = state.records.length === 0
        ? "No domains yet — run the scraper from the popup."
        : "No domains match your filter.";
    }

    // Build the page synchronously into a fragment (max pageSize items, so
    // this is cheap) and swap in one go — no rAF chunking, so a fast-typing
    // search can never interleave stale frames with newer ones.
    list.replaceChildren();
    const frag = document.createDocumentFragment();
    for (const rec of pageItems) frag.appendChild(buildItem(rec));
    list.appendChild(frag);

    // Meta
    const shown = items.length ? `${U.formatCount(start + 1)}–${U.formatCount(start + pageItems.length)} of ${U.formatCount(items.length)}` : "0 results";
    $("count-info").textContent = state.query
      ? `${U.formatCount(items.length)} of ${U.formatCount(state.records.length)} domains match "${state.query}"`
      : `${U.formatCount(state.records.length)} domains`;
    $("page-info").textContent = hasData ? `Page ${state.page} / ${state.pageCount} · ${shown}` : "—";
    $("prev").disabled = state.page <= 1;
    $("next").disabled = state.page >= state.pageCount;
  }

  /* ------------------------------------------------------------------ *
   * Actions
   * ------------------------------------------------------------------ */

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

  /** Copy domains, honoring the active search filter. */
  async function copyAll() {
    const items = filteredSorted();
    const text = items.map((r) => r.domain).join("\n");
    if (!text) { toast("Nothing to copy", "error"); return; }
    const ok = await copyText(text);
    toast(ok ? `Copied ${items.length} domains` : "Copy failed", ok ? "success" : "error");
  }

  /** Copy every matching full domain+path URL, deduplicated, order preserved. */
  async function copyUrls() {
    const items = filteredSorted();
    const seen = new Set();
    const urls = [];
    for (const r of items) {
      for (const u of (r.urls || [])) {
        if (u && !seen.has(u)) { seen.add(u); urls.push(u); }
      }
    }
    if (!urls.length) { toast("Nothing to copy", "error"); return; }
    const ok = await copyText(urls.join("\n"));
    toast(ok ? `Copied ${U.formatCount(urls.length)} unique URLs` : "Copy failed", ok ? "success" : "error");
  }

  function exportCSV() {
    if (!state.records.length) { toast("Nothing to export", "error"); return; }
    const rows = [["domain", "count", "title", "urls"]];
    for (const r of state.records) {
      // All scraped domain+path URLs for this domain (pipe-separated, quoted
      // by toCSV when needed).
      rows.push([r.domain, r.count, r.title || "", (r.urls || []).join(" | ")]);
    }
    U.downloadBlob("hulk-domains.csv", U.toCSV(rows), "text/csv");
    toast("Exported CSV");
  }

  function exportJSON() {
    if (!state.records.length) { toast("Nothing to export", "error"); return; }
    const payload = {
      exportedAt: new Date().toISOString(),
      run: state.run,
      domains: state.records
    };
    U.downloadBlob("hulk-domains.json", JSON.stringify(payload, null, 2), "application/json");
    toast("Exported JSON");
  }

  let toastTimer = null;
  function toast(msg, type) {
    const el = $("toast");
    el.textContent = msg;
    el.className = "toast show" + (type ? " " + type : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
  }

  /* ------------------------------------------------------------------ *
   * Error boundary
   * ------------------------------------------------------------------ */

  window.addEventListener("error", (ev) => {
    Log.error("Uncaught error in results page", ev.error || ev.message);
  });
  window.addEventListener("unhandledrejection", (ev) => {
    Log.error("Unhandled rejection in results page", ev.reason);
  });

  // Boot
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init().catch((err) => {
      Log.error("Init failed", err);
      const empty = $("empty");
      empty.hidden = false;
      $("empty-text").textContent = "Failed to load results: " + ((err && err.message) || err);
    });
  }
})();
