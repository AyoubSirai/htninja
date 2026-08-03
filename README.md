<p align="center">
  <img src="icons/logo.png" alt="HtNinja logo" width="128" height="128" />
</p>

<h1 align="center">HtNinja</h1>

<p align="center">
  <strong>Desktop HTTPS traffic inspector &amp; MITM proxy</strong><br />
  Capture, hold, edit, search, and resend HTTP(S) traffic — inspired by Burp Suite’s Proxy and HTTP History.
</p>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg" />
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows-0078D4.svg" />
  <img alt="Node.js" src="https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg" />
  <img alt="Electron" src="https://img.shields.io/badge/electron-33-47848F.svg" />
  <img alt="Version" src="https://img.shields.io/badge/version-1.0.0-informational.svg" />
</p>

---

## Overview

**HtNinja** is a local man-in-the-middle (MITM) proxy packaged as a desktop app. Point a browser or any HTTP-aware client at it, trust the generated Root CA, and inspect live HTTPS traffic in a clean history table with request/response viewers.

It is built for **authorized security testing, debugging, and learning** — when you need Burp-style interception without leaving a lightweight Electron app.

| Capability | What you get |
|---|---|
| **Proxy** | Local HTTPS-capable listener with a generated Root CA |
| **History** | Live HTTP(S) table + Raw / Headers / Body inspector |
| **Intercept** | Hold requests and responses, edit them, then forward or abort |
| **Automation** | Sandboxed JavaScript hooks to filter history or transform traffic |
| **Repeater** | Multi-tab request editor with side-by-side responses |
| **Search** | Advanced text / RegEx / JS search across captured traffic |
| **Browsers** | One-click Chrome/Edge/Chromium and Firefox launchers |

---

## Features

### Proxy & capture
- Start / pause / resume a local MITM proxy (default `127.0.0.1:8080`)
- Dynamic **HtNinja Root CA** for HTTPS decryption
- **Pause** keeps the listener alive — traffic still flows, but is not logged
- Configurable host and port (useful for LAN clients); locked while the proxy is running
- One-click **Export CA** to PEM

### Interception
- **Hold requests** before they reach the upstream server
- Edit held requests (method, URL, headers, body), then keep held or forward
- **Pause responses** before they reach the browser
- Edit held responses (status, headers, body), find/replace, one-shot JS transform, abort, or forward

### Automatic hooks
- Persistent **response / request Hook** scripts that run without pausing traffic
- Optional domain scope (tied to the Domain filter)
- Compile + dry-run validation before save/start
- Content-Length / Transfer-Encoding recalculated after body edits

### History & filters
- Traffic table: method, host, path, status, content-type, size, time
- Split-pane inspector: Request / Response → Raw, Headers, Body
- Domain and Content-Type filters (substring + wildcards like `*.api.com`, `image/*`)
- Sandboxed **JS filter** predicates to control which entries appear in history
- Send any history row to **Repeater**

### Advanced Search
- Dedicated search window
- Plain text or RegEx, optional case sensitivity
- Field scopes: URLs, metadata, request/response headers & bodies, or anything
- Optional JS condition and Domain-filter scoping
- Focus matching rows in the main history table

### Repeater
- Multi-tab sessions (new, duplicate, close) — request tabs persist across launches
- CodeMirror raw HTTP editor with HTTP / JSON / form highlighting
- Side-by-side request and response panes (Pretty / Raw / Headers)
- In-pane find, **Copy as `fetch()`**, keyboard shortcuts (`Ctrl+Enter`, `Ctrl+T`, `Ctrl+W`)

### Browser launchers
- **Chrome / Chromium / Edge** — persistent HtNinja profile, proxy preconfigured
- **Firefox** — managed profile with proxy prefs and enterprise-roots support
- Launchers enabled only while the proxy is running

### Appearance
- Light and dark themes
- Settings persist in Electron’s user-data directory

---

## Screenshots

> Add screenshots here after publishing (main history, repeater, hold/edit, search).
>
> Suggested layout:
> ```md
> | History | Repeater |
> |---|---|
> | ![History](docs/screenshots/history.png) | ![Repeater](docs/screenshots/repeater.png) |
> ```

---

## Quick start

### Requirements

- **Node.js 18+**
- **Windows** for the packaged portable build (`npm run dist`)
- Chrome, Chromium, Microsoft Edge, and/or Firefox for the launchers
- macOS / Linux can run from source with `npm start` where Electron is supported

### Install & run from source

```bash
git clone https://github.com/<your-username>/htninja.git
cd htninja
npm install
npm start
```

`npm start` automatically builds the CodeMirror Repeater editor bundle, then launches Electron.

### Build a Windows portable executable

