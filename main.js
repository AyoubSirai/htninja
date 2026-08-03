'use strict';

/**
 * Electron main process — window lifecycle, IPC, proxy orchestration.
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { ProxyEngine, DEFAULT_HOST, DEFAULT_PORT } = require('./proxy/engine');
const { launchChrome, launchFirefox } = require('./proxy/browserLauncher');
const { resendRequest, parseHeaderText } = require('./proxy/resender');
const { runAdvancedSearch } = require('./proxy/advancedSearch');

app.setName('HtNinja');

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {BrowserWindow | null} */
let configWindow = null;
/** @type {BrowserWindow | null} */
let repeaterWindow = null;
/** @type {BrowserWindow | null} */
let helpWindow = null;
/** @type {BrowserWindow | null} */
let searchWindow = null;
let lastAdvancedSearch = null;
let currentDomainFilter = '';
const settingsPath = path.join(app.getPath('userData'), 'settings.json');
const repeaterPath = path.join(app.getPath('userData'), 'repeater-sessions.json');
const browserProfilesPath = path.join(app.getPath('userData'), 'browser-profiles');
const MAX_REPEATER_SESSIONS = 200;

function loadSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return validateSettings(parsed);
  } catch {
    return {
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
      theme: 'light',
      responseTransformSource: '',
      responseTransformEnabled: false,
      responseTransformInScope: true,
    };
  }
}

function validateSettings(value) {
  const host = String(value && value.host ? value.host : '').trim();
  const port = Number(value && value.port);
  const theme = value && value.theme === 'dark' ? 'dark' : 'light';
  const responseTransformSource = String(value?.responseTransformSource || '').slice(0, 50_000);
  const responseTransformEnabled = Boolean(value?.responseTransformEnabled && responseTransformSource.trim());
  const responseTransformInScope = value?.responseTransformInScope !== false;

  const hostnamePattern =
    /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
  if (net.isIP(host) === 0 && !hostnamePattern.test(host)) {
    throw new Error('Host must be a valid hostname or IP address without a port.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Port must be an integer between 1 and 65535.');
  }
  return {
    host,
    port,
    theme,
    responseTransformSource,
    responseTransformEnabled,
    responseTransformInScope,
  };
}

function saveSettings(value) {
  const settings = validateSettings(value);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const temporaryPath = `${settingsPath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(temporaryPath, settingsPath);
  return settings;
}

let settings = loadSettings();
let repeaterSessions = loadRepeaterSessions();
const proxy = new ProxyEngine({
  host: settings.host,
  port: settings.port,
  certsDir: path.join(app.getPath('userData'), 'certs'),
});
try {
  proxy.setResponseTransform(
    settings.responseTransformSource,
    settings.responseTransformEnabled,
    settings.responseTransformInScope
  );
} catch {
  settings.responseTransformEnabled = false;
}

function headersToText(headers, options = {}) {
  const skipBodyHeaders = Boolean(options.skipBodyHeaders);
  return Object.entries(headers || {})
    .filter(([name]) => {
      if (!skipBodyHeaders) return true;
      return !/^(content-length|content-type|content-encoding|transfer-encoding)$/i.test(
        String(name || '')
      );
    })
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');
}

function normalizeRepeaterResponse(response) {
  if (!response || typeof response !== 'object') return null;
  return {
    id: String(response.id || ''),
    method: String(response.method || 'GET'),
    url: String(response.url || '').slice(0, 16_384),
    status: response.status ?? null,
    responseHeaders:
      response.responseHeaders && typeof response.responseHeaders === 'object'
        ? response.responseHeaders
        : {},
    responseBody: String(response.responseBody || '').slice(0, 2 * 1024 * 1024),
    responseBodySize: Number(response.responseBodySize) || 0,
    responseBinary: Boolean(response.responseBinary),
    contentType: String(response.contentType || ''),
    contentLength: Number(response.contentLength) || 0,
    durationMs: Number(response.durationMs) || 0,
    timestamp: Number(response.timestamp) || Date.now(),
  };
}

function normalizeRepeaterSession(value, fallbackId) {
  const method = String(value?.method || 'GET').trim().toUpperCase().slice(0, 20);
  const url = String(value?.url || '').trim().slice(0, 16_384);
  let title = String(value?.title || '').trim().slice(0, 80);
  if (!title && url) {
    try {
      const parsed = new URL(url);
      title = `${method} ${parsed.hostname}${parsed.pathname}`;
    } catch {
      title = `${method} request`;
    }
  }

  return {
    id: String(value?.id || fallbackId || `repeater-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    title: title || 'New request',
    method: method || 'GET',
    url,
    headers: String(value?.headers || '').slice(0, 262_144),
    body: String(value?.body || '').slice(0, 2 * 1024 * 1024),
    response: normalizeRepeaterResponse(value?.response),
    createdAt: Number(value?.createdAt) || Date.now(),
    updatedAt: Date.now(),
  };
}

