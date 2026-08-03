'use strict';

const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
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
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for response hold.');
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
    const request = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method,
      path: `http://127.0.0.1:${originPort}${pathName}`,
      headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const rawBody = Buffer.concat(chunks);
        resolve({
          status: response.statusCode,
          headers: response.headers,
          rawBody,
          body: rawBody.toString('utf8'),
        });
      });
    });
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
      if (req.url === '/gzip') {
        const compressed = zlib.gzipSync(Buffer.from('compressed old value'));
        res.writeHead(200, {
          'content-type': 'text/plain',
          'content-encoding': 'gzip',
          'content-length': compressed.length,
        });
        res.end(compressed);
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/plain',
        'x-origin': 'yes',
      });
      res.end('hello old value');
    });
  });
  const originPort = await listen(origin);
  const proxy = new ProxyEngine({
    host: '127.0.0.1',
    port: 18082,
    certsDir: path.join(os.tmpdir(), 'smartnet-response-interceptor-test-certs'),
  });

  try {
    await proxy.start();
    proxy.setResponseTransform(`if (!req.path.startsWith('/automatic')) return;
      res.status = 202;
      res.headers['x-automatic-hook'] = 'yes';
      res.body = res.body.replaceAll('old', 'automatic');`, true, true);
    proxy.setResponseTransformDomainScope('outside.example');
    const outOfScope = await proxyRequest(18082, originPort, '/automatic-out-of-scope');
    if (outOfScope.status !== 200 || outOfScope.body !== 'hello old value') {
      throw new Error(`In-scope hook modified an out-of-scope response: ${JSON.stringify(outOfScope)}`);
    }
    proxy.setResponseTransformDomainScope('127.0.0.1');
    const automatic = await proxyRequest(18082, originPort, '/automatic');
    if (
      automatic.status !== 202 ||
      automatic.headers['x-automatic-hook'] !== 'yes' ||
      automatic.body !== 'hello automatic value' ||
      proxy.getState().heldResponseCount !== 0
    ) {
      throw new Error(`Automatic hook paused or returned wrong response: ${JSON.stringify(automatic)}`);
    }
    const automaticHistory = proxy.getHistory().find((entry) => entry.path === '/automatic');
    if (!automaticHistory?.responseModified) {
      throw new Error('Automatic response modification was not recorded in history.');
    }
    const transformSource = proxy.getResponseTransform().source;
    proxy.setResponseTransformDomainScope('outside.example');
    proxy.setResponseTransform(transformSource, true, false);
    const allDomains = await proxyRequest(18082, originPort, '/automatic-all-domains');
    if (allDomains.status !== 202 || allDomains.body !== 'hello automatic value') {
      throw new Error(`Disabled in-scope restriction still filtered the hook: ${JSON.stringify(allDomains)}`);
    }

    proxy.setResponseTransform(
      `req.body = '';
       req.headers['x-hooked-request'] = 'yes';
       if (phase === 'response') {
         res.headers['x-hooked-response'] = 'yes';
       }`,
      true,
      false
    );
    lastObserved = null;
    const cleared = await proxyRequest(18082, originPort, '/clear-body', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'secret-payload',
    });
    if (
      !lastObserved ||
      lastObserved.body !== '' ||
      lastObserved.headers['content-length'] !== '0' ||
      lastObserved.headers['x-hooked-request'] !== 'yes' ||
      cleared.headers['x-hooked-response'] !== 'yes'
    ) {
      throw new Error(
        `Request hook did not clear/modify the outbound request: ${JSON.stringify({
          lastObserved,
          cleared,
        })}`
      );
    }
    const clearedHistory = proxy.getHistory().find((entry) => entry.path === '/clear-body');
    if (
      !clearedHistory?.requestModified ||
      clearedHistory.requestBody !== '' ||
      clearedHistory.requestHeaders['content-length'] !== '0'
    ) {
      throw new Error(`Cleared request was not recorded in history: ${JSON.stringify(clearedHistory)}`);
    }

    proxy.setResponseTransform(
      `req.body = 'replaced-payload';
       req.headers['content-type'] = 'text/plain';`,
      true,
      false
    );
    lastObserved = null;
    await proxyRequest(18082, originPort, '/replace-body', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'original-payload',
    });
    if (!lastObserved || lastObserved.body !== 'replaced-payload') {
      throw new Error(
        `Request hook did not replace the outbound body: ${JSON.stringify(lastObserved)}`
      );
    }

    proxy.setResponseTransform(
      `if (req.path === '/hook-abort') {
         req.abort();
         return;
       }
       if (req.path === '/hook-pause') {
         pause();
       }`,
      true,
      false
    );
    const abortedByHook = await Promise.race([
      proxyRequest(18082, originPort, '/hook-abort')
        .then(() => ({ aborted: false }))
        .catch(() => ({ aborted: true })),
      new Promise((resolve) => setTimeout(() => resolve({ aborted: true, timedOut: true }), 2000)),
    ]);
    if (!abortedByHook.aborted) {
      throw new Error('req.abort() did not cancel the request.');
    }

    const pausePromise = proxyRequest(18082, originPort, '/hook-pause', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'pause-me',
    });
    await waitFor(() => proxy.getState().heldCount === 1);
    if (!proxy.getState().holding) {
      throw new Error('pause() did not enable Hold Requests.');
    }
    const pausedEntry = proxy.getHistory().find((entry) => entry.path === '/hook-pause' && entry.held);
    if (!pausedEntry) throw new Error('pause() did not hold the current request.');
    proxy.setHolding(false);
    const pausedResponse = await pausePromise;
    if (pausedResponse.status !== 200) {
      throw new Error(`Paused request returned unexpected response: ${JSON.stringify(pausedResponse)}`);
    }

    proxy.setResponseTransform(transformSource, false, false);

    proxy.setResponseIntercepting(true);

    const responsePromise = proxyRequest(18082, originPort, '/modify');
    await waitFor(() => proxy.getState().heldResponseCount === 1);
    const held = proxy.getHistory().find((entry) => entry.responseHeld);
    if (!held) throw new Error('Intercepted response was not published to history.');

    proxy.replaceHeldResponseText(held.id, 'old', 'new');
    const transformed = proxy.applyHeldResponseTransform(
      held.id,
      `res.status = 201;
        res.headers['x-transformed'] = req.path;
        res.body = res.body.toUpperCase();
        return res;`
    );
    if (transformed.status !== 201 || transformed.responseBody !== 'HELLO NEW VALUE') {
      throw new Error(`Unexpected transformed entry: ${JSON.stringify(transformed)}`);
    }
    proxy.updateHeldResponse(held.id, {}, true);

    const response = await responsePromise;
    if (
      response.status !== 201 ||
      response.headers['x-transformed'] !== '/modify' ||
      response.body !== 'HELLO NEW VALUE'
    ) {
      throw new Error(`Browser received wrong modified response: ${JSON.stringify(response)}`);
    }

    const gzipPromise = proxyRequest(18082, originPort, '/gzip');
    await waitFor(() => proxy.getState().heldResponseCount === 1);
    const gzipEntry = proxy.getHistory().find((entry) => entry.responseHeld);
    proxy.replaceHeldResponseText(gzipEntry.id, 'old', 'new');
    proxy.updateHeldResponse(gzipEntry.id, {}, true);
    const gzipResponse = await gzipPromise;
    const decodedGzip = gzipResponse.headers['content-encoding'] === 'gzip'
      ? zlib.gunzipSync(gzipResponse.rawBody).toString('utf8')
      : gzipResponse.body;
    if (decodedGzip !== 'compressed new value') {
      throw new Error(`Edited compressed response was invalid: ${decodedGzip}`);
    }

    const abortedPromise = proxyRequest(18082, originPort, '/abort')
      .then(() => ({ aborted: false }))
      .catch(() => ({ aborted: true }));
    await waitFor(() => proxy.getState().heldResponseCount === 1);
    const abortEntry = proxy.getHistory().find((entry) => entry.responseHeld);
    proxy.abortHeldResponse(abortEntry.id, 'reset');
    const aborted = await abortedPromise;
    if (!aborted.aborted) throw new Error('Reset response did not abort the client connection.');

    proxy.setResponseIntercepting(false);
    console.log('Response interceptor modify/transform/abort test passed');
  } finally {
    if (proxy.getState().running) await proxy.stop();
    await new Promise((resolve) => origin.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
