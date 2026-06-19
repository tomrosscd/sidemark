// panel.js
//
// Side panel controller. Two top-level modes:
//   - Prompts: browse/search the prompt library, build a prompt with the
//     chosen timeframe/comparison, insert it into Sidekick or copy it.
//   - Export: scrape the open Sidekick conversation and export it as
//     Markdown (existing behaviour), plus CSV export for tables.

// ---------------------------------------------------------------------------
// Settings (chrome.storage.local)
// ---------------------------------------------------------------------------

const SETTINGS_KEY = 'sidemarkSettings';
const DEFAULT_SETTINGS = {
  topMode: 'prompts',
  timeframe: 'last 30 days',
  comparison: 'prev',
  category: 'All',
  includeReasoning: false,
  trimFollowups: true,
};

const PROMPTS_URL = 'https://tomrosscd.github.io/sidecar/prompts.json';
const CACHE_KEY = 'sidecar_prompts_cache_v1';

let settings = { ...DEFAULT_SETTINGS };

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    settings = { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
  } catch (e) {
    settings = { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  chrome.storage.local.set({ [SETTINGS_KEY]: settings }).catch(() => {});
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const topModeRadios   = document.querySelectorAll('input[name="topMode"]');
const promptsModeEl   = document.getElementById('promptsMode');
const exportModeEl    = document.getElementById('exportMode');

const tfSelect       = document.getElementById('tfSelect');
const cmpSelect      = document.getElementById('cmpSelect');
const catChipsEl     = document.getElementById('catChips');
const searchInput    = document.getElementById('searchInput');
const promptsCountEl = document.getElementById('promptsCount');
const promptsListEl  = document.getElementById('promptsList');

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
const trimFollowupsEl = document.getElementById('trimFollowups');
const actionStatusEl  = document.getElementById('actionStatus');
const allCountEl      = document.getElementById('allCount');
const copyBtn         = document.getElementById('copyBtn');
const downloadBtn     = document.getElementById('downloadBtn');
const countReadoutEl  = document.getElementById('countReadout');

const exportSubModeRadios = document.querySelectorAll('input[name="exportSubMode"]');
const exportSubViewRadios = document.querySelectorAll('input[name="exportSubView"]');
const markdownViewEl  = document.getElementById('markdownView');
const tablesViewEl    = document.getElementById('tablesView');
const tablesListEl    = document.getElementById('tablesList');
const tablesCountEl   = document.getElementById('tablesCount');
const markdownActionsRowEl = document.getElementById('markdownActionsRow');

let loadedPrompts = [];
let scrapeResult = null;
let selectedIndices = new Set();
let currentExportSubMode = 'latest';
let currentExportSubView = 'markdown';
let openPromptSlugs = new Set();
let insertMessages = new Map(); // slug -> message string
const cardState = new Map(); // slug -> { values: Map }

init();

async function init() {
  await loadSettings();
  applySettingsToUI();
  wireTopModeSwitch();
  wirePromptsControls();
  wireExportControls();
  showTopMode(settings.topMode);
  loadPromptsData();

  if (settings.topMode === 'export') {
    await runScrape(includeReasoningEl.checked);
  }
}

function applySettingsToUI() {
  tfSelect.value = settings.timeframe;
  cmpSelect.value = settings.comparison;
  includeReasoningEl.checked = settings.includeReasoning;
  trimFollowupsEl.checked = settings.trimFollowups;
  document.querySelector(`input[name="topMode"][value="${settings.topMode}"]`).checked = true;
}

// ---------------------------------------------------------------------------
// Top-level mode switch
// ---------------------------------------------------------------------------

function wireTopModeSwitch() {
  topModeRadios.forEach((radio) => {
    radio.addEventListener('change', async () => {
      settings.topMode = radio.value;
      saveSettings();
      showTopMode(settings.topMode);
      if (settings.topMode === 'export' && !scrapeResult) {
        await runScrape(includeReasoningEl.checked);
      }
    });
  });
}

function showTopMode(mode) {
  promptsModeEl.hidden = mode !== 'prompts';
  exportModeEl.hidden = mode !== 'export';
}

// ---------------------------------------------------------------------------
// Prompts mode — data loading
// ---------------------------------------------------------------------------

function isValidPayload(data) {
  if (!data || !Array.isArray(data.prompts)) return false;
  return data.prompts.every(p =>
    typeof p.slug === 'string' && p.slug &&
    typeof p.title === 'string' && p.title &&
    typeof p.category === 'string' && p.category &&
    typeof p.body === 'string' && p.body &&
    Array.isArray(p.placeholders)
  );
}

async function loadPromptsData() {
  let cached = null;
  try {
    const stored = await chrome.storage.local.get(CACHE_KEY);
    if (stored[CACHE_KEY] && isValidPayload(stored[CACHE_KEY])) {
      cached = stored[CACHE_KEY];
    }
  } catch (e) {}

  if (cached) {
    loadedPrompts = cached.prompts;
    buildCategoryChips();
    renderPromptsList();
  } else {
    renderSkeleton();
  }

  let remoteFetched = false;
  try {
    const res = await fetch(PROMPTS_URL, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (isValidPayload(data)) {
        const isNew = !cached || data.updated !== cached.updated || data.count !== cached.count;
        if (isNew) {
          await chrome.storage.local.set({ [CACHE_KEY]: data });
          loadedPrompts = data.prompts;
          buildCategoryChips();
          renderPromptsList();
        }
        remoteFetched = true;
      }
    }
  } catch (e) {}

  if (!remoteFetched && !cached) {
    try {
      const res = await fetch(chrome.runtime.getURL('prompts.json'));
      if (res.ok) {
        const data = await res.json();
        if (isValidPayload(data)) {
          await chrome.storage.local.set({ [CACHE_KEY]: data });
          loadedPrompts = data.prompts;
          buildCategoryChips();
          renderPromptsList();
        }
      }
    } catch (e) {}
  }
}

function renderSkeleton() {
  promptsCountEl.textContent = '';
  promptsListEl.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const skel = document.createElement('div');
    skel.className = 'prompt-skeleton';
    promptsListEl.appendChild(skel);
  }
}

// ---------------------------------------------------------------------------
// Prompts mode — category chips
// ---------------------------------------------------------------------------

function buildCategoryChips() {
  catChipsEl.innerHTML = '';
  const cats = ['All', ...[...new Set(loadedPrompts.map(p => p.category))].sort()];

  for (const cat of cats) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cat-chip' + (cat === settings.category ? ' cat-chip-active' : '');
    btn.dataset.cat = cat;
    const count = cat === 'All'
      ? loadedPrompts.length
      : loadedPrompts.filter(p => p.category === cat).length;
    btn.textContent = `${cat} (${count})`;
    btn.addEventListener('click', () => {
      settings.category = cat;
      saveSettings();
      updateCategoryChips();
      renderPromptsList();
    });
    catChipsEl.appendChild(btn);
  }
}

