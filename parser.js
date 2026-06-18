// parser.js
//
// Pure DOM-to-Markdown logic for Shopify Sidekick conversations.
// Loaded as a classic (non-module) script via chrome.scripting.executeScript
// together with scraper.js, in that order, so the functions/consts declared
// here are available as globals to scraper.js in the same injected world.
//
// ---------------------------------------------------------------------------
// SELECTORS
// ---------------------------------------------------------------------------
// Single source of truth for every CSS selector / DOM convention this
// extension depends on. If Shopify changes Sidekick's markup, this is the
// only block that should need editing. Hashed class names (e.g. "_table_..")
// rotate with deploys, so they are only ever matched as *substrings* via
// [class*="..."], never as exact class names. Prefer semantic tags, ARIA
// roles and data-* attributes wherever Shopify provides them.
// var (not const) on purpose: popup.js re-injects this file into the same
// tab's isolated world every time it re-scrapes (initial load, then again
// whenever the "include reasoning" toggle changes). A top-level const/let
// throws "already declared" on re-injection since the isolated world's
// global lexical environment persists across executeScript calls; var
// redeclaration is allowed.
var SELECTORS = {
  // Root / scope
  root: ['#sidekick', '[aria-label="Sidekick"]', '[id*="sidekick"]'],
  log: ['[role="log"]', '#sidekick-chat-body'],
  conversationTitleButton: 'button[class*="ConversationTitleButton"]',
  conversationTitleHeading: '.s-internal-heading',
  headerHeadingFallback: 'h1, h2, h3',

  // Exchange grouping
  userMessageRole: '[data-message-role="user"]',
  userMessageContent: '[class*="UserMessageContentMessage"]',
  itemTypeAttr: 'data-item-type', // "content" | "group"
  messageFooter: '[class*="MessageFooter"]',

  // Answer article
  answerArticle: 'article[class*="container"]',
  h2: '[class*="_h2_"]',

  // Tables
  tableContainer: '[class*="tableContainer"]',

  // Code cards
  codeCard: '[class*="CodeCard"]',
  codeCardPre: 'pre',
  codeCardCode: 'code[class*="language-"]',

  // Report link cards
  reportCard: '[class*="BaseCard"][class*="WithLink"]',
  internalLink: 's-internal-link',
  internalParagraph: 's-internal-paragraph',

  // Metric cards
  metricCard: 's-shopifyql-metric-card',
  metricListContainer: 'ul.list-container',
  metricListItem: 'li.list-item',
  metricLabel: '.label-text',
  metricValue: '.list-item-value',
  internalText: 's-internal-text',
  // The metric card's own title text lives outside the <s-shopifyql-metric-card>
  // element itself, in a sibling header above it (e.g. "Customer count grouped
  // by lifetime order count"). Walked via ancestor search, not a descendant one.
  cardHeader: '[class*="CardHeader"]',

  // Generic card fallback
  baseCard: '[class*="BaseCard"]',

  // Cleanup
  loadingIndicator: '[class*="loadingIndicator"], [class*="_Dots_"], [role="status"][aria-label="Loading"]',
  iconLike: 'svg, [class*="Icon"], [class*="chevron"], [class*="Chevron"]',

  // Reasoning groups
  reasoningGroupLabel: '[class*="Label"], summary, button',
};

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function qs(root, selector) {
  if (!root || !selector) return null;
  try {
    return root.querySelector(selector);
  } catch (e) {
    return null;
  }
}

function qsAny(root, selectors) {
  for (const sel of selectors) {
    const found = qs(root, sel);
    if (found) return found;
  }
  return null;
}

function qsa(root, selector) {
  if (!root || !selector) return [];
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch (e) {
    return [];
  }
}

function cleanText(str) {
  return (str || '').replace(/\s+/g, ' ').trim();
}

function escapePipes(str) {
  return (str || '').replace(/\|/g, '\\|');
}

function collapseBlankLines(str) {
  return str.replace(/\n{3,}/g, '\n\n');
}

function absoluteUrl(href, origin) {
  if (!href) return '';
  try {
    return new URL(href, origin).toString();
  } catch (e) {
    return href;
  }
}

