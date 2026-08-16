/**
 * tabs/scrape.js
 * ---------------------------------------------------------------------------
 * Scrape tab: controls for the Google domain scraper.
 * - Start / Stop messaging to the service worker.
 * - Live progress via HULK_STATUS polling + storage.onChanged events.
 * - Progress bar, page counter, domain counter, elapsed time.
 * - Opens the results dashboard on completion.
 * ---------------------------------------------------------------------------
 */
(() => {
  "use strict";

  const T = window.HulkTabs;
  const U = window.HulkUtils;
  const Log = window.HulkLog;

  const STATE_KEY = "hulkScrapeState";
  const RESULTS_KEY = "hulkResults";

  let pollTimer = null;
  let lastSummary = null;

  function init() {
    const pane = document.getElementById("pane-scrape");
    pane.replaceChildren();

    // --- Header ---
    const header = document.createElement("div");
    header.className = "pane-header";
    const title = document.createElement("h2");
    title.textContent = "Google Scraper";
    const badge = document.createElement("span");
    badge.className = "status-badge";
    badge.id = "scrape-badge";
    badge.textContent = "Idle";
    header.append(title, badge);
    pane.appendChild(header);

    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "Scrapes domains from Google search result pages. Open a Google search first, then start.";
    pane.appendChild(note);

    // --- Progress card ---
    const card = document.createElement("div");
    card.className = "card";

    const progressRow = document.createElement("div");
    progressRow.className = "progress-row";

    // Circular progress ring
    const ringWrap = document.createElement("div");
    ringWrap.className = "ring-wrap";
    ringWrap.setAttribute("role", "progressbar");
    ringWrap.setAttribute("aria-valuemin", "0");
    ringWrap.setAttribute("aria-valuemax", "100");
    ringWrap.setAttribute("aria-valuenow", "0");
    ringWrap.setAttribute("aria-label", "Scrape progress");

    const R = 33;
    const CIRC = 2 * Math.PI * R;
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 80 80");
    svg.classList.add("ring-svg");
    const bg = document.createElementNS(svgNS, "circle");
    bg.setAttribute("cx", "40"); bg.setAttribute("cy", "40"); bg.setAttribute("r", String(R));
    bg.classList.add("ring-bg");
    const fg = document.createElementNS(svgNS, "circle");
    fg.setAttribute("cx", "40"); fg.setAttribute("cy", "40"); fg.setAttribute("r", String(R));
    fg.setAttribute("stroke-dasharray", String(CIRC));
    fg.setAttribute("stroke-dashoffset", String(CIRC));
    fg.classList.add("ring-fg");
    fg.id = "scrape-ring-fg";
    svg.append(bg, fg);

    const ringCenter = document.createElement("div");
    ringCenter.className = "ring-center";
    const pct = document.createElement("span");
    pct.className = "ring-pct";
    pct.id = "scrape-ring-pct";
    pct.textContent = "0%";
    ringCenter.appendChild(pct);
    ringWrap.append(svg, ringCenter);
    progressRow.appendChild(ringWrap);

    // Linear progress (kept as a secondary indicator)
    const progressWrap = document.createElement("div");
    progressWrap.className = "progress-wrap";
    const progress = document.createElement("div");
    progress.className = "progress";
    progress.id = "scrape-progress";
    const progressFill = document.createElement("div");
    progressFill.className = "progress-fill";
    progressFill.id = "scrape-progress-fill";
    progress.appendChild(progressFill);
    progressWrap.appendChild(progress);
    progressRow.appendChild(progressWrap);

    card.appendChild(progressRow);

    const stats = document.createElement("div");
    stats.className = "stats-row";

    const pageStat = statBox("scrape-pages", "0", "Pages");
    const domainStat = statBox("scrape-domains", "0", "Domains");
    const timeStat = statBox("scrape-time", "0s", "Elapsed");
    stats.append(pageStat, domainStat, timeStat);
    card.appendChild(stats);

    const statusLine = document.createElement("p");
    statusLine.className = "status-line";
    statusLine.id = "scrape-status-line";
    statusLine.setAttribute("aria-live", "polite");
    statusLine.textContent = "Ready — open a Google search results page.";
    card.appendChild(statusLine);

    pane.appendChild(card);

    // --- Actions ---
    const actions = document.createElement("div");
    actions.className = "btn-row";

    const startBtn = document.createElement("button");
    startBtn.type = "button";
    startBtn.id = "scrape-start";
    startBtn.className = "btn primary";
    startBtn.innerHTML = T.icon("play") + '<span class="btn-label">Start</span>';

    const stopBtn = document.createElement("button");
    stopBtn.type = "button";
    stopBtn.id = "scrape-stop";
    stopBtn.className = "btn danger";
    stopBtn.innerHTML = T.icon("stop") + '<span class="btn-label">Stop</span>';
    stopBtn.disabled = true;

    const openResultsBtn = document.createElement("button");
    openResultsBtn.type = "button";
    openResultsBtn.id = "scrape-open-results";
    openResultsBtn.className = "btn ghost";
    openResultsBtn.innerHTML = T.icon("chart") + '<span class="btn-label">Results</span>';

    const copyAllBtn = document.createElement("button");
    copyAllBtn.type = "button";
    copyAllBtn.id = "scrape-copy";
    copyAllBtn.className = "btn ghost";
    copyAllBtn.innerHTML = T.icon("copy") + '<span class="btn-label">Copy all</span>';

    const copyUrlsBtn = document.createElement("button");
    copyUrlsBtn.type = "button";
    copyUrlsBtn.id = "scrape-copy-urls";
    copyUrlsBtn.className = "btn ghost";
    copyUrlsBtn.innerHTML = T.icon("external") + '<span class="btn-label">Copy URLs</span>';
    copyUrlsBtn.setAttribute("aria-label", "Copy all collected URLs, deduplicated");

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.id = "scrape-clear";
    clearBtn.className = "btn ghost";
    clearBtn.innerHTML = T.icon("trash") + '<span class="btn-label">Clear</span>';
    clearBtn.setAttribute("aria-label", "Clear saved results");

    actions.append(startBtn, stopBtn, openResultsBtn, copyAllBtn, copyUrlsBtn, clearBtn);
    pane.appendChild(actions);

    const hint = document.createElement("p");
    hint.className = "muted";
    hint.textContent = "Rate limiting: tune the page delay and max pages in Settings.";
    pane.appendChild(hint);

    // --- Wiring ---
    startBtn.addEventListener("click", async () => {
      try {
        const resp = await chrome.runtime.sendMessage({ type: "HULK_START" });
        if (resp && resp.ok) {
          T.toast("Scraping started", "success");
        } else {
          // Log and show the actual reason (a string), never the raw object.
          const reason = String((resp && resp.error) || "Could not start scrape");
          T.toast(reason, "error");
          Log.warn("Start rejected", reason);
        }
      } catch (err) {
        T.toast("Start failed: " + ((err && err.message) || err), "error");
      }
      pollStatus();
    });

    stopBtn.addEventListener("click", async () => {
      try {
        const resp = await chrome.runtime.sendMessage({ type: "HULK_STOP" });
        if (resp && resp.ok) T.toast("Scrape stopped");
        else T.toast("Could not stop scrape", "error");
      } catch (err) {
        T.toast("Stop failed: " + ((err && err.message) || err), "error");
      }
      pollStatus();
    });

    openResultsBtn.addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("google/results.html") });
    });

    copyAllBtn.addEventListener("click", async () => {
      try {
        const data = await chrome.storage.local.get(RESULTS_KEY);
        const records = (data[RESULTS_KEY] && data[RESULTS_KEY].domains) || [];
        if (!records.length) { T.toast("Nothing to copy yet", "error"); return; }
        const text = records.map((r) => r.domain).join("\n");
        const ok = await T.copyText(text);
        T.toast(ok ? `Copied ${records.length} domains` : "Copy failed", ok ? "success" : "error");
      } catch (err) {
        T.toast("Copy failed", "error");
      }
    });

    copyUrlsBtn.addEventListener("click", async () => {
      try {
        const data = await chrome.storage.local.get(RESULTS_KEY);
        const records = (data[RESULTS_KEY] && data[RESULTS_KEY].domains) || [];
        // All scraped full domain+path URLs, deduplicated, order preserved.
        const seen = new Set();
        const urls = [];
        for (const r of records) {
          for (const u of (r.urls || [])) {
            if (u && !seen.has(u)) { seen.add(u); urls.push(u); }
          }
        }
        if (!urls.length) { T.toast("No URLs collected yet", "error"); return; }
        const ok = await T.copyText(urls.join("\n"));
        T.toast(ok ? `Copied ${urls.length} unique URLs` : "Copy failed", ok ? "success" : "error");
      } catch (err) {
        T.toast("Copy failed", "error");
      }
    });

    clearBtn.addEventListener("click", async () => {
      try {
        await chrome.runtime.sendMessage({ type: "HULK_CLEAR" });
        T.toast("Results cleared");
        pollStatus();
      } catch (err) {
        T.toast("Could not clear results", "error");
      }
    });

    // Listen for storage changes (works even if the SW was restarted).
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && (changes[STATE_KEY] || changes[RESULTS_KEY])) {
        pollStatus();
      }
    });

    startPolling();
    pollStatus();
  }

  function statBox(id, value, label) {
    const box = document.createElement("div");
    box.className = "stat-box";
    const v = document.createElement("span");
    v.className = "stat-value";
    v.id = id;
    v.textContent = value;
    const l = document.createElement("span");
    l.className = "stat-label";
    l.textContent = label;
    box.append(v, l);
    return box;
  }

  function startPolling() {
    clearInterval(pollTimer);
    // Poll only while the Scrape pane is visible (don't wake the SW needlessly
    // when the user is looking at another tab).
    pollTimer = setInterval(() => {
      const pane = document.getElementById("pane-scrape");
      if (pane && pane.classList.contains("active")) pollStatus();
    }, 1000);
  }

  async function pollStatus() {
    try {
      const resp = await chrome.runtime.sendMessage({ type: "HULK_STATUS" });
      if (!resp || !resp.ok || !resp.state) return;
      render(resp.state);
    } catch (err) {
      Log.warn("Status poll failed", err);
    }
  }

  function render(summary) {
    if (lastSummary && JSON.stringify(summary) === JSON.stringify(lastSummary)) return;
    lastSummary = summary;

    const running = summary.running;
    const page = summary.page || 0;
    const maxPages = summary.maxPages || 0;
    const total = summary.totalDomains || 0;
    const startedAt = summary.startedAt || null;
    const status = summary.status || "idle";

    const badge = document.getElementById("scrape-badge");
    const fill = document.getElementById("scrape-progress-fill");
    const pagesEl = document.getElementById("scrape-pages");
    const domainsEl = document.getElementById("scrape-domains");
    const timeEl = document.getElementById("scrape-time");
    const line = document.getElementById("scrape-status-line");
    const startBtn = document.getElementById("scrape-start");
    const stopBtn = document.getElementById("scrape-stop");

    if (!badge) return;

    // "idle" means there is no run state at all (fresh install or after
    // Clear) — show a clean 0% / 0 pages instead of the last run's numbers
    // or an "unlimited" glyph (maxPages is 0 when no run exists).
    const noRun = status === "idle";
    const unlimited = !maxPages && !noRun;
    const pct = noRun || unlimited ? 0 : Math.min(100, Math.round((page / maxPages) * 100));
    fill.style.width = pct + "%";
    pagesEl.textContent = noRun ? "0 / 0" : `${page} / ${unlimited ? "\u221e" : maxPages}`;
    domainsEl.textContent = U.formatCount(total);
    timeEl.textContent = startedAt ? U.formatDuration(Date.now() - startedAt) : "0s";

    // Circular ring
    const ringFg = document.getElementById("scrape-ring-fg");
    const ringPct = document.getElementById("scrape-ring-pct");
    const ringWrap = document.querySelector(".ring-wrap");
    if (ringFg && ringPct) {
      const CIRC = 2 * Math.PI * 33;
      ringFg.style.strokeDashoffset = String(CIRC * (1 - pct / 100));
      // Unlimited runs have no percentage — show the infinity glyph instead.
      ringPct.textContent = noRun ? "0%" : (unlimited ? "\u221e" : pct + "%");
    }
    if (ringWrap) {
      ringWrap.setAttribute("aria-valuenow", String(noRun ? 0 : (unlimited ? -1 : pct)));
      ringWrap.setAttribute("aria-valuetext", noRun ? "0%" : (unlimited ? "unlimited pages" : pct + "%"));
    }

    if (running) {
      badge.textContent = "Running";
      badge.className = "status-badge running";
      startBtn.disabled = true;
      stopBtn.disabled = false;
      line.textContent = `Scraping page ${page} of ${unlimited ? "\u221e" : maxPages} — ${U.formatCount(total)} domains so far.`;
    } else {
      badge.textContent = statusLabel(status, summary.error);
      badge.className = "status-badge" + (summary.error ? " error" : " idle");
      startBtn.disabled = false;
      stopBtn.disabled = true;
      if (status === "finished" || status === "stopped") {
        line.textContent = summary.error
          ? `Finished with error: ${summary.error}`
          : `Done — ${U.formatCount(total)} domains across ${page} pages.`;
      } else {
        line.textContent = "Ready — open a Google search results page.";
      }
    }
  }

  function statusLabel(status, error) {
    switch (status) {
      case "running": return "Running";
      case "finished": return error ? "Error" : "Complete";
      case "stopped": return "Stopped";
      case "timeout": return "Timed out";
      case "tab_closed": return "Tab closed";
      case "nav_failed": return "Navigation failed";
      case "error": return "Error";
      default: return "Idle";
    }
  }

  T.register("scrape", init);
})();
