'use strict';

/**
 * Mockttp MITM proxy lifecycle, CA certificate management,
 * and request/response capture with pause/resume (ProxyState).
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const zlib = require('zlib');
const { EventEmitter } = require('events');
const { promisify } = require('util');
const mockttp = require('mockttp');
const {
  compileFilter,
  compileResponseTransform,
  validateResponseTransform: validateTransformSource,
} = require('./scriptSandbox');

const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const brotliDecompress = promisify(zlib.brotliDecompress);

const DEFAULT_PORT = 8080;
const DEFAULT_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB kept in memory per side
const BODY_PREVIEW_NOTE = '\n\n… [body truncated for memory safety]';

/**
 * @typedef {'recording' | 'paused' | 'stopped'} ProxyMode
 */

class ProxyEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || DEFAULT_PORT;
    this.host = options.host || DEFAULT_HOST;
    this.certsDir = options.certsDir || path.join(process.cwd(), 'certs');
    this.caKeyPath = path.join(this.certsDir, 'ca.key');
    this.caCertPath = path.join(this.certsDir, 'ca.pem');

    /** @type {import('mockttp').Mockttp | null} */
    this.server = null;
    /** @type {import('net').Server | null} */
    this.listener = null;
    this.listenerSockets = new Set();
    /** @type {ProxyMode} */
    this.mode = 'stopped';
    this.requestSeq = 0;
    /** @type {Map<string, object>} */
    this.pending = new Map();
    /** @type {object[]} */
    this.history = [];
    this.maxHistory = options.maxHistory || 5000;

    this._jsFilterSource = '';
    this._jsFilter = compileFilter('');
    this._rule = null;
    this.holding = false;
    this.heldRequests = new Map();
    this.interceptResponses = false;
    this.heldResponses = new Map();
    this.responseTransformSource = '';
    this.responseTransform = null;
    this.responseTransformInScope = true;
    this.responseTransformDomainPattern = '';
  }

  getState() {
    return {
      mode: this.mode,
      host: this.host,
      port: this.port,
      recording: this.mode === 'recording',
      running: this.mode === 'recording' || this.mode === 'paused',
      holding: this.holding,
      heldCount: this.heldRequests.size,
      interceptResponses: this.interceptResponses,
      heldResponseCount: this.heldResponses.size,
      responseTransformActive: Boolean(this.responseTransform),
      responseTransformInScope: this.responseTransformInScope,
      historyCount: this.history.length,
      caCertPath: this.caCertPath,
      hasCA: fs.existsSync(this.caCertPath),
    };
  }

  async ensureCA() {
    fs.mkdirSync(this.certsDir, { recursive: true });

    if (fs.existsSync(this.caKeyPath) && fs.existsSync(this.caCertPath)) {
      return {
        key: fs.readFileSync(this.caKeyPath, 'utf8'),
        cert: fs.readFileSync(this.caCertPath, 'utf8'),
      };
    }

    const ca = await mockttp.generateCACertificate({
      commonName: 'HtNinja MITM CA',
      organizationName: 'HtNinja Local Proxy',
      bits: 2048,
    });

    fs.writeFileSync(this.caKeyPath, ca.key, { mode: 0o600 });
    fs.writeFileSync(this.caCertPath, ca.cert, { mode: 0o644 });
    return ca;
  }

  getCACertificatePem() {
    if (!fs.existsSync(this.caCertPath)) {
      throw new Error('CA certificate not generated yet. Start the proxy first.');
    }
    return fs.readFileSync(this.caCertPath, 'utf8');
  }

  getCACertificatePath() {
    return this.caCertPath;
  }

  setJsFilter(source, options = {}) {
    const compiled = compileFilter(source || '');
    if (!compiled.ok) {
      return { ok: false, error: compiled.error };
    }
    this._jsFilterSource = source || '';
    this._jsFilter = compiled;

    let removed = 0;
    if (options.applyToExisting) {
      removed = this._applyJsFilterToHistory(options.domainScope);
    }
    return { ok: true, removed };
  }

  getJsFilterSource() {
    return this._jsFilterSource;
  }

  /**
   * Re-evaluate the active JS filter against completed history.
   * When domainScope is set, only in-scope hosts are considered.
   */
  _applyJsFilterToHistory(domainScope) {
    if (!this._jsFilter || !this._jsFilter.evaluate) return 0;
    const scope = domainScope == null ? this.responseTransformDomainPattern : domainScope;
    const toRemove = [];

    for (const entry of this.history) {
      if (!entry || entry.source === 'resend') continue;
      if (!this._domainMatches(entry.host, scope)) continue;

      const reqView = {
        id: entry.id,
        method: entry.method,
        url: entry.url,
        host: entry.host,
        path: entry.path,
        headers: entry.requestHeaders,
        body: entry.requestBody,
      };
      const resView = {
        status: entry.status,
        headers: entry.responseHeaders,
        body: entry.responseBody,
        contentType: entry.contentType,
      };
      const evaluated = this._jsFilter.evaluate(reqView, resView);
      if (!evaluated.ok) {
        this.emit('filter-error', {
          id: entry.id,
          error: evaluated.error || 'Filter execution failed.',
        });
        continue;
      }
      if (!evaluated.pass) toRemove.push(entry.id);
    }

    for (const id of toRemove) this._removeHistoryEntry(id);
    return toRemove.length;
  }

  _domainMatches(host, pattern) {
    const normalized = String(pattern || '').trim().toLowerCase();
    if (!normalized) return true;
    let value = String(host || '').trim().toLowerCase();
    if (value.startsWith('[')) {
      const end = value.indexOf(']');
      if (end > 0) value = value.slice(1, end);
    } else {
      value = value.replace(/:\d+$/, '');
    }
    if (!value) return false;
    if (normalized.startsWith('*.')) {
      return value === normalized.slice(2) || value.endsWith(normalized.slice(1));
    }
    if (normalized.includes('*')) {
      const escaped = normalized
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');
      return new RegExp(`^${escaped}$`, 'i').test(value);
    }
    return value.includes(normalized);
  }

  async start(port = this.port, host = this.host) {
    if (this.server) {
      await this.stop();
    }

    const normalizedPort = Number(port);
    const normalizedHost = String(host || '').trim();
    if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
      throw new Error('Proxy port must be an integer between 1 and 65535.');
    }
    const hostnamePattern =
      /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
    if (net.isIP(normalizedHost) === 0 && !hostnamePattern.test(normalizedHost)) {
      throw new Error('Proxy host must be a valid hostname or IP address.');
    }

    this.port = normalizedPort;
    this.host = normalizedHost;
    const https = await this.ensureCA();

    this.server = mockttp.getLocal({
      https: {
        key: https.key,
        cert: https.cert,
      },
      cors: false,
      // Record bodies for completed events / pass-through callbacks
      maxBodySize: MAX_BODY_BYTES + 1024,
    });

    // Mockttp does not expose a bind-host option. Run it on an ephemeral
    // internal port and expose only the configured interface via a TCP bridge.
    await this.server.start(0);

    // Pass everything through; capture via beforeRequest / beforeResponse.
    this._rule = await this.server.forAnyRequest().thenPassThrough({
      ignoreHostCertificateErrors: true,
      beforeRequest: async (req) => {
        try {
          const requestId = await this._onBeforeRequest(req);
          const automatic = this._applyAutomaticRequestTransform(requestId);
          if (automatic === 'close' || automatic === 'reset') {
            return { response: automatic };
          }
          return await this._waitIfHolding(requestId, automatic);
        } catch (err) {
          this.emit('error', err);
          return undefined;
        }
      },
      beforeResponse: async (res, req) => {
        try {
          const entry = await this._onBeforeResponse(res, req);
          const automatic = this._applyAutomaticResponseTransform(entry);
          if (automatic === 'close' || automatic === 'reset') return automatic;
          return await this._waitIfResponseIntercepting(entry, automatic);
        } catch (err) {
          this.emit('error', err);
          return undefined;
        }
      },
    });

    const internalPort = this.server.port;
    this.listener = net.createServer((client) => {
      const upstream = net.connect({ host: '127.0.0.1', port: internalPort });
      this.listenerSockets.add(client);
      this.listenerSockets.add(upstream);
      client.pipe(upstream);
      upstream.pipe(client);

      const closeBoth = () => {
        this.listenerSockets.delete(client);
        this.listenerSockets.delete(upstream);
        if (!client.destroyed) client.destroy();
        if (!upstream.destroyed) upstream.destroy();
      };
      client.on('close', closeBoth);
      upstream.on('close', closeBoth);
      client.on('error', closeBoth);
      upstream.on('error', closeBoth);
    });

    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          this.listener.removeListener('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          this.listener.removeListener('error', onError);
          resolve();
        };
        this.listener.once('error', onError);
        this.listener.once('listening', onListening);
        this.listener.listen(this.port, this.host);
      });
    } catch (err) {
      await this.server.stop().catch(() => {});
      this.server = null;
      this.listener = null;
      throw err;
    }

    this.mode = 'recording';
    this.emit('state', this.getState());
    return this.getState();
  }

  async pause() {
    if (!this.server) {
      throw new Error('Proxy is not running.');
    }
    this.mode = 'paused';
    this.emit('state', this.getState());
    return this.getState();
  }

  async resume() {
    if (!this.server) {
      throw new Error('Proxy is not running.');
    }
    this.mode = 'recording';
    this.emit('state', this.getState());
    return this.getState();
  }

  async toggle() {
    if (!this.server) {
      return this.start();
    }
    if (this.mode === 'recording') {
      return this.pause();
    }
    return this.resume();
  }

  setHolding(enabled) {
    if (!this.server) {
      throw new Error('Proxy is not running.');
    }

    if (enabled) {
      this.holding = true;
      this.emit('state', this.getState());
    } else {
      this._releaseHeldRequests();
    }
    return this.getState();
  }

  _waitIfHolding(requestId, initialModifications) {
    if (!this.holding) return Promise.resolve(initialModifications);

    const entry = this.pending.get(requestId);
    if (entry) {
      entry.held = true;
      if (this.mode === 'recording' && !entry._historyRecorded) {
        this.requestSeq += 1;
        entry.seq = this.requestSeq;
        entry._historyRecorded = true;
        const serializable = this._toSerializable(entry);
        this.history.push(serializable);
        if (this.history.length > this.maxHistory) {
          this.history.splice(0, this.history.length - this.maxHistory);
        }
        this.emit('entry', serializable);
      }
    }

    // The request body stream is already consumed for history. Always provide a
    // body override so releasing via setHolding(false)/pause() still forwards.
    const capturedBody = entry
      ? Buffer.from(entry.requestBody == null ? '' : String(entry.requestBody), 'utf8')
      : null;
    const fallbackModifications =
      entry && !initialModifications
        ? {
            method: entry.method,
            url: entry.url,
            headers: { ...entry.requestHeaders },
            rawBody: capturedBody,
          }
        : null;
    const seeded =
      initialModifications &&
      typeof initialModifications === 'object' &&
      initialModifications.rawBody == null &&
      initialModifications.body == null &&
      capturedBody
        ? { ...initialModifications, rawBody: capturedBody }
        : initialModifications;

    return new Promise((resolve) => {
      const token = Symbol('held-request');
      const holder = {
        id: requestId,
        entry,
        modifications: seeded || fallbackModifications || null,
        release: null,
      };
      const release = () => {
        if (!this.heldRequests.delete(token)) return;
        if (entry) {
          entry.held = false;
          if (entry._historyRecorded) this._updateHistoryEntry(entry);
        }
        resolve(holder.modifications || undefined);
        this.emit('state', this.getState());
      };
      holder.release = release;
      this.heldRequests.set(token, holder);
      this.emit('state', this.getState());
    });
  }

  _releaseHeldRequests() {
    this.holding = false;
    const holders = Array.from(this.heldRequests.values());
    for (const holder of holders) holder.release();
    this.emit('state', this.getState());
  }

  updateHeldRequest(id, changes, forward = false) {
    const holder = Array.from(this.heldRequests.values()).find((item) => item.id === id);
    const entry = holder && holder.entry;
    if (!holder || !entry || !entry.held) {
      throw new Error('Held request not found or already released.');
    }

    const method = String(changes?.method || entry.method).trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9-]{0,19}$/.test(method)) {
      throw new Error('Invalid HTTP method.');
    }

    const urlText = String(changes?.url || entry.url).trim();
    let parsed;
    try {
      parsed = new URL(urlText);
    } catch {
      throw new Error('Invalid request URL.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only HTTP and HTTPS request URLs are supported.');
    }

    const headers = this._normalizeHeaders(changes?.headers || entry.requestHeaders);
    const body = changes?.body == null ? entry.requestBody : String(changes.body);
    const bodySize = Buffer.byteLength(body, 'utf8');
    if (bodySize > MAX_BODY_BYTES) {
      throw new Error(`Edited request body exceeds ${MAX_BODY_BYTES} bytes.`);
    }

    // Keep captured history and forwarded bytes consistent.
    if (body !== entry.requestBody) {
      delete headers['content-encoding'];
    }
    if (bodySize > 0 || !['GET', 'HEAD'].includes(method)) {
      headers['content-length'] = String(bodySize);
    } else {
      delete headers['content-length'];
    }
    delete headers['transfer-encoding'];
    for (const name of Object.keys(headers)) {
      if (name.startsWith(':')) delete headers[name];
    }
    headers.host = parsed.host;

    entry.method = method;
    entry.url = parsed.href;
    entry.host = parsed.host;
    entry.path = parsed.pathname + parsed.search;
    entry.protocol = parsed.protocol.replace(':', '');
    entry.requestHeaders = headers;
    entry.requestBody = body;
    entry.requestBodySize = bodySize;
    entry.requestBinary = false;

    holder.modifications = {
      method,
      url: parsed.href,
      headers,
      body,
    };

    if (entry._historyRecorded) this._updateHistoryEntry(entry);
    if (forward) holder.release();
    return this._toSerializable(entry);
  }

  setResponseIntercepting(enabled) {
    if (!this.server) throw new Error('Proxy is not running.');
    if (enabled) {
      this.interceptResponses = true;
      this.emit('state', this.getState());
    } else {
      this._releaseHeldResponses();
    }
    return this.getState();
  }

  setResponseTransform(source, enabled = true, inScope = true) {
    const code = String(source || '').trim();
    this.responseTransformSource = code;
    this.responseTransformInScope = inScope !== false;
    if (!enabled || !code) {
      this.responseTransform = null;
      this.emit('state', this.getState());
      return { source: code, enabled: false, inScope: this.responseTransformInScope };
    }
    const validation = validateTransformSource(code);
    if (!validation.ok) throw new Error(validation.error);
    const compiled = compileResponseTransform(code);
    if (!compiled.ok) throw new Error(compiled.error);
    this.responseTransform = compiled;
    this.emit('state', this.getState());
    return {
      source: code,
      enabled: true,
      inScope: this.responseTransformInScope,
      warnings: validation.warnings || [],
    };
  }

  validateResponseTransform(source) {
    return validateTransformSource(String(source || '').trim());
  }

  getResponseTransform() {
    return {
      source: this.responseTransformSource,
      enabled: Boolean(this.responseTransform),
      inScope: this.responseTransformInScope,
    };
  }

  setResponseTransformDomainScope(pattern) {
    this.responseTransformDomainPattern = String(pattern || '').trim();
  }

  _responseTransformDomainMatches(host) {
    return this._domainMatches(host, this.responseTransformDomainPattern);
  }

  _buildRequestModifications(entry, reqResult) {
    if (!entry || !reqResult || typeof reqResult !== 'object') return undefined;

    const method = String(reqResult.method || entry.method || 'GET').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9-]{0,19}$/.test(method)) {
      this.emit('response-transform-error', {
        id: entry.id,
        error: 'Transformed request method is invalid.',
      });
      return undefined;
    }

    const urlText = String(reqResult.url || entry.url || '').trim();
    let parsed;
    try {
      parsed = new URL(urlText);
    } catch {
      this.emit('response-transform-error', {
        id: entry.id,
        error: 'Transformed request URL is invalid.',
      });
      return undefined;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      this.emit('response-transform-error', {
        id: entry.id,
        error: 'Transformed request URL must use HTTP or HTTPS.',
      });
      return undefined;
    }

    const headers = this._normalizeHeaders(reqResult.headers || entry.requestHeaders);
    const originalBody = entry.requestBody == null ? '' : String(entry.requestBody);
    const body =
      Object.prototype.hasOwnProperty.call(reqResult, 'body') && reqResult.body != null
        ? String(reqResult.body)
        : Object.prototype.hasOwnProperty.call(reqResult, 'body')
          ? ''
          : originalBody;
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      this.emit('response-transform-error', {
        id: entry.id,
        error: `Transformed request body exceeds ${MAX_BODY_BYTES} bytes.`,
      });
      return undefined;
    }

    const bodySize = Buffer.byteLength(body, 'utf8');
    const bodyChanged = body !== originalBody;
    // Captured bodies are decoded text. Drop encodings so Mockttp does not
    // re-compress and mismatch Content-Length against the override bytes.
    if (bodyChanged) {
      delete headers['content-encoding'];
    }
    if (bodySize > 0 || !['GET', 'HEAD'].includes(method) || bodyChanged) {
      headers['content-length'] = String(bodySize);
    } else {
      delete headers['content-length'];
    }
    delete headers['transfer-encoding'];
    for (const name of Object.keys(headers)) {
      if (name.startsWith(':')) delete headers[name];
    }
    headers.host = parsed.host;

    const changed =
      method !== entry.method ||
      parsed.href !== entry.url ||
      bodyChanged ||
      JSON.stringify(headers) !== JSON.stringify(entry.requestHeaders);
    if (!changed) return undefined;

    entry.method = method;
    entry.url = parsed.href;
    entry.host = parsed.host;
    entry.path = parsed.pathname + parsed.search;
    entry.protocol = parsed.protocol.replace(':', '');
    entry.requestHeaders = headers;
    entry.requestBody = body;
    entry.requestBodySize = bodySize;
    entry.requestBinary = false;
    entry.requestModified = true;
    // Always re-provide the body: Mockttp has already consumed the original
    // stream while we captured history. Prefer rawBody when the hook changed
    // the body so Content-Encoding is not re-applied to decoded text.
    if (bodyChanged) {
      return {
        method,
        url: parsed.href,
        headers,
        body,
        rawBody: Buffer.from(body, 'utf8'),
      };
    }
    return {
      method,
      url: parsed.href,
      headers,
      body,
      rawBody: Buffer.from(body, 'utf8'),
    };
  }

  _applyAutomaticRequestTransform(requestId) {
    if (!this.responseTransform) return undefined;
    const entry = this.pending.get(requestId);
    if (!entry) return undefined;
    if (
      this.responseTransformInScope &&
      !this._responseTransformDomainMatches(entry.host)
    ) {
      return undefined;
    }

    const req = {
      id: entry.id,
      method: entry.method,
      url: entry.url,
      host: entry.host,
      path: entry.path,
      headers: { ...entry.requestHeaders },
      body: entry.requestBody == null ? '' : String(entry.requestBody),
    };
    const evaluated = this.responseTransform.evaluate(req, null);
    if (!evaluated.ok) {
      this.emit('response-transform-error', {
        id: entry.id,
        error: evaluated.error || 'Automatic request transform failed.',
      });
      return undefined;
    }
    if (evaluated.warning) {
      this.emit('response-transform-error', {
        id: entry.id,
        error: `Request-phase warning: ${evaluated.warning}`,
      });
    }
    if (evaluated.pauseAll) {
      this._pauseFromHook();
    }
    if (evaluated.abort === 'close' || evaluated.abort === 'reset') {
      entry.requestAborted = true;
      entry.requestModified = true;
      if (this.mode === 'recording') {
        if (!entry._historyRecorded) {
          this.requestSeq += 1;
          entry.seq = this.requestSeq;
          entry._historyRecorded = true;
        }
        this._updateHistoryEntry(entry);
      }
      this.pending.delete(requestId);
      return evaluated.abort;
    }

    const modifications = this._buildRequestModifications(entry, evaluated.req);
    if (modifications && this.mode === 'recording' && entry._historyRecorded) {
      this._updateHistoryEntry(entry);
    }
    return modifications;
  }

  _applyAutomaticResponseTransform(entry) {
    if (!entry || !this.responseTransform) return undefined;
    if (
      this.responseTransformInScope &&
      !this._responseTransformDomainMatches(entry.host)
    ) {
      return undefined;
    }
    const req = {
      id: entry.id,
      method: entry.method,
      url: entry.url,
      host: entry.host,
      path: entry.path,
      headers: entry.requestHeaders,
      body: entry.requestBody == null ? '' : String(entry.requestBody),
    };
    const res = {
      status: entry.status,
      headers: { ...entry.responseHeaders },
      body: entry.responseBody,
      contentType: entry.contentType,
    };
    const evaluated = this.responseTransform.evaluate(req, res);
    if (!evaluated.ok) {
      this.emit('response-transform-error', {
        id: entry.id,
        error: evaluated.error || 'Automatic response transform failed.',
      });
      return undefined;
    }
    if (evaluated.pauseAll) {
      this._pauseFromHook();
    }
    if (evaluated.abort === 'close' || evaluated.abort === 'reset') {
      entry.responseAborted = true;
      entry.responseModified = true;
      this._updateHistoryEntry(entry);
      return evaluated.abort;
    }
    if (!evaluated.res || typeof evaluated.res !== 'object') {
      this.emit('response-transform-error', {
        id: entry.id,
        error: 'Response transform must return a response object, "close", or "reset".',
      });
      return undefined;
    }

    const result = evaluated.res;
    const status = Number(result.status ?? result.statusCode ?? entry.status);
    if (!Number.isInteger(status) || status < 100 || status > 999) {
      this.emit('response-transform-error', {
        id: entry.id,
        error: 'Transformed response status must be an integer between 100 and 999.',
      });
      return undefined;
    }
    const headers = this._normalizeHeaders(result.headers || entry.responseHeaders);
    const body = result.body == null ? entry.responseBody : String(result.body);
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      this.emit('response-transform-error', {
        id: entry.id,
        error: `Transformed response body exceeds ${MAX_BODY_BYTES} bytes.`,
      });
      return undefined;
    }
    const changed =
      status !== entry.status ||
      body !== entry.responseBody ||
      JSON.stringify(headers) !== JSON.stringify(entry.responseHeaders);
    if (!changed) return undefined;

    delete headers['content-length'];
    delete headers['transfer-encoding'];
    for (const name of Object.keys(headers)) {
      if (name.startsWith(':')) delete headers[name];
    }
    entry.status = status;
    entry.responseHeaders = headers;
    entry.responseBody = body;
    entry.responseBodySize = Buffer.byteLength(body, 'utf8');
    entry.responseBinary = false;
    entry.contentType = headers['content-type'] || '';
    entry.contentLength = entry.responseBodySize;
    entry.responseModified = true;
    this._updateHistoryEntry(entry);
    return { statusCode: status, headers, body };
  }

  /**
   * pause() from a response hook: hold all requests, including the current one
   * when called during the request phase.
   */
  _pauseFromHook() {
    if (this.holding) return;
    this.holding = true;
    this.emit('state', this.getState());
  }

  _waitIfResponseIntercepting(entry, initialModifications) {
    if (!this.interceptResponses || !entry) return Promise.resolve(initialModifications);

    entry.responseHeld = true;
    if (!entry._historyRecorded) {
      this.requestSeq += 1;
      entry.seq = this.requestSeq;
      entry._historyRecorded = true;
    }
    this._updateHistoryEntry(entry);

    return new Promise((resolve) => {
      const token = Symbol('held-response');
      const holder = {
        id: entry.id,
        entry,
        modifications: initialModifications || null,
        release: null,
      };
      holder.release = () => {
        if (!this.heldResponses.delete(token)) return;
        entry.responseHeld = false;
        this._updateHistoryEntry(entry);
        resolve(holder.modifications || undefined);
        this.emit('state', this.getState());
      };
      this.heldResponses.set(token, holder);
      this.emit('state', this.getState());
    });
  }

  _releaseHeldResponses() {
    this.interceptResponses = false;
    const holders = Array.from(this.heldResponses.values());
    for (const holder of holders) holder.release();
    this.emit('state', this.getState());
  }

  _findHeldResponse(id) {
    return Array.from(this.heldResponses.values()).find((item) => item.id === id);
  }

  updateHeldResponse(id, changes, forward = false) {
    const holder = this._findHeldResponse(id);
    const entry = holder && holder.entry;
    if (!holder || !entry || !entry.responseHeld) {
      throw new Error('Held response not found or already released.');
    }

    const status = Number(changes?.status ?? changes?.statusCode ?? entry.status);
    if (!Number.isInteger(status) || status < 100 || status > 999) {
      throw new Error('Response status must be an integer between 100 and 999.');
    }
    const headers = this._normalizeHeaders(changes?.headers || entry.responseHeaders);
    const body = changes?.body == null ? entry.responseBody : String(changes.body);
    const bodySize = Buffer.byteLength(body, 'utf8');
    if (bodySize > MAX_BODY_BYTES) {
      throw new Error(`Edited response body exceeds ${MAX_BODY_BYTES} bytes.`);
    }
    delete headers['content-length'];
    delete headers['transfer-encoding'];
    for (const name of Object.keys(headers)) {
      if (name.startsWith(':')) delete headers[name];
    }

    entry.status = status;
    entry.responseHeaders = headers;
    entry.responseBody = body;
    entry.responseBodySize = bodySize;
    entry.responseBinary = false;
    entry.contentType = headers['content-type'] || '';
    entry.contentLength = bodySize;
    entry.responseModified = true;
    holder.modifications = { statusCode: status, headers, body };
    this._updateHistoryEntry(entry);
    if (forward) holder.release();
    return this._toSerializable(entry);
  }

  replaceHeldResponseText(id, search, replacement, options = {}) {
    const holder = this._findHeldResponse(id);
    if (!holder?.entry?.responseHeld) {
      throw new Error('Held response not found or already released.');
    }
    const needle = String(search || '');
    if (!needle) throw new Error('Replacement search text is empty.');
    const source = holder.entry.responseBody || '';
    let body;
    if (options.regex) {
      const flags = `g${options.caseSensitive ? '' : 'i'}`;
      let regex;
      try {
        regex = new RegExp(needle, flags);
      } catch (err) {
        throw new Error(`Invalid replacement regular expression: ${err.message}`);
      }
      body = source.replace(regex, String(replacement || ''));
    } else if (options.caseSensitive) {
      body = source.split(needle).join(String(replacement || ''));
    } else {
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      body = source.replace(new RegExp(escaped, 'gi'), String(replacement || ''));
    }
    return this.updateHeldResponse(id, { body }, false);
  }

  applyHeldResponseTransform(id, source) {
    const holder = this._findHeldResponse(id);
    const entry = holder && holder.entry;
    if (!holder || !entry || !entry.responseHeld) {
      throw new Error('Held response not found or already released.');
    }
    const compiled = compileResponseTransform(source);
    if (!compiled.ok) throw new Error(compiled.error);
    const req = {
      id: entry.id,
      method: entry.method,
      url: entry.url,
      host: entry.host,
      path: entry.path,
      headers: entry.requestHeaders,
      body: entry.requestBody,
    };
    const res = {
      status: entry.status,
      headers: { ...entry.responseHeaders },
      body: entry.responseBody,
      contentType: entry.contentType,
    };
    const evaluated = compiled.evaluate(req, res);
    if (!evaluated.ok) throw new Error(evaluated.error);
    if (evaluated.pauseAll) {
      this._pauseFromHook();
    }
    if (evaluated.abort === 'close' || evaluated.abort === 'reset') {
      return this.abortHeldResponse(id, evaluated.abort);
    }
    if (!evaluated.res || typeof evaluated.res !== 'object') {
      throw new Error('Response transform must return a response object, "close", or "reset".');
    }
    const result = evaluated.res;
    return this.updateHeldResponse(id, {
      status: result.status ?? result.statusCode ?? entry.status,
      headers: result.headers || entry.responseHeaders,
      body: result.body ?? entry.responseBody,
    }, false);
  }

  abortHeldResponse(id, mode = 'reset') {
    const holder = this._findHeldResponse(id);
    const entry = holder && holder.entry;
    if (!holder || !entry || !entry.responseHeld) {
      throw new Error('Held response not found or already released.');
    }
    const action = mode === 'close' ? 'close' : 'reset';
    entry.responseAborted = true;
    entry.responseModified = true;
    holder.modifications = action;
    holder.release();
    return this._toSerializable(entry);
  }

  async stop() {
    this._releaseHeldRequests();
    this._releaseHeldResponses();
    if (this.listener) {
      const listener = this.listener;
      this.listener = null;
      for (const socket of this.listenerSockets) socket.destroy();
      this.listenerSockets.clear();
      await new Promise((resolve) => listener.close(() => resolve())).catch(() => {});
    }
    if (this.server) {
      try {
        await this.server.stop();
      } catch (err) {
        this.emit('error', err);
      }
    }
    this.server = null;
    this._rule = null;
    this.pending.clear();
    this.mode = 'stopped';
    this.emit('state', this.getState());
    return this.getState();
  }

  clearHistory(keepIds = []) {
    const keep = new Set(
      (Array.isArray(keepIds) ? keepIds : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean)
    );

    if (keep.size === 0) {
      this.history = [];
      this.requestSeq = 0;
      for (const entry of this.pending.values()) {
        entry._historyRecorded = false;
        entry.seq = 0;
      }
      this.emit('cleared', { keptIds: [] });
      return { keptIds: [] };
    }

    this.history = this.history.filter((entry) => keep.has(entry.id));
    let maxSeq = 0;
    for (const entry of this.history) {
      if (Number(entry.seq) > maxSeq) maxSeq = Number(entry.seq);
    }
    this.requestSeq = maxSeq;
    for (const entry of this.pending.values()) {
      if (!keep.has(entry.id)) {
        entry._historyRecorded = false;
        entry.seq = 0;
      }
    }
    const keptIds = this.history.map((entry) => entry.id);
    this.emit('cleared', { keptIds });
    return { keptIds };
  }

  /**
   * Normalize headers to a plain lowercase-key object with string values.
   */
  _normalizeHeaders(headers) {
    const out = {};
    if (!headers || typeof headers !== 'object') return out;
    for (const [key, value] of Object.entries(headers)) {
      if (value == null) continue;
      const k = String(key).toLowerCase();
      if (Array.isArray(value)) {
        out[k] = value.map(String).join(', ');
      } else {
        out[k] = String(value);
      }
    }
    return out;
  }

  async _readBody(bodyLike, headers) {
    let buffer = Buffer.alloc(0);
    let encoding = null;

    try {
      if (!bodyLike) {
        return { text: '', buffer, truncated: false, binary: false, size: 0 };
      }

      // Mockttp CompletedBody / MessageBody APIs
      if (typeof bodyLike.getDecodedBuffer === 'function') {
        buffer = (await bodyLike.getDecodedBuffer()) || Buffer.alloc(0);
        encoding = null; // already decoded
      } else if (typeof bodyLike.getBuffer === 'function') {
        buffer = (await bodyLike.getBuffer()) || Buffer.alloc(0);
        encoding = (headers && (headers['content-encoding'] || headers['Content-Encoding'])) || null;
      } else if (Buffer.isBuffer(bodyLike)) {
        buffer = bodyLike;
        encoding = (headers && (headers['content-encoding'] || headers['Content-Encoding'])) || null;
      } else if (typeof bodyLike === 'string') {
        buffer = Buffer.from(bodyLike, 'utf8');
      } else if (bodyLike.buffer && Buffer.isBuffer(bodyLike.buffer)) {
        buffer = bodyLike.buffer;
      }
    } catch (err) {
      return {
        text: `[Failed to read body: ${err.message}]`,
        buffer: Buffer.alloc(0),
        truncated: false,
        binary: false,
        size: 0,
        error: err.message,
      };
    }

    const rawSize = buffer.length;
    let truncated = false;

    if (encoding) {
      try {
        buffer = await this._decompress(buffer, encoding);
      } catch (err) {
        // Keep raw bytes if decompression fails
        return {
          text: `[Decompression failed (${encoding}): ${err.message}]`,
          buffer,
          truncated: false,
          binary: true,
          size: rawSize,
          error: err.message,
        };
      }
    }

    if (buffer.length > MAX_BODY_BYTES) {
      buffer = buffer.subarray(0, MAX_BODY_BYTES);
      truncated = true;
    }

    const binary = this._looksBinary(buffer, headers);
    let text = '';
    if (binary) {
      const preview = buffer.subarray(0, Math.min(512, buffer.length));
      text =
        `[Binary content — ${rawSize} bytes]` +
        (truncated ? BODY_PREVIEW_NOTE : '') +
        `\n\nHex preview:\n${preview.toString('hex').replace(/(..)/g, '$1 ').trim()}`;
    } else {
      text = buffer.toString('utf8');
      if (truncated) text += BODY_PREVIEW_NOTE;
    }

    return {
      text,
      buffer,
      truncated,
      binary,
      size: rawSize,
    };
  }

  async _decompress(buffer, contentEncoding) {
    const encodings = String(contentEncoding)
      .toLowerCase()
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    let out = buffer;
    // Decompress in reverse order of application (last encoding first).
    for (let i = encodings.length - 1; i >= 0; i--) {
      const enc = encodings[i];
      if (enc === 'gzip' || enc === 'x-gzip') {
        out = await gunzip(out);
      } else if (enc === 'deflate') {
        try {
          out = await inflate(out);
        } catch {
          out = await promisify(zlib.inflateRaw)(out);
        }
      } else if (enc === 'br') {
        out = await brotliDecompress(out);
      } else if (enc === 'identity' || enc === '') {
        // no-op
      } else {
        // Unknown encoding — leave as-is
      }
    }
    return out;
  }

  _looksBinary(buffer, headers) {
    const ct = String(
      (headers && (headers['content-type'] || headers['Content-Type'])) || ''
    ).toLowerCase();

    if (
      ct.startsWith('image/') ||
      ct.startsWith('audio/') ||
      ct.startsWith('video/') ||
      ct.includes('octet-stream') ||
      ct.includes('wasm') ||
      ct.includes('font/') ||
      ct.includes('zip') ||
      ct.includes('pdf')
    ) {
      return true;
    }

    if (!buffer || buffer.length === 0) return false;

    const sample = buffer.subarray(0, Math.min(800, buffer.length));
    let weird = 0;
    for (let i = 0; i < sample.length; i++) {
      const c = sample[i];
      // Allow common whitespace & printable ASCII / high UTF-8 bytes
      if (c === 9 || c === 10 || c === 13) continue;
      if (c < 32) weird++;
    }
    return weird / sample.length > 0.15;
  }

  _parseUrl(urlString) {
    try {
      const u = new URL(urlString);
      return {
        host: u.host,
        hostname: u.hostname,
        path: u.pathname + u.search,
        protocol: u.protocol.replace(':', ''),
      };
    } catch {
      return { host: '', hostname: '', path: urlString || '', protocol: '' };
    }
  }

  async _onBeforeRequest(req) {
    const id = req.id || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const headers = this._normalizeHeaders(req.headers);
    const parsed = this._parseUrl(req.url);
    const bodyInfo = await this._readBody(req.body, headers);

    const entry = {
      id,
      seq: 0, // assigned when finalized / recorded
      method: (req.method || 'GET').toUpperCase(),
      url: req.url,
      host: parsed.host || headers.host || '',
      path: parsed.path || req.path || '',
      protocol: parsed.protocol,
      requestHeaders: headers,
      requestBody: bodyInfo.text,
      requestBodySize: bodyInfo.size,
      requestBinary: bodyInfo.binary,
      timestamp: Date.now(),
      timingStart: Date.now(),
      // Response fields filled later
      status: null,
      responseHeaders: {},
      responseBody: '',
      responseBodySize: 0,
      responseBinary: false,
      contentType: '',
      contentLength: null,
      durationMs: null,
      complete: false,
      held: false,
      _historyRecorded: false,
    };

    this.pending.set(id, entry);

    // Also stash on the request object so beforeResponse can correlate
    // if Mockttp preserves custom properties across the pass-through.
    try {
      req.__smartnetId = id;
    } catch {
      /* ignore */
    }
    return id;
  }

  async _onBeforeResponse(res, req) {
    // PassThroughResponse.id matches CompletedRequest.id
    const id = res.id || (req && req.id);
    let entry = id ? this.pending.get(id) : null;

    const headers = this._normalizeHeaders(res.headers);
    const bodyInfo = await this._readBody(res.body, headers);
    const contentType = headers['content-type'] || '';
    const contentLengthHeader = headers['content-length'];
    const contentLength = contentLengthHeader
      ? Number(contentLengthHeader)
      : bodyInfo.size;

    if (!entry) {
      // Fallback: create a minimal entry if request hook missed
      const url = (req && req.url) || '';
      const parsed = this._parseUrl(url);
      entry = {
        id: id || `orphan-${Date.now()}`,
        seq: 0,
        method: ((req && req.method) || 'GET').toUpperCase(),
        url,
        host: parsed.host,
        path: parsed.path || (req && req.path) || '',
        protocol: parsed.protocol || (req && req.protocol) || '',
        requestHeaders: this._normalizeHeaders((req && req.headers) || {}),
        requestBody: '',
        requestBodySize: 0,
        requestBinary: false,
        timestamp: Date.now(),
        timingStart: Date.now(),
        held: false,
        _historyRecorded: false,
      };
    }

    const wasHistoryRecorded = Boolean(entry._historyRecorded);
    entry.status = res.statusCode ?? res.status ?? null;
    entry.responseHeaders = headers;
    entry.responseBody = bodyInfo.text;
    entry.responseBodySize = bodyInfo.size;
    entry.responseBinary = bodyInfo.binary;
    entry.contentType = contentType;
    entry.contentLength = Number.isFinite(contentLength) ? contentLength : bodyInfo.size;
    entry.durationMs = Math.max(0, Date.now() - (entry.timingStart || Date.now()));
    entry.complete = true;
    entry.held = false;

    this.pending.delete(entry.id);

    // When paused or stopped, still pass through but do not log to UI.
    if (this.mode !== 'recording' && !wasHistoryRecorded) {
      return entry;
    }

    // Apply JS sandbox filter before emitting
    if (this._jsFilter && this._jsFilter.evaluate) {
      const reqView = {
        id: entry.id,
        method: entry.method,
        url: entry.url,
        host: entry.host,
        path: entry.path,
        headers: entry.requestHeaders,
        body: entry.requestBody,
      };
      const resView = {
        status: entry.status,
        headers: entry.responseHeaders,
        body: entry.responseBody,
        contentType: entry.contentType,
      };
      const evaluated = this._jsFilter.evaluate(reqView, resView);
      const result =
        typeof evaluated === 'boolean'
          ? { ok: true, pass: evaluated }
          : evaluated || { ok: false, pass: false, error: 'Filter returned no result.' };
      if (!result.ok) {
        this.emit('filter-error', {
          id: entry.id,
          error: result.error || 'Filter execution failed.',
        });
        // On filter error, still record (fail open for visibility)
      } else if (!result.pass) {
        if (wasHistoryRecorded) this._removeHistoryEntry(entry.id);
        return entry;
      }
    }

    if (wasHistoryRecorded) {
      this._updateHistoryEntry(entry);
    } else {
      this.requestSeq += 1;
      entry.seq = this.requestSeq;
      entry._historyRecorded = true;
      this._updateHistoryEntry(entry);
    }
    return entry;
  }

  _updateHistoryEntry(entry) {
    const serializable = this._toSerializable(entry);
    const index = this.history.findIndex((item) => item.id === entry.id);
    if (index >= 0) this.history[index] = serializable;
    else this.history.push(serializable);
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }
    this.emit('entry', serializable);
  }

  _removeHistoryEntry(id) {
    const index = this.history.findIndex((entry) => entry.id === id);
    if (index >= 0) this.history.splice(index, 1);
    this.emit('entry-removed', id);
  }

  _toSerializable(entry) {
    return {
      id: entry.id,
      seq: entry.seq,
      method: entry.method,
      url: entry.url,
      host: entry.host,
      path: entry.path,
      protocol: entry.protocol,
      requestHeaders: entry.requestHeaders,
      requestBody: entry.requestBody,
      requestBodySize: entry.requestBodySize,
      requestBinary: entry.requestBinary,
      timestamp: entry.timestamp,
      status: entry.status,
      responseHeaders: entry.responseHeaders,
      responseBody: entry.responseBody,
      responseBodySize: entry.responseBodySize,
      responseBinary: entry.responseBinary,
      contentType: entry.contentType,
      contentLength: entry.contentLength,
      durationMs: entry.durationMs,
      complete: entry.complete,
      held: Boolean(entry.held),
      requestModified: Boolean(entry.requestModified),
      requestAborted: Boolean(entry.requestAborted),
      responseHeld: Boolean(entry.responseHeld),
      responseModified: Boolean(entry.responseModified),
      responseAborted: Boolean(entry.responseAborted),
      source: entry.source || 'proxy',
    };
  }

  /**
   * Record a manually resent request into history (always logged).
   */
  recordManualEntry(partial) {
    this.requestSeq += 1;
    const entry = this._toSerializable({
      id: partial.id || `resend-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      seq: this.requestSeq,
      method: (partial.method || 'GET').toUpperCase(),
      url: partial.url || '',
      host: partial.host || '',
      path: partial.path || '',
      protocol: partial.protocol || '',
      requestHeaders: partial.requestHeaders || {},
      requestBody: partial.requestBody || '',
      requestBodySize: partial.requestBodySize || 0,
      requestBinary: Boolean(partial.requestBinary),
      timestamp: partial.timestamp || Date.now(),
      status: partial.status ?? null,
      responseHeaders: partial.responseHeaders || {},
      responseBody: partial.responseBody || '',
      responseBodySize: partial.responseBodySize || 0,
      responseBinary: Boolean(partial.responseBinary),
      contentType: partial.contentType || '',
      contentLength: partial.contentLength ?? partial.responseBodySize ?? 0,
      durationMs: partial.durationMs ?? null,
      complete: true,
      source: 'resend',
    });

    this.history.push(entry);
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }
    this.emit('entry', entry);
    return entry;
  }

  getHistory() {
    return this.history.slice();
  }

  getEntry(id) {
    return this.history.find((e) => e.id === id) || null;
  }
}

module.exports = {
  ProxyEngine,
  DEFAULT_HOST,
  DEFAULT_PORT,
  MAX_BODY_BYTES,
};