function updateCategoryChips() {
  const search = searchInput.value.trim().toLowerCase();
  catChipsEl.querySelectorAll('.cat-chip').forEach(btn => {
    const cat = btn.dataset.cat;
    btn.classList.toggle('cat-chip-active', cat === settings.category);
    const count = loadedPrompts.filter(p => {
      if (cat !== 'All' && p.category !== cat) return false;
      if (search && !p.title.toLowerCase().includes(search) && !(p.description || '').toLowerCase().includes(search)) return false;
      return true;
    }).length;
    btn.textContent = `${cat} (${count})`;
  });
}

function wirePromptsControls() {
  tfSelect.addEventListener('change', () => {
    settings.timeframe = tfSelect.value;
    saveSettings();
    renderPromptsList();
  });
  cmpSelect.addEventListener('change', () => {
    settings.comparison = cmpSelect.value;
    saveSettings();
    renderPromptsList();
  });
  searchInput.addEventListener('input', () => {
    updateCategoryChips();
    renderPromptsList();
  });
}

function getFilteredPrompts() {
  const search = searchInput.value.trim().toLowerCase();
  return loadedPrompts.filter(p => {
    if (settings.category !== 'All' && p.category !== settings.category) return false;
    if (search && !p.title.toLowerCase().includes(search) && !(p.description || '').toLowerCase().includes(search)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Prompts mode — list rendering
// ---------------------------------------------------------------------------

function renderPromptsList() {
  const filtered = getFilteredPrompts();
  promptsCountEl.textContent = `Showing ${filtered.length} prompt${filtered.length === 1 ? '' : 's'}`;
  promptsListEl.innerHTML = '';

  for (const p of filtered) {
    const row = document.createElement('div');
    row.className = 'prompt-row';
    row.dataset.slug = p.slug;

    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'prompt-row-header';

    const titleEl = document.createElement('div');
    titleEl.className = 'prompt-title';
    titleEl.textContent = p.title;

    const descEl = document.createElement('div');
    descEl.className = 'prompt-desc';
    descEl.textContent = p.description || '';

    const badgesEl = document.createElement('div');
    badgesEl.className = 'prompt-badges';
    const catBadge = document.createElement('span');
    catBadge.className = 'badge badge-cat';
    catBadge.textContent = p.category;
    badgesEl.appendChild(catBadge);
    if (p.featured) {
      const star = document.createElement('span');
      star.className = 'badge badge-featured';
      star.textContent = 'Featured';
      badgesEl.appendChild(star);
    }

    header.appendChild(titleEl);
    header.appendChild(descEl);
    header.appendChild(badgesEl);
    header.addEventListener('click', () => {
      if (openPromptSlugs.has(p.slug)) {
        openPromptSlugs.delete(p.slug);
      } else {
        openPromptSlugs.add(p.slug);
      }
      renderPromptsList();
    });

    row.appendChild(header);

    if (openPromptSlugs.has(p.slug)) {
      row.appendChild(renderExpandedPrompt(p));
    }

    promptsListEl.appendChild(row);
  }

  updateCategoryChips();
}

function buildPreviewText(template, values) {
  let text = template;
  values.forEach((val, token) => {
    if (val) text = text.split(token).join(val);
  });
  return text;
}

function validateBeforeAction(wrap) {
  const inputs = wrap.querySelectorAll('.placeholder-input');
  let valid = true;
  inputs.forEach(input => {
    if (!input.value.trim()) {
      input.classList.add('input-error');
      valid = false;
    } else {
      input.classList.remove('input-error');
    }
  });
  const validationMsg = wrap.querySelector('.validation-msg');
  if (!valid) {
    validationMsg.textContent = 'Fill in the highlighted fields before continuing.';
    validationMsg.hidden = false;
    return null;
  }
  const previewTA = wrap.querySelector('.prompt-preview-textarea');
  const text = previewTA ? previewTA.value : '';
  if (/\[[^\]]+\]/.test(text) || /\{\{[^}]+\}\}/.test(text)) {
    validationMsg.textContent = 'Fill in all placeholder fields before continuing.';
    validationMsg.hidden = false;
    return null;
  }
  validationMsg.hidden = true;
  return text;
}

function renderExpandedPrompt(p) {
  const template = buildPrompt(p, settings.timeframe, settings.comparison);

  if (!cardState.has(p.slug)) {
    cardState.set(p.slug, { values: new Map() });
  }
  const state = cardState.get(p.slug);

  const wrap = document.createElement('div');
  wrap.className = 'prompt-expanded';

  // Placeholder inputs
  let previewTA = null;

  if (p.placeholders && p.placeholders.length > 0) {
    const inputsSection = document.createElement('div');
    inputsSection.className = 'placeholder-inputs';

    for (const token of p.placeholders) {
      const label = token.replace(/^\[|\]$/g, '');
      const group = document.createElement('div');
      group.className = 'placeholder-group';

      const labelEl = document.createElement('label');
      labelEl.className = 'placeholder-label';
      labelEl.textContent = label;

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'placeholder-input';
      input.dataset.token = token;
      input.value = state.values.get(token) || '';
      input.placeholder = label;

      input.addEventListener('input', () => {
        input.classList.remove('input-error');
        state.values.set(token, input.value);
        if (previewTA) previewTA.value = buildPreviewText(template, state.values);
      });

      group.appendChild(labelEl);
      group.appendChild(input);
      inputsSection.appendChild(group);
    }

    wrap.appendChild(inputsSection);
  }

  // Editable preview textarea
  previewTA = document.createElement('textarea');
  previewTA.className = 'prompt-preview-textarea';
  previewTA.spellcheck = false;
  previewTA.value = buildPreviewText(template, state.values);
  wrap.appendChild(previewTA);

  // Validation message
  const validationMsg = document.createElement('p');
  validationMsg.className = 'validation-msg';
  validationMsg.hidden = true;
  wrap.appendChild(validationMsg);

  // Actions
  const actionsRow = document.createElement('div');
  actionsRow.className = 'prompt-actions-row';

  const insertBtn = document.createElement('button');
  insertBtn.type = 'button';
  insertBtn.className = 'btn-primary';
  insertBtn.textContent = 'Insert';
  insertBtn.addEventListener('click', () => {
    const text = validateBeforeAction(wrap);
    if (text === null) return;
    onInsertPrompt(p.slug, text);
  });

  const copyBtnEl = document.createElement('button');
  copyBtnEl.type = 'button';
  copyBtnEl.className = 'btn-outline';
  copyBtnEl.textContent = 'Copy';
  copyBtnEl.addEventListener('click', () => {
    const text = validateBeforeAction(wrap);
    if (text === null) return;
    onCopyPrompt(p.slug, text);
  });

  actionsRow.appendChild(insertBtn);
  actionsRow.appendChild(copyBtnEl);
  wrap.appendChild(actionsRow);

  const msg = insertMessages.get(p.slug);
  if (msg) {
    const msgEl = document.createElement('p');
    msgEl.className = 'prompt-insert-msg';
    msgEl.textContent = msg;
    wrap.appendChild(msgEl);
  }

  // Follow-up link
  if (p.followUp) {
    const target = loadedPrompts.find(lp => lp.slug === p.followUp);
    if (target) {
      const row = document.createElement('p');
      row.className = 'follow-up-row';
      const link = document.createElement('a');
      link.href = '#';
      link.className = 'follow-up-link';
      link.textContent = `Suggested follow-up: ${target.title}`;
      link.addEventListener('click', e => {
        e.preventDefault();
        navigateToFollowUp(p.followUp);
      });
      row.appendChild(link);
      wrap.appendChild(row);
    }
  }

  return wrap;
}

function navigateToFollowUp(slug) {
  searchInput.value = '';
  settings.category = 'All';
  saveSettings();
  openPromptSlugs.add(slug);
  buildCategoryChips();
  renderPromptsList();

  const targetRow = promptsListEl.querySelector(`[data-slug="${slug}"]`);
  if (targetRow) {
    targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
    targetRow.classList.add('flash-highlight');
    setTimeout(() => targetRow.classList.remove('flash-highlight'), 1500);
  }
}

const SHOPIFY_TAB_PATTERN = /^https:\/\/(admin\.shopify\.com|[^/]+\.myshopify\.com)\//;

function insertIntoSidekick(text) {
  const ta = document.querySelector('textarea[name="sidekickMessage"]')
          || document.querySelector('#sidekick textarea')
          || document.querySelector('textarea[enterkeyhint="send"]');
  if (!ta) return { ok: false, reason: 'input-not-found' };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, text);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
  return { ok: true };
}

async function onInsertPrompt(slug, text) {
  insertMessages.delete(slug);

  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) {
    tab = null;
  }

  if (!tab || !tab.id || !tab.url || !SHOPIFY_TAB_PATTERN.test(tab.url)) {
    insertMessages.set(slug, 'Open Sidekick on this tab to insert');
    renderPromptsList();
    return;
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: insertIntoSidekick,
      args: [text],
    });
    const result = results && results[0] && results[0].result;
    if (!result || !result.ok) {
      insertMessages.set(slug, 'Open Sidekick on this tab to insert');
    } else {
      insertMessages.delete(slug);
    }
  } catch (e) {
    insertMessages.set(slug, 'Open Sidekick on this tab to insert');
  }
  renderPromptsList();
}

