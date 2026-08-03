'use strict';

const { compileFilter } = require('./scriptSandbox');

const SEARCH_SCOPES = new Set([
  'url',
  'metadata',
  'requestHeaders',
  'requestBody',
  'responseHeaders',
  'responseBody',
]);

function searchableHeaders(headers) {
  return Object.entries(headers || {})
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');
}

function wildcardToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function domainMatches(host, pattern) {
  const value = String(pattern || '').trim().toLowerCase();
  if (!value) return true;
  let normalizedHost = String(host || '').trim().toLowerCase();
  if (normalizedHost.startsWith('[')) {
    const closingBracket = normalizedHost.indexOf(']');
    if (closingBracket > 0) normalizedHost = normalizedHost.slice(1, closingBracket);
  } else {
    normalizedHost = normalizedHost.replace(/:\d+$/, '');
  }
  if (!normalizedHost) return false;
  if (value.startsWith('*.')) {
    const suffix = value.slice(1);
    const bare = value.slice(2);
    return normalizedHost === bare || normalizedHost.endsWith(suffix);
  }
  if (value.includes('*')) return wildcardToRegExp(value).test(normalizedHost);
  return normalizedHost.includes(value);
}

function searchFields(entry) {
  return {
    url: `${entry.method || ''} ${entry.url || ''}\n${entry.host || ''}${entry.path || ''}`,
    metadata: [
      entry.method || '',
      entry.host || '',
      entry.path || '',
      String(entry.status ?? ''),
      entry.contentType || '',
      entry.protocol || '',
    ].join('\n'),
    requestHeaders: searchableHeaders(entry.requestHeaders),
    requestBody: entry.requestBody || '',
    responseHeaders: searchableHeaders(entry.responseHeaders),
    responseBody: entry.responseBody || '',
  };
}

function searchViews(entry) {
  return {
    req: {
      id: entry.id,
      method: entry.method,
      url: entry.url,
      host: entry.host,
      path: entry.path,
      headers: entry.requestHeaders || {},
      body: entry.requestBody || '',
    },
    res: {
      status: entry.status,
      headers: entry.responseHeaders || {},
      body: entry.responseBody || '',
      contentType: entry.contentType || '',
    },
  };
}

function previewMatch(text, matcher) {
  const source = String(text || '');
  let index = -1;
  let length = 0;
  if (matcher.mode === 'regex') {
    const match = matcher.regex.exec(source);
    if (match) {
      index = match.index;
      length = match[0].length;
    }
  } else {
    const haystack = matcher.caseSensitive ? source : source.toLowerCase();
    const needle = matcher.caseSensitive ? matcher.pattern : matcher.pattern.toLowerCase();
    index = haystack.indexOf(needle);
    length = needle.length;
  }
  if (index < 0) return '';
  const start = Math.max(0, index - 70);
  const end = Math.min(source.length, index + Math.max(length, 1) + 110);
  return `${start > 0 ? '…' : ''}${source.slice(start, end).replace(/\s+/g, ' ')}${end < source.length ? '…' : ''}`;
}

function runAdvancedSearch(historyValue, value) {
  const pattern = String(value?.pattern || '');
  const jsCondition = String(value?.jsCondition || '').trim();
  const mode = value?.mode === 'regex' ? 'regex' : 'text';
  const caseSensitive = Boolean(value?.caseSensitive);
  const inScopeOnly = Boolean(value?.inScopeOnly);
  const domainPattern = String(value?.domainPattern || '').trim();
  const scopes = [...new Set(Array.isArray(value?.scopes) ? value.scopes : [])]
    .filter((scope) => SEARCH_SCOPES.has(scope));

  if (!pattern && !jsCondition) {
    return { ok: false, error: 'Enter a search pattern or a JavaScript condition.' };
  }
  if (pattern.length > 5000) {
    return { ok: false, error: 'Search pattern cannot exceed 5,000 characters.' };
  }
  if (pattern && scopes.length === 0) {
    return { ok: false, error: 'Select at least one place to search.' };
  }

  let regex = null;
  if (pattern && mode === 'regex') {
    try {
      regex = new RegExp(pattern, caseSensitive ? 'm' : 'im');
    } catch (err) {
      return { ok: false, error: `Invalid regular expression: ${err.message}` };
    }
  }

  const compiled = compileFilter(jsCondition);
  if (!compiled.ok) return { ok: false, error: compiled.error };

  const matcher = { pattern, mode, caseSensitive, regex };
  const matches = [];
  const allHistory = (Array.isArray(historyValue) ? historyValue : [])
    .filter((entry) => entry.source !== 'resend');
  const history = inScopeOnly
    ? allHistory.filter((entry) => domainMatches(entry.host, domainPattern))
    : allHistory;
  for (const entry of history) {
    const views = searchViews(entry);
    const jsResult = compiled.evaluate(views.req, views.res);
    if (!jsResult.ok) {
      return {
        ok: false,
        error: `JavaScript condition failed for request #${entry.seq}: ${jsResult.error}`,
      };
    }
    if (!jsResult.pass) continue;

    const fields = searchFields(entry);
    const matchedScopes = [];
    let preview = '';
    if (pattern) {
      for (const scope of scopes) {
        const text = String(fields[scope] || '').slice(0, 1_000_000);
        const matched = mode === 'regex'
          ? regex.test(text)
          : (caseSensitive ? text : text.toLowerCase()).includes(
              caseSensitive ? pattern : pattern.toLowerCase()
            );
        if (matched) {
          matchedScopes.push(scope);
          if (!preview) preview = previewMatch(text, matcher);
        }
      }
      if (matchedScopes.length === 0) continue;
    } else {
      matchedScopes.push('jsCondition');
    }

    matches.push({
      id: entry.id,
      seq: entry.seq,
      method: entry.method,
      url: entry.url,
      host: entry.host,
      path: entry.path,
      status: entry.status,
      contentType: entry.contentType,
      matchedScopes,
      preview,
    });
  }

  return {
    ok: true,
    matches,
    totalSearched: history.length,
    query: {
      pattern,
      mode,
      caseSensitive,
      scopes,
      jsCondition,
      hasJsCondition: Boolean(jsCondition),
      inScopeOnly,
      domainPattern,
    },
    totalAvailable: allHistory.length,
    focus: false,
  };
}

module.exports = {
  runAdvancedSearch,
  SEARCH_SCOPES,
  domainMatches,
};
