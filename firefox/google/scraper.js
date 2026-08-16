/**
 * google/scraper.js
 * ---------------------------------------------------------------------------
 * Background service worker (MV3) — coordinates Google result scraping.
 *
 * Reliability design (MV3 service workers are killed after ~30s of idle):
 *  - ALL state lives in chrome.storage.local, so progress survives SW restarts.
 *  - A chrome.alarms keepalive wakes the worker while a scrape is running and
 *    resumes the loop from persisted state.
 *  - Retries with exponential backoff (1s, 2s, 4s) on transient failures.
 *  - Rate limiting: configurable delay between page scrapes (pageDelayMs).
 *  - Domains are sanitized with HulkUtils before being stored.
 *
 * Protocol (popup -> SW):
 *   { type: "HULK_START" }  -> { ok, error? }
 *   { type: "HULK_STOP" }   -> { ok }
 *   { type: "HULK_STATUS" } -> { ok, state: summary }
 *   { type: "HULK_CLEAR" }  -> { ok }
 * ---------------------------------------------------------------------------
 */
"use strict";


const HulkUtils = self.HulkUtils;
const HulkConfig = self.HulkConfig;
const HulkLog = self.HulkLog;

const STATE_KEY = "hulkScrapeState";
const RESULTS_KEY = "hulkResults";
const ALARM_NAME = "hulk-scrape-keepalive";
const MAX_RETRIES = 3;
const MAX_RUN_MS = 10 * 60 * 1000; // hard cap: 10 minutes per run
const MIN_DELAY_MS = 500;
const NAV_TIMEOUT_MS = 15000; // max wait for the next page to load
const MAX_NAV_ATTEMPTS = 3;   // click-next retries
const MAX_URLS_PER_DOMAIN = 15; // full domain+path URLs kept per domain
const MAX_DOMAINS = 3000; // cap unique domains per run (bounds storage.local + results memory)

let wakeTimer = null; // in-memory scheduler (lost on SW restart — alarm resumes)
let stepInFlight = false; // re-entrancy guard (timer + alarm can both fire)

/* ------------------------------------------------------------------ *
 * Storage helpers
 * ------------------------------------------------------------------ */

/** @returns {Promise<Object|null>} persisted scrape state */
async function getState() {
  try {
    const data = await chrome.storage.local.get(STATE_KEY);
    return (data && data[STATE_KEY]) || null;
  } catch (err) {
    HulkLog.error("getState failed", err);
    return null;
  }
}

/** @param {Object} state */
async function setState(state) {
  try {
    await chrome.storage.local.set({ [STATE_KEY]: state });
  } catch (err) {
    HulkLog.error("setState failed", err);
  }
}

/**
 * Re-read persisted state and return it ONLY while the run is still active.
 * Returns null when the user stopped the run or it finished while we were
 * awaiting something. Steps call this after every `await` so an in-flight
 * step can never resurrect a stopped run or clobber its final state — this
 * is what makes the Stop button reliable.
 * @returns {Promise<Object|null>} Fresh running state or null.
 */
async function freshStateIfRunning() {
  const fresh = await getState();
  return (fresh && fresh.running && fresh.status === "running") ? fresh : null;
}

/** Lightweight summary sent to the popup (avoids shipping full domain maps). */
function summarize(state) {
  return {
    running: !!(state && state.running),
    status: state ? state.status : "idle",
    page: state ? state.page : 0,
    maxPages: state ? state.maxPages : 0,
    totalDomains: state ? Object.keys(state.domains || {}).length : 0,
    error: state ? state.error : null,
    startedAt: state ? state.startedAt : null,
    updatedAt: state ? state.updatedAt : null
  };
}

/* ------------------------------------------------------------------ *
 * Messaging helpers
 * ------------------------------------------------------------------ */

/**
 * Send a message to a tab and await the response with a timeout.
 * Rejects on chrome.runtime.lastError or timeout.
 * @param {number} tabId
 * @param {Object} msg
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<Object>}
 */
function sendMessageToTab(tabId, msg, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("timeout"));
      }
    }, timeoutMs);
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(resp);
    });
  });
}

/** Inject the content script (and its dependency) via scripting API. */
async function ensureContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["google/domain-utils.js", "google/content.js"]
  });
}

