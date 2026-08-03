'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const session = {
  id: 'editor-test',
  title: 'POST api.example.test',
  method: 'POST',
  url: 'https://api.example.test/items?view=full',
  headers: 'Host: api.example.test\nContent-Type: application/json',
  body: '{"name":"Widget","enabled":true}',
  response: null,
};

ipcMain.handle('config:get', () => ({
  ok: true,
  settings: { theme: 'light', host: '127.0.0.1', port: 8080 },
}));
ipcMain.handle('repeater:list', () => ({ ok: true, sessions: [session] }));
ipcMain.handle('repeater:update', () => ({ ok: true }));
ipcMain.handle('repeater:add', () => ({ ok: true, session }));
ipcMain.handle('repeater:remove', () => ({ ok: true }));

app.whenReady().then(async () => {
  const errors = [];
  const window = new BrowserWindow({
    show: false,
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
  await window.loadFile(path.join(__dirname, '..', 'renderer', 'repeater.html'));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const result = await window.webContents.executeJavaScript(`(() => ({
    hasEditor: Boolean(document.querySelector('#request-raw .cm-editor')),
    hasHeaderHighlight: Boolean(document.querySelector('.cm-syntax-header-name')),
    hasJsonHighlight: Boolean(document.querySelector('.cm-syntax-property')),
    content: document.querySelector('#request-raw .cm-content')?.textContent || '',
    hasRequestFind: Boolean(document.getElementById('request-find')),
    hasResponseFind: Boolean(document.getElementById('response-find')),
    hasCopyAsFetch: Boolean(document.getElementById('copy-as-fetch')),
    hasFetchDialog: Boolean(document.getElementById('fetch-dialog')),
    toolbarLayout: (() => {
      const controls = document.querySelector('.request-controls').getBoundingClientRect();
      const send = document.getElementById('send-request').getBoundingClientRect();
      const method = document.getElementById('request-method').getBoundingClientRect();
      const url = document.getElementById('request-url').getBoundingClientRect();
      const state = document.getElementById('send-state').getBoundingClientRect();
      const fetch = document.getElementById('copy-as-fetch').getBoundingClientRect();
      return send.left < method.left &&
        method.left < url.left &&
        url.left < state.left &&
        state.left < fetch.left &&
        method.width >= 90 &&
        fetch.width <= 40 &&
        fetch.right <= controls.right;
    })(),
    contentLengthMatches: (() => {
      const raw = [...document.querySelectorAll('#request-raw .cm-line')]
        .map((line) => line.textContent)
        .join('\\n');
      const parts = raw.replace(/\\r\\n/g, '\\n').split('\\n\\n');
      const value = /^content-length:\\s*(\\d+)$/im.exec(parts[0] || '')?.[1];
      return Number(value) === new TextEncoder().encode(parts.slice(1).join('\\n\\n')).length;
    })()
  }))()`);

  if (!result.hasEditor) throw new Error('CodeMirror editor did not initialize.');
  if (!result.hasHeaderHighlight) throw new Error('HTTP header highlighting is missing.');
  if (!result.hasJsonHighlight) throw new Error('JSON highlighting is missing.');
  if (!result.content.includes('"name": "Widget"')) {
    throw new Error('JSON request body was not prettified.');
  }
  if (!result.hasRequestFind || !result.hasResponseFind) {
    throw new Error('Repeater search controls are missing.');
  }
  if (!result.hasCopyAsFetch || !result.hasFetchDialog) {
    throw new Error('Copy as fetch dialog controls are missing.');
  }
  if (!result.toolbarLayout) {
    throw new Error('Repeater toolbar controls are ordered or sized incorrectly.');
  }
  if (!result.contentLengthMatches) {
    throw new Error('Repeater Content-Length does not match UTF-8 request body bytes.');
  }

  await window.webContents.executeJavaScript(
    `document.getElementById('copy-as-fetch').click()`
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  const fetchDialog = await window.webContents.executeJavaScript(`(() => {
    const code = document.getElementById('fetch-code')?.textContent || '';
    return {
      code,
      open: document.getElementById('fetch-dialog').open,
      hasFetch: code.includes('await fetch('),
      hasUrl: code.includes('https://api.example.test/items?view=full'),
      hasMethod: code.includes('method: "POST"'),
      hasBody: code.includes('body:') && code.includes('Widget'),
      highlighted: Boolean(document.querySelector('#fetch-code .cm-content span')),
    };
  })()`);
  if (
    !fetchDialog.open ||
    !fetchDialog.hasFetch ||
    !fetchDialog.hasUrl ||
    !fetchDialog.hasMethod ||
    !fetchDialog.hasBody ||
    !fetchDialog.highlighted
  ) {
    throw new Error(`Fetch dialog snippet is incomplete: ${JSON.stringify(fetchDialog)}`);
  }
  if (fetchDialog.code.includes('\\n')) {
    throw new Error('Fetch snippet JSON body should be compact, not prettified.');
  }
  if (errors.length) throw new Error(`Renderer errors: ${errors.join(' | ')}`);

  console.log('Repeater CodeMirror UI test passed');
  window.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
