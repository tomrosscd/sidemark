<div align="center">
  <img src="icons/sidekick_icon.svg" width="64" height="64" alt="Sidemark icon" />
  <h1>Sidemark</h1>
  <p><strong>Shopify Sidekick chat, exported clean into Markdown.</strong></p>
</div>

---

Sidemark is a Chrome extension that captures the active Shopify Sidekick conversation and converts it into clean, portable Markdown — ready to copy into Claude, paste into Notion, or save for your records.

Everything runs locally. The extension makes no network requests. The only data that leaves your browser is what you explicitly copy or download.

---

## Installing

Sidemark is loaded as an unpacked extension — no Chrome Web Store listing required.

1. Download or clone this repository to your machine.
2. Open **chrome://extensions** in Chrome.
3. Enable **Developer mode** using the toggle in the top-right corner.
4. Click **Load unpacked**.
5. Select the folder you just downloaded.
6. Pin the Sidemark icon to your Chrome toolbar for quick access.

> **Note:** You'll need to repeat step 4–5 after any updates to the extension files.

---

## Using Sidemark

1. Open a Shopify admin tab and start a Sidekick conversation.
2. Click the **Sidemark** toolbar icon to open the popup.
3. Sidemark scans the page and lists your conversation exchanges.

### Export modes

Choose how much of the conversation to export using the tab selector at the top:

| Mode | What it exports |
|---|---|
| **Latest Prompt** | Only the most recent exchange — the default |
| **All Prompts (N)** | Every exchange in the conversation |
| **Custom** | A checklist of exchanges you pick individually |

### Editing and exporting

- The **Markdown preview** updates live as you change modes or selections. You can edit the text directly — Copy and Download both use whatever is in that box.
- **Copy Markdown** copies the preview to your clipboard.
- **Download .md** saves a file named `sidekick-<title>-<date>.md`.
- The **↺ rescan icon** in the header re-scrapes the page at any time — useful if you've added more questions or want to discard manual edits to the preview.

### Export settings

**Include collapsed reasoning step labels** — off by default. Turn it on to add a one-line note for each collapsed reasoning group rather than skipping it entirely.

---

## What gets converted

- **Tables** → GitHub-flavoured Markdown tables
- **Report cards** → bold link + fenced ` ```shopifyql ``` ` block with the decoded query
- **Metric cards** → query and inline values (best-effort)
- **Collapsed reasoning steps** → skipped by default (see Export settings above)

---

## How it works

| File | Role |
|---|---|
| `popup.js` | Controller — injects the scraper on demand, renders the UI, wires up Copy/Download |
| `scraper.js` | Runs in the page — finds the Sidekick log, scrolls it fully, groups DOM nodes into exchanges |
| `parser.js` | DOM-to-Markdown conversion — all element handling and selector logic lives here |

The scraper is injected on demand (not a persistent content script), so it only runs when you open the popup.

---

## Updating selectors if Shopify changes the DOM

All CSS selectors live in the `SELECTORS` object at the top of `parser.js`. If Shopify ships a UI update and scraping breaks, that's the first place to look.

Hashed class names (e.g. `_table_13sb5_185`) are matched as substrings using `[class*="..."]` rather than exact strings — the hash suffix changes with each deploy, so prefer that pattern when updating a selector.

---

## Distribution

Currently designed to be loaded unpacked. To share with teammates, zip the folder and have them follow the Installing steps above. A Chrome Web Store listing is an option for wider distribution when needed.
