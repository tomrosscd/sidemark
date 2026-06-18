<div align="center">
  <img src="assets/sidekick_icon.svg" width="64" height="64" alt="Sidemark icon" />
  <h1>Sidemark</h1>
  <p><strong>Shopify Sidekick chat, exported clean into Markdown.</strong></p>
</div>

Sidemark is a Chrome extension that pulls your open Shopify Sidekick conversation and converts it to clean Markdown you can copy or download.

Everything runs locally. Nothing leaves your browser unless you copy or download it.

---

## Install

Sidemark loads as an unpacked extension. No Chrome Web Store needed.

1. Download or clone this repo.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (toggle, top right).
4. Click **Load unpacked**.
5. Select the folder.
6. Pin Sidemark to your toolbar.

After updating any files, reload the extension from that same page.

---

## Usage

1. Open a Shopify admin tab with a Sidekick conversation active.
2. Click the Sidemark icon in your toolbar.
3. Sidemark scans the page and shows your exchanges.

### Choose what to export

Three modes at the top of the popup:

| Mode | What you get |
|---|---|
| Latest Prompt | The most recent exchange. Default. |
| All Prompts (N) | Every exchange in the conversation. |
| Custom | Pick individual exchanges from a checklist. |

### Preview and export

The Markdown preview updates as you switch modes or change selections. You can edit the text before copying or downloading.

- **Copy Markdown:** copies the preview to your clipboard.
- **Download .md:** saves a file as `sidekick-<title>-<date>.md`.
- **Rescan (↺):** re-scrapes the page. Good for picking up new questions or resetting edits you have made to the preview.

### Reasoning steps

Off by default. Turn on "Include collapsed reasoning step labels" to add a one-line note for each collapsed reasoning group instead of skipping it.

---

## What gets converted

| Element | Output |
|---|---|
| Tables | GitHub-flavoured Markdown tables |
| Report cards | Bold link plus a fenced `shopifyql` code block with the decoded query |
| Metric cards | Query and inline values (best effort) |
| Collapsed reasoning steps | Skipped by default |

---

## How it works

| File | What it does |
|---|---|
| `popup.js` | Controls the UI, injects the scraper on demand, wires up Copy and Download |
| `scraper.js` | Runs inside the page, finds the Sidekick log, scrolls it fully, groups nodes into exchanges |
| `parser.js` | Handles all DOM-to-Markdown conversion and selector logic |

The scraper only runs when you open the popup. There is no persistent content script.

---

## If Shopify updates the DOM and scraping breaks

All CSS selectors are in the `SELECTORS` object at the top of `parser.js`. Start there.

Hashed class names like `_table_13sb5_185` are matched as substrings using `[class*="..."]` rather than exact strings. The hash changes on each deploy, so use that pattern when updating a selector.

---

## Sharing with others

Zip the folder and have them follow the Install steps above. A Chrome Web Store listing is worth doing once it is ready for wider distribution.
