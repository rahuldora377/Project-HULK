<p align="center">
  <img width="128" height="128" alt="Project HULK" src="https://github.com/user-attachments/assets/dfa7c9d7-318f-42de-afdd-5397fad003c2" />
</p>

<h1 align="center">Project HULK</h1>

<h2 align="center"> A modern browser recon toolkit for Chrome & Firefox.</h2>

<h3 align="center"> Project HULK is a browser extension for security testing, focused on fast, local reconnaissance from the browser tab. </h3>
<p align="center"> <a href="https://rahuldora377.github.io/ProjectHulk-Website/"> 🌐 Website </a>

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
git clone https://github.com/rahuldora377/Project-HULK.git
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

Use ProjectHULK only against systems you own or have explicit permission to test.

### License

MIT
