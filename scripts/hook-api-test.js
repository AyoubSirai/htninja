'use strict';

const http = require('http');
const os = require('os');
const path = require('path');
const { ProxyEngine } = require('../proxy/engine');

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function waitFor(check, timeoutMs = 3000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function proxyRequest(proxyPort, originPort, pathName, options = {}) {
  return new Promise((resolve, reject) => {
    const method = options.method || 'GET';
    const body = options.body == null ? null : String(options.body);
    const headers = {
      host: `127.0.0.1:${originPort}`,
      ...(options.headers || {}),
    };
    if (body != null && headers['content-length'] == null) {
      headers['content-length'] = Buffer.byteLength(body, 'utf8');
    }
    const request = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method,
        path: `http://127.0.0.1:${originPort}${pathName}`,
        headers,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    request.on('error', reject);
    if (body != null) request.end(body);
    else request.end();
  });
}

async function main() {
  let lastObserved = null;
  const origin = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      lastObserved = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello');
    });
  });
  const originPort = await listen(origin);
  const proxyPort = 30000 + Math.floor(Math.random() * 20000);
  const proxy = new ProxyEngine({
    host: '127.0.0.1',
    port: proxyPort,
    certsDir: path.join(os.tmpdir(), 'smartnet-hook-api-test-certs'),
  });

  try {
    await proxy.start();
    console.log('proxy up on', proxyPort);

    // Pause first (before abort) to isolate the hold/release path.
    proxy.setResponseTransform(
      `if (req.path === '/hook-pause') pause();`,
      true,
      false
    );
    const pausePromise = proxyRequest(proxyPort, originPort, '/hook-pause', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'pause-me',
    });
    await waitFor(() => proxy.getState().heldCount === 1);
    console.log('held', proxy.getState().heldCount, 'holding', proxy.getState().holding);
    const pausedEntry = proxy.getHistory().find((entry) => entry.path === '/hook-pause' && entry.held);
    proxy.updateHeldRequest(
      pausedEntry.id,
      {
        method: 'POST',
        url: pausedEntry.url,
        headers: { 'content-type': 'text/plain', 'x-released': '1' },
        body: 'pause-me',
      },
      true
    );
    const pausedResponse = await Promise.race([
      pausePromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('pause release timed out')), 3000)),
    ]);
    console.log('pause ok', pausedResponse.status, 'origin body', lastObserved && lastObserved.body);
    proxy.setHolding(false);

    proxy.setResponseTransform(`req.body = 'replaced-payload';`, true, false);
    lastObserved = null;
    await proxyRequest(proxyPort, originPort, '/replace-body', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'original-payload',
    });
    if (!lastObserved || lastObserved.body !== 'replaced-payload') {
      throw new Error(`Body replace failed: ${JSON.stringify(lastObserved)}`);
    }
    console.log('body replace ok');

    proxy.setResponseTransform(
      `if (req.path === '/hook-abort') { req.abort(); }`,
      true,
      false
    );
    const aborted = await Promise.race([
      proxyRequest(proxyPort, originPort, '/hook-abort')
        .then(() => false)
        .catch(() => true),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 2000)),
    ]);
    if (aborted !== true && aborted !== 'timeout') {
      throw new Error(`req.abort() failed: ${aborted}`);
    }
    console.log('abort ok', aborted);

    proxy.history.push({
      id: 'hist-1',
      seq: 1,
      method: 'GET',
      url: 'http://example.com/keep',
      host: 'example.com',
      path: '/keep',
      requestHeaders: {},
      requestBody: '',
      status: 200,
      responseHeaders: {},
      responseBody: 'keep',
      contentType: 'text/plain',
      source: 'proxy',
    });
    proxy.history.push({
      id: 'hist-2',
      seq: 2,
      method: 'POST',
      url: 'http://example.com/drop',
      host: 'example.com',
      path: '/drop',
      requestHeaders: {},
      requestBody: 'x',
      status: 200,
      responseHeaders: {},
      responseBody: 'drop',
      contentType: 'text/plain',
      source: 'proxy',
    });
    const filtered = proxy.setJsFilter(`req.method === 'GET'`, {
      applyToExisting: true,
      domainScope: 'example.com',
    });
    if (!filtered.ok || filtered.removed !== 1) {
      throw new Error(
        `Filter existing failed: ${JSON.stringify(filtered)} history=${proxy.history.length}`
      );
    }
    console.log('filter existing ok');
    console.log('hook api tests passed');
  } finally {
    if (proxy.getState().running) await proxy.stop();
    await new Promise((resolve) => origin.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