async function onCopyPrompt(slug, text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    // clipboard write failures are rare and not actionable here
  }
}

// ---------------------------------------------------------------------------
// Export mode (existing behaviour + enhancements)
// ---------------------------------------------------------------------------

function wireExportControls() {
  exportSubModeRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      currentExportSubMode = radio.value;
      onExportSubModeChange();
    });
  });

  exportSubViewRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      currentExportSubView = radio.value;
      onExportSubViewChange();
    });
  });

  includeReasoningEl.addEventListener('change', () => {
    settings.includeReasoning = includeReasoningEl.checked;
    saveSettings();
    runScrape(includeReasoningEl.checked);
  });

  trimFollowupsEl.addEventListener('change', () => {
    settings.trimFollowups = trimFollowupsEl.checked;
    saveSettings();
    updatePreview();
    updateTablesView();
  });

  rescanBtn.addEventListener('click', () => runScrape(includeReasoningEl.checked));
  errorRescanBtn.addEventListener('click', () => runScrape(includeReasoningEl.checked));
  copyBtn.addEventListener('click', onCopy);
  downloadBtn.addEventListener('click', onDownload);
  previewEl.addEventListener('input', updateCountReadout);
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
}

function showError(message, hint = '') {
  scanningEl.hidden = true;
  contentEl.hidden = true;
  errorStateEl.hidden = false;
  errorMsgEl.textContent = message;
  errorHintEl.textContent = hint;
  errorHintEl.hidden = !hint;
}

