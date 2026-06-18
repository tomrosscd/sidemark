// popup.js
//
// Popup controller: orchestrates injecting the scraper into the active tab,
// renders the exchange-selection UI, builds the live Markdown preview, and
// wires up Copy/Download. No network requests are ever made.

const errorStateEl = document.getElementById('errorState');
const errorMsgEl = document.getElementById('errorMsg');
const rescanBtn = document.getElementById('rescanBtn');
const scanningEl = document.getElementById('scanning');
const contentEl = document.getElementById('content');
const exchangeListEl = document.getElementById('exchangeList');
const previewEl = document.getElementById('preview');
const includeReasoningEl = document.getElementById('includeReasoning');
const actionStatusEl = document.getElementById('actionStatus');

const selectAllBtn = document.getElementById('selectAll');
const selectLatestBtn = document.getElementById('selectLatest');
const selectClearBtn = document.getElementById('selectClear');
const copyBtn = document.getElementById('copyBtn');
const downloadBtn = document.getElementById('downloadBtn');
const refreshBtn = document.getElementById('refreshBtn');

let scrapeResult = null; // { ok, title, storeHandle, url, exchanges }
let selectedIndices = new Set();

init();

async function init() {
  includeReasoningEl.addEventListener('change', () => {
    runScrape(includeReasoningEl.checked);
  });
  selectAllBtn.addEventListener('click', () => applyQuickSelect('all'));
  selectLatestBtn.addEventListener('click', () => applyQuickSelect('latest'));
  selectClearBtn.addEventListener('click', () => applyQuickSelect('clear'));
  previewEl.addEventListener('input', () => {
    // User hand-edited the preview; nothing else to do, it's already the
    // value Copy/Download will use.
  });
  copyBtn.addEventListener('click', onCopy);
  downloadBtn.addEventListener('click', onDownload);
  rescanBtn.addEventListener('click', () => runScrape(includeReasoningEl.checked));
  refreshBtn.addEventListener('click', () => runScrape(includeReasoningEl.checked));

  await runScrape(false);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function runScrape(includeReasoning) {
  showScanning();

  let tab;
  try {
    tab = await getActiveTab();
  } catch (e) {
    showError('Could not access the active tab.');
    return;
  }

  if (!tab || !tab.id) {
    showError('Could not access the active tab.');
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (value) => {
        window.__sidekickIncludeReasoning = value;
      },
      args: [includeReasoning],
    });

    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['parser.js', 'scraper.js'],
    });

    const result = injectionResults && injectionResults[0] && injectionResults[0].result;

    if (!result || !result.ok) {
      showError('Open Sidekick on this Shopify admin tab, then reopen this popup.');
      return;
    }

    scrapeResult = result;
    onScrapeSuccess();
  } catch (e) {
    showError('Open Sidekick on this Shopify admin tab, then reopen this popup.');
  }
}

function showScanning() {
  scanningEl.hidden = false;
  errorStateEl.hidden = true;
  contentEl.hidden = true;
}

function showError(message) {
  scanningEl.hidden = true;
  contentEl.hidden = true;
  errorStateEl.hidden = false;
  errorMsgEl.textContent = message;
}

function onScrapeSuccess() {
  scanningEl.hidden = true;
  errorStateEl.hidden = true;
  contentEl.hidden = false;

  const exchanges = scrapeResult.exchanges || [];

  if (exchanges.length === 0) {
    showError('Sidekick was found, but no exchanges could be parsed yet. Send a message and reopen this popup.');
    return;
  }

  // Default selection: all, unless we already had a selection (e.g. after
  // toggling "include reasoning") in which case keep the same indices.
  if (selectedIndices.size === 0) {
    selectedIndices = new Set(exchanges.map((e) => e.index));
  }

  renderExchangeList(exchanges);
  updatePreview();
}

function truncate(text, max) {
  if (!text) return '(empty prompt)';
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  const slice = collapsed.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trim()}…`;
}

function renderExchangeList(exchanges) {
  exchangeListEl.innerHTML = '';

  for (const exchange of exchanges) {
    const li = document.createElement('li');

    const label = document.createElement('label');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedIndices.has(exchange.index);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        selectedIndices.add(exchange.index);
      } else {
        selectedIndices.delete(exchange.index);
      }
      updatePreview();
    });

    const promptSpan = document.createElement('span');
    promptSpan.className = 'exchange-prompt';
    promptSpan.textContent = `${exchange.index}. ${truncate(exchange.userPrompt, 80)}`;

    if (exchange.isLatest) {
      const badge = document.createElement('span');
      badge.className = 'latest-badge';
      badge.textContent = 'LATEST';
      promptSpan.appendChild(badge);
    }

    label.appendChild(checkbox);
    label.appendChild(promptSpan);
    li.appendChild(label);
    exchangeListEl.appendChild(li);
  }
}

function applyQuickSelect(mode) {
  const exchanges = (scrapeResult && scrapeResult.exchanges) || [];
  if (exchanges.length === 0) return;

  if (mode === 'all') {
    selectedIndices = new Set(exchanges.map((e) => e.index));
  } else if (mode === 'latest') {
    const latest = exchanges[exchanges.length - 1];
    selectedIndices = new Set([latest.index]);
  } else if (mode === 'clear') {
    selectedIndices = new Set();
  }

  renderExchangeList(exchanges);
  updatePreview();
}

function slugify(text) {
  return (text || 'sidekick')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'sidekick';
}

function formatExportedTimestamp() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).formatToParts(now);

  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const time = `${get('hour')}:${get('minute')}`;
  const zone = get('timeZoneName') || 'AEST';
  return `${date} ${time} ${zone}`;
}

function formatExportedDateForFilename() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function buildMarkdown() {
  if (!scrapeResult) return '';

  const { title, storeHandle, url, exchanges } = scrapeResult;

  const selected = exchanges
    .filter((e) => selectedIndices.has(e.index))
    .sort((a, b) => a.index - b.index);

  const header = [
    `# ${title}`,
    `Source: ${url}`,
    `Store: ${storeHandle}`,
    `Exported: ${formatExportedTimestamp()}`,
  ].join('\n');

  const sections = selected.map((exchange) => {
    const heading = `## ${exchange.index}. ${truncate(exchange.userPrompt, 80)}`;
    const quoted = `> ${exchange.userPrompt.replace(/\n/g, '\n> ')}`;
    const body = exchange.markdown || '_(no assistant response captured)_';
    return [heading, quoted, '', body].join('\n');
  });

  return [header, ...sections].join('\n\n---\n\n').trim() + '\n';
}

function updatePreview() {
  previewEl.value = buildMarkdown();
}

async function onCopy() {
  try {
    await navigator.clipboard.writeText(previewEl.value);
    showActionStatus('Copied to clipboard.', false);
  } catch (e) {
    showActionStatus('Could not copy to clipboard.', true);
  }
}

function onDownload() {
  const title = scrapeResult ? scrapeResult.title : 'sidekick';
  const filename = `sidekick-${slugify(title)}-${formatExportedDateForFilename()}.md`;

  const blob = new Blob([previewEl.value], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showActionStatus(`Downloaded ${filename}`, false);
}

let actionStatusTimer = null;
function showActionStatus(message, isError) {
  actionStatusEl.textContent = message;
  actionStatusEl.classList.toggle('error', Boolean(isError));
  if (actionStatusTimer) clearTimeout(actionStatusTimer);
  actionStatusTimer = setTimeout(() => {
    actionStatusEl.textContent = '';
  }, 3000);
}