// Recursively pierce open shadow roots, returning the FIRST element that
// matches `selector` and stopping immediately. Metric cards can nest the
// same value list across more than one shadow boundary; collecting every
// match across every shadow root (the old behaviour) re-reads that same
// list several times over. Reading only the first match found avoids the
// duplication entirely.
function pierceShadowQueryFirst(root, selector) {
  if (!root) return null;
  if (root.matches && root.matches(selector)) return root;
  if (root.querySelector) {
    try {
      const found = root.querySelector(selector);
      if (found) return found;
    } catch (e) {
      /* ignore invalid selector on this node type */
    }
  }
  const children = root.children ? Array.from(root.children) : [];
  for (const child of children) {
    if (child.shadowRoot) {
      const found = pierceShadowQueryFirst(child.shadowRoot, selector);
      if (found) return found;
    }
  }
  return null;
}

// Decode a ShopifyQL string passed via a `ql` query param: URL-decode then
// turn "+" into spaces (classic application/x-www-form-urlencoded style).
function decodeQueryParam(raw) {
  if (!raw) return '';
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch (e) {
    return raw.replace(/\+/g, ' ');
  }
}

function softWrapShopifyQL(query) {
  if (!query) return '';
  // Soft-wrap at clause boundaries (common ShopifyQL keywords) so long
  // one-line queries stay readable without altering semantics.
  const clauseKeywords = ['FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'SINCE', 'UNTIL', 'VISUALIZE', 'LIMIT'];
  let result = query.trim();
  for (const kw of clauseKeywords) {
    const re = new RegExp(`\\s+(${kw})\\b`, 'gi');
    result = result.replace(re, `\n${kw}`);
  }
  return result;
}

function isIconOrChevronOnly(el) {
  if (!el) return false;
  if (el.tagName === 'SVG') return true;
  const text = cleanText(el.textContent);
  if (text) return false;
  return qs(el, SELECTORS.iconLike) !== null;
}

function stripNoise(root) {
  qsa(root, SELECTORS.loadingIndicator).forEach((el) => el.remove());
}

// ---------------------------------------------------------------------------
// Inline content rendering (strong/em/code/a/br/text + s-internal-link)
// ---------------------------------------------------------------------------

function renderInline(node, origin) {
  if (!node) return '';
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent.replace(/\s+/g, ' ');
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const tag = node.tagName.toLowerCase();

  if (tag === 'br') return '\n';

  if (tag === 'strong' || tag === 'b') {
    return `**${renderInlineChildren(node, origin)}**`;
  }
  if (tag === 'em' || tag === 'i') {
    return `*${renderInlineChildren(node, origin)}*`;
  }
  if (tag === 'code') {
    return '`' + cleanText(node.textContent) + '`';
  }
  if (tag === 'a' || tag === 's-internal-link') {
    const href = absoluteUrl(node.getAttribute('href'), origin);
    const text = cleanText(node.textContent) || href;
    return href ? `[${text}](${href})` : text;
  }
  if (isIconOrChevronOnly(node)) return '';

  return renderInlineChildren(node, origin);
}

function renderInlineChildren(node, origin) {
  return Array.from(node.childNodes).map((child) => renderInline(child, origin)).join('');
}

// ---------------------------------------------------------------------------
// Lists (nested ul/ol)
// ---------------------------------------------------------------------------

function renderList(listEl, origin, depth) {
  const indent = '  '.repeat(depth);
  const ordered = listEl.tagName.toLowerCase() === 'ol';
  let counter = 1;
  const lines = [];
  for (const li of Array.from(listEl.children)) {
    if (li.tagName.toLowerCase() !== 'li') continue;
    const nestedLists = Array.from(li.children).filter((c) => ['ul', 'ol'].includes(c.tagName.toLowerCase()));
    const clone = li.cloneNode(true);
    nestedLists.forEach((_, i) => {
      const toRemove = Array.from(clone.children).filter((c) => ['ul', 'ol'].includes(c.tagName.toLowerCase()));
      toRemove.forEach((n) => n.remove());
    });
    const text = cleanText(renderInlineChildren(clone, origin));
    const marker = ordered ? `${counter}.` : '-';
    lines.push(`${indent}${marker} ${text}`);
    if (ordered) counter += 1;
    for (const nested of nestedLists) {
      lines.push(renderList(nested, origin, depth + 1));
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function renderTable(tableEl) {
  const headerCells = qsa(tableEl, 'thead th');
  const headers = headerCells.map((th) => escapePipes(cleanText(th.textContent)));
  if (headers.length === 0) {
    const firstRowCells = qsa(tableEl, 'tr:first-child th, tr:first-child td');
    firstRowCells.forEach((c) => headers.push(escapePipes(cleanText(c.textContent))));
  }
  const bodyRows = qsa(tableEl, 'tbody tr');
  const rows = bodyRows.map((tr) =>
    qsa(tr, 'td').map((td) => escapePipes(cleanText(td.textContent)))
  );

  if (headers.length === 0 && rows.length === 0) return '';

  const colCount = headers.length || (rows[0] ? rows[0].length : 0);
  const headerLine = `| ${headers.join(' | ')} |`;
  const sepLine = `| ${Array(colCount).fill('---').join(' | ')} |`;
  const rowLines = rows.map((r) => `| ${r.join(' | ')} |`);

  return [headerLine, sepLine, ...rowLines].join('\n');
}

// ---------------------------------------------------------------------------
// Special cards
// ---------------------------------------------------------------------------

// A report-link card is identified by the <s-internal-link href> element
// itself, not by its BaseCard wrapper div. Matching on the wrapper instead
// (the old approach) meant that if a wrapper ever contained — or appeared
// to contain via a shared ancestor — more than one link, only the first
// link found by querySelector got rendered and the rest were silently
// dropped. Treating each link as its own atomic unit guarantees every
// s-internal-link[href] in an answer gets its own report block, regardless
// of how many siblings share a parent or how deeply any of them are nested.
function isReportLink(el) {
  return Boolean(el && el.tagName && el.tagName.toLowerCase() === 's-internal-link' && el.hasAttribute('href'));
}

function renderReportLinkCard(linkEl, origin) {
  if (!linkEl) return '';
  const href = absoluteUrl(linkEl.getAttribute('href'), origin);

  let label = '';
  const para = qs(linkEl, SELECTORS.internalParagraph);
  if (para) {
    label = cleanText(para.textContent);
  }
  if (!label) {
    const clone = linkEl.cloneNode(true);
    qsa(clone, SELECTORS.iconLike).forEach((n) => n.remove());
    label = cleanText(clone.textContent);
  }

  let ql = '';
  try {
    const url = new URL(href);
    ql = decodeQueryParam(url.searchParams.get('ql'));
  } catch (e) {
    /* not a valid absolute URL, skip ql decode */
  }

  const lines = [`**Report:** [${label || href}](${href})`];
  if (ql) {
    lines.push('```shopifyql');
    lines.push(softWrapShopifyQL(ql));
    lines.push('```');
  }
  return lines.join('\n');
}

function isCodeCard(el) {
  return el.matches && el.matches(SELECTORS.codeCard) || qs(el, SELECTORS.codeCard) !== null;
}

function renderCodeCard(el) {
  const container = el.matches(SELECTORS.codeCard) ? el : qs(el, SELECTORS.codeCard);
  if (!container) return '';
  const codeEl = qs(container, SELECTORS.codeCardCode) || qs(container, 'code');
  const isContainerPre = container.tagName.toLowerCase() === 'pre';
  const preEl = isContainerPre ? container : qs(container, SELECTORS.codeCardPre);
  const text = (codeEl || preEl || container).textContent.trim();

  let lang = '';
  if (codeEl) {
    const cls = Array.from(codeEl.classList).find((c) => c.startsWith('language-'));
    if (cls) lang = cls.replace('language-', '');
  }
  return ['```' + lang, text, '```'].join('\n');
}

function isMetricCard(el) {
  return el.tagName && el.tagName.toLowerCase() === SELECTORS.metricCard;
}

// The metric card's title rarely lives inside the element itself — it's
// usually a sibling heading above it (e.g. a "_CardHeader_" div containing
// an <h6><s-internal-text>title</s-internal-text></h6>). Walk a few levels
// up looking for the nearest ancestor that has such a header anywhere in
// its subtree, stopping at the first (closest) one found.
function findAncestorCardHeaderTitle(el) {
  let node = el.parentElement;
  let depth = 0;
  while (node && depth < 8) {
    const header = qs(node, SELECTORS.cardHeader);
    if (header) {
      const textEl = qs(header, SELECTORS.internalText) || qs(header, 'h1, h2, h3, h4, h5, h6');
      const text = textEl ? cleanText(textEl.textContent) : cleanText(header.textContent);
      if (text) return text;
    }
    node = node.parentElement;
    depth += 1;
  }
  return '';
}

function getMetricCardTitle(el) {
  const innerTitleEl = qs(el, SELECTORS.internalText) || qs(el, 'h1, h2, h3, h4, h5, h6');
  if (innerTitleEl) {
    const text = cleanText(innerTitleEl.textContent);
    if (text) return text;
  }
  const ancestorTitle = findAncestorCardHeaderTitle(el);
  if (ancestorTitle) return ancestorTitle;
  return 'Metric';
}

// Find the single value list to read, and stop there. The card's shadow
// tree can nest the same <ul> across more than one shadow boundary; reading
// only the FIRST matching list (rather than collecting matches everywhere)
// is what avoids reading — and thus emitting — the same rows repeatedly.
function findMetricListEl(el) {
  const direct = pierceShadowQueryFirst(el, SELECTORS.metricListContainer);
  if (direct) return direct;
  const anyList = pierceShadowQueryFirst(el, 'ul');
  if (anyList && qs(anyList, SELECTORS.metricListItem)) return anyList;
  return null;
}

function renderMetricCard(el) {
  const title = getMetricCardTitle(el);
  const query = el.getAttribute('query') || '';

  const lines = [`**${title}**`];
  if (query) {
    lines.push('```shopifyql');
    lines.push(softWrapShopifyQL(decodeQueryParam(query)));
    lines.push('```');
  }

  const listEl = findMetricListEl(el);
  if (listEl) {
    // Only this list's own direct <li> children — never descend further,
    // since that's exactly what caused the same rows to be read multiple
    // times before.
    const items = Array.from(listEl.children).filter((c) => c.tagName && c.tagName.toLowerCase() === 'li');
    const rows = items
      .map((li) => {
        const labelEl = qs(li, SELECTORS.metricLabel);
        const valueEl = qs(li, SELECTORS.metricValue);
        const label = labelEl ? cleanText(labelEl.textContent) : '';
        const value = valueEl ? cleanText(valueEl.textContent) : '';
        if (!label && !value) return null;
        return `| ${escapePipes(label)} | ${escapePipes(value)} |`;
      })
      .filter(Boolean);
    if (rows.length > 0) {
      lines.push('| Label | Value |');
      lines.push('| --- | --- |');
      lines.push(...rows);
    }
  } else if (query) {
    lines.push('_Inline metric values were not captured._');
  }

  return lines.join('\n');
}

function isGenericCard(el) {
  return el.matches && el.matches(SELECTORS.baseCard);
}

function renderGenericCard(el, origin) {
  const titleEl = qs(el, 'h1, h2, h3, h4, [class*="Title"]');
  const title = titleEl ? cleanText(titleEl.textContent) : '';
  const linkEl = qs(el, 'a[href], s-internal-link[href]');
  const href = linkEl ? absoluteUrl(linkEl.getAttribute('href'), origin) : '';
  const clone = el.cloneNode(true);
  qsa(clone, SELECTORS.iconLike).forEach((n) => n.remove());
  const text = cleanText(clone.textContent);

  const lines = [];
  if (title) lines.push(`**${title}**`);
  if (href) lines.push(`[${title || href}](${href})`);
  else if (text) lines.push(text);
  return lines.join('\n');
}

// Detect a chart/visualisation with no tabular equivalent inside a paragraph
// wrapper or generic block.
function findChartPlaceholder(el) {
  const svg = qs(el, 'svg');
  if (!svg) return null;
  const hasTable = qs(el, 'table') !== null;
  if (hasTable) return null;
  const titleEl = qs(el, '[class*="Title"], h1, h2, h3, h4');
  const title = titleEl ? cleanText(titleEl.textContent) : 'chart';
  return `_[Visualisation: ${title}, not captured]_`;
}

// Given a <p> node, detect whether it wraps a special card. Returns markdown
// string if handled, or null if the paragraph should render generically.
function renderSpecialCardIfAny(el, origin) {
  if (isMetricCard(el)) return renderMetricCard(el);
  const metricDescendant = qs(el, SELECTORS.metricCard);
  if (metricDescendant) return renderMetricCard(metricDescendant);

  const linkDescendant = qs(el, SELECTORS.internalLink);
  if (linkDescendant) return renderReportLinkCard(linkDescendant, origin);

  if (isCodeCard(el)) return renderCodeCard(el);

  const chartPlaceholder = findChartPlaceholder(el);
  if (chartPlaceholder) return chartPlaceholder;

  if (isGenericCard(el)) return renderGenericCard(el, origin);
  const genericDescendant = qs(el, SELECTORS.baseCard);
  if (genericDescendant) return renderGenericCard(genericDescendant, origin);

  return null;
}

// ---------------------------------------------------------------------------
// Block-level article walking
// ---------------------------------------------------------------------------

function headingLevel(el) {
  const tag = el.tagName.toLowerCase();
  const match = /^h([1-6])$/.exec(tag);
  if (match) return Number(match[1]);
  if (el.matches && el.matches(SELECTORS.h2)) return 2;
  return null;
}

// A "known" element is one we convert directly and never recurse into —
// recursing into it would either double-count its content (e.g. walking
// into a table's cells again) or break apart a card we know how to render
// as a unit. Everything else is treated as an unrecognised layout wrapper
// (div/span/Polaris-Box/BlockStack/etc.) and we recurse into its children
// instead of skipping it, since Sidekick nests real content arbitrarily
// deep inside such wrappers (and the browser's HTML parser auto-closes a
// <p> as soon as it hits a block-level child like a <div>, so card markup
// written as "<p><div>card</div></p>" in the source actually lands as an
// empty <p> followed by a sibling <div> in the live DOM — recursing into
// unknown wrappers handles both shapes without special-casing either one).
function isKnownBlock(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
  const tag = el.tagName.toLowerCase();
  if (headingLevel(el)) return true;
  if (tag === 'hr') return true;
  if (tag === 'ul' || tag === 'ol') return true;
  if (tag === 'table') return true;
  if (tag === 'pre') return true;
  if (el.matches && el.matches(SELECTORS.tableContainer)) return true;
  if (el.matches && el.matches(SELECTORS.codeCard)) return true;
  if (isMetricCard(el)) return true;
  if (isReportLink(el)) return true;
  if (tag === 'p') {
    // Custom elements like <s-internal-link> and <s-shopifyql-metric-card>
    // don't trigger the browser's auto-close-<p>-before-block-content rule,
    // so a <p> can still end up directly wrapping a card. Only treat the
    // <p> as an atomic leaf if it doesn't wrap one — if it does, recurse
    // into it instead so every card inside is matched individually by the
    // checks above rather than just the first one found.
    const wrapsCard = qs(el, SELECTORS.internalLink) || qs(el, SELECTORS.metricCard) || qs(el, SELECTORS.codeCard);
    return !wrapsCard;
  }
  return false;
}

function renderBlock(el, origin) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';

  const tag = el.tagName.toLowerCase();

  const level = headingLevel(el);
  if (level) {
    return `${'#'.repeat(level)} ${cleanText(renderInlineChildren(el, origin))}`;
  }

  if (tag === 'hr') return '---';
  if (tag === 'ul' || tag === 'ol') return renderList(el, origin, 0);
  if (tag === 'table') return renderTable(el);

  if (el.matches && el.matches(SELECTORS.tableContainer)) {
    const table = qs(el, 'table');
    return table ? renderTable(table) : '';
  }

  if (el.matches && el.matches(SELECTORS.codeCard)) return renderCodeCard(el);
  if (isMetricCard(el)) return renderMetricCard(el);
  if (isReportLink(el)) return renderReportLinkCard(el, origin);
  if (tag === 'pre') return renderCodeCard(el);

  if (tag === 'p') {
    const special = renderSpecialCardIfAny(el, origin);
    if (special !== null) return special;
    return cleanText(renderInlineChildren(el, origin));
  }

  // Defensive fallback; isKnownBlock should never let anything else through.
  const special = renderSpecialCardIfAny(el, origin);
  if (special !== null) return special;
  return cleanText(renderInlineChildren(el, origin));
}

// Recursively collect rendered blocks from `node`'s descendants, in
// document order, without assuming any particular nesting depth.
function collectBlocks(node, origin, blocks) {
  for (const el of Array.from(node.children)) {
    if (isIconOrChevronOnly(el)) continue;

    if (isKnownBlock(el)) {
      const rendered = renderBlock(el, origin);
      if (rendered && rendered.trim()) blocks.push(rendered.trim());
      continue;
    }

    const before = blocks.length;
    collectBlocks(el, origin, blocks);

    // An unrecognised BaseCard-style wrapper that produced nothing via
    // recursion (i.e. none of its descendants matched a known card type)
    // degrades gracefully to the generic-card fallback instead of vanishing.
    if (el.matches && el.matches(SELECTORS.baseCard) && blocks.length === before) {
      const fallback = renderGenericCard(el, origin);
      if (fallback && fallback.trim()) blocks.push(fallback.trim());
    }
  }
}

// Parse an assistant answer <article> element into a Markdown string. This
// is the single entry point scraper.js calls per content item — it does not
// assume content sits at any fixed depth under <article>.
function articleToMarkdown(articleEl, origin) {
  if (!articleEl) return '';
  stripNoise(articleEl);
  const blocks = [];
  collectBlocks(articleEl, origin, blocks);
  return collapseBlankLines(blocks.join('\n\n'));
}