function onScrapeSuccess() {
  scanningEl.hidden = true;
  errorStateEl.hidden = true;
  contentEl.hidden = false;

  const exchanges = scrapeResult.exchanges || [];

  if (exchanges.length === 0) {
    showError(
      'No exchanges found yet.',
      'Send a message in Sidekick and then rescan.'
    );
    return;
  }

  allCountEl.textContent = `(${exchanges.length})`;

  currentExportSubMode = 'latest';
  selectedIndices = new Set();
  document.querySelector('input[name="exportSubMode"][value="latest"]').checked = true;

  onExportSubModeChange();
}

function onExportSubModeChange() {
  const exchanges = (scrapeResult && scrapeResult.exchanges) || [];
  const isCustom = currentExportSubMode === 'custom';

  contentEl.classList.toggle('custom-active', isCustom);
  customSelEl.hidden = !isCustom;

  if (isCustom) {
    if (selectedIndices.size === 0) {
      selectedIndices = new Set(exchanges.map(e => e.index));
    }
    renderExchangeList(exchanges);
  }

  updatePreview();
  updateTablesView();
}

function onExportSubViewChange() {
  markdownViewEl.hidden = currentExportSubView !== 'markdown';
  tablesViewEl.hidden = currentExportSubView !== 'tables';
  markdownActionsRowEl.hidden = currentExportSubView !== 'markdown';
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
      updateTablesView();
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

function getSelectedExchanges() {
  if (!scrapeResult) return [];
  const exchanges = scrapeResult.exchanges || [];

  if (currentExportSubMode === 'latest') {
    return exchanges.slice(-1);
  } else if (currentExportSubMode === 'all') {
    return [...exchanges];
  }
  return exchanges
    .filter(e => selectedIndices.has(e.index))
    .sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------------------
// Trim trailing Sidekick follow-up questions
// ---------------------------------------------------------------------------

const FOLLOWUP_PREFIXES = [
  'want me to', 'would you like', 'should i', 'do you want', 'let me know', 'i can also', 'want to',
];

function trimFollowupParagraph(markdown) {
  if (!markdown) return markdown;
  const paragraphs = markdown.split(/\n{2,}/);
  if (paragraphs.length === 0) return markdown;

  const last = paragraphs[paragraphs.length - 1].trim();
  if (!last.endsWith('?')) return markdown;

  const lower = last.toLowerCase();
  const matches = FOLLOWUP_PREFIXES.some((prefix) => lower.startsWith(prefix));
  if (!matches) return markdown;

  return paragraphs.slice(0, -1).join('\n\n').trim();
}

function getExchangeBody(exchange) {
  const body = exchange.markdown || '_(no assistant response captured)_';
  return trimFollowupsEl.checked ? trimFollowupParagraph(body) : body;
}

// ---------------------------------------------------------------------------
// Markdown preview
// ---------------------------------------------------------------------------

function buildMarkdown() {
  if (!scrapeResult) return '';

  const { title, storeHandle, url } = scrapeResult;
  const selected = getSelectedExchanges();

  const header = [
    `# ${title}`,
    `Source: ${url}`,
    `Store: ${storeHandle}`,
    `Exported: ${formatExportedTimestamp()}`,
  ].join('\n');

  const sections = selected.map((exchange) => {
    const heading = `## ${exchange.index}. ${truncate(exchange.userPrompt, 80)}`;
    const quoted = `> ${exchange.userPrompt.replace(/\n/g, '\n> ')}`;
    const body = getExchangeBody(exchange);
    return [heading, quoted, '', body].join('\n');
  });

  return [header, ...sections].join('\n\n---\n\n').trim() + '\n';
}

function updatePreview() {
  previewEl.value = buildMarkdown();
  updateCountReadout();
}

function updateCountReadout() {
  const text = previewEl.value || '';
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const tokensEst = Math.round(text.length / 4);
  countReadoutEl.textContent = `${words} word${words === 1 ? '' : 's'} · ~${tokensEst} token${tokensEst === 1 ? '' : 's'} (estimate)`;
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

// ---------------------------------------------------------------------------
// Tables sub-view + CSV export
// ---------------------------------------------------------------------------

function isTableRowLine(line) {
  return /^\s*\|.*\|\s*$/.test(line);
}
function isTableSeparatorLine(line) {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-');
}

function extractTablesFromExchange(exchange) {
  const body = getExchangeBody(exchange);
  const lines = body.split('\n');
  const tables = [];
  let currentHeading = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const headingMatch = line.match(/^#{1,6}\s+(.*)/);
    if (headingMatch) {
      currentHeading = headingMatch[1].trim();
      i++;
      continue;
    }

    if (isTableRowLine(line) && lines[i + 1] && isTableSeparatorLine(lines[i + 1])) {
      const tableLines = [line, lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && isTableRowLine(lines[j])) {
        tableLines.push(lines[j]);
        j++;
      }
      tables.push({
        label: currentHeading || `Prompt ${exchange.index}`,
        lines: tableLines,
      });
      i = j;
      continue;
    }

    i++;
  }

  return tables;
}

function parseTableLine(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function stripMarkdownEmphasis(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/_(.*?)_/g, '$1');
}

function csvEscapeField(field) {
  const needsQuoting = /[",\n]/.test(field);
  const escaped = field.replace(/"/g, '""');
  return needsQuoting ? `"${escaped}"` : escaped;
}

function tableToCsv(tableLines) {
  const rows = tableLines
    .filter((line, idx) => idx !== 1) // skip the --- separator row
    .map(parseTableLine)
    .map((cells) => cells.map((c) => stripMarkdownEmphasis(c)));

  return rows.map((row) => row.map(csvEscapeField).join(',')).join('\r\n');
}

function getAllTables() {
  const exchanges = getSelectedExchanges();
  const tables = [];
  for (const exchange of exchanges) {
    for (const t of extractTablesFromExchange(exchange)) {
      tables.push(t);
    }
  }
  return tables;
}

function updateTablesView() {
  const tables = getAllTables();
  tablesCountEl.textContent = tables.length ? `(${tables.length})` : '';
  tablesListEl.innerHTML = '';

  if (tables.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'tables-empty';
    empty.textContent = 'No tables found in the current selection.';
    tablesListEl.appendChild(empty);
    return;
  }

  tables.forEach((table, idx) => {
    const csv = tableToCsv(table.lines);

    const card = document.createElement('div');
    card.className = 'table-card';

    const labelEl = document.createElement('div');
    labelEl.className = 'table-card-label';
    labelEl.textContent = table.label;
    card.appendChild(labelEl);

    const tablePreviewEl = document.createElement('div');
    tablePreviewEl.className = 'table-card-preview';
    tablePreviewEl.textContent = table.lines.join('\n');
    card.appendChild(tablePreviewEl);

    const actionsRow = document.createElement('div');
    actionsRow.className = 'table-card-actions';

    const copyCsvBtn = document.createElement('button');
    copyCsvBtn.type = 'button';
    copyCsvBtn.className = 'btn-outline';
    copyCsvBtn.textContent = 'Copy CSV';
    copyCsvBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(csv);
        showActionStatus('Copied CSV to clipboard.', false);
      } catch (e) {
        showActionStatus('Could not copy CSV.', true);
      }
    });

    const downloadCsvBtn = document.createElement('button');
    downloadCsvBtn.type = 'button';
    downloadCsvBtn.className = 'btn-primary';
    downloadCsvBtn.textContent = 'Download CSV';
    downloadCsvBtn.addEventListener('click', () => {
      const store = scrapeResult ? slugify(scrapeResult.storeHandle) : 'sidekick';
      const labelSlug = slugify(table.label);
      const filename = `${store}-${labelSlug}-${formatExportedDateForFilename()}.csv`;
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showActionStatus(`Downloaded ${filename}`, false);
    });

    actionsRow.appendChild(copyCsvBtn);
    actionsRow.appendChild(downloadCsvBtn);
    card.appendChild(actionsRow);

    tablesListEl.appendChild(card);
  });
}
