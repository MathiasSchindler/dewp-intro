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
const minWordsInput = document.getElementById('minWordsInput');
const maxWordsInput = document.getElementById('maxWordsInput');
const wordRangeLabel = document.getElementById('wordRangeLabel');
const wordRangeFill = document.getElementById('wordRangeFill');
const wordFilterResult = document.getElementById('wordFilterResult');
const resetWordFilterButton = document.getElementById('resetWordFilter');
const EXCLUDED_PREFIXES = ['Wikipedia:', 'Spezial:', 'Datei:', 'Special:', 'Benutzer:'];
const EXCLUDED_ARTICLE_PATTERNS = [
  /^Nekrolog(?:[\s_(]|$)/i,
  /^Hauptseite$/i
];
const WIKITEXT_CACHE_PREFIX = 'wikipedia-top100-wikitext:';
const LEAD_REQUEST_INTERVAL_MS = 1000;
const pendingLeadTasks = [];
const inFlightLeadRequests = new Map();
let currentMode = 'month';
let currentRenderToken = 0;
let isLeadQueueRunning = false;
let lastLeadRequestAt = 0;
const WORD_FILTER_FALLBACK_MAX = 100;
let currentWordFilterMax = WORD_FILTER_FALLBACK_MAX;

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

const renderer = window.WikitextRenderer;

if (!renderer) {
  throw new Error('render.js konnte nicht geladen werden.');
}

const {
  formatArticleTitle,
  buildWikipediaUrl,
  extractLeadWikitext,
  buildLeadAnalysis
} = renderer;

function getArticleRows() {
  return Array.from(resultsBody.querySelectorAll('tr[data-article-row="true"]'));
}

function formatWordBound(value) {
  return value === Infinity ? '∞' : Number(value).toLocaleString('de-DE');
}

function getWordFilterState() {
  const min = Number(minWordsInput.value || 0);
  const upperValue = Number(maxWordsInput.value || currentWordFilterMax);

  return {
    min,
    upperValue,
    max: upperValue >= currentWordFilterMax ? Infinity : upperValue,
    isDefault: min === 0 && upperValue >= currentWordFilterMax
  };
}

function updateWordFilterSummary(visibleCount, totalCount, waitingCount, isDefault) {
  if (!totalCount) {
    wordFilterResult.textContent = 'Noch keine Artikel geladen.';
    return;
  }

  if (isDefault) {
    wordFilterResult.textContent = `Alle ${totalCount} Artikel sichtbar`;
    return;
  }

  if (waitingCount > 0) {
    wordFilterResult.textContent = `${visibleCount} Treffer · ${waitingCount} Artikel werden noch gezählt`;
    return;
  }

  wordFilterResult.textContent = `${visibleCount} Treffer im gewählten Bereich`;
}

function applyWordFilter() {
  const { min, max, isDefault } = getWordFilterState();
  const articleRows = getArticleRows();
  let visibleCount = 0;
  let waitingCount = 0;

  for (const row of articleRows) {
    const wordCount = Number(row.dataset.wordCount);
    const hasWordCount = Number.isFinite(wordCount);

    if (!hasWordCount) {
      waitingCount += 1;
    }

    const matches = isDefault || (hasWordCount && wordCount >= min && wordCount <= max);
    row.hidden = !matches;

    if (matches) {
      visibleCount += 1;
    }
  }

  updateWordFilterSummary(visibleCount, articleRows.length, waitingCount, isDefault);
}

function syncWordFilterUi() {
  let minValue = Number(minWordsInput.value || 0);
  let maxValue = Number(maxWordsInput.value || currentWordFilterMax);

  if (minValue > maxValue) {
    minValue = maxValue;
    minWordsInput.value = String(minValue);
  }

  const upperLabel = maxValue >= currentWordFilterMax ? '∞' : formatWordBound(maxValue);
  wordRangeLabel.textContent = `${formatWordBound(minValue)} bis ${upperLabel} Wörter`;
  resetWordFilterButton.disabled = minValue === 0 && maxValue >= currentWordFilterMax;

  const minPercent = currentWordFilterMax === 0 ? 0 : (minValue / currentWordFilterMax) * 100;
  const maxPercent = currentWordFilterMax === 0 ? 100 : (maxValue / currentWordFilterMax) * 100;
  wordRangeFill.style.left = `${minPercent}%`;
  wordRangeFill.style.right = `${100 - maxPercent}%`;

  applyWordFilter();
}

function updateWordFilterRange(nextWordCount = 0) {
  const nextLimit = Math.max(
    WORD_FILTER_FALLBACK_MAX,
    Math.ceil(Number(nextWordCount || 0) / 25) * 25
  );

  if (nextLimit <= currentWordFilterMax) {
    return;
  }

  const previousMax = currentWordFilterMax;
  const currentUpper = Number(maxWordsInput.value || previousMax);
  const upperWasOpen = currentUpper >= previousMax;

  currentWordFilterMax = nextLimit;
  minWordsInput.max = String(nextLimit);
  maxWordsInput.max = String(nextLimit);

  if (upperWasOpen || !maxWordsInput.value) {
    maxWordsInput.value = String(nextLimit);
  } else if (currentUpper > nextLimit) {
    maxWordsInput.value = String(nextLimit);
  }

  if (Number(minWordsInput.value) > nextLimit) {
    minWordsInput.value = String(nextLimit);
  }

  syncWordFilterUi();
}

function setRowWordCount(row, wordCount) {
  if (!row) {
    return;
  }

  row.dataset.wordCount = String(wordCount);
  updateWordFilterRange(wordCount);
  applyWordFilter();
}

function updateLeadStats(container, analysis = null, state = 'ready') {
  container.className = `lead-stats lead-${state}`;

  if (state !== 'ready' || !analysis) {
    container.textContent = state === 'error' ? 'Statistik nicht verfügbar' : 'Wird gezählt…';
    return;
  }

  container.innerHTML = `
    <span><strong>${analysis.characterCount.toLocaleString('de-DE')}</strong> Zeichen</span>
    <span><strong>${analysis.wordCount.toLocaleString('de-DE')}</strong> Wörter</span>
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
  updateLeadContent(leadContainer, 'Einleitung wird neu geladen…', 'loading');
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
    return selectedDate.toLocaleDateString('de-DE', {
      day: '2-digit',
      month: 'long',
      year: 'numeric'
    });
  }

  const [year, month] = monthInput.value.split('-');
  const selectedMonth = new Date(Number(year), Number(month) - 1, 1);
  return selectedMonth.toLocaleDateString('de-DE', {
    month: 'long',
    year: 'numeric'
  });
}

function isExcludedArticle(articleName) {
  const displayTitle = formatArticleTitle(articleName);

  return EXCLUDED_PREFIXES.some((prefix) => articleName.startsWith(prefix))
    || EXCLUDED_ARTICLE_PATTERNS.some((pattern) => pattern.test(displayTitle));
}

function updateLeadContent(container, leadText, state = 'ready') {
  container.className = `lead-text lead-${state}`;

  if (state === 'ready') {
    const html = leadText.trim() || '<span class="lead-empty">Keine Einleitung gefunden.</span>';
    container.innerHTML = html;
    requestAnimationFrame(() => syncLeadOverflowState(container));
    return;
  }

  container.textContent = leadText.trim() || 'Keine Einleitung gefunden.';
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
      throw new Error(`Abruf der Einleitung mit Status ${response.status} fehlgeschlagen`);
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
      const row = task.leadContainer.closest('tr[data-article-row="true"]');
      updateLeadContent(task.leadContainer, analysis.html);
      updateLeadStats(task.statsContainer, analysis);
      setRowWordCount(row, analysis.wordCount);
    } catch (error) {
      if (task.renderToken !== currentRenderToken) {
        continue;
      }

      updateLeadContent(task.leadContainer, 'Einleitung nicht verfügbar.', 'error');
      updateLeadStats(task.statsContainer, null, 'error');
      applyWordFilter();
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
    cell.textContent = 'Für diese Auswahl wurden keine Daten zurückgegeben.';
    row.append(cell);
    resultsBody.append(row);
    applyWordFilter();
    return;
  }

  topHundred.forEach((entry, index) => {
    const row = document.createElement('tr');
    row.dataset.articleRow = 'true';

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
    reloadButton.title = `Einleitung für ${formatArticleTitle(entry.article)} neu laden`;
    reloadButton.setAttribute('aria-label', `Einleitung für ${formatArticleTitle(entry.article)} neu laden`);
    reloadButton.textContent = '↻';
    reloadButton.addEventListener('click', () => {
      reloadArticleLead(entry.article, leadContent, statsContent, reloadButton, renderToken);
    });

    const cachedWikitext = readCachedWikitext(entry.article);

    if (cachedWikitext !== null) {
      const analysis = buildLeadAnalysis(cachedWikitext);
      updateLeadContent(leadContent, analysis.html);
      updateLeadStats(statsContent, analysis);
      setRowWordCount(row, analysis.wordCount);
      setReloadButtonState(reloadButton, false);
    } else {
      leadContent.className = 'lead-text lead-loading';
      leadContent.textContent = 'Einleitung wird geladen…';
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

  applyWordFilter();
}

async function loadStatistics(mode = currentMode) {
  setCurrentMode(mode);

  const hasDay = mode === 'day' && dayInput.value;
  const hasMonth = mode === 'month' && monthInput.value;

  if (!hasDay && !hasMonth) {
    statusText.textContent = 'Bitte wählen Sie einen gültigen Tag oder Monat.';
    return;
  }

  const endpoint = buildEndpoint(mode);
  tableTitle.textContent = buildHeading(mode);
  statusText.textContent = 'Einträge werden geladen…';

  try {
    const response = await fetch(endpoint);

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error('Für diese Auswahl sind noch keine Daten verfügbar. Versuchen Sie einen früheren Tag oder Monat.');
      }

      throw new Error(`Anfrage mit Status ${response.status} fehlgeschlagen`);
    }

    const payload = await response.json();
    const articles = payload.items?.[0]?.articles ?? [];
    const filteredCount = articles.filter((entry) => !isExcludedArticle(entry.article || '')).length;
    renderRows(articles);
    statusText.textContent = `${Math.min(100, filteredCount)} Einträge geladen · Einleitungen werden ergänzt.`;
  } catch (error) {
    resultsBody.innerHTML = `
      <tr>
        <td colspan="5" class="empty-state">Daten von Wikimedia konnten nicht geladen werden.</td>
      </tr>
    `;
    statusText.textContent = error.message;
    applyWordFilter();
  }
}

minWordsInput.addEventListener('input', () => {
  if (Number(minWordsInput.value) > Number(maxWordsInput.value)) {
    maxWordsInput.value = minWordsInput.value;
  }

  syncWordFilterUi();
});

maxWordsInput.addEventListener('input', () => {
  if (Number(maxWordsInput.value) < Number(minWordsInput.value)) {
    minWordsInput.value = maxWordsInput.value;
  }

  syncWordFilterUi();
});

resetWordFilterButton.addEventListener('click', () => {
  minWordsInput.value = '0';
  maxWordsInput.value = String(currentWordFilterMax);
  syncWordFilterUi();
});

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
syncWordFilterUi();
setCurrentMode('month');
updateNavigationState();
loadStatistics('month');
