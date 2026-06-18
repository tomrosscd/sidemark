// popup.js
//
// Popup controller: orchestrates injecting the scraper into the active tab,
// renders the exchange-selection UI, builds the live Markdown preview, and
// wires up Copy/Download. No network requests are ever made.

const rescanBtn       = document.getElementById('rescanBtn');
const errorRescanBtn  = document.getElementById('errorRescanBtn');
const errorStateEl    = document.getElementById('errorState');
const errorMsgEl      = document.getElementById('errorMsg');
const errorHintEl     = document.getElementById('errorHint');
const scanningEl      = document.getElementById('scanning');
const contentEl       = document.getElementById('content');
const customSelEl     = document.getElementById('customSelection');
const exchangeListEl  = document.getElementById('exchangeList');
const previewEl       = document.getElementById('preview');
const includeReasoningEl = document.getElementById('includeReasoning');
const actionStatusEl  = document.getElementById('actionStatus');
const allCountEl      = document.getElementById('allCount');
const copyBtn         = document.getElementById('copyBtn');
const downloadBtn     = document.getElementById('downloadBtn');

const modeRadios = document.querySelectorAll('input[name="exportMode"]');

let scrapeResult = null;
let selectedIndices = new Set();
let currentMode = 'latest';

init();

async function init() {
  modeRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      currentMode = radio.value;
      onModeChange();
    });
  });

  includeReasoningEl.addEventListener('change', () => {
    runScrape(includeReasoningEl.checked);
  });

  rescanBtn.addEventListener('click', () => runScrape(includeReasoningEl.checked));
  errorRescanBtn.addEventListener('click', () => runScrape(includeReasoningEl.checked));
  copyBtn.addEventListener('click', onCopy);
  downloadBtn.addEventListener('click', onDownload);

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
    showError('Could not access the active tab.', 'Make sure you\'re on a Shopify admin page.');
    return;
  }

  if (!tab || !tab.id) {
    showError('Could not access the active tab.', 'Make sure you\'re on a Shopify admin page.');
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (value) => { window.__sidekickIncludeReasoning = value; },
      args: [includeReasoning],
    });

    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['parser.js', 'scraper.js'],
    });

    const result = injectionResults && injectionResults[0] && injectionResults[0].result;

    if (!result || !result.ok) {
      showError(
        'No Sidekick conversation found.',
        'Open Shopify Sidekick in this tab and then rescan.'
      );
      return;
    }

    scrapeResult = result;
    onScrapeSuccess();
  } catch (e) {
    showError(
      'No Sidekick conversation found.',
      'Open Shopify Sidekick in this tab and then rescan.'
    );
  }
}

function showScanning() {
  scanningEl.hidden = false;
  errorStateEl.hidden = true;
  contentEl.hidden = true;
  rescanBtn.hidden = false;
}

function showError(message, hint = '') {
  scanningEl.hidden = true;
  contentEl.hidden = true;
  errorStateEl.hidden = false;
  rescanBtn.hidden = false;
  errorMsgEl.textContent = message;
  errorHintEl.textContent = hint;
  errorHintEl.hidden = !hint;
}

function onScrapeSuccess() {
  scanningEl.hidden = true;
  errorStateEl.hidden = true;
  contentEl.hidden = false;
  rescanBtn.hidden = true;

  const exchanges = scrapeResult.exchanges || [];

  if (exchanges.length === 0) {
    showError(
      'No exchanges found yet.',
      'Send a message in Sidekick and then rescan.'
    );
    return;
  }

  allCountEl.textContent = `(${exchanges.length})`;

  // Reset to latest mode on every fresh scrape
  currentMode = 'latest';
  selectedIndices = new Set();
  document.querySelector('input[name="exportMode"][value="latest"]').checked = true;

  onModeChange();
}

function onModeChange() {
  const exchanges = (scrapeResult && scrapeResult.exchanges) || [];
  const isCustom = currentMode === 'custom';

  contentEl.classList.toggle('custom-active', isCustom);
  customSelEl.hidden = !isCustom;

  if (isCustom) {
    if (selectedIndices.size === 0) {
      selectedIndices = new Set(exchanges.map(e => e.index));
    }
    renderExchangeList(exchanges);
  }

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

function buildMarkdown() {
  if (!scrapeResult) return '';

  const { title, storeHandle, url, exchanges } = scrapeResult;

  let selected;
  if (currentMode === 'latest') {
    selected = exchanges.slice(-1);
  } else if (currentMode === 'all') {
    selected = [...exchanges];
  } else {
    selected = exchanges
      .filter(e => selectedIndices.has(e.index))
      .sort((a, b) => a.index - b.index);
  }

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
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false, timeZoneName: 'short',
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} ${get('timeZoneName') || 'AEST'}`;
}

function formatExportedDateForFilename() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
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
  actionStatusTimer = setTimeout(() => { actionStatusEl.textContent = ''; }, 3000);
}