function loadRepeaterSessions() {
  try {
    const parsed = JSON.parse(fs.readFileSync(repeaterPath, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(-MAX_REPEATER_SESSIONS).map((session) =>
      normalizeRepeaterSession({ ...session, response: null }, session.id)
    );
  } catch {
    return [];
  }
}

function saveRepeaterSessions() {
  fs.mkdirSync(path.dirname(repeaterPath), { recursive: true });
  const persistent = repeaterSessions.map(({ response: _response, ...session }) => session);
  fs.writeFileSync(repeaterPath, JSON.stringify(persistent, null, 2), 'utf8');
}

const APP_ICON = path.join(__dirname, 'icons', 'logo.png');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: settings.theme === 'light' ? '#f5f5f7' : '#000000',
    title: 'HtNinja — HTTPS Traffic Inspector',
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createConfigWindow() {
  if (configWindow && !configWindow.isDestroyed()) {
    configWindow.focus();
    return;
  }

  configWindow = new BrowserWindow({
    width: 460,
    height: 410,
    minWidth: 420,
    minHeight: 380,
    parent: mainWindow || undefined,
    modal: Boolean(mainWindow),
    show: false,
    resizable: false,
    backgroundColor: settings.theme === 'light' ? '#f5f5f7' : '#000000',
    title: 'HtNinja Configuration',
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  configWindow.loadFile(path.join(__dirname, 'renderer', 'config.html'));
  configWindow.once('ready-to-show', () => configWindow.show());
  configWindow.on('closed', () => {
    configWindow = null;
  });
}

function createRepeaterWindow() {
  if (repeaterWindow && !repeaterWindow.isDestroyed()) {
    repeaterWindow.show();
    repeaterWindow.focus();
    return;
  }

  repeaterWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    show: false,
    backgroundColor: settings.theme === 'light' ? '#f5f5f7' : '#000000',
    title: 'HtNinja Repeater',
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  repeaterWindow.loadFile(path.join(__dirname, 'renderer', 'repeater.html'));
  repeaterWindow.once('ready-to-show', () => repeaterWindow.show());
  repeaterWindow.on('closed', () => {
    repeaterWindow = null;
  });
}

function createHelpWindow() {
  if (helpWindow && !helpWindow.isDestroyed()) {
    helpWindow.show();
    helpWindow.focus();
    return;
  }

  helpWindow = new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    show: false,
    backgroundColor: settings.theme === 'light' ? '#f5f5f7' : '#000000',
    title: 'HtNinja Help — JavaScript Filter Guide',
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  helpWindow.loadFile(path.join(__dirname, 'renderer', 'help.html'));
  helpWindow.once('ready-to-show', () => helpWindow.show());
  helpWindow.on('closed', () => {
    helpWindow = null;
  });
}

function createSearchWindow() {
  if (searchWindow && !searchWindow.isDestroyed()) {
    searchWindow.show();
    searchWindow.focus();
    return;
  }

  searchWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 780,
    minHeight: 580,
    show: false,
    backgroundColor: settings.theme === 'light' ? '#f5f5f7' : '#000000',
    title: 'HtNinja Advanced Search',
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  searchWindow.loadFile(path.join(__dirname, 'renderer', 'search.html'));
  searchWindow.once('ready-to-show', () => searchWindow.show());
  searchWindow.on('closed', () => {
    searchWindow = null;
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function sendToRepeater(channel, payload) {
  if (repeaterWindow && !repeaterWindow.isDestroyed()) {
    repeaterWindow.webContents.send(channel, payload);
  }
}

function sendToSearchWindow(channel, payload) {
  if (searchWindow && !searchWindow.isDestroyed()) {
    searchWindow.webContents.send(channel, payload);
  }
}

proxy.on('entry', (entry) => {
  if (entry.source !== 'resend') send('traffic:entry', entry);
});
proxy.on('entry-removed', (id) => send('traffic:entryRemoved', id));
proxy.on('state', (state) => send('proxy:state', state));
proxy.on('response-transform-error', (info) => send('responseTransform:error', info));
proxy.on('cleared', (payload) => send('traffic:cleared', payload || { keptIds: [] }));
proxy.on('filter-error', (info) => send('filter:error', info));
proxy.on('error', (err) => {
  send('proxy:error', { message: err.message || String(err) });
});

function registerIpc() {
  ipcMain.handle('proxy:getState', async () => proxy.getState());

  ipcMain.handle('proxy:start', async () => {
    try {
      const state = await proxy.start(settings.port, settings.host);
      return { ok: true, state };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('proxy:pause', async () => {
    try {
      const state = await proxy.pause();
      return { ok: true, state };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('proxy:resume', async () => {
    try {
      const state = await proxy.resume();
      return { ok: true, state };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('proxy:toggle', async () => {
    try {
      const state = await proxy.toggle();
      return { ok: true, state };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('proxy:setHolding', async (_e, enabled) => {
    try {
      const state = proxy.setHolding(Boolean(enabled));
      return { ok: true, state };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('proxy:updateHeldRequest', async (_e, id, payload, forward) => {
    try {
      let headers = payload?.headers;
      if (typeof headers === 'string') headers = parseHeaderText(headers);
      else if (!headers || typeof headers !== 'object') headers = {};

      const entry = proxy.updateHeldRequest(
        String(id || ''),
        {
          method: payload?.method,
          url: payload?.url,
          headers,
          body: payload?.body,
        },
        Boolean(forward)
      );
      return { ok: true, entry, state: proxy.getState() };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('proxy:setResponseIntercepting', async (_e, enabled) => {
    try {
      const state = proxy.setResponseIntercepting(Boolean(enabled));
      return { ok: true, state };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('proxy:updateHeldResponse', async (_e, id, payload, forward) => {
    try {
      let headers = payload?.headers;
      if (typeof headers === 'string') headers = parseHeaderText(headers);
      else if (!headers || typeof headers !== 'object') headers = {};
      const entry = proxy.updateHeldResponse(
        String(id || ''),
        {
          status: payload?.status,
          headers,
          body: payload?.body,
        },
        Boolean(forward)
      );
      return { ok: true, entry, state: proxy.getState() };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('proxy:replaceHeldResponseText', async (_e, id, payload) => {
    try {
      const entry = proxy.replaceHeldResponseText(
        String(id || ''),
        payload?.search,
        payload?.replacement,
        {
          regex: Boolean(payload?.regex),
          caseSensitive: Boolean(payload?.caseSensitive),
        }
      );
      return { ok: true, entry };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('proxy:transformHeldResponse', async (_e, id, source) => {
    try {
      const entry = proxy.applyHeldResponseTransform(String(id || ''), source);
      return { ok: true, entry, state: proxy.getState() };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('proxy:abortHeldResponse', async (_e, id, mode) => {
    try {
      const entry = proxy.abortHeldResponse(String(id || ''), mode);
      return { ok: true, entry, state: proxy.getState() };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('proxy:stop', async () => {
    try {
      const state = await proxy.stop();
      return { ok: true, state };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('proxy:clearHistory', async (_e, keepIds = []) => {
    const result = proxy.clearHistory(keepIds);
    lastAdvancedSearch = null;
    const clearedSearch = {
      ok: true,
      active: false,
      focus: false,
      matches: [],
      query: null,
      totalSearched: 0,
    };
    send('search:results', clearedSearch);
    sendToSearchWindow('search:results', clearedSearch);
    return { ok: true, keptIds: result.keptIds || [] };
  });

  ipcMain.handle('proxy:getHistory', async () =>
    proxy.getHistory().filter((entry) => entry.source !== 'resend')
  );

  ipcMain.handle('proxy:exportCA', async () => {
    try {
      // Ensure CA exists even if proxy not started yet
      await proxy.ensureCA();
      const pem = proxy.getCACertificatePem();
      const defaultPath = path.join(app.getPath('documents'), 'htninja-ca.pem');

      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: 'Export HtNinja Root CA Certificate',
        defaultPath,
        filters: [
          { name: 'PEM Certificate', extensions: ['pem', 'crt', 'cer'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });

      if (canceled || !filePath) {
        return { ok: false, canceled: true };
      }

      fs.writeFileSync(filePath, pem, 'utf8');
      return { ok: true, filePath, caPath: proxy.getCACertificatePath() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('proxy:getCAPath', async () => {
    try {
      await proxy.ensureCA();
      return { ok: true, path: proxy.getCACertificatePath() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('proxy:openCAFolder', async () => {
    try {
      await proxy.ensureCA();
      const folder = path.dirname(proxy.getCACertificatePath());
      await shell.openPath(folder);
      return { ok: true, path: folder };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('filter:setJs', async (_e, source, options = {}) => {
    const result = proxy.setJsFilter(source, {
      applyToExisting: Boolean(options?.applyToExisting),
      domainScope: options?.domainScope,
    });
    return result;
  });

  ipcMain.handle('filter:getJs', async () => ({
    ok: true,
    source: proxy.getJsFilterSource(),
  }));

  ipcMain.handle('responseTransform:get', async () => ({
    ok: true,
    ...proxy.getResponseTransform(),
  }));

  ipcMain.handle('responseTransform:validate', async (_event, source) => {
    try {
      const result = proxy.validateResponseTransform(source);
      return result;
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('responseTransform:set', async (_event, source, enabled, inScope) => {
    try {
      const result = proxy.setResponseTransform(source, Boolean(enabled), inScope !== false);
      settings = saveSettings({
        ...settings,
        responseTransformSource: result.source,
        responseTransformEnabled: result.enabled,
        responseTransformInScope: result.inScope,
      });
      return { ok: true, ...result, state: proxy.getState() };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('config:open', async () => {
    createConfigWindow();
    return { ok: true };
  });

  ipcMain.handle('config:get', async () => ({
    ok: true,
    settings,
    proxyRunning: proxy.getState().running,
  }));

  ipcMain.handle('config:save', async (_e, value) => {
    try {
      const next = validateSettings({ ...settings, ...value });
      const state = proxy.getState();
      const networkChanged = next.host !== settings.host || next.port !== settings.port;
      if (state.running && networkChanged) {
        return {
          ok: false,
          error: 'Pause does not release the listener. Stop and restart the app before changing host or port.',
        };
      }

      settings = saveSettings(next);
      proxy.host = settings.host;
      proxy.port = settings.port;
      mainWindow?.setBackgroundColor(settings.theme === 'light' ? '#f5f5f7' : '#000000');
      configWindow?.setBackgroundColor(settings.theme === 'light' ? '#f5f5f7' : '#000000');
      repeaterWindow?.setBackgroundColor(settings.theme === 'light' ? '#f5f5f7' : '#000000');
      helpWindow?.setBackgroundColor(settings.theme === 'light' ? '#f5f5f7' : '#000000');
      searchWindow?.setBackgroundColor(settings.theme === 'light' ? '#f5f5f7' : '#000000');
      send('config:changed', settings);
      sendToRepeater('config:changed', settings);
      helpWindow?.webContents.send('config:changed', settings);
      searchWindow?.webContents.send('config:changed', settings);
      return { ok: true, settings };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('config:close', async () => {
    configWindow?.close();
    return { ok: true };
  });

  ipcMain.handle('help:open', async () => {
    createHelpWindow();
    return { ok: true };
  });

  ipcMain.handle('search:open', async () => {
    createSearchWindow();
    return { ok: true };
  });

  ipcMain.handle('search:setDomainScope', async (_event, pattern) => {
    currentDomainFilter = String(pattern || '').trim();
    proxy.setResponseTransformDomainScope(currentDomainFilter);
    sendToSearchWindow('search:domainScope', currentDomainFilter);
    return { ok: true, domainFilter: currentDomainFilter };
  });

  ipcMain.handle('search:run', async (_event, value) => {
    try {
      const result = runAdvancedSearch(proxy.getHistory(), {
        ...(value || {}),
        domainPattern: currentDomainFilter,
      });
      if (!result.ok) return result;
      lastAdvancedSearch = result;
      send('search:results', { ...result, active: true });
      return result;
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('search:getState', async () => ({
    ok: true,
    active: Boolean(lastAdvancedSearch),
    result: lastAdvancedSearch,
    domainFilter: currentDomainFilter,
  }));

  ipcMain.handle('search:setFocus', async (_event, enabled) => {
    if (!lastAdvancedSearch) {
      return { ok: false, error: 'Run a search before focusing matches.' };
    }
    lastAdvancedSearch = { ...lastAdvancedSearch, focus: Boolean(enabled) };
    send('search:results', { ...lastAdvancedSearch, active: true });
    return { ok: true, focus: lastAdvancedSearch.focus };
  });

  ipcMain.handle('search:clear', async () => {
    lastAdvancedSearch = null;
    const clearedSearch = {
      ok: true,
      active: false,
      focus: false,
      matches: [],
      query: null,
      totalSearched: 0,
    };
    send('search:results', clearedSearch);
    sendToSearchWindow('search:results', clearedSearch);
    return { ok: true };
  });

  ipcMain.handle('search:select', async (_event, id) => {
    const entry = proxy.getEntry(String(id || ''));
    if (!entry || entry.source === 'resend') {
      return { ok: false, error: 'That request is no longer available.' };
    }
    mainWindow?.show();
    mainWindow?.focus();
    send('search:select', entry.id);
    return { ok: true };
  });

  ipcMain.handle('repeater:open', async () => {
    createRepeaterWindow();
    return { ok: true };
  });

  ipcMain.handle('repeater:list', async () => ({
    ok: true,
    sessions: repeaterSessions,
  }));

  ipcMain.handle('repeater:add', async (_e, value) => {
    try {
      let source = value;
      if (value?.requestHeaders || value?.requestBody != null || value?.seq != null) {
        const method = String(value.method || 'GET').trim().toUpperCase() || 'GET';
        const isBodyless = method === 'GET' || method === 'HEAD';
        source = {
          title: `#${value.seq || ''} ${method} ${value.host || ''}`.trim(),
          method,
          url: value.url || '',
          headers: headersToText(value.requestHeaders || {}, { skipBodyHeaders: isBodyless }),
          body: isBodyless ? '' : value.requestBody || '',
        };
      }
      const session = normalizeRepeaterSession(source);
      repeaterSessions.push(session);
      if (repeaterSessions.length > MAX_REPEATER_SESSIONS) {
        repeaterSessions.splice(0, repeaterSessions.length - MAX_REPEATER_SESSIONS);
      }
      saveRepeaterSessions();
      createRepeaterWindow();
      sendToRepeater('repeater:changed', {
        type: 'add',
        session: {
          ...session,
          headers: String(session.headers || ''),
          body: String(session.body || ''),
        },
      });
      return { ok: true, session };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('repeater:update', async (_e, id, patch) => {
    try {
      const index = repeaterSessions.findIndex((session) => session.id === id);
      if (index < 0) return { ok: false, error: 'Repeater request not found.' };
      const current = repeaterSessions[index];
      const updated = normalizeRepeaterSession(
        {
          ...current,
          ...patch,
          id: current.id,
          createdAt: current.createdAt,
        },
        current.id
      );
      repeaterSessions[index] = updated;
      saveRepeaterSessions();
      sendToRepeater('repeater:changed', { type: 'update', session: updated });
      return { ok: true, session: updated };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('repeater:remove', async (_e, id) => {
    const index = repeaterSessions.findIndex((session) => session.id === id);
    if (index < 0) return { ok: false, error: 'Repeater request not found.' };
    repeaterSessions.splice(index, 1);
    saveRepeaterSessions();
    sendToRepeater('repeater:changed', { type: 'remove', id });
    return { ok: true };
  });

  ipcMain.handle('request:resend', async (_e, payload) => {
    try {
      const method = String(payload?.method || 'GET').toUpperCase();
      const url = String(payload?.url || '').trim();
      if (!url) return { ok: false, error: 'URL is required.' };

      let headers = payload?.headers;
      if (typeof headers === 'string') {
        headers = parseHeaderText(headers);
      } else if (!headers || typeof headers !== 'object') {
        headers = {};
      }

      let ca;
      try {
        await proxy.ensureCA();
        ca = proxy.getCACertificatePem();
      } catch {
        ca = undefined;
      }

      const result = await resendRequest(
        {
          method,
          url,
          headers,
          body: payload?.body == null ? '' : String(payload.body),
        },
        { ca }
      );

      const entry = proxy.recordManualEntry(result);
      return { ok: true, entry };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('browser:launchChrome', async (_e, opts) => {
    try {
      const state = proxy.getState();
      if (!state.running) {
        return { ok: false, error: 'Start the proxy before launching a browser.' };
      }
      const info = launchChrome(state.port, {
        ...(opts || {}),
        host: state.host,
        profileRoot: browserProfilesPath,
      });
      return { ok: true, info };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('browser:launchFirefox', async (_e, opts) => {
    try {
      const state = proxy.getState();
      if (!state.running) {
        return { ok: false, error: 'Start the proxy before launching a browser.' };
      }
      const info = launchFirefox(state.port, {
        ...(opts || {}),
        host: state.host,
        profileRoot: browserProfilesPath,
      });
      return { ok: true, info };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let quitting = false;

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (e) => {
  if (quitting) return;
  if (!proxy.getState().running) return;
  e.preventDefault();
  quitting = true;
  proxy
    .stop()
    .catch(() => {})
    .finally(() => app.exit(0));
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  send('proxy:error', { message: err.message || String(err) });
});

process.on('unhandledRejection', (reason) => {
  const message = reason && reason.message ? reason.message : String(reason);
  console.error('[unhandledRejection]', message);
  send('proxy:error', { message });
});
