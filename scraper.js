// scraper.js
//
// Injected into the active Shopify admin tab (after parser.js, in the same
// classic-script world) by popup.js via chrome.scripting.executeScript.
// Finds the Sidekick conversation, forces any lazily-rendered turns to
// mount, then extracts exchanges by selecting user messages and answer
// articles together (so they come back in document order regardless of
// exact nesting) and interleaving them. Returns a single result object
// (the resolved value of the async IIFE below becomes the executeScript
// result).

(async function scrapeSidekick() {
  const origin = window.location.origin;
  const includeReasoningLabels = Boolean(window.__sidekickIncludeReasoning);

  const root = qsAny(document, SELECTORS.root);
  if (!root) {
    return { ok: false, error: 'not_found' };
  }

  const log = qsAny(root, SELECTORS.log) || qsAny(document, SELECTORS.log) || root;

  await forceRenderAllTurns(log);
  stripNoise(log);

  const title = getConversationTitle(root);
  const storeHandle = getStoreHandle(window.location.href);

  const exchanges = extractExchanges(log, origin, includeReasoningLabels);

  return {
    ok: true,
    title,
    storeHandle,
    url: window.location.href,
    exchanges,
  };

  // -- helpers (scoped to this IIFE) ----------------------------------------

  async function forceRenderAllTurns(logEl) {
    const originalScrollTop = logEl.scrollTop;
    const steps = 8;
    for (let i = 0; i <= steps; i += 1) {
      const target = (logEl.scrollHeight * i) / steps;
      logEl.scrollTop = target;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    logEl.scrollTop = originalScrollTop;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  function getConversationTitle(rootEl) {
    const titleButton = qs(rootEl, SELECTORS.conversationTitleButton);
    if (titleButton) {
      const heading = qs(titleButton, SELECTORS.conversationTitleHeading);
      const text = cleanText((heading || titleButton).textContent);
      if (text) return text;
    }
    const fallbackHeading = qs(rootEl, SELECTORS.headerHeadingFallback);
    if (fallbackHeading) {
      const text = cleanText(fallbackHeading.textContent);
      if (text) return text;
    }
    return 'Sidekick conversation';
  }

  function getStoreHandle(url) {
    const match = /\/store\/([^/?#]+)/.exec(url);
    return match ? match[1] : '';
  }

  function getReasoningLabel(groupEl) {
    const labelEl = qs(groupEl, SELECTORS.reasoningGroupLabel);
    const text = labelEl ? cleanText(labelEl.textContent) : cleanText(groupEl.textContent);
    return text;
  }

  // Select user messages and answer articles together so they come back in
  // document order, then interleave them into exchanges. This does not
  // assume the answer is nested inside the user turn, nor any fixed
  // sibling/depth relationship between the two — only that they appear in
  // the log in document order, which the live Sidekick DOM guarantees.
  function extractExchanges(logEl, pageOrigin, includeReasoning) {
    const userSelector = '[data-message-role="user"]';
    const articleSelector = '[data-item-type="content"] article';
    const groupSelector = '[data-item-type="group"]';

    const selectorParts = [userSelector, articleSelector];
    if (includeReasoning) selectorParts.push(groupSelector);

    const nodes = logEl.querySelectorAll(selectorParts.join(', '));

    // Quick self-check: confirms both user turns and answer articles were
    // actually found in the live DOM (rather than e.g. selector mismatch
    // silently returning zero of one kind).
    const userCount = logEl.querySelectorAll(userSelector).length;
    const articleCount = logEl.querySelectorAll(articleSelector).length;
    console.log('[Sidekick→Markdown] matched user nodes:', userCount, '| article nodes:', articleCount);

    const exchanges = [];
    let current = null;

    nodes.forEach((node) => {
      if (node.matches(userSelector)) {
        if (current) exchanges.push(current);
        const promptEl = qs(node, SELECTORS.userMessageContent);
        current = { userPrompt: cleanText((promptEl || node).textContent), parts: [] };
        return;
      }

      if (includeReasoning && node.matches(groupSelector)) {
        if (!current) current = { userPrompt: '', parts: [] };
        const label = getReasoningLabel(node);
        if (label) current.parts.push(`_${label}_`);
        return;
      }

      // Otherwise this is an answer <article> matched via articleSelector.
      if (!current) current = { userPrompt: '', parts: [] };
      const markdown = articleToMarkdown(node, pageOrigin);
      if (markdown && markdown.trim()) current.parts.push(markdown.trim());
    });

    if (current) exchanges.push(current);

    return exchanges.map((exchange, i) => ({
      index: i + 1,
      userPrompt: exchange.userPrompt,
      markdown: collapseBlankLines(exchange.parts.join('\n\n')).trim() || '_(no assistant response captured)_',
      isLatest: i === exchanges.length - 1,
    }));
  }
})();
