const dayField = document.getElementById('dayField');
const monthField = document.getElementById('monthField');
const dayInput = document.getElementById('dayInput');
const monthInput = document.getElementById('monthInput');
const prevDayButton = document.getElementById('prevDay');
const nextDayButton = document.getElementById('nextDay');
const prevMonthButton = document.getElementById('prevMonth');
const nextMonthButton = document.getElementById('nextMonth');
const resultsBody = document.getElementById('resultsBody');
const statusText = document.getElementById('status');
const tableTitle = document.getElementById('tableTitle');
const EXCLUDED_PREFIXES = ['Wikipedia:', 'Spezial:', 'Datei:', 'Special:', 'Benutzer:'];
const EXCLUDED_ARTICLE_PATTERNS = [/^Nekrolog(?:[\s_(]|$)/i];
const WIKITEXT_CACHE_PREFIX = 'wikipedia-top100-wikitext:';
const LEAD_REQUEST_INTERVAL_MS = 1000;
const pendingLeadTasks = [];
const inFlightLeadRequests = new Map();
let currentMode = 'month';
let currentRenderToken = 0;
let isLeadQueueRunning = false;
let lastLeadRequestAt = 0;

function formatDateValue(date) {
  return date.toISOString().slice(0, 10);
}

function formatMonthValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function getWikitextCacheKey(articleName) {
  return `${WIKITEXT_CACHE_PREFIX}${articleName}`;
}

function readCachedWikitext(articleName) {
  try {
    const cachedValue = localStorage.getItem(getWikitextCacheKey(articleName));

    if (!cachedValue) {
      return null;
    }

    const parsed = JSON.parse(cachedValue);
    return typeof parsed?.wikitext === 'string' ? parsed.wikitext : null;
  } catch (error) {
    return null;
  }
}

function deleteCachedWikitext(articleName) {
  try {
    localStorage.removeItem(getWikitextCacheKey(articleName));
  } catch (error) {
    // Ignore storage access errors.
  }
}

function decodeHtmlEntities(value) {
  const textarea = document.createElement('textarea');
  textarea.innerHTML = value;
  return textarea.value;
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("'", '&#39;');
}

function findMatchingMarkupEnd(text, startIndex, openToken, closeToken) {
  if (!text.startsWith(openToken, startIndex)) {
    return -1;
  }

  let depth = 0;

  for (let index = startIndex; index < text.length;) {
    if (text.startsWith(openToken, index)) {
      depth += 1;
      index += openToken.length;
      continue;
    }

    if (text.startsWith(closeToken, index)) {
      depth -= 1;

      if (depth === 0) {
        return index;
      }

      index += closeToken.length;
      continue;
    }

    index += 1;
  }

  return -1;
}

function extractLeadWikitext(wikitext) {
  if (!wikitext) {
    return '';
  }

  const normalized = wikitext.replace(/\r\n/g, '\n');
  const leadLines = [];

  for (const line of normalized.split('\n')) {
    if (/^\s*=+\s*[^=].*?\s*=+\s*$/.test(line)) {
      break;
    }

    leadLines.push(line);
  }

  return leadLines.join('\n').trim();
}

function stripNestedTemplates(text) {
  let result = '';

  for (let index = 0; index < text.length;) {
    if (text.startsWith('{{', index)) {
      const endIndex = findMatchingMarkupEnd(text, index, '{{', '}}');

      if (endIndex === -1) {
        break;
      }

      index = endIndex + 2;
      continue;
    }

    result += text[index];
    index += 1;
  }

  return result;
}

function stripMediaLinks(text) {
  let result = '';

  for (let index = 0; index < text.length;) {
    if (text.startsWith('[[', index)) {
      const endIndex = findMatchingMarkupEnd(text, index, '[[', ']]');

      if (endIndex === -1) {
        result += text.slice(index);
        break;
      }

      const content = text.slice(index + 2, endIndex).trim();

      if (/^(Datei|File|Bild|Image|Kategorie|Category):/i.test(content)) {
        index = endIndex + 2;
        continue;
      }

      result += text.slice(index, endIndex + 2);
      index = endIndex + 2;
      continue;
    }

    result += text[index];
    index += 1;
  }

  return result;
}

function cleanLeadWikitext(wikitext) {
  let cleaned = extractLeadWikitext(wikitext)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<ref\b[^>]*\/>/gi, '')
    .replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/__TOC__|__NOTOC__|__FORCETOC__|__INHALTSVERZEICHNIS_ERZWINGEN__/gi, '');

  cleaned = stripNestedTemplates(cleaned);
  cleaned = stripMediaLinks(cleaned);
  cleaned = decodeHtmlEntities(cleaned);

  return cleaned
    .replace(/\[(https?:\/\/[^\s\]]+)\s+([^\]]+)\]/gi, '$2')
    .replace(/\[(https?:\/\/[^\]]+)\]/gi, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/^[:;*#]+\s*/gm, '')
    .replace(/[\u00A0\u202F\u2007]/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function renderInlineWikitext(text) {
  let html = '';

  for (let index = 0; index < text.length;) {
    if (text.startsWith("'''''", index)) {
      const endIndex = text.indexOf("'''''", index + 5);

      if (endIndex !== -1) {
        html += `<strong><em>${renderInlineWikitext(text.slice(index + 5, endIndex))}</em></strong>`;
        index = endIndex + 5;
        continue;
      }
    }

    if (text.startsWith("'''", index)) {
      const endIndex = text.indexOf("'''", index + 3);

      if (endIndex !== -1) {
        html += `<strong>${renderInlineWikitext(text.slice(index + 3, endIndex))}</strong>`;
        index = endIndex + 3;
        continue;
      }
    }

    if (text.startsWith("''", index)) {
      const endIndex = text.indexOf("''", index + 2);

      if (endIndex !== -1) {
        html += `<em>${renderInlineWikitext(text.slice(index + 2, endIndex))}</em>`;
        index = endIndex + 2;
        continue;
      }
    }

    if (text.startsWith('[[', index)) {
      const endIndex = findMatchingMarkupEnd(text, index, '[[', ']]');

      if (endIndex !== -1) {
        const rawContent = text.slice(index + 2, endIndex).trim();

        if (/^(Datei|File|Bild|Image|Kategorie|Category):/i.test(rawContent)) {
          index = endIndex + 2;
          continue;
        }

        let nextIndex = endIndex + 2;
        let suffix = '';

        while (nextIndex < text.length && /[0-9A-Za-zÀ-ÖØ-öø-ÿ-]/.test(text[nextIndex])) {
          suffix += text[nextIndex];
          nextIndex += 1;
        }

        const parts = rawContent.split('|');
        const target = (parts.shift() || '').trim();
        const labelSource = (parts.at(-1) || target).trim();
        const label = `${formatArticleTitle(labelSource)}${suffix}`;

        if (target) {
          html += `<a href="${escapeAttribute(buildWikipediaUrl(target))}" target="_blank" rel="noopener noreferrer">${renderInlineWikitext(label)}</a>`;
        } else {
          html += escapeHtml(label);
        }

        index = nextIndex;
        continue;
      }
    }

    html += escapeHtml(text[index]);
    index += 1;
  }

  return html;
}

function renderLeadMarkup(wikitext) {
  const cleanedLead = cleanLeadWikitext(wikitext);

  if (!cleanedLead) {
    return '';
  }

  return cleanedLead
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.split('\n').map((line) => line.trim()).filter(Boolean).join(' '))
    .filter(Boolean)
    .map((paragraph) => `<p>${renderInlineWikitext(paragraph)}</p>`)
    .join('');
}

function extractPlainTextFromHtml(html) {
  const temp = document.createElement('div');
  temp.innerHTML = html;

  return (temp.textContent || '')
    .replace(/[\u00A0\u202F\u2007]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildLeadAnalysis(wikitext) {
  const html = renderLeadMarkup(wikitext);
  const plainText = extractPlainTextFromHtml(html);

  return {
    html,
    plainText,
    characterCount: plainText.length,
    wordCount: plainText ? plainText.split(/\s+/u).length : 0
  };
}

function updateLeadStats(container, analysis = null, state = 'ready') {
  container.className = `lead-stats lead-${state}`;

  if (state !== 'ready' || !analysis) {
    container.textContent = state === 'error' ? 'Stats unavailable' : 'Counting…';
    return;
  }

  container.innerHTML = `
    <span><strong>${analysis.characterCount.toLocaleString('de-DE')}</strong> chars</span>
    <span><strong>${analysis.wordCount.toLocaleString('de-DE')}</strong> words</span>
  `;
}

function syncLeadOverflowState(container) {
  const leadCell = container.closest('.lead-cell');
  const isOverflowing = container.scrollHeight > container.clientHeight + 2;

  container.classList.toggle('is-overflowing', isOverflowing);

  if (leadCell) {
    leadCell.classList.toggle('lead-overflow', isOverflowing);
  }
}

function setReloadButtonState(button, isLoading) {
  if (!button) {
    return;
  }

  button.disabled = isLoading;
  button.textContent = isLoading ? '…' : '↻';
}

function reloadArticleLead(articleName, leadContainer, statsContainer, reloadButton, renderToken) {
  deleteCachedWikitext(articleName);
  updateLeadContent(leadContainer, 'Reloading lead section…', 'loading');
  updateLeadStats(statsContainer, null, 'loading');
  setReloadButtonState(reloadButton, true);
  queueLeadSectionLoad(articleName, leadContainer, renderToken, {
    statsContainer,
    reloadButton,
    forceRefresh: true,
    prioritize: true
  });
}

function writeCachedWikitext(articleName, wikitext) {
  const timestamp = new Date().toISOString();

  try {
    localStorage.setItem(
      getWikitextCacheKey(articleName),
      JSON.stringify({
        title: articleName,
        cachedAt: timestamp,
        wikitext
      })
    );
  } catch (error) {
    try {
      localStorage.setItem(
        getWikitextCacheKey(articleName),
        JSON.stringify({
          title: articleName,
          cachedAt: timestamp,
          wikitext: extractLeadWikitext(wikitext),
          partial: true
        })
      );
    } catch (storageError) {
      // Ignore storage quota errors.
    }
  }
}

function setDefaultDates() {
  const recentAvailableDay = new Date();
  recentAvailableDay.setDate(recentAvailableDay.getDate() - 7);

  const previousMonth = new Date();
  previousMonth.setMonth(previousMonth.getMonth() - 1, 1);

  dayInput.value = formatDateValue(recentAvailableDay);
  monthInput.value = formatMonthValue(previousMonth);
}

function setCurrentMode(mode) {
  currentMode = mode;
  dayField.classList.toggle('active', mode === 'day');
  monthField.classList.toggle('active', mode === 'month');
}

function updateNavigationState() {
  const today = formatDateValue(new Date());
  const lastCompleteMonth = new Date();
  lastCompleteMonth.setMonth(lastCompleteMonth.getMonth() - 1, 1);

  nextDayButton.disabled = dayInput.value >= today;
  nextMonthButton.disabled = monthInput.value >= formatMonthValue(lastCompleteMonth);
}

function shiftDayBy(amount) {
  const current = new Date(`${dayInput.value}T12:00:00`);
  current.setDate(current.getDate() + amount);
  dayInput.value = formatDateValue(current);
  setCurrentMode('day');
  updateNavigationState();
  loadStatistics('day');
}

function shiftMonthBy(amount) {
  const [year, month] = monthInput.value.split('-');
  const current = new Date(Number(year), Number(month) - 1, 1);
  current.setMonth(current.getMonth() + amount, 1);
  monthInput.value = formatMonthValue(current);
  setCurrentMode('month');
  updateNavigationState();
  loadStatistics('month');
}

function buildEndpoint(mode = currentMode) {
  if (mode === 'day') {
    const [year, month, day] = dayInput.value.split('-');
    return `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/de.wikipedia.org/all-access/${year}/${month}/${day}`;
  }

  const [year, month] = monthInput.value.split('-');
  return `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/de.wikipedia.org/all-access/${year}/${month}/all-days`;
}

function buildHeading(mode = currentMode) {
  if (mode === 'day') {
    const selectedDate = new Date(`${dayInput.value}T12:00:00`);
    return `Top 100 articles for ${selectedDate.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'long',
      year: 'numeric'
    })}`;
  }

  const [year, month] = monthInput.value.split('-');
  const selectedMonth = new Date(Number(year), Number(month) - 1, 1);
  return `Top 100 articles for ${selectedMonth.toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric'
  })}`;
}

function formatArticleTitle(articleName) {
  return articleName.replace(/_/g, ' ');
}

function isExcludedArticle(articleName) {
  const displayTitle = formatArticleTitle(articleName);

  return EXCLUDED_PREFIXES.some((prefix) => articleName.startsWith(prefix))
    || EXCLUDED_ARTICLE_PATTERNS.some((pattern) => pattern.test(displayTitle));
}

function buildWikipediaUrl(articleName) {
  const normalizedTitle = articleName.replaceAll(' ', '_');
  return `https://de.wikipedia.org/wiki/${encodeURIComponent(normalizedTitle)
    .replace(/%2F/g, '/')
    .replace(/%3A/g, ':')
    .replace(/%23/g, '#')}`;
}

function updateLeadContent(container, leadText, state = 'ready') {
  container.className = `lead-text lead-${state}`;

  if (state === 'ready') {
    const html = leadText.trim() || '<span class="lead-empty">No lead section found.</span>';
    container.innerHTML = html;
    requestAnimationFrame(() => syncLeadOverflowState(container));
    return;
  }

  container.textContent = leadText.trim() || 'No lead section found.';
  requestAnimationFrame(() => syncLeadOverflowState(container));
}

async function fetchArticleWikitext(articleName, options = {}) {
  const { forceRefresh = false } = options;
  const cachedWikitext = forceRefresh ? null : readCachedWikitext(articleName);

  if (cachedWikitext !== null) {
    return cachedWikitext;
  }

  if (inFlightLeadRequests.has(articleName)) {
    return inFlightLeadRequests.get(articleName);
  }

  const request = (async () => {
    const waitTime = Math.max(0, LEAD_REQUEST_INTERVAL_MS - (Date.now() - lastLeadRequestAt));

    if (waitTime > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    lastLeadRequestAt = Date.now();

    const endpoint = new URL('https://de.wikipedia.org/w/api.php');
    endpoint.search = new URLSearchParams({
      action: 'query',
      prop: 'revisions',
      titles: articleName,
      rvprop: 'content',
      rvslots: 'main',
      format: 'json',
      formatversion: '2',
      origin: '*'
    }).toString();

    const response = await fetch(endpoint);

    if (!response.ok) {
      throw new Error(`Lead request failed with status ${response.status}`);
    }

    const payload = await response.json();
    const wikitext = payload.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content ?? '';
    writeCachedWikitext(articleName, wikitext);
    return wikitext;
  })().finally(() => {
    inFlightLeadRequests.delete(articleName);
  });

  inFlightLeadRequests.set(articleName, request);
  return request;
}

function queueLeadSectionLoad(articleName, leadContainer, renderToken, options = {}) {
  const task = {
    articleName,
    leadContainer,
    renderToken,
    forceRefresh: options.forceRefresh ?? false,
    prioritize: options.prioritize ?? false,
    statsContainer: options.statsContainer ?? null,
    reloadButton: options.reloadButton ?? null
  };

  if (task.prioritize) {
    pendingLeadTasks.unshift(task);
  } else {
    pendingLeadTasks.push(task);
  }

  processLeadQueue();
}

async function processLeadQueue() {
  if (isLeadQueueRunning) {
    return;
  }

  isLeadQueueRunning = true;

  while (pendingLeadTasks.length > 0) {
    const task = pendingLeadTasks.shift();

    if (!task || task.renderToken !== currentRenderToken) {
      continue;
    }

    try {
      setReloadButtonState(task.reloadButton, true);
      const wikitext = await fetchArticleWikitext(task.articleName, { forceRefresh: task.forceRefresh });

      if (task.renderToken !== currentRenderToken) {
        continue;
      }

      const analysis = buildLeadAnalysis(wikitext);
      updateLeadContent(task.leadContainer, analysis.html);
      updateLeadStats(task.statsContainer, analysis);
    } catch (error) {
      if (task.renderToken !== currentRenderToken) {
        continue;
      }

      updateLeadContent(task.leadContainer, 'Lead section unavailable.', 'error');
      updateLeadStats(task.statsContainer, null, 'error');
    } finally {
      setReloadButtonState(task.reloadButton, false);
    }
  }

  isLeadQueueRunning = false;
}

function renderRows(articles) {
  resultsBody.innerHTML = '';
  pendingLeadTasks.length = 0;
  const renderToken = ++currentRenderToken;

  const topHundred = articles
    .filter((entry) => !isExcludedArticle(entry.article || ''))
    .slice(0, 100);

  if (!topHundred.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.className = 'empty-state';
    cell.textContent = 'No data was returned for this selection.';
    row.append(cell);
    resultsBody.append(row);
    return;
  }

  topHundred.forEach((entry, index) => {
    const row = document.createElement('tr');

    const rankCell = document.createElement('td');
    rankCell.textContent = String(index + 1);

    const titleCell = document.createElement('td');
    const link = document.createElement('a');
    link.href = buildWikipediaUrl(entry.article);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = formatArticleTitle(entry.article);
    titleCell.append(link);

    const viewsCell = document.createElement('td');
    viewsCell.textContent = Number(entry.views || 0).toLocaleString('de-DE');

    const leadCell = document.createElement('td');
    leadCell.className = 'lead-cell';
    const leadContent = document.createElement('div');

    const statsCell = document.createElement('td');
    statsCell.className = 'stats-cell';
    const statsContent = document.createElement('div');
    const reloadButton = document.createElement('button');
    reloadButton.type = 'button';
    reloadButton.className = 'reload-button';
    reloadButton.title = `Reload lead section for ${formatArticleTitle(entry.article)}`;
    reloadButton.setAttribute('aria-label', `Reload lead section for ${formatArticleTitle(entry.article)}`);
    reloadButton.textContent = '↻';
    reloadButton.addEventListener('click', () => {
      reloadArticleLead(entry.article, leadContent, statsContent, reloadButton, renderToken);
    });

    const cachedWikitext = readCachedWikitext(entry.article);

    if (cachedWikitext !== null) {
      const analysis = buildLeadAnalysis(cachedWikitext);
      updateLeadContent(leadContent, analysis.html);
      updateLeadStats(statsContent, analysis);
      setReloadButtonState(reloadButton, false);
    } else {
      leadContent.className = 'lead-text lead-loading';
      leadContent.textContent = 'Loading lead section…';
      updateLeadStats(statsContent, null, 'loading');
      setReloadButtonState(reloadButton, true);
      queueLeadSectionLoad(entry.article, leadContent, renderToken, {
        statsContainer: statsContent,
        reloadButton
      });
    }

    leadCell.append(leadContent);
    statsCell.append(statsContent, reloadButton);
    row.append(rankCell, titleCell, viewsCell, leadCell, statsCell);
    resultsBody.append(row);
  });
}

async function loadStatistics(mode = currentMode) {
  setCurrentMode(mode);

  const hasDay = mode === 'day' && dayInput.value;
  const hasMonth = mode === 'month' && monthInput.value;

  if (!hasDay && !hasMonth) {
    statusText.textContent = 'Please choose a valid day or month.';
    return;
  }

  const endpoint = buildEndpoint(mode);
  tableTitle.textContent = buildHeading(mode);
  statusText.textContent = 'Loading data…';

  try {
    const response = await fetch(endpoint);

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error('No data is available yet for that selection. Try an earlier day or month.');
      }

      throw new Error(`Request failed with status ${response.status}`);
    }

    const payload = await response.json();
    const articles = payload.items?.[0]?.articles ?? [];
    const filteredCount = articles.filter((entry) => !isExcludedArticle(entry.article || '')).length;
    renderRows(articles);
    statusText.textContent = `Loaded ${Math.min(100, filteredCount)} entries. Lead sections now fill in gradually and are cached in your browser.`;
  } catch (error) {
    resultsBody.innerHTML = `
      <tr>
        <td colspan="5" class="empty-state">Could not load data from Wikimedia.</td>
      </tr>
    `;
    statusText.textContent = error.message;
  }
}

dayInput.addEventListener('focus', () => setCurrentMode('day'));
monthInput.addEventListener('focus', () => setCurrentMode('month'));

dayInput.addEventListener('change', () => {
  setCurrentMode('day');
  updateNavigationState();
  loadStatistics('day');
});

monthInput.addEventListener('change', () => {
  setCurrentMode('month');
  updateNavigationState();
  loadStatistics('month');
});

prevDayButton.addEventListener('click', () => shiftDayBy(-1));
nextDayButton.addEventListener('click', () => shiftDayBy(1));
prevMonthButton.addEventListener('click', () => shiftMonthBy(-1));
nextMonthButton.addEventListener('click', () => shiftMonthBy(1));

setDefaultDates();
setCurrentMode('month');
updateNavigationState();
loadStatistics('month');
