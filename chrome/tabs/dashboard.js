/**
 * tabs/dashboard.js
 * ---------------------------------------------------------------------------
 * Dashboard tab: current tab info, last scrape summary, quick actions.
 * All dynamic text rendered with textContent (XSS-safe).
 * ---------------------------------------------------------------------------
 */
(() => {
  "use strict";

  const T = window.HulkTabs;
  const U = window.HulkUtils;
  const Log = window.HulkLog;

  const RESULTS_KEY = "hulkResults";

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function statCard(num, label) {
    const card = el("div", "stat-card");
    const n = el("span", "stat-num", num);
    const l = el("span", "stat-label", label);
    card.append(n, l);
    return card;
  }

  async function init() {
    const pane = document.getElementById("pane-dashboard");
    pane.replaceChildren();

    // Active tab info
    let tabLine = "No active tab";
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url) {
        const host = U.extractHostname(U.parseUrl(tab.url)) || tab.url;
        tabLine = tab.title ? `${tab.title}` : host;
      }
    } catch (err) {
      Log.warn("Could not read active tab", err);
    }

    // Last scrape summary
    let last = null;
    try {
      const data = await chrome.storage.local.get(RESULTS_KEY);
      last = data[RESULTS_KEY] || null;
    } catch (err) {
      Log.warn("Could not read results", err);
    }

    // Header card
    const header = el("div", "card");
    const hTitle = el("h2", "card-title", "Dashboard");
    const hText = el("p", "muted", "JS files, paths, subdomains and Google domain extraction — plus a payload reference — all in one tab.");
    header.append(hTitle, hText);
    pane.appendChild(header);

    // Active tab card
    const tabCard = el("div", "card");
    const tabTitle = el("h2", "card-title", "Active tab");
    const tabRow = el("div", "tab-row");
    const favicon = el("span", "favicon");
    const tabText = el("span", "tab-text", tabLine);
    tabText.title = tabLine;
    tabRow.append(favicon, tabText);
    tabCard.append(tabTitle, tabRow);
    pane.appendChild(tabCard);

    // Last scrape card
    const scrapeCard = el("div", "card");
    const sTitle = el("h2", "card-title", "Last scrape");
    if (last && Array.isArray(last.domains)) {
      const statusMap = {
        finished: last.error ? "finished with errors" : "complete",
        stopped: "stopped",
        timeout: "timed out",
        tab_closed: "tab closed",
        error: "error"
      };
      const status = statusMap[last.status] || last.status || "done";
      const meta = el("p", "muted",
        `${U.formatCount(last.totalDomains)} domains across ${last.pages} pages · ${status} · ${U.timeAgo(last.finishedAt)}`);
      const stats = el("div", "stats-row");
      stats.append(
        statCard(U.formatCount(last.totalDomains), "Domains"),
        statCard(U.formatCount(last.pages), "Pages"),
        statCard(last.maxPages ? U.formatCount(last.maxPages) : "\u221e", "Max pages")
      );
      const actions = el("div", "btn-row");
      const openResults = el("button", "btn primary", "View results");
      openResults.type = "button";
      openResults.addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("google/results.html") }));
      const openScrape = el("button", "btn ghost", "Start scraping");
      openScrape.type = "button";
      openScrape.addEventListener("click", () => {
        const btn = document.querySelector('[data-tab="scrape"]');
        if (btn) btn.click();
      });
      actions.append(openResults, openScrape);
      scrapeCard.append(sTitle, meta, stats, actions);
    } else {
      const p = el("p", "muted", "No scrape yet. Open a Google search page and hit Start in the Scrape tab.");
      const go = el("button", "btn primary", "Go to Scrape");
      go.type = "button";
      go.addEventListener("click", () => {
        const btn = document.querySelector('[data-tab="scrape"]');
        if (btn) btn.click();
      });
      scrapeCard.append(sTitle, p, go);
    }
    pane.appendChild(scrapeCard);

    // Shortcuts card
    const tips = el("div", "card");
    const tipsTitle = el("h2", "card-title", "Keyboard shortcuts");
    const list = el("ul", "tips");
    const shortcuts = [
      ["Alt + 1–7", "Switch popup tabs"],
      ["/", "Focus search in results page"],
      ["Esc", "Clear search / close"]
    ];
    for (const [keys, desc] of shortcuts) {
      const li = el("li");
      const kbd = el("kbd", undefined, keys);
      const span = el("span", undefined, desc);
      li.append(kbd, span);
      list.appendChild(li);
    }
    tips.append(tipsTitle, list);
    pane.appendChild(tips);
  }

  T.register("dashboard", init);
})();
