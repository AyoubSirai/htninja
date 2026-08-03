'use strict';

const http = require('http');
const os = require('os');
const path = require('path');
const { ProxyEngine } = require('../proxy/engine');

async function listen(server, host = '127.0.0.1') {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function main() {
  let observedRequest = null;
  const origin = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      observedRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('released');
    });
  });
  const originPort = await listen(origin);

  const proxy = new ProxyEngine({
    host: '127.0.0.1',
    port: 18081,
    certsDir: path.join(os.tmpdir(), 'smartnet-hold-test-certs'),
  });

  try {
    await proxy.start();
    proxy.setHolding(true);

    let completed = false;
    const responsePromise = new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port: 18081,
          method: 'GET',
          path: `http://127.0.0.1:${originPort}/held`,
          headers: { host: `127.0.0.1:${originPort}` },
        },
        (response) => {
          response.resume();
          response.on('end', () => {
            completed = true;
            resolve(response.statusCode);
          });
        }
      );
      request.on('error', reject);
      request.end();
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    if (completed) throw new Error('Request completed while hold was active.');
    if (proxy.getState().heldCount !== 1) {
      throw new Error(`Expected 1 held request, got ${proxy.getState().heldCount}.`);
    }
    const heldHistory = proxy.getHistory();
    if (heldHistory.length !== 1 || !heldHistory[0].held || heldHistory[0].complete) {
      throw new Error(`Held request was not published to history: ${JSON.stringify(heldHistory)}`);
    }
    const heldId = heldHistory[0].id;

    proxy.updateHeldRequest(
      heldId,
      {
        method: 'POST',
        url: `http://127.0.0.1:${originPort}/edited?x=1`,
        headers: { 'x-edited': 'yes' },
        body: 'changed body',
      },
      true
    );
    const status = await responsePromise;
    if (status !== 200) throw new Error(`Expected status 200, got ${status}.`);
    if (proxy.getState().heldCount !== 0) throw new Error('Held request was not released.');
    if (
      !observedRequest ||
      observedRequest.method !== 'POST' ||
      observedRequest.url !== '/edited?x=1' ||
      observedRequest.headers['x-edited'] !== 'yes' ||
      observedRequest.body !== 'changed body'
    ) {
      throw new Error(`Edited request was not forwarded correctly: ${JSON.stringify(observedRequest)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    const completedHistory = proxy.getHistory();
    if (
      completedHistory.length !== 1 ||
      completedHistory[0].id !== heldId ||
      completedHistory[0].held ||
      !completedHistory[0].complete ||
      completedHistory[0].status !== 200
    ) {
      throw new Error(`Held history row was not updated in place: ${JSON.stringify(completedHistory)}`);
    }

    console.log('Request hold/release test passed');
  } finally {
    if (proxy.getState().running && proxy.getState().holding) proxy.setHolding(false);
    await proxy.stop();
    await close(origin);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
