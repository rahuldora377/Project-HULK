/**
 * tabs/jsfiles.js
 * ---------------------------------------------------------------------------
 * JS Files tab: discovers JavaScript on the active tab.
 *  - External <script src> files (deduped, absolute URLs).
 *  - Inline <script> blocks — clicking one opens the full source, beautified
 *    and colorized, in a new viewer tab (lightweight, no external libs).
 *  - Obvious 3rd-party libraries (jQuery, React, CDN scripts…) are NOT
 *    deleted — they are greyed out, and a "hide libs" toggle removes them
 *    from the view entirely.
 *
 * The injected collector function is fully self-contained (no closures) so
 * chrome.scripting.executeScript can serialize it.
 * ---------------------------------------------------------------------------
 */
(() => {
  "use strict";

  const T = window.HulkTabs;
  const U = window.HulkUtils;

  /** Library names detected in the filename (lowercase). */
  const LIB_NAMES = [
    "jquery", "bootstrap", "react", "react-dom", "vue", "angular", "lodash",
    "moment", "axios", "d3", "jquery-ui", "core-js", "webpack", "polyfill",
    "underscore", "backbone", "ember", "knockout", "svelte", "preact",
    "alpinejs", "tailwind", "chart.js", "highcharts", "leaflet", "gsap",
    "swiper", "owl.carousel", "fancybox", "select2", "datatables", "popper",
    "bootstrap-4", "font-awesome", "bootstrap-icons", "socket.io"
  ];

  /** Obvious CDN hosts — treat as 3rd-party libraries. */
  const CDN_HOSTS = [
    "cdnjs.cloudflare.com", "unpkg.com", "cdn.jsdelivr.net", "code.jquery.com",
    "ajax.googleapis.com", "cdn.tailwindcss.com",
    "stackpath.bootstrapcdn.com", "maxcdn.bootstrapcdn.com", "cdn.socket.io",
    "cdn.ampproject.org", "polyfill.io", "cdn.polyfill.io", "static.cloudflareinsights.com"
  ];

  /**
   * Runs inside the active page (isolated world). Self-contained only.
   * `baseUrl` is the page's own base URL (document.baseURI), used by the
   * popup to resolve relative <script src> values correctly.
   *
   * Inline entries carry the FULL source (`full`) so the popup can open it
   * in the viewer — only the collapsed snippet (`snippet`) is shown in the
   * list, keeping the popup DOM light.
   *
   * @returns {{baseUrl: string, external: string[], inline: Array<{snippet: string, full: string, truncated: boolean}>}}
   */
  function collectJsAssets() {
    const baseUrl = document.baseURI || document.location.href || "";
    const external = Array.from(document.querySelectorAll("script[src]"))
      .map((s) => s.getAttribute("src") || s.src)
      .filter(Boolean);

    const inline = [];
    const MAX_INLINE = 20; // cap for performance
    const MAX_INLINE_LEN = 400; // collapsed snippet shown in the list
    const MAX_INLINE_FULL = 1048576; // cap text handed to the viewer (1 MiB)
    for (const s of document.querySelectorAll("script:not([src])")) {
      if (inline.length >= MAX_INLINE) break;
      const raw = (s.textContent || "").trim();
      if (raw.length < 8) continue;
      const snippet = raw.replace(/\s+/g, " ").trim();
      inline.push({
        snippet: snippet.slice(0, MAX_INLINE_LEN),
        full: raw.slice(0, MAX_INLINE_FULL),
        truncated: raw.length > MAX_INLINE_FULL
      });
    }
    return { baseUrl, external, inline };
  }

  /** Heuristic: is this URL an obvious 3rd-party library? */
  function isLibraryUrl(url) {
    try {
      const u = new URL(url);
      if (CDN_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith("." + h))) return true;
      const filename = (u.pathname.split("/").pop() || "").toLowerCase();
      return LIB_NAMES.some((lib) => filename.startsWith(lib + ".") || filename.includes("." + lib + ".") || filename === lib + ".js");
    } catch (err) {
      return false;
    }
  }

  // Cached scan results so the hide-libs toggle re-renders from memory instead
  // of re-injecting a script into the (possibly changed) active tab.
  let cachedItems = [];

  /**
   * Copy every external JS file URL, one per line. Inline scripts are excluded
   * (their full source lives in the viewer, not in this list).
   */
  async function copyAllJsFiles() {
    const files = cachedItems.filter((i) => i.type === "external").map((i) => i.text);
    if (!files.length) { T.toast("No JS files to copy", "error"); return; }
    const ok = await T.copyText(files.join("\n"));
    if (ok) T.toast(`Copied ${U.formatCount(files.length)} JS files`, "success");
    else T.toast("Copy failed — clipboard unavailable", "error");
  }

  function init() {
    const pane = document.getElementById("pane-jsfiles");
    pane.replaceChildren();

    // Header
    const header = document.createElement("div");
    header.className = "pane-header";
    const title = document.createElement("h2");
    title.textContent = "JS Files";
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "icon-btn";
    refresh.setAttribute("aria-label", "Refresh");
    refresh.dataset.tooltip = "Re-scan the active tab";
    refresh.innerHTML = T.icon("refresh");
    header.append(title, refresh);
    pane.appendChild(header);

    // Toolbar: hide-libs toggle
    const toolbar = document.createElement("div");
    toolbar.className = "scan-toolbar";
    const toggleLabel = document.createElement("label");
    toggleLabel.className = "scan-toggle";
    const toggleInput = document.createElement("input");
    toggleInput.type = "checkbox";
    toggleInput.id = "js-hide-libs";
    toggleInput.setAttribute("aria-label", "Hide 3rd-party libraries");
    const toggleText = document.createElement("span");
    toggleText.textContent = "Hide 3rd-party libraries";
    toggleLabel.append(toggleInput, toggleText);
    const spacer = document.createElement("span");
    spacer.className = "status-spacer";
    const copyAllBtn = document.createElement("button");
    copyAllBtn.type = "button";
    copyAllBtn.className = "btn ghost";
    copyAllBtn.innerHTML = T.icon("copy") + '<span class="btn-label">Copy all JS files</span>';
    copyAllBtn.setAttribute("aria-label", "Copy all external JavaScript file URLs (inline scripts excluded)");
    copyAllBtn.addEventListener("click", copyAllJsFiles);
    toolbar.append(toggleLabel, spacer, copyAllBtn);
    pane.appendChild(toolbar);

    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "External + inline scripts on the active tab. Libraries are greyed out; tick the box above to hide them. Click an inline script to open it beautified & colorized in a new tab.";
    pane.appendChild(note);

    const list = document.createElement("div");
    list.className = "item-list";
    list.setAttribute("aria-live", "polite");
    pane.appendChild(list);

    const loading = document.createElement("div");
    loading.className = "loading-ring";
    loading.setAttribute("role", "status");
    loading.setAttribute("aria-label", "Scanning page…");

    function buildItem(entry) {
      // entry: { type: "external"|"inline", text | snippet/full/source, isLib }
      if (entry.type === "inline") {
        // Clicking an inline script opens the beautified + colorized viewer
        // in a new tab (no copy — the list only ever shows a collapsed snippet).
        const snippet = entry.snippet || "";
        const label = `[inline] ${snippet.slice(0, 60)}${snippet.length > 60 ? "…" : ""}`;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "copy-btn inline-item";
        btn.setAttribute("aria-label", "Open inline script in viewer");
        btn.title = "Open beautified & colorized in a new tab";

        const iconSpan = document.createElement("span");
        iconSpan.className = "copy-btn-icon";
        iconSpan.innerHTML = T.icon("external");

        const labelSpan = document.createElement("span");
        labelSpan.className = "copy-btn-label";
        labelSpan.textContent = label;

        btn.append(iconSpan, labelSpan);
        btn.addEventListener("click", () => openInlineScript(entry));
        return btn;
      }

      const btn = T.makeCopyButton(entry.text, entry.text);
      if (entry.isLib) btn.classList.add("lib-item");
      return btn;
    }

    function render(items) {
      const hideLibs = toggleInput.checked;
      const visible = hideLibs ? items.filter((i) => !i.isLib) : items;
      const libCount = items.filter((i) => i.isLib).length;

      list.replaceChildren();
      if (!visible.length) {
        const empty = document.createElement("p");
        empty.className = "empty";
        empty.textContent = hideLibs && items.length
          ? "Only 3rd-party libraries found — uncheck “hide” to show them."
          : "No JavaScript found on this page.";
        list.appendChild(empty);
        return;
      }

      const count = document.createElement("p");
      count.className = "count-line";
      count.textContent = `${U.formatCount(visible.length)} shown` +
        (libCount ? ` · ${U.formatCount(libCount)} library(ies) greyed out` : "");
      list.appendChild(count);
      T.renderChunked(list, visible, buildItem);
    }

    async function scan() {
      list.replaceChildren(loading);
      try {
        const data = await T.runInActiveTab(collectJsAssets);
        const external = data && data.external ? data.external : [];
        const inline = data && data.inline ? data.inline : [];

        const items = [];

        // External scripts — dedupe, resolve to absolute, mark libraries.
        // Resolve relative srcs against the page's real base URL (never a
        // fabricated origin like example.invalid).
        const base = (data && data.baseUrl) || "";
        const seen = new Set();
        for (const raw of external) {
          const url = U.resolveUrl(raw, base);
          if (!url || !/^https?:$/.test(url.protocol)) continue;
          if (seen.has(url.href)) continue;
          seen.add(url.href);
          items.push({ type: "external", text: url.href, isLib: isLibraryUrl(url.href) });
        }

        // Inline scripts — shown with a collapsed snippet; clicking opens the
        // full source in the viewer. Never marked as libs.
        for (const item of inline) {
          items.push({
            type: "inline",
            snippet: item.snippet || "",
            full: item.full || "",
            truncated: !!item.truncated,
            source: base,
            isLib: false
          });
        }

        items.sort((a, b) => {
          if (a.isLib !== b.isLib) return a.isLib ? 1 : -1; // non-libs first
          return (a.text || a.snippet || "").localeCompare(b.text || b.snippet || "");
        });

        cachedItems = items;
        render(items);
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

    /**
     * Open the beautified + colorized inline script in a new extension tab.
     * The source is handed over via storage.local (a URL query would blow up
     * on anything non-trivial) and the viewer clears the key after reading.
     */
    async function openInlineScript(entry) {
      try {
        await chrome.storage.local.set({
          hulkViewer: {
            text: entry.full || entry.snippet,
            source: entry.source || "",
            truncated: !!entry.truncated
          }
        });
        await chrome.tabs.create({ url: chrome.runtime.getURL("viewer.html"), active: true });
      } catch (err) {
        T.toast("Could not open viewer: " + ((err && err.message) || err), "error");
      }
    }

    refresh.addEventListener("click", scan);
    // Toggle re-renders from the cached scan — no re-injection needed.
    toggleInput.addEventListener("change", () => {
      render(cachedItems);
    });
    scan();
  }

  T.register("jsfiles", init);
})();