/**
 * ensureContentScript, but never throws: a failed injection is not fatal.
 * The "Could not establish connection" fallback in scrapePageOnce /
 * clickNextOnce re-injects and retries when the run actually needs the
 * script, so proactive injection is best-effort only.
 */
async function ensureContentScriptSafe(tabId) {
  try {
    await ensureContentScript(tabId);
  } catch (err) {
    HulkLog.warn("Content script injection failed (fallback will retry)", err);
  }
}

/** Small sleep helper (service workers may use setTimeout for short waits). */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Ask the page for scraped domains. If the content script is not present
 * (page loaded before the extension was installed), inject it and retry once.
 */
async function scrapePageOnce(state, tabId) {
  let resp;
  try {
    resp = await sendMessageToTab(tabId, {
      type: "HULK_SCRAPE_PAGE",
      page: state.page,
      selector: state.nextSelector
    });
  } catch (err) {
    if (String((err && err.message) || "").includes("Could not establish connection")) {
      HulkLog.info("Content script missing — injecting", tabId);
      await ensureContentScript(tabId);
      await sleep(250);
      resp = await sendMessageToTab(tabId, {
        type: "HULK_SCRAPE_PAGE",
        page: state.page,
        selector: state.nextSelector
      });
    } else {
      throw err;
    }
  }
  if (!resp || resp.ok !== true) {
    throw new Error((resp && resp.error) || "No response from page");
  }
  return resp;
}

/**
 * Ask the content script to click the "next page" link (with inject-retry).
 * @returns {Promise<Object|null>} The click response or null on failure.
 */
async function clickNextOnce(state, tabId) {
  let resp;
  try {
    resp = await sendMessageToTab(tabId, {
      type: "HULK_GO_NEXT",
      selector: state.nextSelector
    }, 5000);
  } catch (err) {
    if (String((err && err.message) || "").includes("Could not establish connection")) {
      await ensureContentScript(tabId);
      await sleep(250);
      resp = await sendMessageToTab(tabId, {
        type: "HULK_GO_NEXT",
        selector: state.nextSelector
      }, 5000);
    } else {
      HulkLog.warn("GO_NEXT message failed", err);
      return null;
    }
  }
  return (resp && resp.ok) ? resp : null;
}

/**
 * Wait until the tab navigates away from `fromUrl` and finishes loading.
 * @returns {Promise<boolean>}
 */
async function waitForNavigation(tabId, fromUrl) {
  const deadline = Date.now() + NAV_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      // `tab.url` may be undefined for protected pages — treat that as "no
      // change" rather than a successful navigation (avoids false positives).
      if (tab.url && tab.url !== fromUrl && tab.status === "complete") {
        return true;
      }
    } catch (err) {
      return false; // tab closed mid-navigation
    }
    await sleep(600);
  }
  return false;
}

/**
 * Click the next-page link and wait for the navigation, retrying with
 * exponential backoff. Persists `awaitingNav` so a killed service worker can
 * resume the wait instead of re-scraping the same page.
 * @returns {Promise<boolean>}
 */
async function navigateToNextPage(state) {
  // Bail before touching state if the run was stopped while the previous
  // step was awaiting — writing `awaitingNav` would resurrect the run.
  if (!(await freshStateIfRunning())) return false;
  const fromUrl = state.lastUrl || "";
  state.awaitingNav = true;
  state.navFromUrl = fromUrl;
  await setState(state);

  let navOk = false;
  for (let attempt = 1; attempt <= MAX_NAV_ATTEMPTS; attempt++) {
    const clickResp = await clickNextOnce(state, state.tabId);
    if (clickResp && clickResp.clicked) {
      navOk = await waitForNavigation(state.tabId, fromUrl);
      if (navOk) break;
    }
    // Re-read state: user may have stopped the run mid-navigation.
    const fresh = await getState();
    if (!fresh || !fresh.running) break;
    HulkLog.warn(`Next-page navigation attempt ${attempt}/${MAX_NAV_ATTEMPTS} failed — retrying`);
    await sleep(1000 * Math.pow(2, attempt - 1)); // 1s, 2s, 4s
  }

  // Only persist the "navigation done" flags if the run is STILL active — a
  // Stop that landed during the wait must never be overwritten by this stale
  // (running: true) object.
  const still = await freshStateIfRunning();
  if (!still) return false;
  state.awaitingNav = false;
  state.navFromUrl = null;
  await setState(state);

  // Scripts injected via executeScript do NOT survive navigation — re-inject
  // so the next scrape succeeds without a doomed message round-trip.
  if (navOk) await ensureContentScriptSafe(state.tabId);
  return navOk;
}