```bash
npm run dist
```

Output:

```
dist/HtNinja-1.0.0-portable.exe
```

Unpacked build (optional):

```bash
npm run dist:dir
# → dist/win-unpacked/HtNinja.exe
```

---

## First-time workflow

1. Launch HtNinja and click **Start Proxy** (default `127.0.0.1:8080`).
2. Click **Export CA** and save `htninja-ca.pem`.
3. Trust the certificate (see [Trust the Root CA](#trust-the-root-ca)).
4. Click **Chrome** or **Firefox**, or point any client at the proxy manually.
5. Browse — requests appear in the history table.
6. Select a row to inspect Raw / Headers / Body.
7. Optionally use **Hold**, **Pause Resp.**, **Hook**, **Search**, or **Send to Repeater**.

### Manual proxy settings

| Setting | Value |
|---|---|
| HTTP proxy host | `127.0.0.1` |
| Port | `8080` (or your configured port) |

Example with curl:

```bash
curl -x http://127.0.0.1:8080 https://example.com --cacert htninja-ca.pem
```

---

## Trust the Root CA

HTTPS decryption requires clients to trust HtNinja’s Root CA. On first start the CA is written to Electron’s user-data folder (`certs/ca.pem`).

### Export

Use **Export CA** in the toolbar and save `htninja-ca.pem`.

### Windows (Chrome / Edge / system store)

1. Double-click the PEM/CRT file → **Install Certificate…**
2. Store location: **Current User** (or Local Machine)
3. Place all certificates in **Trusted Root Certification Authorities**
4. Finish, then fully restart the browser

PowerShell (Current User):

```powershell
Import-Certificate -FilePath ".\htninja-ca.pem" -CertStoreLocation Cert:\CurrentUser\Root
```

### macOS

```bash
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain htninja-ca.pem
```

Or use **Keychain Access** → File → Import Items → set Trust to **Always Trust** for SSL.

### Firefox

Firefox uses its own certificate store by default:

1. Settings → Privacy & Security → Certificates → **View Certificates**
2. **Authorities** → **Import** → select `htninja-ca.pem`
3. Enable **Trust this CA to identify websites**

The **Firefox** launcher uses a managed HtNinja profile with proxy prefs and `security.enterprise_roots.enabled`. You still need to import the CA into that profile (or rely on OS trust where enterprise roots apply).

### Chrome launcher note

**Chrome** launches with `--ignore-certificate-errors` and a persistent HtNinja profile, so HTTPS inspection works even before the CA is trusted. Prefer trusting the CA when using your normal browser pointed at the proxy.

---

## Using HtNinja

### Proxy controls

| Control | Behavior |
|---|---|
| **Start / Pause / Resume** | Start the listener; pause logging without tearing it down; resume logging |
| **Hold** | Keep new requests waiting until released or edited |
| **Pause Resp.** | Hold upstream responses before they reach the browser |
| **Hook** | Automatic JS transforms on matching traffic (no pause required) |
| **Export CA** | Save the Root CA PEM |
| **Settings** | Host, port, theme |
| **Clear** | Clear history |

### Holding & editing requests

1. Start the proxy, then enable **Hold**.
2. Held rows appear in history with status **Held**.
3. Select a held row → **Edit Held** to change method, URL, headers, or body.
4. **Save & Keep Held** or **Save & Forward Now**.
5. **Release** forwards every remaining held request.

### Holding & editing responses

1. Enable **Pause Resp.**
2. Open **Edit Response** on a held response.
3. Edit status / headers / body, use find/replace or a one-shot JS transform.
4. **Save & Keep Held**, **Abort (Reset)**, or **Save & Forward**.

### JavaScript filters (history visibility)

Filters control which completed entries appear in history. They do **not** block network traffic.

Examples:

```js
req.method === 'POST'
```

```js
req.host.includes('api.') && /json/i.test(res.contentType || '')
```

Available fields:

- `req`: `method`, `url`, `host`, `path`, `headers`, `body`
- `res`: `status`, `headers`, `body`, `contentType`

Apply scope:

- **Incoming only** — new traffic
- **All existing in-scope requests** — re-evaluate history matching the Domain filter

Open **Help** in the app for the full automation guide (filters, hooks, recipes, sandbox limits).

### Response Hook (automation)

Hooks run on every matching request/response without pausing. You can mutate `req` / `res`, call `pause()`, or abort. Scripts are validated before they start and can be limited to the Domain filter scope.

### Advanced Search

Open **Search** from the toolbar to run text / RegEx / JS queries across selectable fields, optionally limited to the Domain filter. Focus matches to highlight them in the main history table.

### Repeater

- **Send to Repeater** copies the selected history request into a new tab
- Edit the full raw HTTP message and click **Send**
- Request tabs persist between launches (up to 200); responses stay in memory for the current session
- Resends go **directly to the origin** (not back through the local proxy)

Shortcuts:

| Shortcut | Action |
|---|---|
| `Ctrl+Enter` | Send |
| `Ctrl+T` | New tab |
| `Ctrl+W` | Close tab |

### Configuration

**Settings** → host, port, and theme (light / dark). Host and port cannot change while the proxy is running. Theme can.

Persisted under Electron user-data:

| Path | Contents |
|---|---|
| `certs/` | Root CA (`ca.pem`, `ca.key`) |
| `settings.json` | Host, port, theme, hook scripts |
| `repeater-sessions.json` | Repeater request tabs |
| `browser-profiles/` | Chrome / Firefox launcher profiles |

---

## Project structure

```
htninja/
├── main.js                 # Electron main process, windows, IPC
├── preload.js              # Secure contextBridge API
├── package.json
├── icons/
│   └── logo.png            # App / window / build icon
├── proxy/
│   ├── engine.js           # Mockttp lifecycle, CA, capture, hold, hooks
│   ├── advancedSearch.js   # History search engine
│   ├── browserLauncher.js  # Chrome / Edge / Firefox helpers
│   ├── resender.js         # Direct-origin Repeater sends
│   └── scriptSandbox.js    # Sandboxed JS filter & transform evaluation
├── renderer/
│   ├── index.html          # Main history UI
│   ├── repeater.html       # Repeater window
│   ├── search.html         # Advanced Search window
│   ├── config.html         # Settings
│   ├── help.html           # In-app documentation
│   └── fonts/              # Bundled Roboto
└── scripts/                # Smoke and feature tests
```

---

## Scripts

| Command | Description |
|---|---|
| `npm start` | Build renderer bundle and launch Electron |
| `npm run build:renderer` | Bundle the CodeMirror Repeater editor |
| `npm run dist` | Build Windows portable `.exe` |
| `npm run dist:dir` | Build unpacked Windows app directory |
| `npm run smoke` | Basic proxy smoke test |
| `npm run test:search` | Advanced search tests |
| `npm run test:response-interceptor` | Response intercept tests |
| `npm run test:response-interceptor-ui` | Response intercept UI tests |
| `npm run test:repeater-ui` | Repeater editor UI tests |

---

## Tech stack

- **Electron** — desktop shell
- **Mockttp** — HTTPS MITM proxy and dynamic certificates
- **CodeMirror 6** — Repeater / hook editors
- **esbuild** — renderer bundling
- **electron-builder** — Windows portable packaging
- Vanilla HTML / CSS / JS UI (no React/Vue framework)

---

## Security & ethics

> **Use HtNinja only on systems and traffic you are authorized to inspect.**

- The generated Root CA can decrypt HTTPS for any client that trusts it. Treat `certs/` as sensitive; delete it when you are finished.
- Binding the listener to a non-loopback host exposes the MITM proxy on your network.
- The Chrome launcher ignores certificate errors for convenience — prefer CA trust for realistic testing.
- Repeater HTTPS uses relaxed TLS verification when talking to origins.
- JS filters and hooks run in a restricted sandbox (timeouts, no Node APIs, cloned inputs), but they still execute your code — do not paste untrusted scripts.
- History is kept **in memory** (not written to disk). Bodies may be truncated for very large responses.

---

## Limitations

- Focused on HTTP(S) request/response inspection — not a full WebSocket debugging suite
- History is session memory (capped); it is not persisted across restarts
- Packaged releases currently target **Windows portable x64**
- Repeater responses are not persisted between app launches

---

## Troubleshooting

| Issue | Fix |
|---|---|
| `EADDRINUSE` on start | Change the port in Settings, or stop the process using it |
| Browser certificate warnings | Trust the Root CA, or use the **Chrome** launcher |
| Empty history while browsing | Confirm the client uses the proxy; check you are not **Paused** |
| Firefox HTTPS failures | Import the CA into Firefox Authorities |
| Chrome / Edge not found | Install a Chromium browser or ensure it is on `PATH` |
| Old CA name after upgrade | Delete `certs/` in the Electron user-data folder and restart |

---

## Contributing

Issues and pull requests are welcome. Please:

1. Keep changes focused and documented
2. Run relevant `npm run test:*` scripts when touching proxy, search, or Repeater behavior
3. Avoid committing secrets, generated CAs, or `dist/` artifacts

---

## License

Released under the [MIT License](LICENSE).

---

<p align="center">
  <sub>HtNinja — inspect HTTPS traffic you are authorized to debug.</sub>
</p>
