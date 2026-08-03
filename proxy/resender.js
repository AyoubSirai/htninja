'use strict';

/**
 * Edit & resend HTTP(S) requests from captured history.
 * Bypasses the local proxy and talks to the origin directly.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const zlib = require('zlib');
const { promisify } = require('util');

const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const brotliDecompress = promisify(zlib.brotliDecompress);

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'host',
]);

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * @param {{ method?: string, url: string, headers?: object, body?: string }} request
 * @param {{ timeoutMs?: number, ca?: string }} [options]
 */
async function resendRequest(request, options = {}) {
  if (!request || !request.url) {
    throw new Error('Request URL is required.');
  }

  let target;
  try {
    target = new URL(request.url);
  } catch {
    throw new Error('Invalid request URL.');
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error('Only http and https URLs are supported.');
  }

  const method = String(request.method || 'GET').toUpperCase();
  const isBodyless = method === 'GET' || method === 'HEAD';
  const bodyText = isBodyless
    ? ''
    : request.body == null
      ? ''
      : String(request.body);
  const bodyBuffer = Buffer.from(bodyText, 'utf8');

  const headers = sanitizeHeaders(request.headers || {});
  if (isBodyless) {
    delete headers['content-length'];
    delete headers['content-type'];
    delete headers['content-encoding'];
    delete headers['transfer-encoding'];
  }
  headers.host = target.host;
  if (bodyBuffer.length > 0 || !isBodyless) {
    headers['content-length'] = String(bodyBuffer.length);
  }

  const transport = target.protocol === 'https:' ? https : http;
  const startedAt = Date.now();

  const response = await new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method,
        headers,
        timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
        rejectUnauthorized: false,
        ca: options.ca || undefined,
      },
      (res) => {
        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          total += chunk.length;
          if (total <= MAX_BODY_BYTES) chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            statusMessage: res.statusMessage || '',
            headers: res.headers,
            rawBody: Buffer.concat(chunks),
            truncated: total > MAX_BODY_BYTES,
            byteLength: total,
          });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out after ${options.timeoutMs || DEFAULT_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);

    if (!isBodyless && bodyBuffer.length > 0) {
      req.write(bodyBuffer);
    }
    req.end();
  });

  const responseHeaders = normalizeHeaders(response.headers);
  const decoded = await decodeBody(response.rawBody, responseHeaders);
  const contentType = responseHeaders['content-type'] || '';
  const binary = looksBinary(decoded.buffer, contentType);
  let responseBody = binary
    ? `[Binary content — ${response.byteLength} bytes]`
    : decoded.buffer.toString('utf8');
  if (response.truncated) {
    responseBody += '\n\n… [body truncated for memory safety]';
  }

  return {
    method,
    url: target.href,
    host: target.host,
    path: target.pathname + target.search,
    protocol: target.protocol.replace(':', ''),
    requestHeaders: headers,
    requestBody: bodyText,
    requestBodySize: bodyBuffer.length,
    requestBinary: false,
    timestamp: startedAt,
    status: response.statusCode,
    responseHeaders,
    responseBody,
    responseBodySize: response.byteLength,
    responseBinary: binary,
    contentType,
    contentLength: response.byteLength,
    durationMs: Math.max(0, Date.now() - startedAt),
    complete: true,
  };
}

function sanitizeHeaders(input) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (value == null) continue;
    const name = String(key).trim();
    if (!name) continue;
    if (name.startsWith(':')) continue;
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    out[name] = Array.isArray(value) ? value.map(String).join(', ') : String(value);
  }
  return out;
}

function normalizeHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value == null) continue;
    const k = String(key).toLowerCase();
    out[k] = Array.isArray(value) ? value.map(String).join(', ') : String(value);
  }
  return out;
}

async function decodeBody(buffer, headers) {
  const encoding = String(headers['content-encoding'] || '')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let out = buffer;
  for (let i = encoding.length - 1; i >= 0; i--) {
    const enc = encoding[i];
    try {
      if (enc === 'gzip' || enc === 'x-gzip') out = await gunzip(out);
      else if (enc === 'deflate') {
        try {
          out = await inflate(out);
        } catch {
          out = await promisify(zlib.inflateRaw)(out);
        }
      } else if (enc === 'br') out = await brotliDecompress(out);
    } catch {
      return { buffer };
    }
  }
  return { buffer: out };
}

function looksBinary(buffer, contentType) {
  const ct = String(contentType || '').toLowerCase();
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
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 32) weird++;
  }
  return weird / sample.length > 0.15;
}

/**
 * Parse "Name: Value" header lines from the repeater editor.
 */
function parseHeaderText(text) {
  const headers = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.startsWith(':') ? trimmed.indexOf(':', 1) : trimmed.indexOf(':');
    if (idx <= 0) {
      throw new Error(`Invalid header line: "${trimmed}"`);
    }
    const name = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!name) throw new Error(`Invalid header line: "${trimmed}"`);
    if (headers[name] != null) headers[name] = `${headers[name]}, ${value}`;
    else headers[name] = value;
  }
  return headers;
}

module.exports = {
  resendRequest,
  parseHeaderText,
  sanitizeHeaders,
};
