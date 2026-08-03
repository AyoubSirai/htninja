'use strict';

/**
 * Locate and spawn Chrome / Chromium / Firefox with proxy settings
 * so all browser traffic flows through HtNinja.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const spawned = new Set();

function exists(p) {
  try {
    return Boolean(p) && fs.existsSync(p);
  } catch {
    return false;
  }
}

function whichSync(cmd) {
  try {
    const { execSync } = require('child_process');
    const isWin = process.platform === 'win32';
    const out = execSync(isWin ? `where ${cmd}` : `which ${cmd}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return first && exists(first) ? first : null;
  } catch {
    return null;
  }
}

function chromeCandidates() {
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA || '';
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

  if (process.platform === 'win32') {
    return [
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(local, 'Chromium', 'Application', 'chrome.exe'),
      path.join(pf, 'Chromium', 'Application', 'chrome.exe'),
      path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      whichSync('chrome'),
      whichSync('chromium'),
      whichSync('msedge'),
    ].filter(Boolean);
  }

  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      whichSync('google-chrome'),
      whichSync('chromium'),
    ].filter(Boolean);
  }

  // linux
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    whichSync('google-chrome'),
    whichSync('chromium'),
    whichSync('chromium-browser'),
  ].filter(Boolean);
}

function firefoxCandidates() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';

  if (process.platform === 'win32') {
    return [
      path.join(pf, 'Mozilla Firefox', 'firefox.exe'),
      path.join(pf86, 'Mozilla Firefox', 'firefox.exe'),
      path.join(local, 'Mozilla Firefox', 'firefox.exe'),
      whichSync('firefox'),
    ].filter(Boolean);
  }

  if (process.platform === 'darwin') {
    return [
      '/Applications/Firefox.app/Contents/MacOS/firefox',
      whichSync('firefox'),
    ].filter(Boolean);
  }

  return [
    '/usr/bin/firefox',
    '/snap/bin/firefox',
    whichSync('firefox'),
  ].filter(Boolean);
}

function findBrowser(kind) {
  const list = kind === 'firefox' ? firefoxCandidates() : chromeCandidates();
  for (const candidate of list) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function ensureProfileDir(profileDir) {
  fs.mkdirSync(profileDir, { recursive: true });
  return profileDir;
}

function formatProxyAddress(host, port) {
  const value = String(host || '127.0.0.1');
  const formattedHost = value.includes(':') && !value.startsWith('[') ? `[${value}]` : value;
  return `${formattedHost}:${port}`;
}

/**
 * @param {number} port
 * @param {{ startUrl?: string, host?: string, profileRoot?: string }} [opts]
 */
function launchChrome(port, opts = {}) {
  const exe = findBrowser('chrome');
  if (!exe) {
    throw new Error(
      'Chrome/Chromium/Edge not found. Install Google Chrome or set it on PATH.'
    );
  }

  const browser = path.basename(exe).toLowerCase().includes('edge') ? 'edge' : 'chrome';
  const userDataDir = opts.profileRoot
    ? ensureProfileDir(path.join(opts.profileRoot, browser))
    : makeTempDir('smartnet-chrome-');
  const host = opts.host || '127.0.0.1';
  const args = [
    `--proxy-server=http://${formatProxyAddress(host, port)}`,
    '--ignore-certificate-errors',
    '--ignore-certificate-errors-spki-list',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=TranslateUI',
    '--disable-sync',
    '--restore-last-session',
  ];
  if (opts.startUrl) args.push(opts.startUrl);

  const child = spawn(exe, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  spawned.add(child.pid);

  return {
    pid: child.pid,
    executable: exe,
    userDataDir,
    browser,
  };
}

/**
 * Create or update a Firefox profile with HtNinja proxy preferences.
 * @param {number} port
 * @param {string} host
 * @param {string} [profileDir]
 */
function createFirefoxProfile(port, host = '127.0.0.1', profileDir = null) {
  const resolvedProfileDir = profileDir
    ? ensureProfileDir(profileDir)
    : makeTempDir('smartnet-ff-');
  const prefs = `
// HtNinja managed proxy profile
user_pref("network.proxy.type", 1);
user_pref("network.proxy.http", ${JSON.stringify(host)});
user_pref("network.proxy.http_port", ${port});
user_pref("network.proxy.ssl", ${JSON.stringify(host)});
user_pref("network.proxy.ssl_port", ${port});
user_pref("network.proxy.share_proxy_settings", true);
user_pref("network.proxy.no_proxies_on", "");
user_pref("network.proxy.allow_hijacking_localhost", true);
user_pref("security.enterprise_roots.enabled", true);
user_pref("security.cert_pinning.enforcement_level", 0);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.page", 3);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("app.update.enabled", false);
`.trimStart();

  fs.writeFileSync(
    path.join(resolvedProfileDir, 'user.js'),
    prefs,
    'utf8'
  );
  return resolvedProfileDir;
}

/**
 * @param {number} port
 * @param {{ startUrl?: string, host?: string, profileRoot?: string }} [opts]
 */
function launchFirefox(port, opts = {}) {
  const exe = findBrowser('firefox');
  if (!exe) {
    throw new Error('Firefox not found. Install Mozilla Firefox or set it on PATH.');
  }

  const persistentProfileDir = opts.profileRoot
    ? path.join(opts.profileRoot, 'firefox')
    : null;
  const profileDir = createFirefoxProfile(
    port,
    opts.host || '127.0.0.1',
    persistentProfileDir
  );
  const args = [
    '-no-remote',
    '-profile',
    profileDir,
  ];
  if (opts.startUrl) args.push(opts.startUrl);

  const child = spawn(exe, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  spawned.add(child.pid);

  return {
    pid: child.pid,
    executable: exe,
    profileDir,
    browser: 'firefox',
  };
}

module.exports = {
  findBrowser,
  launchChrome,
  launchFirefox,
  createFirefoxProfile,
};