/* ------------------------------------------------------------------ *
 * Scrape loop
 * ------------------------------------------------------------------ */

/**
 * Run one scrape step. State is read fresh from storage every time so the
 * loop can resume after a service worker restart.
 */
async function runScrapeStep() {
  if (stepInFlight) return;
  stepInFlight = true;
  try {
    await runScrapeStepInner();
  } finally {
    stepInFlight = false;
  }
}

/** Actual step logic (guarded by runScrapeStep). */
async function runScrapeStepInner() {
  let state = await getState();
  if (!state || !state.running) return;

  // Hard time cap.
  if (Date.now() - state.startedAt > MAX_RUN_MS) {
    HulkLog.warn("Scrape hit time cap — finishing");
    await finishScrape(state, "timeout");
    return;
  }

  // Tab may have been closed mid-run.
  let tab;
  try {
    tab = await chrome.tabs.get(state.tabId);
  } catch (err) {
    HulkLog.warn("Tab closed mid-scrape");
    await finishScrape(state, "tab_closed");
    return;
  }

  // Resume path: the service worker was killed while waiting for the next
  // page to load. Wait for the navigation (with one re-click attempt, in case
  // the worker died before the original click was dispatched), then continue.
  if (state.awaitingNav) {
    HulkLog.info("Resuming mid-navigation");
    const fromUrl = state.navFromUrl || "";
    let navOk = await waitForNavigation(state.tabId, fromUrl);
    if (!navOk) {
      // The click may never have been sent — try once before giving up.
      HulkLog.info("No navigation observed on resume — re-clicking next");
      const clickResp = await clickNextOnce(state, state.tabId);
      if (clickResp && clickResp.clicked) {
        navOk = await waitForNavigation(state.tabId, fromUrl);
      }
    }
    // A Stop may have landed while we waited — never clobber it.
    if (!(await freshStateIfRunning())) return;
    state.awaitingNav = false;
    state.navFromUrl = null;
    await setState(state);
    if (!navOk) {
      await finishScrape(state, "nav_failed");
      return;
    }
    // Re-inject after the resumed navigation (see navigateToNextPage).
    await ensureContentScriptSafe(state.tabId);
    scheduleNext(state.pageDelayMs);
    return;
  }

  try {
    const resp = await scrapePageOnce(state, state.tabId);

    // The user may have clicked Stop while we were scraping this page.
    // Re-read state and operate on the fresh copy — never the stale one.
    const fresh = await freshStateIfRunning();
    if (!fresh) return;
    state = fresh;
    state.lastUrl = resp.url || tab.url || "";

    // Sanitize + merge domains. New domains are capped at MAX_DOMAINS so
    // storage.local stays well under quota and the results dashboard never
    // loads an unbounded array into memory (long unlimited runs).
    let domainCount = Object.keys(state.domains).length;
    if (domainCount >= MAX_DOMAINS) {
      HulkLog.warn(`Domain cap reached (${MAX_DOMAINS}) — not collecting new domains`);
    }
    for (const d of resp.domains || []) {
      const domain = HulkUtils.sanitizeDomain(d && d.domain);
      if (!domain) continue;
      const existing = state.domains[domain];
      if (existing) {
        existing.count += (d.count || 1);
        if (!existing.title && d.title) existing.title = d.title;
        for (const u of d.urls || []) {
          if (existing.urls.length < MAX_URLS_PER_DOMAIN) existing.urls.push(u);
        }
      } else {
        if (domainCount >= MAX_DOMAINS) continue; // cap reached — skip new domains
        state.domains[domain] = {
          count: d.count || 1,
          title: d.title || "",
          urls: (d.urls || []).slice(0, MAX_URLS_PER_DOMAIN)
        };
        domainCount += 1;
      }
    }

    state.page += 1;
    state.updatedAt = Date.now();
    state.lastError = null;
    state.retries = 0;
    await setState(state);

    if (!resp.hasNext) {
      HulkLog.info(`Scrape complete at page ${state.page}`);
      await finishScrape(state, "complete");
      return;
    }
    if (state.maxPages > 0 && state.page >= state.maxPages) {
      HulkLog.info(`Reached max pages (${state.maxPages})`);
      await finishScrape(state, "max_pages");
      return;
    }

    // Click the next button and wait for the navigation to complete before
    // scraping the following page. This is what makes multi-page crawling work.
    const navOk = await navigateToNextPage(state);
    // A Stop may have landed during the navigation wait.
    const still = await freshStateIfRunning();
    if (!still) return;
    if (!navOk) {
      HulkLog.warn("Could not advance to the next results page");
      await finishScrape(state, "nav_failed");
      return;
    }
    HulkLog.info(`Navigated to next page — continuing (page ${state.page + 1}/${state.maxPages})`);
    scheduleNext(state.pageDelayMs); // rate limiting between pages
  } catch (err) {
    // A Stop may have landed while this step was failing — don't retry a dead run.
    const still = await freshStateIfRunning();
    if (!still) return;
    state = still;
    state.retries = (state.retries || 0) + 1;
    state.lastError = String((err && err.message) || err);
    await setState(state);
    HulkLog.warn(`Scrape step failed (${state.retries}/${MAX_RETRIES})`, state.lastError);
    if (state.retries >= MAX_RETRIES) {
      await finishScrape(state, "error");
      return;
    }
    scheduleNext(1000 * Math.pow(2, state.retries - 1)); // 1s, 2s, 4s backoff
  }
}

