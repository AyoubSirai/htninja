'use strict';

(function () {
  const requestRawEditor = window.SmartNetCodeEditor.create(
    document.getElementById('request-raw')
  );
  const fetchCodeEditor = window.SmartNetCodeEditor.createJavaScript(
    document.getElementById('fetch-code')
  );
  fetchCodeEditor.disabled = true;
  const ui = {
    tabs: document.getElementById('request-tabs'),
    newTab: document.getElementById('new-tab'),
    newTabPlus: document.getElementById('new-tab-plus'),
    duplicateTab: document.getElementById('duplicate-tab'),
    sessionCount: document.getElementById('session-count'),
    send: document.getElementById('send-request'),
    copyAsFetch: document.getElementById('copy-as-fetch'),
    method: document.getElementById('request-method'),
    url: document.getElementById('request-url'),
    raw: requestRawEditor,
    sendState: document.getElementById('send-state'),
    responseOutput: document.getElementById('response-output'),
    responseMeta: document.getElementById('response-meta'),
    saveState: document.getElementById('save-state'),
    fetchDialog: document.getElementById('fetch-dialog'),
    fetchForm: document.getElementById('fetch-dialog-form'),
    fetchClose: document.getElementById('fetch-dialog-close'),
    fetchCancel: document.getElementById('fetch-dialog-cancel'),
    fetchCopy: document.getElementById('fetch-dialog-copy'),
    fetchCode: fetchCodeEditor,
    fetchStatus: document.getElementById('fetch-dialog-status'),
    requestFind: document.getElementById('request-find'),
    requestFindPrev: document.getElementById('request-find-prev'),
    requestFindNext: document.getElementById('request-find-next'),
    requestFindCase: document.getElementById('request-find-case'),
    requestFindRegex: document.getElementById('request-find-regex'),
    requestFindCount: document.getElementById('request-find-count'),
    responseFind: document.getElementById('response-find'),
    responseFindPrev: document.getElementById('response-find-prev'),
    responseFindNext: document.getElementById('response-find-next'),
    responseFindCase: document.getElementById('response-find-case'),
    responseFindRegex: document.getElementById('response-find-regex'),
    responseFindCount: document.getElementById('response-find-count'),
  };

  let sessions = [];
  let activeId = null;
  let responseView = 'pretty';
  let saveTimer = null;
  let sending = false;
  let activeFindTarget = 'request';
  const findState = {
    request: { matches: [], index: -1 },
    response: { matches: [], index: -1 },
  };

  function activeSession() {
    return sessions.find((session) => session.id === activeId) || null;
  }

  function deriveTitle(session) {
    const method = (session.method || 'GET').toUpperCase();
    if (!session.url) return `${method} request`;
    try {
      const parsed = new URL(session.url);
      return `${method} ${parsed.hostname}${parsed.pathname}`;
    } catch {
      return `${method} request`;
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function findControls(target) {
    const prefix = target === 'request' ? 'request' : 'response';
    return {
      input: ui[`${prefix}Find`],
      caseSensitive: ui[`${prefix}FindCase`],
      regex: ui[`${prefix}FindRegex`],
      count: ui[`${prefix}FindCount`],
      root: target === 'response' ? ui.responseOutput : null,
    };
  }

  function findMatches(source, query, useRegex, caseSensitive) {
    if (!query) return { matches: [], error: '' };
    let regex;
    try {
      regex = useRegex
        ? new RegExp(query, `${caseSensitive ? '' : 'i'}gm`)
        : new RegExp(
            query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
            `${caseSensitive ? '' : 'i'}g`
          );
    } catch (err) {
      return { matches: [], error: err.message };
    }
    const matches = [];
    let match;
    let guard = 0;
    while ((match = regex.exec(source)) !== null && guard++ < 10_000) {
      if (match[0].length === 0) {
        regex.lastIndex += 1;
        continue;
      }
      matches.push({ start: match.index, end: match.index + match[0].length });
    }
    return { matches, error: '' };
  }

  function rangesForOffsets(root, offsets) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let total = 0;
    let node;
    while ((node = walker.nextNode())) {
      nodes.push({ node, start: total, end: total + node.data.length });
      total += node.data.length;
    }
    return offsets.flatMap(({ start, end }) => {
      const startNode = nodes.find((item) => start >= item.start && start < item.end);
      const endNode = nodes.find((item) => end > item.start && end <= item.end);
      if (!startNode || !endNode) return [];
      const range = document.createRange();
      range.setStart(startNode.node, start - startNode.start);
      range.setEnd(endNode.node, end - endNode.start);
      return [range];
    });
  }

  function paintFindHighlights(target) {
    const state = findState[target];
    if (target === 'request') {
      ui.raw.setSearchMatches(state.matches, state.index);
      return;
    }
    if (!CSS.highlights || typeof Highlight === 'undefined') return;
    const controls = findControls(target);
    const allName = `${target}-search`;
    const currentName = `${target}-search-current`;
    CSS.highlights.delete(allName);
    CSS.highlights.delete(currentName);
    if (!state.matches.length) return;
    const ranges = rangesForOffsets(controls.root, state.matches);
    CSS.highlights.set(allName, new Highlight(...ranges));
    const current = ranges[state.index];
    if (current) CSS.highlights.set(currentName, new Highlight(current));
  }

  function refreshFind(target, preserveIndex = false) {
    const controls = findControls(target);
    const state = findState[target];
    const source = target === 'request' ? ui.raw.value : ui.responseOutput.textContent;
    const result = findMatches(
      source,
      controls.input.value,
      controls.regex.checked,
      controls.caseSensitive.checked
    );
    state.matches = result.matches;
    state.index = preserveIndex && state.matches.length
      ? Math.min(Math.max(state.index, 0), state.matches.length - 1)
      : state.matches.length
        ? 0
        : -1;
    controls.count.textContent = result.error
      ? 'Invalid'
      : state.matches.length
        ? `${state.index + 1} / ${state.matches.length}`
        : '0 / 0';
    controls.count.title = result.error || '';
    paintFindHighlights(target);
  }

  function revealFindMatch(target, direction) {
    const state = findState[target];
    if (!state.matches.length) return;
    state.index =
      (state.index + direction + state.matches.length) % state.matches.length;
    const controls = findControls(target);
    controls.count.textContent = `${state.index + 1} / ${state.matches.length}`;
    paintFindHighlights(target);
    const match = state.matches[state.index];
    if (target === 'request') {
      ui.raw.focus({ preventScroll: true });
      ui.raw.setSelectionRange(match.start, match.end);
      return;
    }
    const current = rangesForOffsets(ui.responseOutput, [match])[0];
    const rect = current?.getBoundingClientRect();
    const containerRect = ui.responseOutput.getBoundingClientRect();
    if (rect && (rect.top < containerRect.top || rect.bottom > containerRect.bottom)) {
      ui.responseOutput.scrollTop += rect.top - containerRect.top - containerRect.height / 3;
    }
  }

  function renderTabs() {
    ui.tabs.innerHTML = sessions
      .map((session) => {
        const title = session.title || deriveTitle(session);
        return `
          <button
            class="request-tab${session.id === activeId ? ' active' : ''}"
            data-id="${escapeHtml(session.id)}"
            type="button"
            role="tab"
            title="${escapeHtml(title)}"
          >
            <span class="request-tab-label">${escapeHtml(title)}</span>
            <span class="request-tab-close" data-close="${escapeHtml(session.id)}" title="Close">×</span>
          </button>
        `;
      })
      .join('');
    ui.sessionCount.textContent = `${sessions.length} request${sessions.length === 1 ? '' : 's'}`;

    requestAnimationFrame(() => {
      ui.tabs.querySelector('.request-tab.active')?.scrollIntoView({
        block: 'nearest',
        inline: 'nearest',
      });
    });
  }

  function ensureMethodOption(method) {
    const value = String(method || 'GET').toUpperCase();
    if (![...ui.method.options].some((option) => option.value === value)) {
      ui.method.add(new Option(value, value));
    }
    ui.method.value = value;
  }

  function prettyJsonRequestBody(body, headers) {
    const source = String(body || '');
    const contentTypeLine = String(headers || '')
      .split(/\r?\n/)
      .find((line) => /^content-type\s*:/i.test(line));
    const contentType = contentTypeLine
      ? contentTypeLine.slice(contentTypeLine.indexOf(':') + 1).toLowerCase()
      : '';
    const trimmed = source.trim();
    const looksJson =
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'));
    if (!contentType.includes('json') && !looksJson) return null;
    try {
      return JSON.stringify(JSON.parse(source), null, 4);
    } catch {
      return null;
    }
  }

  function utf8ByteLength(value) {
    return new TextEncoder().encode(String(value || '')).length;
  }

  function updateContentLengthHeaders(headerText, method, body) {
    const lines = String(headerText || '').split(/\r?\n/);
    const byteLength = utf8ByteLength(body);
    const include = byteLength > 0 || !['GET', 'HEAD'].includes(String(method).toUpperCase());
    let found = false;
    const updated = [];

    for (const line of lines) {
      if (!/^content-length\s*:/i.test(line)) {
        if (line) updated.push(line);
        continue;
      }
      if (!include || found) continue;
      const name = line.slice(0, line.indexOf(':')).trim() || 'Content-Length';
      updated.push(`${name}: ${byteLength}`);
      found = true;
    }
    if (include && !found) updated.push(`Content-Length: ${byteLength}`);
    return updated.join('\n');
  }

  function syncRawContentLength() {
    const source = String(ui.raw.value || '').replace(/\r\n/g, '\n');
    const separator = source.indexOf('\n\n');
    if (separator < 0) return;

    const head = source.slice(0, separator);
    const body = source.slice(separator + 2);
    const lines = head.split('\n');
    const requestLine = lines.shift() || '';
    const methodMatch = requestLine.match(/^([A-Za-z][A-Za-z0-9-]{0,19})\s+/);
    if (!methodMatch) return;

    const nextHeaders = updateContentLengthHeaders(
      lines.join('\n'),
      methodMatch[1],
      body
    );
    const next = `${requestLine}${nextHeaders ? `\n${nextHeaders}` : ''}\n\n${body}`;
    if (next === source) return;

    const oldBodyStart = separator + 2;
    const newBodyStart = next.indexOf('\n\n') + 2;
    const selectionStart = ui.raw.selectionStart;
    const selectionEnd = ui.raw.selectionEnd;
    const delta = newBodyStart - oldBodyStart;
    ui.raw.value = next;
    ui.raw.setSelectionRange(
      selectionStart >= oldBodyStart ? selectionStart + delta : selectionStart,
      selectionEnd >= oldBodyStart ? selectionEnd + delta : selectionEnd
    );
  }

  function stripBodyHeaders(headerText) {
    return String(headerText || '')
      .split(/\r?\n/)
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        return !/^(content-length|content-type|content-encoding|transfer-encoding)\s*:/i.test(
          trimmed
        );
      })
      .join('\n');
  }

  function applyMethodConstraints(session) {
    const method = String(session.method || 'GET').toUpperCase();
    session.method = method;
    if (method === 'GET' || method === 'HEAD') {
      session.body = '';
      session.headers = stripBodyHeaders(session.headers);
    }
    return session;
  }

  function buildRawRequest(session) {
    let target = '/';
    try {
      const parsed = new URL(session.url);
      target = parsed.pathname + parsed.search || '/';
    } catch {
      // Keep the default target for a new/incomplete request.
    }
    applyMethodConstraints(session);
    const originalBody = String(session.body || '');
    const originalHeaders = String(session.headers || '');
    const body = prettyJsonRequestBody(originalBody, originalHeaders) ?? originalBody;
    const headers = updateContentLengthHeaders(
      originalHeaders,
      session.method || 'GET',
      body
    ).replace(/\r?\n/g, '\r\n');
    const bodyPart =
      session.method === 'GET' || session.method === 'HEAD' ? '' : body;
    return `${session.method || 'GET'} ${target} HTTP/1.1\r\n${headers}${headers ? '\r\n' : ''}\r\n${bodyPart}`;
  }

  function parseRawRequest(raw, session) {
    const normalized = String(raw || '').replace(/\r\n/g, '\n');
    const separator = normalized.indexOf('\n\n');
    const head = separator >= 0 ? normalized.slice(0, separator) : normalized;
    const body = separator >= 0 ? normalized.slice(separator + 2) : '';
    const lines = head.split('\n');
    const requestLine = (lines.shift() || '').trim();
    const match = requestLine.match(/^([A-Za-z][A-Za-z0-9-]{0,19})\s+(\S+)\s+HTTP\/\d(?:\.\d)?$/i);

    session.headers = lines.join('\n');
    session.body = body;
    session.rawError = '';

    if (!match) {
      session.rawError = 'Request line must use: METHOD /path HTTP/1.1';
      return false;
    }

    session.method = match[1].toUpperCase();
    const target = match[2];
    try {
      if (/^https?:\/\//i.test(target)) {
        session.url = new URL(target).href;
      } else if (session.url) {
        session.url = new URL(target, session.url).href;
      } else {
        const hostLine = lines.find((line) => /^host\s*:/i.test(line));
        const host = hostLine ? hostLine.slice(hostLine.indexOf(':') + 1).trim() : '';
        if (host) session.url = new URL(target, `http://${host}`).href;
      }
    } catch {
      session.rawError = 'The request target or Host header is invalid.';
      return false;
    }

    ensureMethodOption(session.method);
    ui.url.value = session.url || '';
    return true;
  }

  function populateEditor() {
    const session = activeSession();
    const disabled = !session;
    for (const element of [ui.method, ui.url, ui.raw, ui.send, ui.copyAsFetch]) {
      element.disabled = disabled;
    }

    if (!session) {
      ui.url.value = '';
      ui.raw.value = '';
      renderRequestHighlight();
      ui.responseMeta.textContent = 'No response';
      ui.responseOutput.textContent = 'Create or select a request.';
      return;
    }

    ensureMethodOption(session.method);
    ui.url.value = session.url || '';
    ui.raw.value = buildRawRequest(session);
    renderRequestHighlight();
    setSendState(session.response ? 'Complete' : 'Ready', session.response ? 'ok' : '');
    renderResponse();
  }

  function selectSession(id) {
    if (!sessions.some((session) => session.id === id)) return;
    if (id === activeId) return;
    // Persist the current tab into its session object before switching so a
    // later async save cannot read the next tab's editor into this session.
    const previous = activeSession();
    if (previous) {
      syncRawContentLength();
      parseRawRequest(ui.raw.value, previous);
      applyMethodConstraints(previous);
      previous.title = deriveTitle(previous);
      previous.updatedAt = Date.now();
    }
    clearTimeout(saveTimer);
    saveTimer = null;
    activeId = id;
    renderTabs();
    populateEditor();
    scheduleSave();
  }

  function collectEditor() {
    const session = activeSession();
    if (!session) return null;
    syncRawContentLength();
    parseRawRequest(ui.raw.value, session);
    // Dropdown is authoritative for method/url when the user edits those controls.
    if (ui.method.value) session.method = String(ui.method.value).toUpperCase();
    if (ui.url.value.trim()) session.url = ui.url.value.trim();
    applyMethodConstraints(session);
    session.title = deriveTitle(session);
    session.updatedAt = Date.now();
    return session;
  }

  function scheduleSave() {
    collectEditor();
    renderTabs();
    ui.saveState.textContent = 'Unsaved';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => flushSave(), 350);
  }

  async function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const session = collectEditor();
    if (!session) return;
    // Snapshot fields before awaiting so a tab switch cannot mutate this save.
    const snapshot = {
      id: session.id,
      title: session.title,
      method: session.method,
      url: session.url,
      headers: session.headers,
      body: session.body,
      response: session.response,
    };
    const result = await window.smartnet.updateRepeaterSession(snapshot.id, {
      title: snapshot.title,
      method: snapshot.method,
      url: snapshot.url,
      headers: snapshot.headers,
      body: snapshot.body,
      response: snapshot.response,
    });
    if (activeId === snapshot.id) {
      ui.saveState.textContent = result.ok ? 'Saved' : 'Save failed';
    }
  }

  function setSendState(text, type = '') {
    ui.sendState.textContent = text;
    ui.sendState.className = `send-state${type ? ` ${type}` : ''}`;
  }

  function headersText(headers) {
    return Object.entries(headers || {})
      .map(([name, value]) => `${name}: ${value}`)
      .join('\n');
  }

  function responseRaw(response) {
    if (!response) return 'No response yet.';
    const statusLine = `HTTP/1.1 ${response.status ?? ''}`;
    const headers = headersText(response.responseHeaders);
    return `${statusLine}\r\n${headers}\r\n\r\n${response.responseBody || ''}`;
  }

  function appendSyntax(parent, text, className = '') {
    if (!text) return;
    if (!className) {
      parent.append(document.createTextNode(text));
      return;
    }
    const span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    parent.append(span);
  }

  function responseLanguage(response, body) {
    const type = String(response.contentType || '').toLowerCase();
    const trimmed = String(body || '').trimStart();
    if (type.includes('application/x-www-form-urlencoded')) return 'form';
    if (type.includes('json') || /^[{[]/.test(trimmed)) return 'json';
    if (type.includes('html')) return 'html';
    if (type.includes('xml') || trimmed.startsWith('<?xml')) return 'xml';
    if (type.includes('javascript') || type.includes('ecmascript')) return 'javascript';
    if (type.includes('css')) return 'css';
    if (/^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/.test(trimmed.trim())) return 'form';
    return 'text';
  }

  function formatMarkup(source) {
    const lines = String(source).replace(/>\s*</g, '>\n<').split('\n');
    let depth = 0;
    return lines
      .map((line) => {
        const value = line.trim();
        if (/^<\//.test(value)) depth = Math.max(0, depth - 1);
        const formatted = `${'    '.repeat(depth)}${value}`;
        if (
          /^<[^!?/][^>]*>$/.test(value) &&
          !/\/>$/.test(value) &&
          !/<\/[^>]+>$/.test(value) &&
          !/^<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b/i.test(value)
        ) {
          depth += 1;
        }
        return formatted;
      })
      .join('\n');
  }

  function formatCss(source) {
    let depth = 0;
    return String(source)
      .replace(/\s*{\s*/g, ' {\n')
      .replace(/;\s*/g, ';\n')
      .replace(/\s*}\s*/g, '\n}\n')
      .split('\n')
      .map((line) => {
        const value = line.trim();
        if (value === '}') depth = Math.max(0, depth - 1);
        const formatted = value ? `${'    '.repeat(depth)}${value}` : '';
        if (value.endsWith('{')) depth += 1;
        return formatted;
      })
      .filter((line, index, lines) => line || (index > 0 && lines[index - 1]))
      .join('\n')
      .trim();
  }

  function formatResponseBody(body, language) {
    if (!body) return '(Empty response body)';
    if (language === 'json') {
      try {
        return JSON.stringify(JSON.parse(body), null, 4);
      } catch {
        return body;
      }
    }
    if (language === 'html' || language === 'xml') return formatMarkup(body);
    if (language === 'css') return formatCss(body);
    return body;
  }

  function syntaxClass(token, language) {
    if (/^\/[/*]/.test(token) || /^<!--/.test(token)) return 'syntax-comment';
    if ((language === 'html' || language === 'xml') && /^</.test(token)) return 'syntax-tag';
    if (/^"(?:\\.|[^"\\])*"\s*:$/s.test(token)) return 'syntax-property';
    if (/^['"`]/.test(token)) return 'syntax-string';
    if (/^(true|false|null|undefined)$/i.test(token)) return 'syntax-literal';
    if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(token)) return 'syntax-number';
    if (/^[A-Za-z_$][\w$-]*\s*(?=:)/.test(token)) return 'syntax-property';
    return 'syntax-keyword';
  }

  function highlightFormEncoded(parent, source) {
    let expectingName = true;
    for (const part of String(source).split(/([&=])/)) {
      if (part === '&') {
        appendSyntax(parent, part, 'syntax-punctuation');
        expectingName = true;
      } else if (part === '=') {
        appendSyntax(parent, part, 'syntax-punctuation');
        expectingName = false;
      } else {
        appendSyntax(parent, part, expectingName ? 'syntax-property' : 'syntax-string');
      }
    }
  }

  function highlightCode(parent, source, language) {
    if (language === 'form') {
      highlightFormEncoded(parent, source);
      return;
    }
    if (language === 'text') {
      appendSyntax(parent, source);
      return;
    }
    const pattern = language === 'html' || language === 'xml'
      ? /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>|&(?:#\d+|#x[\da-f]+|[\w]+);/gi
      : /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|-?(?:\b\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?\b|\b(?:true|false|null|undefined|const|let|var|function|return|if|else|for|while|class|new|async|await|import|export|throw|try|catch)\b|[A-Za-z_$][\w$-]*\s*(?=:)|[{}\[\]:,]/gim;
    let cursor = 0;
    for (const match of source.matchAll(pattern)) {
      appendSyntax(parent, source.slice(cursor, match.index));
      const token = match[0];
      const className = /^[{}\[\]:,]$/.test(token)
        ? 'syntax-punctuation'
        : syntaxClass(token, language);
      appendSyntax(parent, token, className);
      cursor = match.index + match[0].length;
    }
    appendSyntax(parent, source.slice(cursor));
  }

  function renderRequestHighlight() {
    refreshFind('request', true);
  }

  function renderPrettyResponse(response) {
    ui.responseOutput.replaceChildren();
    appendSyntax(ui.responseOutput, `HTTP/1.1 ${response.status ?? ''}`, 'syntax-status');
    appendSyntax(ui.responseOutput, '\n');
    for (const [name, value] of Object.entries(response.responseHeaders || {})) {
      appendSyntax(ui.responseOutput, name, 'syntax-header-name');
      appendSyntax(ui.responseOutput, ': ', 'syntax-punctuation');
      appendSyntax(ui.responseOutput, String(value), 'syntax-header-value');
      appendSyntax(ui.responseOutput, '\n');
    }
    const body = response.responseBody || '';
    const language = responseLanguage(response, body);
    const prettyBody = formatResponseBody(body, language);
    if (prettyBody) {
      appendSyntax(ui.responseOutput, '\n');
      highlightCode(ui.responseOutput, prettyBody, language);
    }
  }

  function renderResponse() {
    const response = activeSession()?.response || null;
    if (!response) {
      ui.responseMeta.textContent = 'No response';
      ui.responseOutput.textContent = 'Click Send to issue this request.';
      refreshFind('response', true);
      return;
    }

    ui.responseMeta.textContent =
      `${response.status ?? '?'} · ${response.durationMs ?? '?'} ms · ${formatBytes(response.contentLength)}`;

    if (responseView === 'raw') {
      ui.responseOutput.textContent = responseRaw(response);
    } else if (responseView === 'headers') {
      ui.responseOutput.textContent = headersText(response.responseHeaders) || '(No response headers)';
    } else {
      renderPrettyResponse(response);
    }
    refreshFind('response', true);
  }

  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes)) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  async function addSession(source = {}) {
    await flushSave();
    const result = await window.smartnet.addRepeaterSession({
      method: source.method || 'GET',
      url: source.url || '',
      headers: source.headers || '',
      body: source.body || '',
      title: source.title || '',
    });
    if (!result.ok) {
      setSendState(result.error || 'Could not create request', 'err');
      return;
    }
    if (!sessions.some((session) => session.id === result.session.id)) {
      sessions.push(result.session);
    }
    activeId = result.session.id;
    renderTabs();
    populateEditor();
    ui.url.focus();
  }

  async function closeSession(id) {
    const originalIndex = sessions.findIndex((session) => session.id === id);
    if (originalIndex < 0) return;
    const wasActive = id === activeId;
    const result = await window.smartnet.removeRepeaterSession(id);
    if (!result.ok) {
      setSendState(result.error || 'Could not close request', 'err');
      return;
    }
    const remainingIndex = sessions.findIndex((session) => session.id === id);
    if (remainingIndex >= 0) sessions.splice(remainingIndex, 1);
    if (wasActive) {
      activeId = sessions[Math.min(originalIndex, sessions.length - 1)]?.id || null;
    }
    renderTabs();
    populateEditor();
    if (sessions.length === 0) await addSession();
  }

  function jsString(value) {
    return JSON.stringify(String(value ?? ''));
  }

  function parseSessionHeaders(headerText) {
    const headers = {};
    for (const line of String(headerText || '').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.startsWith(':') ? trimmed.indexOf(':', 1) : trimmed.indexOf(':');
      if (idx <= 0) continue;
      const name = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      if (!name || name.startsWith(':')) continue;
      if (headers[name] != null) headers[name] = `${headers[name]}, ${value}`;
      else headers[name] = value;
    }
    return headers;
  }

  function headersForFetch(headers) {
    const skipped = new Set([
      'host',
      'connection',
      'content-length',
      'transfer-encoding',
      'keep-alive',
      'proxy-connection',
      'upgrade',
      'te',
      'trailer',
      'accept-encoding',
    ]);
    const out = {};
    for (const [name, value] of Object.entries(headers || {})) {
      if (skipped.has(String(name).toLowerCase())) continue;
      out[name] = value;
    }
    return out;
  }

  function bodyForFetch(body, headers) {
    const source = String(body || '');
    const contentTypeEntry = Object.entries(headers || {}).find(
      ([name]) => String(name).toLowerCase() === 'content-type'
    );
    const contentType = String(contentTypeEntry?.[1] || '').toLowerCase();
    const trimmed = source.trim();
    const looksJson =
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'));
    if (!contentType.includes('json') && !looksJson) return source;
    try {
      return JSON.stringify(JSON.parse(source));
    } catch {
      return source;
    }
  }

  function buildFetchSnippet(session) {
    const method = String(session.method || 'GET').toUpperCase();
    const url = String(session.url || '').trim();
    const headers = headersForFetch(parseSessionHeaders(session.headers));
    const body = bodyForFetch(session.body, headers);
    const includeBody = body.length > 0 && method !== 'GET' && method !== 'HEAD';
    const headerEntries = Object.entries(headers);
    const lines = [];
    lines.push('const response = await fetch(');
    lines.push(`  ${jsString(url)},`);
    lines.push('  {');
    lines.push(`    method: ${jsString(method)},`);
    if (headerEntries.length) {
      lines.push('    headers: {');
      for (const [name, value] of headerEntries) {
        lines.push(`      ${jsString(name)}: ${jsString(value)},`);
      }
      lines.push('    },');
    }
    if (includeBody) {
      lines.push(`    body: ${jsString(body)},`);
    }
    lines.push('  }');
    lines.push(');');
    lines.push('');
    lines.push('console.log(response.status, await response.text());');
    return lines.join('\n');
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.append(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      textarea.remove();
      return ok;
    }
  }

  function openFetchDialog() {
    const session = collectEditor();
    if (!session) return;
    if (session.rawError) {
      setSendState(session.rawError, 'err');
      return;
    }
    if (!session.url) {
      setSendState('URL required', 'err');
      ui.url.focus();
      return;
    }
    ui.fetchCode.value = buildFetchSnippet(session);
    ui.fetchStatus.textContent = '';
    ui.fetchStatus.className = 'held-editor-error';
    ui.fetchDialog.showModal();
    ui.fetchCode.focus();
  }

  async function sendRequest() {
    if (sending) return;
    const session = collectEditor();
    if (!session) return;
    if (session.rawError) {
      setSendState(session.rawError, 'err');
      ui.raw.focus();
      return;
    }
    if (!session.url) {
      setSendState('URL required', 'err');
      ui.url.focus();
      return;
    }

    applyMethodConstraints(session);
    // Rebuild the visible editor so GET/HEAD never keep a stale POST body.
    ui.raw.value = buildRawRequest(session);
    renderRequestHighlight();

    const payload = {
      method: session.method,
      url: session.url,
      headers: session.headers,
      body: session.body,
    };

    sending = true;
    ui.send.disabled = true;
    setSendState('Sending…', 'sending');
    await flushSave();

    try {
      const result = await window.smartnet.resendRequest(payload);
      if (!result.ok) {
        setSendState(result.error || 'Request failed', 'err');
        return;
      }

      session.response = result.entry;
      setSendState(`${result.entry.status} · ${result.entry.durationMs} ms`, 'ok');
      renderResponse();
      await window.smartnet.updateRepeaterSession(session.id, {
        title: session.title,
        method: session.method,
        url: session.url,
        headers: session.headers,
        body: session.body,
        response: session.response,
      });
    } catch (err) {
      setSendState(err.message || String(err), 'err');
    } finally {
      sending = false;
      ui.send.disabled = false;
    }
  }

  ui.tabs.addEventListener('click', (event) => {
    const close = event.target.closest('[data-close]');
    if (close) {
      event.stopPropagation();
      closeSession(close.dataset.close);
      return;
    }
    const tab = event.target.closest('.request-tab');
    if (tab) selectSession(tab.dataset.id);
  });

  ui.newTab.addEventListener('click', () => addSession());
  ui.newTabPlus.addEventListener('click', () => addSession());
  ui.duplicateTab.addEventListener('click', () => {
    const session = collectEditor();
    if (!session) return addSession();
    addSession({
      ...session,
      title: `${session.title || deriveTitle(session)} copy`,
      response: null,
    });
  });
  ui.send.addEventListener('click', sendRequest);
  ui.copyAsFetch.addEventListener('click', openFetchDialog);
  ui.fetchForm.addEventListener('submit', (event) => event.preventDefault());
  ui.fetchClose.addEventListener('click', () => ui.fetchDialog.close());
  ui.fetchCancel.addEventListener('click', () => ui.fetchDialog.close());
  ui.fetchCopy.addEventListener('click', async () => {
    const text = ui.fetchCode.value || '';
    const ok = await copyText(text);
    ui.fetchStatus.className = ok
      ? 'held-editor-error response-hook-ok'
      : 'held-editor-error';
    ui.fetchStatus.textContent = ok
      ? 'Copied to clipboard.'
      : 'Could not copy to clipboard.';
  });

  ui.raw.addEventListener('input', () => {
    syncRawContentLength();
    renderRequestHighlight();
    scheduleSave();
  });
  ui.raw.addEventListener('blur', () => {
    const session = collectEditor();
    if (!session || session.rawError) return;
    const prettyBody = prettyJsonRequestBody(session.body, session.headers);
    if (prettyBody == null || prettyBody === session.body) return;
    session.body = prettyBody;
    ui.raw.value = buildRawRequest(session);
    renderRequestHighlight();
    scheduleSave();
  });
  function syncTargetControlsToRaw() {
    const session = activeSession();
    if (!session) return;
    const method = (ui.method.value || 'GET').toUpperCase();
    const url = ui.url.value.trim();
    parseRawRequest(ui.raw.value, session);
    session.method = method;
    session.url = url;
    session.rawError = '';
    applyMethodConstraints(session);
    ensureMethodOption(method);
    ui.url.value = url;
    ui.raw.value = buildRawRequest(session);
    renderRequestHighlight();
    scheduleSave();
  }

  ui.method.addEventListener('change', syncTargetControlsToRaw);
  ui.url.addEventListener('change', syncTargetControlsToRaw);

  for (const target of ['request', 'response']) {
    const controls = findControls(target);
    const previous = ui[`${target}FindPrev`];
    const next = ui[`${target}FindNext`];
    controls.input.addEventListener('focus', () => {
      activeFindTarget = target;
    });
    controls.input.addEventListener('input', () => refreshFind(target));
    controls.input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      revealFindMatch(target, event.shiftKey ? -1 : 1);
    });
    controls.caseSensitive.addEventListener('change', () => refreshFind(target));
    controls.regex.addEventListener('change', () => refreshFind(target));
    previous.addEventListener('click', () => revealFindMatch(target, -1));
    next.addEventListener('click', () => revealFindMatch(target, 1));
  }

  document.querySelector('.request-panel').addEventListener('mousedown', () => {
    activeFindTarget = 'request';
  });
  document.querySelector('.response-panel').addEventListener('mousedown', () => {
    activeFindTarget = 'response';
  });

  document.querySelectorAll('.message-tabs').forEach((group) => {
    group.addEventListener('click', (event) => {
      const button = event.target.closest('.message-tab');
      if (!button) return;
      group.querySelectorAll('.message-tab').forEach((tab) => tab.classList.remove('active'));
      button.classList.add('active');

      responseView = button.dataset.view;
      renderResponse();
    });
  });

  window.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key.toLowerCase() === 'f') {
      event.preventDefault();
      findControls(activeFindTarget).input.focus();
      findControls(activeFindTarget).input.select();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      sendRequest();
    } else if (event.key.toLowerCase() === 't') {
      event.preventDefault();
      addSession();
    } else if (event.key.toLowerCase() === 'w') {
      event.preventDefault();
      if (activeId) closeSession(activeId);
    }
  });

  window.addEventListener('beforeunload', () => {
    collectEditor();
    flushSave();
  });

  window.smartnet.onConfigChanged((config) => {
    document.documentElement.dataset.theme = config.theme || 'light';
  });

  window.smartnet.onRepeaterChanged((change) => {
    if (!change) return;
    if (change.type === 'add') {
      const previousId = activeId;
      const previous = sessions.find((session) => session.id === previousId) || null;
      if (previous && previousId !== change.session.id) {
        syncRawContentLength();
        parseRawRequest(ui.raw.value, previous);
        applyMethodConstraints(previous);
        previous.title = deriveTitle(previous);
        previous.updatedAt = Date.now();
      }
      clearTimeout(saveTimer);
      saveTimer = null;
      const incoming = {
        ...change.session,
        method: String(change.session.method || 'GET').toUpperCase(),
        headers: String(change.session.headers || ''),
        body: String(change.session.body || ''),
        response: change.session.response || null,
      };
      applyMethodConstraints(incoming);
      const existingIndex = sessions.findIndex((session) => session.id === incoming.id);
      if (existingIndex >= 0) sessions[existingIndex] = incoming;
      else sessions.push(incoming);
      activeId = incoming.id;
      renderTabs();
      populateEditor();
    } else if (change.type === 'remove') {
      const index = sessions.findIndex((session) => session.id === change.id);
      if (index >= 0) sessions.splice(index, 1);
      if (activeId === change.id) activeId = sessions[0]?.id || null;
      renderTabs();
      populateEditor();
    } else if (change.type === 'update') {
      const index = sessions.findIndex((session) => session.id === change.session.id);
      if (index >= 0 && change.session.id !== activeId) sessions[index] = change.session;
      renderTabs();
    }
  });

  (async function boot() {
    const config = await window.smartnet.getConfig();
    if (config.ok) document.documentElement.dataset.theme = config.settings.theme || 'light';

    const result = await window.smartnet.getRepeaterSessions();
    if (!result.ok) {
      setSendState(result.error || 'Could not load Repeater requests', 'err');
      return;
    }
    sessions = Array.isArray(result.sessions) ? result.sessions : [];
    activeId = sessions[sessions.length - 1]?.id || null;
    renderTabs();
    populateEditor();
    if (sessions.length === 0) await addSession();
  })();
})();
