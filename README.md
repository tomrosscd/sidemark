# Sidekick to Markdown

A Manifest V3 Chrome extension that scrapes the currently open Shopify
Sidekick conversation and converts it into clean, low-token-weight Markdown
— ready to paste into Claude as context.

- Tables come through as real GitHub-flavoured Markdown tables.
- Report cards become a bold link plus a fenced ```shopifyql``` block with
  the decoded query.
- Metric cards capture their query and (best-effort) their inline values.
- Collapsed "N steps completed" reasoning groups are skipped by default.
- Everything runs locally in your browser. The extension makes no network
  requests — the only data that leaves it is what you explicitly copy or
  download.

## Loading it unpacked

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select this folder.
5. Pin the extension if you'd like quick access from the toolbar.

## Using it

1. Open a Shopify Sidekick conversation in a Shopify admin tab
   (`admin.shopify.com` or `*.myshopify.com`).
2. Click the extension's toolbar icon.
3. The popup scans the page, finds the conversation, and lists each
   exchange (a user prompt plus the response that followed) with a
   checkbox. The most recent exchange is marked **LATEST**.
4. Use the quick-select buttons (**Select all**, **Latest only**,
   **Clear**) or tick boxes individually.
5. The Markdown preview below updates live as your selection changes. You
   can hand-edit the preview text directly — Copy and Download both use
   whatever is currently in that box.
6. Click **Copy to clipboard** to copy, or **Download .md** to save a file
   named `sidekick-<title-slug>-<date>.md`.

There's also an "Include collapsed reasoning step labels" checkbox if you
want a one-line note for each collapsed reasoning group instead of skipping
it entirely.

## How it works

- `popup.js` is the controller: it asks Chrome to inject `parser.js` and
  `scraper.js` into the active tab on demand (no persistent content
  script), reads back the structured result, and renders the selection UI,
  preview, copy and download actions.
- `scraper.js` runs in the page. It finds the Sidekick root and its
  `[role="log"]` conversation log, scrolls the log from top to bottom in
  steps first (in case of lazy-mounted/virtualised turns), then walks the
  log's direct children in document order to group them into exchanges.
- `parser.js` holds the actual DOM-to-Markdown conversion logic, loaded as
  a plain script right before `scraper.js` so its functions are available
  as globals in the same injected context.

## Updating selectors if Shopify changes the DOM

All CSS selectors and DOM conventions Sidekick-specific logic depends on
live in **one place**: the `SELECTORS` object at the top of `parser.js`.
If Shopify ships a UI change and scraping breaks, that's the first (and
usually only) place to look. Hashed class names like `_table_13sb5_185`
are matched as substrings (`[class*="..."]`) rather than exact strings,
since the hash suffix rotates with deploys — prefer that pattern over
hard-coding a new exact class name when you update something.

## Team distribution (later)

Not implemented yet. For now this is meant to be loaded unpacked by a
single person. When it's ready to share with the team, the simplest path
is zipping this folder for others to load unpacked themselves; a Chrome
Web Store listing is a further option if wider distribution is needed.