/** Schedule the next step with a minimum delay (rate limiting). */
function scheduleNext(delayMs) {
  clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => {
    runScrapeStep();
  }, Math.max(MIN_DELAY_MS, delayMs || MIN_DELAY_MS));
}

/**
 * Finish a run: persist results, clear the keepalive alarm, optionally open
 * the results page. Idempotent via state.status check.
 */
async function finishScrape(state, status) {
  if (!state || state.status === "finished" || state.status === "stopped") return;
  state.running = false;
  state.status = status === "stopped" ? "stopped" : "finished";
  state.error =
    status === "error" ? state.lastError || "Scrape failed" :
    status === "nav_failed" ? "Could not advance to the next results page." :
    status === "timeout" ? "Scrape hit the time limit." :
    status === "tab_closed" ? "The tab was closed during scraping." :
    null;
  state.finishedAt = Date.now();

  const records = HulkUtils.recordsToArray(state.domains || {});
  const results = {
    runId: state.runId,
    status: state.status,
    error: state.error,
    pages: state.page,
    maxPages: state.maxPages,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    totalDomains: records.length,
    domains: records
  };

  try {
    await chrome.storage.local.set({ [STATE_KEY]: state, [RESULTS_KEY]: results });
  } catch (err) {
    HulkLog.error("Persist results failed", err);
  }

  try {
    await chrome.alarms.clear(ALARM_NAME);
  } catch (err) { /* ignore */ }

  HulkLog.info(`Run finished: ${status} — ${records.length} domains over ${state.page} pages`);

  // Only auto-open when the popup asked for it (settings) and the run was
  // not deliberately stopped with zero data.
  const settings = await HulkConfig.getSettings();
  if (settings.autoOpenResults && (status === "complete" || status === "max_pages")) {
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL("google/results.html") });
    } catch (err) {
      HulkLog.warn("Could not open results tab", err);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Message handlers
 * ------------------------------------------------------------------ */

/** Start scraping the active Google tab. */
async function startScrape() {
  const settings = await HulkConfig.getSettings();
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.id) return { ok: false, error: "No active tab found." };
  // Accept ANY Google host (www.google.com, google.co.uk, google.co.in, …)
  // — the old regex only allowed `google.com` WITH a trailing slash, so a
  // bare `https://www.google.com` or a regional domain was wrongly rejected.
  // Only walls (consent / /sorry/) are rejected, with a precise message.
  const url = HulkUtils.parseUrl(tab.url || "");
  const host = url ? url.hostname : "";
  if (!url || !/^https?:$/.test(url.protocol) || !HulkUtils.isGoogleHost(host)) {
    const got = host ? ` — got ${host}` : "";
    return { ok: false, error: `Open a Google search results page first${got}.` };
  }
  if (HulkUtils.isGoogleWall(url)) {
    return {
      ok: false,
      error: host === "consent.google.com"
        ? "Google is showing a consent page. Open a search results page (google.com/search?q=…) and try again."
        : "Google is blocking with an unusual-traffic check (/sorry/). Complete it in the tab, then try again."
    };
  }

  // maxPages 0 means "unlimited" — crawl every result page until Google has
  // no next link. Empty/invalid values fall back to the default (10).
  const rawMax = settings.maxPages;
  const parsedMax = (typeof rawMax === "string" && rawMax.trim() === "") ? NaN : Number(rawMax);
  const maxPages = parsedMax === 0
    ? 0
    : (Number.isFinite(parsedMax) && parsedMax >= 1 ? Math.floor(parsedMax) : 10);

  const state = {
    running: true,
    status: "running",
    runId: Date.now(),
    tabId: tab.id,
    page: 0,
    maxPages,
    pageDelayMs: Math.max(MIN_DELAY_MS, Number(settings.pageDelayMs) || 1500),
    nextSelector: settings.nextSelector || "a[aria-label='Next page'], #pnnext, a[aria-label='Next']",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    domains: {},
    retries: 0,
    lastError: null,
    awaitingNav: false,
    navFromUrl: null,
    lastUrl: ""
  };

  await setState(state);
  HulkLog.info("Scrape started", { runId: state.runId, maxPages: state.maxPages });

  try {
    await chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.5, periodInMinutes: 0.5 });
  } catch (err) {
    HulkLog.warn("Could not create keepalive alarm", err);
  }

  // No manifest content script anymore — inject it now so the first page
  // scrape succeeds without a doomed message round-trip.
  await ensureContentScriptSafe(state.tabId);

  scheduleNext(400); // give the popup a beat to render its UI
  return { ok: true, state: summarize(state) };
}

