'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const heldEntry = {
  id: 'response-ui-test',
  seq: 1,
  method: 'GET',
  url: 'https://example.test/api',
  host: 'example.test',
  path: '/api',
  protocol: 'https',
  requestHeaders: { accept: '*/*' },
  requestBody: '',
  timestamp: Date.now(),
  status: 200,
  responseHeaders: { 'content-type': 'text/plain', 'x-test': 'yes' },
  responseBody: 'original response',
  responseBodySize: 17,
  contentType: 'text/plain',
  contentLength: 17,
  durationMs: 10,
  complete: true,
  responseHeld: true,
};

let savedPayload = null;
let savedHook = null;
ipcMain.handle('config:get', () => ({
  ok: true,
  settings: { theme: 'light', host: '127.0.0.1', port: 8080 },
}));
ipcMain.handle('proxy:getState', () => ({
  mode: 'recording',
  host: '127.0.0.1',
  port: 8080,
  holding: false,
  heldCount: 0,
  interceptResponses: true,
  heldResponseCount: 1,
  responseTransformActive: true,
}));
ipcMain.handle('proxy:getHistory', () => [heldEntry]);
ipcMain.handle('search:getState', () => ({ active: false }));
ipcMain.handle('filter:getJs', () => ({ ok: true, source: '' }));
ipcMain.handle('responseTransform:get', () => ({
  ok: true,
  source: "res.body = res.body.replaceAll('a', 'b');\nreturn res;",
  enabled: true,
  inScope: true,
}));
ipcMain.handle('responseTransform:set', (_event, source, enabled, inScope) => {
  savedHook = { source, enabled, inScope };
  return {
    ok: true,
    source,
    enabled,
    inScope,
    state: {
      mode: 'recording',
      host: '127.0.0.1',
      port: 8080,
      responseTransformActive: enabled,
    },
  };
});
ipcMain.handle('proxy:updateHeldResponse', (_event, id, payload, forward) => {
  savedPayload = { id, payload, forward };
  return {
    ok: true,
    entry: {
      ...heldEntry,
      status: Number(payload.status),
      responseHeaders: { 'content-type': 'text/plain' },
      responseBody: payload.body,
    },
  };
});

app.whenReady().then(async () => {
  const errors = [];
  const window = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) errors.push(message);
  });
  await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise((resolve) => setTimeout(resolve, 200));

  const initial = await window.webContents.executeJavaScript(`(() => ({
    dialogOpen: document.getElementById('response-editor-dialog').open,
    status: document.getElementById('response-status').value,
    body: document.getElementById('response-body').value,
    buttonText: document.getElementById('btn-intercept-response').textContent,
    hookButtonText: document.getElementById('btn-response-hook').textContent,
    heldRow: Boolean(document.querySelector('tr.response-held-row')),
    editVisible: !document.getElementById('btn-edit-response').classList.contains('hidden-action')
  }))()`);
  if (
    !initial.dialogOpen ||
    initial.status !== '200' ||
    initial.body !== 'original response' ||
    !initial.buttonText.includes('Release Responses') ||
    !initial.hookButtonText.includes('Running') ||
    !initial.heldRow ||
    !initial.editVisible
  ) {
    throw new Error(`Response interceptor UI did not initialize: ${JSON.stringify(initial)}`);
  }

  await window.webContents.executeJavaScript(`(() => {
    document.getElementById('response-body').value = 'edited in UI';
    document.getElementById('response-save').click();
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (
    !savedPayload ||
    savedPayload.id !== heldEntry.id ||
    savedPayload.payload.body !== 'edited in UI' ||
    savedPayload.forward !== false
  ) {
    throw new Error(`Response editor did not save through IPC: ${JSON.stringify(savedPayload)}`);
  }

  await window.webContents.executeJavaScript(
    `document.getElementById('btn-response-hook').click()`
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  const hookDialog = await window.webContents.executeJavaScript(`(() => ({
    open: document.getElementById('response-hook-dialog').open,
    source: document.querySelector('#response-hook-source .cm-content')?.textContent || '',
    inScope: document.getElementById('response-hook-in-scope').checked,
    hasEditor: Boolean(document.querySelector('#response-hook-source .cm-editor'))
  }))()`);
  if (
    !hookDialog.open ||
    !hookDialog.source.includes("res.body = res.body.replaceAll('a', 'b')") ||
    !hookDialog.inScope ||
    !hookDialog.hasEditor
  ) {
    throw new Error(`Automatic response hook dialog failed: ${JSON.stringify(hookDialog)}`);
  }
  const casing = await window.webContents.executeJavaScript(`(() => {
    const sample = document.querySelector('#response-hook-source .cm-content');
    return sample ? getComputedStyle(sample).textTransform : '';
  })()`);
  if (casing && casing !== 'none') {
    throw new Error(`Hook editor must use normal JavaScript casing, got text-transform=${casing}`);
  }
  await window.webContents.executeJavaScript(
    `document.querySelector('#response-hook-source .cm-content').focus()`
  );
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const indentedSource = await window.webContents.executeJavaScript(
    `document.querySelector('#response-hook-source .cm-content').textContent`
  );
  if (!indentedSource.startsWith('    ') || indentedSource.startsWith('\t')) {
    throw new Error(`Hook editor Tab did not indent by four spaces: ${JSON.stringify(indentedSource)}`);
  }
  await window.webContents.executeJavaScript(
    `document.getElementById('response-hook-start').click()`
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  if (
    !savedHook?.enabled ||
    !savedHook.source.startsWith("    res.body = res.body.replaceAll('a', 'b')") ||
    !savedHook.inScope
  ) {
    throw new Error(`Automatic response hook did not save: ${JSON.stringify(savedHook)}`);
  }
  if (errors.length) throw new Error(`Renderer errors: ${errors.join(' | ')}`);

  console.log('Response interceptor UI test passed');
  window.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
