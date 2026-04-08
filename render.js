(() => {
  function formatArticleTitle(articleName = '') {
    return String(articleName).replace(/_/g, ' ');
  }

  function buildWikipediaUrl(articleName = '') {
    const normalizedTitle = String(articleName).replaceAll(' ', '_');
    return `https://de.wikipedia.org/wiki/${encodeURIComponent(normalizedTitle)
      .replace(/%2F/g, '/')
      .replace(/%3A/g, ':')
      .replace(/%23/g, '#')}`;
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

  window.WikitextRenderer = Object.freeze({
    formatArticleTitle,
    buildWikipediaUrl,
    extractLeadWikitext,
    cleanLeadWikitext,
    renderLeadMarkup,
    buildLeadAnalysis
  });
})();