/** Stop a running scrape (results are still persisted). */
async function stopScrape() {
  const state = await getState();
  if (!state) return { ok: true };
  if (state.running) {
    state.running = false;
    await setState(state);
    HulkLog.info("Scrape stopped by user");
  }
  await finishScrape(state, "stopped");

  // Re-assert shortly after: an in-flight step's storage write can land AFTER
  // our stopped write (sub-millisecond race), leaving `running: true` in
  // storage and letting the loop resurrect. Flipping it back here means the
  // step's next post-await guard reads the stopped state and bails.
  setTimeout(async () => {
    try {
      const cur = await getState();
      if (cur && cur.running) {
        HulkLog.warn("Re-asserting stop after late in-flight write");
        cur.running = false;
        await finishScrape(cur, "stopped");
      }
    } catch (err) {
      /* ignore */
    }
  }, 300);
  return { ok: true };
}

/** Return the current state summary. */
async function getStatus() {
  const state = await getState();
  const data = await chrome.storage.local.get(RESULTS_KEY);
  return {
    ok: true,
    state: summarize(state),
    lastRun: (data && data[RESULTS_KEY]) || null
  };
}

/**
 * Clear the last run entirely: saved results AND the scrape state, so the
 * popup's progress UI (ring, percentage, page/domain counters) resets too.
 * The keepalive alarm is also cleared in case Clear was pressed mid-run —
 * otherwise an orphaned alarm would keep waking the service worker forever.
 */
async function clearResults() {
  try {
    await chrome.storage.local.remove([RESULTS_KEY, STATE_KEY]);
  } catch (err) {
    HulkLog.error("Clear results failed", err);
  }
  try {
    await chrome.alarms.clear(ALARM_NAME);
  } catch (err) {
    HulkLog.warn("Could not clear keepalive alarm", err);
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return undefined;
  const t = msg.type;

  if (t === "HULK_START" || t === "START") {
    startScrape().then(sendResponse).catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true; // async sendResponse
  }
  if (t === "HULK_STOP" || t === "STOP") {
    stopScrape().then(sendResponse).catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
  if (t === "HULK_STATUS" || t === "GET_STATUS") {
    getStatus().then(sendResponse).catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
  if (t === "HULK_CLEAR") {
    clearResults().then(sendResponse).catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
  return undefined;
});

// Keepalive: resume scraping if the service worker was killed mid-run.
// Clear any pending timer first so the alarm and a scheduled step never both
// fire — otherwise the rate-limit delay would be skipped.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  HulkLog.debug("Keepalive alarm fired");
  clearTimeout(wakeTimer);
  runScrapeStep();
});

HulkLog.info("Scraper service worker loaded");
