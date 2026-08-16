/**
 * tabs/paths.js
 * ---------------------------------------------------------------------------
 * Relative Paths tab: discovers relative/absolute asset & link paths on the
 * active tab. Mirrors the jsfiles tab structure (lazy, chunked, DRY copy).
 * ---------------------------------------------------------------------------
 */
(() => {
  "use strict";

  const T = window.HulkTabs;
  const U = window.HulkUtils;

  const ASSET_EXT = /\.(css|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|eot|otf|map|mp4|webm|mp3|pdf)(\?|#|$)/i;

  /** Cache of the last scan so "Copy all paths" doesn't need a re-scan. */
  let cached = [];

  /** Copy every unique path, one per line. */
  async function copyAllPaths() {
    if (!cached.length) { T.toast("Nothing to copy", "error"); return; }
    const ok = await T.copyText(cached.join("\n"));
    if (ok) T.toast(`Copied ${U.formatCount(cached.length)} paths`, "success");
    else T.toast("Copy failed — clipboard unavailable", "error");
  }

  /**
   * Runs inside the active page (isolated world). Self-contained only.
   * `baseUrl` is the page's own base URL, used to resolve relative paths.
   * @returns {{baseUrl: string, paths: string[]}}
   */
  function collectPaths() {
    const baseUrl = document.baseURI || document.location.href || "";
    const paths = Array.from(document.querySelectorAll("[src],[href]"))
      .map((e) => e.getAttribute("src") || e.getAttribute("href"))
      .filter(Boolean)
      .filter((v) => v.startsWith(".") || v.startsWith("/") || /^https?:\/\//i.test(v));
    return { baseUrl, paths };
  }

  function init() {
    const pane = document.getElementById("pane-paths");
    pane.replaceChildren();

    const header = document.createElement("div");
    header.className = "pane-header";
    const title = document.createElement("h2");
    title.textContent = "Relative Paths";
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "icon-btn";
    refresh.setAttribute("aria-label", "Refresh");
    refresh.dataset.tooltip = "Re-scan the active tab";
    refresh.innerHTML = T.icon("refresh");
    header.append(title, refresh);
    pane.appendChild(header);

    // Toolbar: copy all paths
    const toolbar = document.createElement("div");
    toolbar.className = "scan-toolbar";
    const copyAllBtn = document.createElement("button");
    copyAllBtn.type = "button";
    copyAllBtn.className = "btn ghost";
    copyAllBtn.innerHTML = T.icon("copy") + '<span class="btn-label">Copy all paths</span>';
    copyAllBtn.setAttribute("aria-label", "Copy all unique paths");
    copyAllBtn.addEventListener("click", copyAllPaths);
    toolbar.appendChild(copyAllBtn);
    pane.appendChild(toolbar);

    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "Relative/absolute paths on the active tab (static assets excluded).";
    pane.appendChild(note);

    const list = document.createElement("div");
    list.className = "item-list";
    list.setAttribute("aria-live", "polite");
    pane.appendChild(list);

    const loading = document.createElement("div");
    loading.className = "loading-ring";
    loading.setAttribute("role", "status");
    loading.setAttribute("aria-label", "Scanning page…");

    async function scan() {
      list.replaceChildren(loading);
      try {
        const data = await T.runInActiveTab(collectPaths);
        const { paths = [] } = data || {};

        // Resolve relative paths against the page's real base URL (never a
        // fabricated origin like example.invalid).
        const base = (data && data.baseUrl) || "";
        const set = new Set();
        for (const raw of paths) {
          // Strip query/hash for cleaner dedup.
          let clean = raw;
          const u = U.resolveUrl(raw, base);
          if (u) {
            if (!/^https?:$/.test(u.protocol)) continue;
            clean = u.pathname;
          } else {
            clean = raw.split(/[?#]/)[0];
          }
          // .js paths (incl. versioned ones like /beacon.min.js/v…/) belong
          // to the JS Files tab — never list them here.
          if (!clean || ASSET_EXT.test(clean) || U.isJsPath(clean)) continue;
          set.add(clean);
        }

        const items = Array.from(set).sort();
        cached = items;
        if (!items.length) {
          const empty = document.createElement("p");
          empty.className = "empty";
          empty.textContent = "No paths found on this page.";
          list.replaceChildren(empty);
          return;
        }

        const count = document.createElement("p");
        count.className = "count-line";
        count.textContent = U.formatCount(items.length) + " unique paths";
        list.replaceChildren(count);
        T.renderChunked(list, items, (p) => T.makeCopyButton(p));
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
      }
    }

    refresh.addEventListener("click", scan);
    scan();
  }

  T.register("paths", init);
})();
