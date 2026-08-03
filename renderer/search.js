'use strict';

(function () {
  const ui = {
    form: document.getElementById('search-form'),
    pattern: document.getElementById('search-pattern'),
    mode: document.getElementById('search-mode'),
    caseSensitive: document.getElementById('case-sensitive'),
    inScopeOnly: document.getElementById('in-scope-only'),
    domainScopeValue: document.getElementById('domain-scope-value'),
    scopeAll: document.getElementById('scope-all'),
    scopes: [...document.querySelectorAll('input[name="scope"]')],
    jsCondition: document.getElementById('js-condition'),
    run: document.getElementById('run-search'),
    focus: document.getElementById('focus-matches'),
    showAll: document.getElementById('show-all'),
    clear: document.getElementById('clear-search'),
    status: document.getElementById('search-status'),
    summary: document.getElementById('result-summary'),
    empty: document.getElementById('results-empty'),
    results: document.getElementById('search-results'),
    help: document.getElementById('open-filter-help'),
  };

  const scopeLabels = {
    url: 'URL',
    metadata: 'Metadata',
    requestHeaders: 'Req headers',
    requestBody: 'Req body',
    responseHeaders: 'Res headers',
    responseBody: 'Res body',
    jsCondition: 'JS condition',
  };

  let lastResult = null;
  let focused = false;
  let domainPattern = '';

  function setStatus(message, type = '') {
    ui.status.textContent = message;
    ui.status.className = `search-status${type ? ` ${type}` : ''}`;
  }

  function queryValue() {
    return {
      pattern: ui.pattern.value,
      mode: ui.mode.value,
      caseSensitive: ui.caseSensitive.checked,
      inScopeOnly: ui.inScopeOnly.checked,
      domainPattern,
      scopes: ui.scopes.filter((input) => input.checked).map((input) => input.value),
      jsCondition: ui.jsCondition.value,
    };
  }

  function populateQuery(query) {
    if (!query) return;
    ui.pattern.value = query.pattern || '';
    ui.mode.value = query.mode === 'regex' ? 'regex' : 'text';
    ui.caseSensitive.checked = Boolean(query.caseSensitive);
    ui.inScopeOnly.checked = Boolean(query.inScopeOnly);
    ui.jsCondition.value = query.jsCondition || '';
    const selected = new Set(query.scopes || []);
    for (const input of ui.scopes) input.checked = selected.has(input.value);
    const count = ui.scopes.filter((scope) => scope.checked).length;
    ui.scopeAll.checked = count === ui.scopes.length;
    ui.scopeAll.indeterminate = count > 0 && count < ui.scopes.length;
  }

  function applyDomainScope(pattern) {
    domainPattern = String(pattern || '').trim();
    ui.domainScopeValue.textContent = domainPattern
      ? `Current scope: ${domainPattern}`
      : 'Current scope: all domains (Domain filter is empty)';
    ui.inScopeOnly.title = domainPattern
      ? `Only search hosts matching ${domainPattern}`
      : 'The Domain filter is empty, so all domains are in scope';
  }

  function appendHighlighted(parent, text, query) {
    const source = String(text || '');
    if (!query?.pattern) {
      parent.textContent = source;
      return;
    }
    let regex;
    try {
      regex = query.mode === 'regex'
        ? new RegExp(query.pattern, `${query.caseSensitive ? '' : 'i'}gm`)
        : new RegExp(
            query.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
            `${query.caseSensitive ? '' : 'i'}g`
          );
    } catch {
      parent.textContent = source;
      return;
    }
    let cursor = 0;
    let guard = 0;
    for (const match of source.matchAll(regex)) {
      if (++guard > 100 || match[0].length === 0) break;
      parent.append(document.createTextNode(source.slice(cursor, match.index)));
      const mark = document.createElement('mark');
      mark.textContent = match[0];
      parent.append(mark);
      cursor = match.index + match[0].length;
    }
    parent.append(document.createTextNode(source.slice(cursor)));
  }

  function renderResults(result) {
    lastResult = result;
    focused = Boolean(result.focus);
    const matches = result.matches || [];
    ui.results.replaceChildren();
    ui.empty.classList.toggle('hidden', matches.length > 0);
    ui.empty.textContent = matches.length
      ? ''
      : 'No captured requests matched this search.';
    const searchedLabel = result.query?.inScopeOnly
      ? `${result.totalSearched || 0} in-scope request${result.totalSearched === 1 ? '' : 's'}`
      : `${result.totalSearched || 0} captured request${result.totalSearched === 1 ? '' : 's'}`;
    ui.summary.textContent =
      `${matches.length} match${matches.length === 1 ? '' : 'es'} across ${searchedLabel}.`;
    ui.focus.disabled = matches.length === 0 || focused;
    ui.showAll.disabled = !focused;

    const fragment = document.createDocumentFragment();
    for (const match of matches) {
      const item = document.createElement('button');
      item.className = 'result-item';
      item.type = 'button';
      item.dataset.id = match.id;
      item.setAttribute('role', 'listitem');

      const seq = document.createElement('span');
      seq.className = 'result-seq';
      seq.textContent = `#${match.seq ?? '?'}`;

      const method = document.createElement('span');
      method.className = 'result-method';
      method.textContent = match.method || '';

      const main = document.createElement('span');
      main.className = 'result-main';
      const url = document.createElement('span');
      url.className = 'result-url';
      url.textContent = match.url || `${match.host || ''}${match.path || ''}`;
      url.title = url.textContent;
      main.append(url);

      const meta = document.createElement('span');
      meta.className = 'result-meta';
      for (const scope of match.matchedScopes || []) {
        const chip = document.createElement('span');
        chip.className = 'scope-chip';
        chip.textContent = scopeLabels[scope] || scope;
        meta.append(chip);
      }
      main.append(meta);

      if (match.preview) {
        const preview = document.createElement('span');
        preview.className = 'result-preview';
        appendHighlighted(preview, match.preview, result.query);
        main.append(preview);
      }

      const status = document.createElement('span');
      status.className = 'result-status';
      status.textContent = match.status ?? 'Pending';

      item.append(seq, method, main, status);
      fragment.append(item);
    }
    ui.results.append(fragment);
  }

  async function runSearch(event) {
    event?.preventDefault();
    ui.run.disabled = true;
    setStatus('Searching…');
    try {
      const result = await window.smartnet.runAdvancedSearch(queryValue());
      if (!result.ok) {
        setStatus(result.error || 'Search failed', 'error');
        return;
      }
      renderResults(result);
      setStatus(`${result.matches.length} matches`, 'ok');
    } catch (err) {
      setStatus(err.message || String(err), 'error');
    } finally {
      ui.run.disabled = false;
    }
  }

  ui.form.addEventListener('submit', runSearch);

  ui.scopeAll.addEventListener('change', () => {
    for (const input of ui.scopes) input.checked = ui.scopeAll.checked;
    ui.scopeAll.indeterminate = false;
  });

  for (const input of ui.scopes) {
    input.addEventListener('change', () => {
      const count = ui.scopes.filter((scope) => scope.checked).length;
      ui.scopeAll.checked = count === ui.scopes.length;
      ui.scopeAll.indeterminate = count > 0 && count < ui.scopes.length;
    });
  }

  ui.focus.addEventListener('click', async () => {
    const result = await window.smartnet.setSearchFocus(true);
    if (!result.ok) {
      setStatus(result.error || 'Could not focus matches', 'error');
      return;
    }
    focused = true;
    ui.focus.disabled = true;
    ui.showAll.disabled = false;
    setStatus('Only matching requests are shown in HTTP History', 'ok');
  });

  ui.showAll.addEventListener('click', async () => {
    const result = await window.smartnet.setSearchFocus(false);
    if (!result.ok) {
      setStatus(result.error || 'Could not restore requests', 'error');
      return;
    }
    focused = false;
    ui.focus.disabled = !(lastResult?.matches?.length);
    ui.showAll.disabled = true;
    setStatus('All captured requests are visible', 'ok');
  });

  ui.clear.addEventListener('click', async () => {
    await window.smartnet.clearAdvancedSearch();
    ui.pattern.value = '';
    ui.mode.value = 'text';
    ui.caseSensitive.checked = false;
    ui.inScopeOnly.checked = false;
    ui.jsCondition.value = '';
    ui.scopeAll.checked = true;
    ui.scopeAll.indeterminate = false;
    for (const input of ui.scopes) input.checked = true;
    ui.results.replaceChildren();
    ui.empty.classList.remove('hidden');
    ui.empty.textContent = 'Search URLs, headers, bodies, metadata, or combine a pattern with JavaScript.';
    ui.summary.textContent = 'Run a search to inspect captured requests.';
    ui.focus.disabled = true;
    ui.showAll.disabled = true;
    lastResult = null;
    focused = false;
    setStatus('Search cleared');
    ui.pattern.focus();
  });

  ui.results.addEventListener('click', async (event) => {
    const item = event.target.closest('.result-item');
    if (!item) return;
    const result = await window.smartnet.selectSearchResult(item.dataset.id);
    if (!result.ok) setStatus(result.error || 'Request is no longer available', 'error');
  });

  ui.help.addEventListener('click', () => window.smartnet.openHelp());

  function applyTheme(config) {
    document.documentElement.dataset.theme = config?.settings?.theme || config?.theme || 'light';
  }

  window.smartnet.onConfigChanged(applyTheme);
  window.smartnet.onSearchDomainScope(applyDomainScope);
  window.smartnet.onSearchResults((result) => {
    if (result?.active) {
      populateQuery(result.query);
      renderResults(result);
      return;
    }
    ui.results.replaceChildren();
    ui.empty.classList.remove('hidden');
    ui.empty.textContent = 'Search URLs, headers, bodies, metadata, or combine a pattern with JavaScript.';
    ui.summary.textContent = 'Run a search to inspect captured requests.';
    ui.focus.disabled = true;
    ui.showAll.disabled = true;
    lastResult = null;
    focused = false;
    setStatus('Search cleared');
  });
  window.smartnet.getConfig().then(applyTheme);
  window.smartnet.getAdvancedSearchState().then((state) => {
    applyDomainScope(state?.domainFilter);
    if (state?.active && state.result) {
      populateQuery(state.result.query);
      renderResults(state.result);
      setStatus(`${state.result.matches.length} matches`, 'ok');
    }
    ui.pattern.focus();
  });
})();
