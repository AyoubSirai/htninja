'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { ProxyEngine } = require('../proxy/engine');
const { compileFilter } = require('../proxy/scriptSandbox');
const { findBrowser } = require('../proxy/browserLauncher');

async function main() {
  const lines = [];
  const log = (m) => {
    lines.push(String(m));
    console.log(m);
  };

  const c = compileFilter('function filter(req, res) { return req.method === "GET"; }');
  log(`filter ok=${c.ok}`);
  log(`filter pass=${JSON.stringify(c.evaluate({ method: 'GET' }, { status: 200 }))}`);
  log(`chrome=${findBrowser('chrome')}`);
  log(`firefox=${findBrowser('firefox')}`);

  const port = 18080;
  const p = new ProxyEngine({
    certsDir: path.join(os.tmpdir(), 'smartnet-certs-test'),
    port,
  });
  const filterErrors = [];
  p.on('filter-error', (error) => filterErrors.push(error));

  const state = await p.start(port);
  log(`started ${JSON.stringify(state)}`);

  await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: 'http://example.com/',
        headers: { Host: 'example.com' },
        method: 'GET',
        timeout: 15000,
      },
      (res) => {
        let d = '';
        res.on('data', (x) => {
          d += x;
        });
        res.on('end', () => {
          log(`http status=${res.statusCode} bodyLen=${d.length}`);
          resolve();
        });
      }
    );
    req.on('error', reject);
    req.end();
  });

  await new Promise((r) => setTimeout(r, 800));
  if (filterErrors.length > 0) {
    throw new Error(`Unexpected empty-filter runtime errors: ${JSON.stringify(filterErrors)}`);
  }
  log(`history=${p.getHistory().length}`);
  if (p.getHistory()[0]) {
    const e = p.getHistory()[0];
    log(`first ${e.method} ${e.host}${e.path} status=${e.status}`);
  }

  const stopped = await p.stop();
  log(`stopped ${JSON.stringify(stopped)}`);

  fs.writeFileSync(path.join(__dirname, '..', 'smoke-out.txt'), lines.join('\n'), 'utf8');
}

main().catch((err) => {
  console.error(err);
  fs.writeFileSync(
    path.join(__dirname, '..', 'smoke-out.txt'),
    String(err && err.stack ? err.stack : err),
    'utf8'
  );
  process.exit(1);
});
