# Project HULK

**A modern browser recon toolkit for Chrome & Firefox.**

Project HULK is a browser extension for security testing, focused on fast, local reconnaissance from the active browser tab.

## ✨ Features

* 📜 **JS Files** - Discover external & inline JavaScript
* 🛣️ **Paths** - Extract relative & absolute paths
* 🌐 **Subdomains** - Find page-referenced subdomains locally
* 🔎 **Google Scraper** - Multi-page domain & URL extraction with retries
* 🧪 **Payloads** - SQLi, XSS, SSTI, traversal, command injection & more
* 📊 **Results** - Browse and export collected URLs
* ⚙️ **Settings** - Theme, animations, scraper tuning & configuration backup

## 🔐 Privacy & Security

* On-demand page scanning
* No external recon services
* No remote scripts or fonts
* Persistent scrape state with `chrome.storage.local`
* Chrome + Firefox support

## 📦 Installation

### Chrome / Chromium

```bash
git clone <repository-url>
cd projectHulk
```

Then open:

```text
chrome://extensions
```

Enable **Developer mode → Load unpacked → projectHulk/chrome.

### Firefox

open:

```text
about:debugging#/runtime/this-firefox
```

and load `projectHulk/firefox/manifest.json`.



## ⚠️ Disclaimer

**For authorized security testing only.**

Use HULK only against systems you own or have explicit permission to test.

### License

MIT
