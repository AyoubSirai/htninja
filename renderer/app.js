'use strict';

/**
 * HtNinja renderer — traffic table, filters, search, request/response inspector.
 */

(function () {
  /** @type {Map<string, object>} */
  const entries = new Map();
  /** @type {object[]} ordered by arrival */
  let ordered = [];
  /** @type {string | null} */
  let selectedId = null;
  /** @type {Set<string>} */
  let selectedIds = new Set();

  const ui = {
    statusLight: document.getElementById('status-light'),
    statusLabel: document.getElementById('status-label'),
    proxyEndpoint: document.getElementById('proxy-endpoint'),
    btnToggle: document.getElementById('btn-toggle'),
    btnHold: document.getElementById('btn-hold'),
    btnInterceptResponse: document.getElementById('btn-intercept-response'),
    btnResponseHook: document.getElementById('btn-response-hook'),
    btnChrome: document.getElementById('btn-chrome'),
    btnFirefox: document.getElementById('btn-firefox'),
    btnOpenRepeater: document.getElementById('btn-open-repeater'),
    btnSearch: document.getElementById('btn-search'),
    btnExportCa: document.getElementById('btn-export-ca'),
    btnConfig: document.getElementById('btn-config'),
    btnHelp: document.getElementById('btn-help'),
    btnClear: document.getElementById('btn-clear'),
    filterDomain: document.getElementById('filter-domain'),
    filterCtype: document.getElementById('filter-ctype'),
    filterJs: document.getElementById('filter-js'),
    filterJsScope: document.getElementById('filter-js-apply'),
    btnApplyJs: document.getElementById('btn-apply-js'),
    filterJsStatus: document.getElementById('filter-js-status'),
    visibleCount: document.getElementById('visible-count'),
    trafficBody: document.getElementById('traffic-body'),
    emptyState: document.getElementById('empty-state'),
    inspectorMeta: document.getElementById('inspector-meta'),
    inspectorRaw: document.getElementById('inspector-raw'),
    inspectorHeaders: document.getElementById('inspector-headers'),
    inspectorBody: document.getElementById('inspector-body'),
    subtabsRequest: document.getElementById('subtabs-request'),
    subtabsResponse: document.getElementById('subtabs-response'),
    subtabsRepeater: document.getElementById('subtabs-repeater'),
    repeaterEditor: document.getElementById('repeater-editor'),
    repeaterMethod: document.getElementById('repeater-method'),
    repeaterUrl: document.getElementById('repeater-url'),
    repeaterHeaders: document.getElementById('repeater-headers'),
    repeaterBody: document.getElementById('repeater-body'),
    btnLoadRepeater: document.getElementById('btn-load-repeater'),
    btnResend: document.getElementById('btn-resend'),
    btnEditHeld: document.getElementById('btn-edit-held'),
    btnEditResponse: document.getElementById('btn-edit-response'),
    btnSendRepeater: document.getElementById('btn-send-repeater'),
    repeaterStatus: document.getElementById('repeater-status'),
    heldDialog: document.getElementById('held-editor-dialog'),
    heldForm: document.getElementById('held-editor-form'),
    heldClose: document.getElementById('held-editor-close'),
    heldCancel: document.getElementById('held-cancel'),
    heldSave: document.getElementById('held-save'),
    heldForward: document.getElementById('held-forward'),
    heldMethod: document.getElementById('held-method'),
    heldUrl: document.getElementById('held-url'),
    heldHeaders: document.getElementById('held-headers'),
    heldBody: document.getElementById('held-body'),
    heldError: document.getElementById('held-editor-error'),
    responseDialog: document.getElementById('response-editor-dialog'),
    responseForm: document.getElementById('response-editor-form'),
    responseClose: document.getElementById('response-editor-close'),
    responseCancel: document.getElementById('response-editor-cancel'),
    responseStatus: document.getElementById('response-status'),
    responseRequestUrl: document.getElementById('response-request-url'),
    responseHeaders: document.getElementById('response-headers'),
    responseBody: document.getElementById('response-body'),
    responseFindText: document.getElementById('response-find-text'),
    responseReplaceText: document.getElementById('response-replace-text'),
    responseReplaceCase: document.getElementById('response-replace-case'),
    responseReplaceRegex: document.getElementById('response-replace-regex'),
    responseReplaceAll: document.getElementById('response-replace-all'),
    responseTransformJs: document.getElementById('response-transform-js'),
    responseTransformApply: document.getElementById('response-transform-apply'),
    responseTransformHelp: document.getElementById('response-transform-help'),
    responseSave: document.getElementById('response-save'),
    responseForward: document.getElementById('response-forward'),
    responseAbort: document.getElementById('response-abort'),
    responseError: document.getElementById('response-editor-error'),
    responseHookDialog: document.getElementById('response-hook-dialog'),
    responseHookForm: document.getElementById('response-hook-form'),
    responseHookClose: document.getElementById('response-hook-close'),
    responseHookSource: document.getElementById('response-hook-source'),
    responseHookInScope: document.getElementById('response-hook-in-scope'),
    responseHookStatus: document.getElementById('response-hook-status'),
    responseHookHelp: document.getElementById('response-hook-help'),
    responseHookDisable: document.getElementById('response-hook-disable'),
    responseHookStart: document.getElementById('response-hook-start'),
    toast: document.getElementById('toast'),
    footerHint: document.getElementById('footer-hint'),
    workspace: document.querySelector('.workspace'),
    splitter: document.getElementById('splitter'),
  };
  ui.responseHookSource = window.SmartNetCodeEditor.createJavaScript(ui.responseHookSource);

  let activePanel = 'request'; // request | response | repeater
  let activeView = 'raw'; // raw | headers | body
  let proxyMode = 'stopped';
  let holdingRequests = false;
  let interceptingResponses = false;
  let responseHookActive = false;
  let config = { host: '127.0.0.1', port: 8080, theme: 'light' };
  let toastTimer = null;
  let repeaterDirty = false;
  let resending = false;
  let advancedSearch = {
    active: false,
    focus: false,
    ids: new Set(),
    matcher: null,
  };

  // ——— Helpers ———

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatBytes(n) {
    if (n == null || Number.isNaN(n)) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  }

  function formatDuration(ms) {
    if (ms == null) return '—';
    if (ms < 1000) return `${ms} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
  }

  function shortContentType(ct) {
    if (!ct) return '—';
    return String(ct).split(';')[0].trim();
  }

  function statusClass(code) {
    if (code == null) return '';
    if (code >= 500) return 's5';
    if (code >= 400) return 's4';
    if (code >= 300) return 's3';
    if (code >= 200) return 's2';
    return '';
  }

  function showToast(message, kind = '') {
    ui.toast.textContent = message;
    ui.toast.className = 'toast' + (kind ? ` ${kind}` : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      ui.toast.textContent = '';
      ui.toast.className = 'toast';
    }, 4500);
  }

  /**
   * Domain filter: case-insensitive substring or wildcard like *.google.com
   */
  function domainMatches(host, pattern) {
    const p = (pattern || '').trim().toLowerCase();
    if (!p) return true;
    let h = String(host || '').trim().toLowerCase();
    // Strip a numeric port without breaking bracketed IPv6 addresses.
    if (h.startsWith('[')) {
      const closingBracket = h.indexOf(']');
      if (closingBracket > 0) h = h.slice(1, closingBracket);
    } else {
      h = h.replace(/:\d+$/, '');
    }
    if (!h) return false;

    if (p.startsWith('*.')) {
      const suffix = p.slice(1); // .google.com
      const bare = p.slice(2); // google.com
      return h === bare || h.endsWith(suffix);
    }
    if (p.includes('*')) {
      const re = wildcardToRegExp(p);
      return re.test(h);
    }
    // Partial text ("go" → google.com, cargo.dev, or my-go-api.test).
    return h.includes(p);
  }

  function wildcardToRegExp(pattern) {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`, 'i');
  }

  /**
   * Content-Type filter with optional trailing wildcard (image/*)
   */
  function contentTypeMatches(ct, pattern) {
    const p = (pattern || '').trim().toLowerCase();
    if (!p) return true;
    const value = String(ct || '').toLowerCase();
    if (!value) return false;
    const base = value.split(';')[0].trim();

    if (p.endsWith('/*')) {
      const prefix = p.slice(0, -1); // image/
      return base.startsWith(prefix);
    }
    if (p.includes('*')) {
      return wildcardToRegExp(p).test(base);
    }
    return base.includes(p);
  }

  function buildSearchMatcher(query, useRegex, caseSensitive = false) {
    const q = query || '';
    if (!q.trim()) return null;

    if (useRegex) {
      try {
        return { type: 'regex', re: new RegExp(q, caseSensitive ? 'm' : 'im') };
      } catch (err) {
        showToast(`Invalid RegEx: ${err.message}`, 'err');
        return { type: 'regex', re: /$a/, invalid: true };
      }
    }
    return {
      type: 'text',
      needle: caseSensitive ? q : q.toLowerCase(),
      caseSensitive,
    };
  }

  function getFilters() {
    return {
      domain: ui.filterDomain.value,
      ctype: ui.filterCtype.value,
    };
  }

  function entryVisible(entry, filters) {
    if (advancedSearch.active && advancedSearch.focus) {
      return advancedSearch.ids.has(entry.id);
    }
    if (!domainMatches(entry.host, filters.domain)) return false;
    if (!contentTypeMatches(entry.contentType, filters.ctype)) return false;
    return true;
  }

  // ——— Proxy state UI ———

  function applyConfig(next) {
    if (!next) return;
    config = { ...config, ...next };
    document.documentElement.dataset.theme = config.theme;
    ui.proxyEndpoint.textContent = `${config.host}:${config.port}`;
    ui.proxyEndpoint.title = `Proxy endpoint: ${config.host}:${config.port}`;
  }

  function applyProxyState(state) {
    if (!state) return;
    proxyMode = state.mode || 'stopped';
    holdingRequests = Boolean(state.holding);
    interceptingResponses = Boolean(state.interceptResponses);
    responseHookActive = Boolean(state.responseTransformActive);
    ui.statusLight.className = `status-light ${proxyMode}`;
    const host = state.host || config.host;
    const port = state.port || config.port;
    ui.proxyEndpoint.textContent = `${host}:${port}`;

    const running = proxyMode === 'recording' || proxyMode === 'paused';
    ui.btnChrome.disabled = !running;
    ui.btnFirefox.disabled = !running;
    ui.btnHold.disabled = !running;
    ui.btnInterceptResponse.disabled = !running;
    ui.btnHold.classList.toggle('is-holding', holdingRequests);
    ui.btnHold.textContent = holdingRequests
      ? `Release Requests${state.heldCount ? ` (${state.heldCount})` : ''}`
      : 'Hold Requests';
    ui.btnInterceptResponse.classList.toggle('is-holding', interceptingResponses);
    ui.btnInterceptResponse.textContent = interceptingResponses
      ? `Release Responses${state.heldResponseCount ? ` (${state.heldResponseCount})` : ''}`
      : 'Pause Responses';
    ui.btnResponseHook.classList.toggle('is-holding', responseHookActive);
    ui.btnResponseHook.textContent = responseHookActive
      ? 'Response Hook: Running'
      : 'Response Hook';

    if (proxyMode === 'recording') {
      ui.statusLabel.textContent = 'Recording';
      ui.btnToggle.textContent = 'Pause Proxy';
      ui.btnToggle.classList.add('is-pause');
      ui.footerHint.textContent = `Listening on ${host}:${port} — intercepting HTTPS`;
    } else if (proxyMode === 'paused') {
      ui.statusLabel.textContent = 'Paused';
      ui.btnToggle.textContent = 'Resume Proxy';
      ui.btnToggle.classList.remove('is-pause');
      ui.footerHint.textContent = `Proxy up on ${host}:${port} — logging paused`;
    } else {
      ui.statusLabel.textContent = 'Stopped';
      ui.btnToggle.textContent = 'Start Proxy';
      ui.btnToggle.classList.remove('is-pause');
      ui.footerHint.textContent = 'Listening disabled';
    }

    if (holdingRequests) {
      const count = Number(state.heldCount) || 0;
      ui.footerHint.textContent = `Holding ${count} request${count === 1 ? '' : 's'} — browser traffic is waiting`;
    } else if (interceptingResponses) {
      const count = Number(state.heldResponseCount) || 0;
      ui.footerHint.textContent = `Intercepting responses · ${count} browser response${count === 1 ? '' : 's'} waiting`;
    } else if (responseHookActive) {
      ui.footerHint.textContent = 'Automatic response hook running — browser traffic is not paused';
    }
  }

  // ——— Table rendering ———

  function renderTable() {
    const filters = getFilters();
    const frag = document.createDocumentFragment();
    let visible = 0;

    for (const entry of ordered) {
      if (!entryVisible(entry, filters)) continue;
      visible += 1;

      const tr = document.createElement('tr');
      tr.dataset.id = entry.id;
      if (selectedIds.has(entry.id)) tr.classList.add('selected');
      if (entry.held) tr.classList.add('held-row');
      if (entry.responseHeld) tr.classList.add('response-held-row');
      if (advancedSearch.active && advancedSearch.ids.has(entry.id)) {
        tr.classList.add('match-hit');
        tr.title = 'Advanced Search match';
      }

      const method = escapeHtml(entry.method || '');
      const status = entry.held
        ? 'Held'
        : entry.responseHeld
          ? 'Resp held'
          : entry.responseAborted
            ? 'Aborted'
        : !entry.complete
          ? 'Pending'
          : entry.status != null
            ? String(entry.status)
            : '—';
      const statusCss = entry.held
        ? 'held'
        : entry.responseHeld
          ? 'response-held'
          : entry.responseAborted
            ? 'aborted'
        : !entry.complete
          ? 'pending'
          : statusClass(entry.status);
      const size = entry.complete
        ? formatBytes(entry.contentLength ?? entry.responseBodySize)
        : '—';
      const time = formatDuration(entry.durationMs);

      tr.innerHTML = `
        <td class="col-seq">${entry.seq}</td>
        <td class="col-method"><span class="method ${method}">${method}</span></td>
        <td class="col-host" title="${escapeHtml(entry.host)}">${escapeHtml(entry.host)}</td>
        <td class="col-path" title="${escapeHtml(entry.path)}">${escapeHtml(entry.path)}</td>
        <td class="col-status"><span class="status-code ${statusCss}">${escapeHtml(status)}</span></td>
        <td class="col-ctype" title="${escapeHtml(entry.contentType || '')}">${escapeHtml(shortContentType(entry.contentType))}</td>
        <td class="col-size">${escapeHtml(size)}</td>
        <td class="col-time">${escapeHtml(time)}</td>
      `;
      frag.appendChild(tr);
    }

    ui.trafficBody.replaceChildren(frag);
    const matchSummary = advancedSearch.active
      ? `${advancedSearch.ids.size} match${advancedSearch.ids.size === 1 ? '' : 'es'} · `
      : '';
    ui.visibleCount.textContent = `${matchSummary}${visible} / ${ordered.length}`;
    ui.emptyState.classList.toggle('hidden', visible > 0);
    ui.emptyState.textContent = ordered.length === 0
      ? 'Start the proxy, export and trust the Root CA, then launch Chrome or Firefox.'
      : advancedSearch.focus
        ? 'No captured requests match the focused Advanced Search.'
        : 'No requests match the active domain or Content-Type filters.';
  }

  function selectEntry(id, options = {}) {
    const additive = Boolean(options.additive);
    if (!id) return;

    if (additive) {
      if (selectedIds.has(id)) {
        selectedIds.delete(id);
        if (selectedId === id) {
          selectedId = selectedIds.values().next().value || null;
        }
      } else {
        selectedIds.add(id);
        selectedId = id;
      }
    } else {
      selectedIds = new Set([id]);
      selectedId = id;
    }

    for (const tr of ui.trafficBody.querySelectorAll('tr')) {
      tr.classList.toggle('selected', selectedIds.has(tr.dataset.id));
    }
    // Always refresh from the focused history row.
    loadEntryIntoRepeater(selectedId ? entries.get(selectedId) : null);
    renderInspector();
  }

  // ——— Inspector ———

  function formatHeadersBlock(headers) {
    if (!headers) return '';
    return Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
  }

  function loadEntryIntoRepeater(entry) {
    if (!entry) {
      ui.repeaterMethod.value = 'GET';
      ui.repeaterUrl.value = '';
      ui.repeaterHeaders.value = '';
      ui.repeaterBody.value = '';
      ui.repeaterStatus.textContent = '';
      ui.repeaterStatus.className = 'repeater-status';
      repeaterDirty = false;
      return;
    }

    const method = String(entry.method || 'GET').toUpperCase();
    const isBodyless = method === 'GET' || method === 'HEAD';
    const headers = { ...(entry.requestHeaders || {}) };
    if (isBodyless) {
      delete headers['content-length'];
      delete headers['content-type'];
      delete headers['content-encoding'];
      delete headers['transfer-encoding'];
    }

    ui.repeaterMethod.value = method;
    ui.repeaterUrl.value = entry.url || '';
    ui.repeaterHeaders.value = formatHeadersBlock(headers);
    ui.repeaterBody.value = isBodyless ? '' : entry.requestBody || '';
    ui.repeaterStatus.textContent = `Loaded #${entry.seq}`;
    ui.repeaterStatus.className = 'repeater-status';
    repeaterDirty = false;
  }

  function markRepeaterDirty() {
    repeaterDirty = true;
    if (!ui.repeaterStatus.classList.contains('err')) {
      ui.repeaterStatus.textContent = 'Edited';
      ui.repeaterStatus.className = 'repeater-status';
    }
  }

  function switchInspectorPanel(panel) {
    activePanel = panel;
    document.querySelectorAll('.inspector-tabs .tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.panel === panel);
    });
    if (panel === 'request' || panel === 'response') {
      const subtabs = panel === 'request' ? ui.subtabsRequest : ui.subtabsResponse;
      subtabs.querySelectorAll('.subtab').forEach((s) => {
        s.classList.toggle('active', s.dataset.view === activeView);
      });
    }
    renderInspector();
  }

  function buildRawRequest(entry) {
    const path = entry.path || '/';
    const version = 'HTTP/1.1';
    let raw = `${entry.method} ${path} ${version}\r\n`;
    raw += formatHeadersBlock(entry.requestHeaders);
    raw += '\r\n\r\n';
    if (entry.requestBody) raw += entry.requestBody;
    return raw;
  }

  function buildRawResponse(entry) {
    const version = 'HTTP/1.1';
    const statusText = '';
    let raw = `${version} ${entry.status ?? ''} ${statusText}`.trimEnd() + '\r\n';
    raw += formatHeadersBlock(entry.responseHeaders);
    raw += '\r\n\r\n';
    if (entry.responseBody) raw += entry.responseBody;
    return raw;
  }

  function prettyBody(text, contentType, binary) {
    if (binary) return text || '';
    const ct = String(contentType || '').toLowerCase();
    const body = text || '';

    if (ct.includes('json') || looksLikeJson(body)) {
      try {
        return JSON.stringify(JSON.parse(body), null, 4);
      } catch {
        return body;
      }
    }
    return body;
  }

  function looksLikeJson(s) {
    const t = s.trim();
    return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
  }

  function highlightMatches(text, matcher) {
    const source = text || '';
    if (!matcher || matcher.invalid) return escapeHtml(source);

    if (matcher.type === 'text') {
      if (!matcher.needle) return escapeHtml(source);
      const haystack = matcher.caseSensitive ? source : source.toLowerCase();
      let out = '';
      let i = 0;
      while (i < source.length) {
        const idx = haystack.indexOf(matcher.needle, i);
        if (idx === -1) {
          out += escapeHtml(source.slice(i));
          break;
        }
        out += escapeHtml(source.slice(i, idx));
        out += `<mark class="mark">${escapeHtml(source.slice(idx, idx + matcher.needle.length))}</mark>`;
        i = idx + matcher.needle.length;
      }
      return out;
    }

    // RegEx — global highlight (avoid catastrophic backtracking with length guard)
    try {
      const flags = matcher.re.flags.includes('g') ? matcher.re.flags : matcher.re.flags + 'g';
      const re = new RegExp(matcher.re.source, flags);
      let out = '';
      let last = 0;
      let m;
      let guard = 0;
      while ((m = re.exec(source)) !== null) {
        guard += 1;
        if (guard > 5000) break;
        if (m[0].length === 0) {
          re.lastIndex += 1;
          continue;
        }
        out += escapeHtml(source.slice(last, m.index));
        out += `<mark class="mark">${escapeHtml(m[0])}</mark>`;
        last = m.index + m[0].length;
      }
      out += escapeHtml(source.slice(last));
      return out;
    } catch {
      return escapeHtml(source);
    }
  }

  function renderHeadersTable(headers, matcher = null) {
    const rows = Object.entries(headers || {})
      .map(
        ([k, v]) =>
          `<tr><td class="key">${highlightMatches(k, matcher)}</td><td>${highlightMatches(String(v), matcher)}</td></tr>`
      )
      .join('');
    return `
      <table class="headers-table">
        <thead><tr><th>Name</th><th>Value</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="2" style="color:var(--text-muted)">No headers</td></tr>'}</tbody>
      </table>
    `;
  }

  function renderInspector() {
    const entry = selectedId ? entries.get(selectedId) : null;
    const matcher = advancedSearch.active && advancedSearch.ids.has(selectedId)
      ? advancedSearch.matcher
      : null;
    ui.btnEditHeld.classList.toggle('hidden-action', !entry?.held);
    ui.btnEditResponse.classList.toggle('hidden-action', !entry?.responseHeld);

    if (activePanel === 'repeater') {
      ui.inspectorMeta.textContent = ui.repeaterUrl.value
        ? `${ui.repeaterMethod.value || 'GET'} ${ui.repeaterUrl.value}`
        : 'Edit request and resend';
      syncInspectorVisibility();
      return;
    }

    if (!entry) {
      ui.inspectorMeta.textContent = '';
      ui.inspectorRaw.textContent = 'Select a request from the history table.';
      ui.inspectorHeaders.innerHTML = '';
      ui.inspectorBody.textContent = '';
      syncInspectorVisibility();
      return;
    }

    ui.inspectorMeta.textContent = `${entry.method} ${entry.host}${entry.path} → ${entry.status ?? '?'}`;

    if (activePanel === 'request') {
      const raw = buildRawRequest(entry);
      const body = prettyBody(entry.requestBody, entry.requestHeaders['content-type'], entry.requestBinary);
      ui.inspectorRaw.innerHTML = highlightMatches(raw, matcher);
      ui.inspectorHeaders.innerHTML = renderHeadersTable(entry.requestHeaders, matcher);
      ui.inspectorBody.innerHTML = highlightMatches(body, matcher);
    } else {
      const raw = buildRawResponse(entry);
      const body = prettyBody(entry.responseBody, entry.contentType, entry.responseBinary);
      ui.inspectorRaw.innerHTML = highlightMatches(raw, matcher);
      ui.inspectorHeaders.innerHTML = renderHeadersTable(entry.responseHeaders, matcher);
      ui.inspectorBody.innerHTML = highlightMatches(body, matcher);
    }

    syncInspectorVisibility();
  }

  function syncInspectorVisibility() {
    const isRepeater = activePanel === 'repeater';
    ui.subtabsRequest.classList.toggle('hidden', activePanel !== 'request');
    ui.subtabsResponse.classList.toggle('hidden', activePanel !== 'response');
    ui.subtabsRepeater.classList.toggle('hidden', !isRepeater);

    ui.inspectorRaw.classList.toggle('hidden', isRepeater || activeView !== 'raw');
    ui.inspectorHeaders.classList.toggle('hidden', isRepeater || activeView !== 'headers');
    ui.inspectorBody.classList.toggle('hidden', isRepeater || activeView !== 'body');
    ui.repeaterEditor.classList.toggle('hidden', !isRepeater);
  }

  // ——— Events: traffic ———

  function addEntry(entry) {
    if (!entry || !entry.id || entry.source === 'resend') return;
    const wasResponseHeld = Boolean(entries.get(entry.id)?.responseHeld);
    if (entries.has(entry.id)) {
      // update in place
      const idx = ordered.findIndex((e) => e.id === entry.id);
      entries.set(entry.id, entry);
      if (idx >= 0) ordered[idx] = entry;
    } else {
      entries.set(entry.id, entry);
      ordered.push(entry);
    }
    renderTable();
    if (selectedId === entry.id) renderInspector();
    if (entry.responseHeld && !wasResponseHeld && !ui.responseDialog.open) {
      selectedIds = new Set([entry.id]);
      selectedId = entry.id;
      renderTable();
      renderInspector();
      setTimeout(() => openResponseEditor(entry), 0);
    }
  }

  function removeEntry(id) {
    if (!id || !entries.has(id)) return;
    entries.delete(id);
    ordered = ordered.filter((entry) => entry.id !== id);
    selectedIds.delete(id);
    if (selectedId === id) selectedId = selectedIds.values().next().value || null;
    renderTable();
    renderInspector();
  }

  function clearAll(keptIds = []) {
    const keep = new Set((Array.isArray(keptIds) ? keptIds : []).map(String));
    if (keep.size === 0) {
      entries.clear();
      ordered = [];
      selectedId = null;
      selectedIds = new Set();
      advancedSearch = { active: false, focus: false, ids: new Set(), matcher: null };
      loadEntryIntoRepeater(null);
      renderTable();
      renderInspector();
      return;
    }

    ordered = ordered.filter((entry) => keep.has(entry.id));
    for (const id of [...entries.keys()]) {
      if (!keep.has(id)) entries.delete(id);
    }
    selectedIds = new Set([...selectedIds].filter((id) => keep.has(id) && entries.has(id)));
    if (!selectedIds.has(selectedId)) {
      selectedId = selectedIds.values().next().value || ordered[ordered.length - 1]?.id || null;
      if (selectedId) selectedIds.add(selectedId);
    }
    advancedSearch = { active: false, focus: false, ids: new Set(), matcher: null };
    loadEntryIntoRepeater(selectedId ? entries.get(selectedId) : null);
    renderTable();
    renderInspector();
  }

  // ——— Splitter ———

  function initSplitter() {
    let dragging = false;
    let startY = 0;
    let startTopHeight = 0;

    ui.splitter.addEventListener('mousedown', (e) => {
      dragging = true;
      startY = e.clientY;
      const tablePane = document.getElementById('pane-table');
      startTopHeight = tablePane.getBoundingClientRect().height;
      ui.splitter.classList.add('dragging');
      document.body.classList.add('resizing-panes');
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const rect = ui.workspace.getBoundingClientRect();
      const dy = e.clientY - startY;
      const splitterPx = 6;
      const available = Math.max(240, rect.height - splitterPx);
      const topHeight = Math.min(
        available - 120,
        Math.max(120, startTopHeight + dy)
      );
      ui.workspace.style.gridTemplateRows =
        `${topHeight}px ${splitterPx}px minmax(120px, 1fr)`;
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      ui.splitter.classList.remove('dragging');
      document.body.classList.remove('resizing-panes');
    });
  }

  // ——— Wire UI ———

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  const rerenderDebounced = debounce(() => {
    renderTable();
    renderInspector();
  }, 80);

  function openHeldEditor(entry) {
    if (!entry || !entry.held) {
      showToast('This request is no longer held', 'err');
      return;
    }
    ui.heldDialog.dataset.requestId = entry.id;
    ui.heldMethod.value = entry.method || 'GET';
    ui.heldUrl.value = entry.url || '';
    ui.heldHeaders.value = formatHeadersBlock(entry.requestHeaders);
    ui.heldBody.value = entry.requestBody || '';
    ui.heldError.textContent = '';
    ui.heldDialog.showModal();
    ui.heldUrl.focus();
  }

  async function saveHeldRequest(forward) {
    const id = ui.heldDialog.dataset.requestId;
    const entry = id ? entries.get(id) : null;
    if (!entry || !entry.held) {
      ui.heldError.textContent = 'This request has already been released.';
      return;
    }

    ui.heldSave.disabled = true;
    ui.heldForward.disabled = true;
    ui.heldError.textContent = '';
    try {
      const result = await window.smartnet.updateHeldRequest(
        id,
        {
          method: ui.heldMethod.value,
          url: ui.heldUrl.value,
          headers: ui.heldHeaders.value,
          body: ui.heldBody.value,
        },
        forward
      );
      if (!result.ok) {
        ui.heldError.textContent = result.error || 'Could not update held request.';
        return;
      }

      addEntry(result.entry);
      if (result.state) applyProxyState(result.state);
      ui.heldDialog.close();
      showToast(
        forward ? 'Edited request forwarded' : 'Held request changes saved',
        'ok'
      );
    } catch (err) {
      ui.heldError.textContent = err.message || String(err);
    } finally {
      ui.heldSave.disabled = false;
      ui.heldForward.disabled = false;
    }
  }

  ui.btnEditHeld.addEventListener('click', () => {
    openHeldEditor(selectedId ? entries.get(selectedId) : null);
  });
  ui.heldForm.addEventListener('submit', (event) => event.preventDefault());
  ui.heldClose.addEventListener('click', () => ui.heldDialog.close());
  ui.heldCancel.addEventListener('click', () => ui.heldDialog.close());
  ui.heldSave.addEventListener('click', () => saveHeldRequest(false));
  ui.heldForward.addEventListener('click', () => saveHeldRequest(true));

  function openResponseEditor(entry) {
    if (!entry || !entry.responseHeld) {
      showToast('This response is no longer held', 'err');
      return;
    }
    ui.responseDialog.dataset.requestId = entry.id;
    ui.responseStatus.value = entry.status ?? 200;
    ui.responseRequestUrl.value = `${entry.method || 'GET'} ${entry.url || ''}`;
    ui.responseHeaders.value = formatHeadersBlock(entry.responseHeaders);
    ui.responseBody.value = entry.responseBody || '';
    ui.responseError.textContent = '';
    ui.responseDialog.showModal();
    ui.responseBody.focus();
  }

  async function saveHeldResponse(forward) {
    const id = ui.responseDialog.dataset.requestId;
    ui.responseError.textContent = '';
    const result = await window.smartnet.updateHeldResponse(
      id,
      {
        status: ui.responseStatus.value,
        headers: ui.responseHeaders.value,
        body: ui.responseBody.value,
      },
      forward
    );
    if (!result.ok) {
      ui.responseError.textContent = result.error || 'Could not update response.';
      return;
    }
    addEntry(result.entry);
    if (result.state) applyProxyState(result.state);
    if (forward) ui.responseDialog.close();
    showToast(forward ? 'Modified response forwarded' : 'Response changes saved', 'ok');
  }

  ui.btnEditResponse.addEventListener('click', () => {
    openResponseEditor(selectedId ? entries.get(selectedId) : null);
  });
  ui.responseForm.addEventListener('submit', (event) => event.preventDefault());
  ui.responseClose.addEventListener('click', () => ui.responseDialog.close());
  ui.responseCancel.addEventListener('click', () => ui.responseDialog.close());
  ui.responseSave.addEventListener('click', () => saveHeldResponse(false));
  ui.responseForward.addEventListener('click', () => saveHeldResponse(true));
  ui.responseReplaceAll.addEventListener('click', async () => {
    const id = ui.responseDialog.dataset.requestId;
    ui.responseError.textContent = '';
    const result = await window.smartnet.replaceHeldResponseText(id, {
      search: ui.responseFindText.value,
      replacement: ui.responseReplaceText.value,
      regex: ui.responseReplaceRegex.checked,
      caseSensitive: ui.responseReplaceCase.checked,
    });
    if (!result.ok) {
      ui.responseError.textContent = result.error || 'Replacement failed.';
      return;
    }
    ui.responseBody.value = result.entry.responseBody || '';
    addEntry(result.entry);
    showToast('Response text replaced', 'ok');
  });
  ui.responseTransformApply.addEventListener('click', async () => {
    const id = ui.responseDialog.dataset.requestId;
    ui.responseError.textContent = '';
    const result = await window.smartnet.transformHeldResponse(
      id,
      ui.responseTransformJs.value
    );
    if (!result.ok) {
      ui.responseError.textContent = result.error || 'Response transform failed.';
      return;
    }
    addEntry(result.entry);
    if (result.state) applyProxyState(result.state);
    if (!result.entry.responseHeld) {
      ui.responseDialog.close();
      showToast('Response connection aborted by script', 'ok');
      return;
    }
    ui.responseStatus.value = result.entry.status;
    ui.responseHeaders.value = formatHeadersBlock(result.entry.responseHeaders);
    ui.responseBody.value = result.entry.responseBody || '';
    showToast('JavaScript transform applied', 'ok');
  });
  ui.responseTransformHelp.addEventListener('click', () => window.smartnet.openHelp());
  ui.responseAbort.addEventListener('click', async () => {
    if (!window.confirm('Reset this browser connection and discard the response?')) return;
    const id = ui.responseDialog.dataset.requestId;
    const result = await window.smartnet.abortHeldResponse(id, 'reset');
    if (!result.ok) {
      ui.responseError.textContent = result.error || 'Could not abort response.';
      return;
    }
    addEntry(result.entry);
    if (result.state) applyProxyState(result.state);
    ui.responseDialog.close();
    showToast('Response connection reset', 'err');
  });

  async function openResponseHook() {
    ui.responseHookStatus.textContent = '';
    const result = await window.smartnet.getResponseTransform();
    if (!result.ok) {
      showToast(result.error || 'Could not load response hook', 'err');
      return;
    }
    ui.responseHookSource.value = result.source || '';
    ui.responseHookInScope.checked = result.inScope !== false;
    ui.responseHookStatus.textContent = result.enabled
      ? 'Hook is running for all responses.'
      : 'Hook is stopped.';
    ui.responseHookStatus.className = result.enabled
      ? 'held-editor-error response-hook-ok'
      : 'held-editor-error';
    ui.responseHookDialog.showModal();
    ui.responseHookSource.focus();
  }

  ui.btnResponseHook.addEventListener('click', openResponseHook);
  ui.responseHookForm.addEventListener('submit', (event) => event.preventDefault());
  ui.responseHookClose.addEventListener('click', () => ui.responseHookDialog.close());
  ui.responseHookHelp.addEventListener('click', () => window.smartnet.openHelp());
  ui.responseHookStart.addEventListener('click', async () => {
    ui.responseHookStatus.textContent = '';
    ui.responseHookStatus.className = 'held-editor-error';
    const source = ui.responseHookSource.value;
    const validation = await window.smartnet.validateResponseTransform(source);
    if (!validation.ok) {
      ui.responseHookStatus.textContent =
        validation.error || 'Hook contains an error. Fix it before saving.';
      showToast(validation.error || 'Hook validation failed', 'err');
      return;
    }
    const result = await window.smartnet.setResponseTransform(
      source,
      true,
      ui.responseHookInScope.checked
    );
    if (!result.ok) {
      ui.responseHookStatus.textContent = result.error || 'Could not start response hook.';
      showToast(result.error || 'Could not start response hook', 'err');
      return;
    }
    if (result.state) applyProxyState(result.state);
    ui.responseHookStatus.className = 'held-editor-error response-hook-ok';
    const warningText =
      Array.isArray(result.warnings) && result.warnings.length
        ? ` Warning: ${result.warnings.join(' · ')}`
        : '';
    ui.responseHookStatus.textContent = `Hook saved and running for all responses.${warningText}`;
    showToast('Automatic response hook started', 'ok');
  });
  ui.responseHookDisable.addEventListener('click', async () => {
    const result = await window.smartnet.setResponseTransform(
      ui.responseHookSource.value,
      false,
      ui.responseHookInScope.checked
    );
    if (!result.ok) {
      ui.responseHookStatus.className = 'held-editor-error';
      ui.responseHookStatus.textContent = result.error || 'Could not stop response hook.';
      return;
    }
    if (result.state) applyProxyState(result.state);
    ui.responseHookStatus.className = 'held-editor-error';
    ui.responseHookStatus.textContent = 'Hook stopped. The code remains saved.';
    showToast('Automatic response hook stopped', 'ok');
  });

  ui.btnToggle.addEventListener('click', async () => {
    ui.btnToggle.disabled = true;
    try {
      let result;
      if (proxyMode === 'stopped') {
        result = await window.smartnet.start();
      } else if (proxyMode === 'recording') {
        result = await window.smartnet.pause();
      } else {
        result = await window.smartnet.resume();
      }
      if (!result.ok) {
        showToast(result.error || 'Proxy action failed', 'err');
      } else {
        applyProxyState(result.state);
        if (result.state.mode === 'recording') {
          showToast(`Proxy recording on port ${result.state.port}`, 'ok');
        }
      }
    } catch (err) {
      showToast(err.message || String(err), 'err');
    } finally {
      ui.btnToggle.disabled = false;
    }
  });

  ui.btnHold.addEventListener('click', async () => {
    ui.btnHold.disabled = true;
    try {
      const nextHolding = !holdingRequests;
      const result = await window.smartnet.setHolding(nextHolding);
      if (!result.ok) {
        showToast(result.error || 'Could not change request hold state', 'err');
        return;
      }
      applyProxyState(result.state);
      showToast(
        nextHolding
          ? 'New requests will wait until released'
          : 'Held requests released',
        nextHolding ? '' : 'ok'
      );
    } catch (err) {
      showToast(err.message || String(err), 'err');
    } finally {
      ui.btnHold.disabled = proxyMode === 'stopped';
    }
  });

  ui.btnInterceptResponse.addEventListener('click', async () => {
    ui.btnInterceptResponse.disabled = true;
    try {
      const next = !interceptingResponses;
      const result = await window.smartnet.setResponseIntercepting(next);
      if (!result.ok) {
        showToast(result.error || 'Could not change response interception', 'err');
        return;
      }
      applyProxyState(result.state);
      showToast(
        next
          ? 'Upstream responses will wait for inspection'
          : 'Held responses released',
        next ? '' : 'ok'
      );
    } catch (err) {
      showToast(err.message || String(err), 'err');
    } finally {
      ui.btnInterceptResponse.disabled = proxyMode === 'stopped';
    }
  });

  ui.btnChrome.addEventListener('click', async () => {
    const result = await window.smartnet.launchChrome({ startUrl: 'https://example.com' });
    if (!result.ok) showToast(result.error, 'err');
    else showToast(`Launched ${result.info.browser} (pid ${result.info.pid})`, 'ok');
  });

  ui.btnFirefox.addEventListener('click', async () => {
    const result = await window.smartnet.launchFirefox({ startUrl: 'https://example.com' });
    if (!result.ok) showToast(result.error, 'err');
    else showToast(`Launched Firefox (pid ${result.info.pid})`, 'ok');
  });

  ui.btnOpenRepeater.addEventListener('click', async () => {
    const result = await window.smartnet.openRepeater();
    if (!result.ok) showToast(result.error || 'Could not open Repeater', 'err');
  });

  ui.btnSearch.addEventListener('click', async () => {
    await window.smartnet.setSearchDomainScope(ui.filterDomain.value);
    const result = await window.smartnet.openSearch();
    if (!result.ok) showToast(result.error || 'Could not open Advanced Search', 'err');
  });

  ui.btnSendRepeater.addEventListener('click', async () => {
    const entry = selectedId ? entries.get(selectedId) : null;
    if (!entry) {
      showToast('Select a request from history first', 'err');
      return;
    }
    const result = await window.smartnet.addRepeaterSession(entry);
    if (!result.ok) {
      showToast(result.error || 'Could not send request to Repeater', 'err');
      return;
    }
    showToast(`Sent #${entry.seq} to Repeater`, 'ok');
  });

  ui.btnExportCa.addEventListener('click', async () => {
    const result = await window.smartnet.exportCA();
    if (result.canceled) return;
    if (!result.ok) showToast(result.error, 'err');
    else showToast(`CA exported to ${result.filePath}`, 'ok');
  });

  ui.btnConfig.addEventListener('click', async () => {
    const result = await window.smartnet.openConfig();
    if (!result.ok) showToast(result.error || 'Could not open settings', 'err');
  });

  ui.btnHelp.addEventListener('click', async () => {
    const result = await window.smartnet.openHelp();
    if (!result.ok) showToast(result.error || 'Could not open Help', 'err');
  });

  ui.btnClear.addEventListener('click', async () => {
    const keepIds = [...selectedIds];
    const result = await window.smartnet.clearHistory(keepIds);
    const kept = result?.keptIds || keepIds;
    clearAll(kept);
    showToast(
      kept.length
        ? `Cleared history · kept ${kept.length} selected`
        : 'History cleared'
    );
  });

  ui.btnApplyJs.addEventListener('click', async () => {
    const source = ui.filterJs.value;
    const applyToExisting = ui.filterJsScope?.value === 'existing';
    const result = await window.smartnet.setJsFilter(source, {
      applyToExisting,
      domainScope: ui.filterDomain.value,
    });
    if (!result.ok) {
      ui.filterJsStatus.textContent = result.error;
      ui.filterJsStatus.className = 'filter-js-status err';
      showToast(result.error, 'err');
    } else {
      const removed = Number(result.removed) || 0;
      if (applyToExisting) {
        ui.filterJsStatus.textContent = source.trim()
          ? `Applied to history (−${removed})`
          : 'JS filter cleared';
        showToast(
          source.trim()
            ? `JS filter applied to in-scope history (${removed} removed)`
            : 'JS filter cleared',
          'ok'
        );
      } else {
        ui.filterJsStatus.textContent = source.trim() ? 'JS filter active' : 'JS filter cleared';
        showToast('JS filter applied — affects newly captured traffic', 'ok');
      }
      ui.filterJsStatus.className = 'filter-js-status ok';
    }
  });

  ui.filterDomain.addEventListener('input', () => {
    rerenderDebounced();
    window.smartnet.setSearchDomainScope(ui.filterDomain.value);
  });
  ui.filterCtype.addEventListener('input', rerenderDebounced);

  ui.trafficBody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (!tr || !tr.dataset.id) return;
    selectEntry(tr.dataset.id, { additive: e.ctrlKey || e.metaKey });
  });

  document.querySelectorAll('.inspector-tabs .tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      switchInspectorPanel(tab.dataset.panel);
    });
  });

  function wireSubtabs(container) {
    container.querySelectorAll('.subtab').forEach((btn) => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('.subtab').forEach((s) => s.classList.remove('active'));
        btn.classList.add('active');
        activeView = btn.dataset.view;
        // Mirror active view on the other panel's subtabs
        const other = container === ui.subtabsRequest ? ui.subtabsResponse : ui.subtabsRequest;
        other.querySelectorAll('.subtab').forEach((s) => {
          s.classList.toggle('active', s.dataset.view === activeView);
        });
        renderInspector();
      });
    });
  }
  wireSubtabs(ui.subtabsRequest);
  wireSubtabs(ui.subtabsResponse);

  for (const el of [ui.repeaterMethod, ui.repeaterUrl, ui.repeaterHeaders, ui.repeaterBody]) {
    el.addEventListener('input', () => {
      markRepeaterDirty();
      if (activePanel === 'repeater') {
        ui.inspectorMeta.textContent = ui.repeaterUrl.value
          ? `${ui.repeaterMethod.value || 'GET'} ${ui.repeaterUrl.value}`
          : 'Edit request and resend';
      }
    });
  }

  ui.btnLoadRepeater.addEventListener('click', () => {
    const entry = selectedId ? entries.get(selectedId) : null;
    if (!entry) {
      showToast('Select a request from the history table first', 'err');
      return;
    }
    loadEntryIntoRepeater(entry);
    showToast(`Loaded request #${entry.seq} into Repeater`, 'ok');
  });

  ui.btnResend.addEventListener('click', async () => {
    if (resending) return;
    try {
      const method = (ui.repeaterMethod.value || 'GET').trim().toUpperCase();
      const url = (ui.repeaterUrl.value || '').trim();
      if (!url) {
        ui.repeaterStatus.textContent = 'URL required';
        ui.repeaterStatus.className = 'repeater-status err';
        showToast('Enter a request URL before resending', 'err');
        return;
      }

      const isBodyless = method === 'GET' || method === 'HEAD';
      let headersText = ui.repeaterHeaders.value || '';
      if (isBodyless) {
        headersText = headersText
          .split(/\r?\n/)
          .filter(
            (line) =>
              line.trim() &&
              !/^(content-length|content-type|content-encoding|transfer-encoding)\s*:/i.test(
                line.trim()
              )
          )
          .join('\n');
        ui.repeaterHeaders.value = headersText;
        ui.repeaterBody.value = '';
      }

      resending = true;
      ui.btnResend.disabled = true;
      ui.repeaterStatus.textContent = 'Sending…';
      ui.repeaterStatus.className = 'repeater-status';

      const result = await window.smartnet.resendRequest({
        method,
        url,
        headers: headersText,
        body: isBodyless ? '' : ui.repeaterBody.value,
      });
      if (!result.ok) {
        ui.repeaterStatus.textContent = result.error || 'Resend failed';
        ui.repeaterStatus.className = 'repeater-status err';
        showToast(result.error || 'Resend failed', 'err');
        return;
      }

      addEntry(result.entry);
      selectedIds = new Set([result.entry.id]);
      selectedId = result.entry.id;
      repeaterDirty = false;
      ui.repeaterStatus.textContent = `${result.entry.status} · ${result.entry.durationMs} ms`;
      ui.repeaterStatus.className = 'repeater-status ok';
      showToast(`Resent → ${result.entry.status}`, 'ok');
      switchInspectorPanel('response');
      renderTable();
    } catch (err) {
      ui.repeaterStatus.textContent = err.message || String(err);
      ui.repeaterStatus.className = 'repeater-status err';
      showToast(err.message || String(err), 'err');
    } finally {
      resending = false;
      ui.btnResend.disabled = false;
    }
  });

  // ——— IPC subscriptions ———

  function applyAdvancedSearchResults(payload) {
    const ids = new Set((payload?.matches || []).map((match) => match.id));
    const query = payload?.query || null;
    advancedSearch = {
      active: Boolean(payload?.active),
      focus: Boolean(payload?.focus),
      ids,
      matcher: query?.pattern
        ? buildSearchMatcher(
            query.pattern,
            query.mode === 'regex',
            Boolean(query.caseSensitive)
          )
        : null,
    };
    if (advancedSearch.focus && selectedId && !ids.has(selectedId)) {
      const nextId = payload.matches?.[0]?.id || null;
      selectedId = nextId;
      selectedIds = nextId ? new Set([nextId]) : new Set();
    }
    renderTable();
    renderInspector();
    showToast(
      advancedSearch.active
        ? `${ids.size} advanced search match${ids.size === 1 ? '' : 'es'}${advancedSearch.focus ? ' — focus enabled' : ''}`
        : 'Advanced search cleared',
      ids.size ? 'ok' : ''
    );
  }

  window.smartnet.onEntry(addEntry);
  window.smartnet.onEntryRemoved(removeEntry);
  window.smartnet.onCleared((payload) => clearAll(payload?.keptIds || []));
  window.smartnet.onState(applyProxyState);
  window.smartnet.onError((payload) => {
    showToast(payload.message || 'Proxy error', 'err');
  });
  window.smartnet.onFilterError((info) => {
    const message = info && info.error ? String(info.error) : 'Filter execution failed';
    ui.filterJsStatus.textContent = `Runtime: ${message}`;
    ui.filterJsStatus.className = 'filter-js-status err';
  });
  window.smartnet.onResponseTransformError((info) => {
    const message = info?.error || 'Automatic response transform failed';
    ui.responseHookStatus.className = 'held-editor-error';
    ui.responseHookStatus.textContent = `Runtime: ${message}`;
    showToast(`Response hook: ${message}`, 'err');
  });
  window.smartnet.onSearchResults(applyAdvancedSearchResults);
  window.smartnet.onSearchSelect((id) => {
    if (!entries.has(id)) return;
    selectEntry(id);
    ui.trafficBody.querySelector(`tr[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({
      block: 'center',
    });
  });
  window.smartnet.onConfigChanged((next) => {
    applyConfig(next);
    showToast('Configuration saved', 'ok');
  });

  // ——— Boot ———

  initSplitter();
  renderTable();
  renderInspector();

  (async function boot() {
    try {
      const loadedConfig = await window.smartnet.getConfig();
      if (loadedConfig.ok) applyConfig(loadedConfig.settings);
      const state = await window.smartnet.getState();
      applyProxyState(state);
      const history = await window.smartnet.getHistory();
      if (Array.isArray(history)) {
        for (const entry of history) addEntry(entry);
      }
      const searchState = await window.smartnet.getAdvancedSearchState();
      if (searchState?.active && searchState.result) {
        applyAdvancedSearchResults({ ...searchState.result, active: true });
      }
      const js = await window.smartnet.getJsFilter();
      if (js.ok && js.source) ui.filterJs.value = js.source;
    } catch (err) {
      showToast(err.message || String(err), 'err');
    }
  })();
})();
