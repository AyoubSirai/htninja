'use strict';

/**
 * Safe evaluation of user-defined JavaScript filter predicates.
 * Uses Node's vm module with a frozen, minimal context and timeouts.
 */

const vm = require('vm');

const DEFAULT_TIMEOUT_MS = 100;
const MAX_SCRIPT_LENGTH = 50_000;

/**
 * Compile a user filter predicate once for repeated evaluation.
 *
 * The preferred format is the expression that would appear inside the
 * application's filter function:
 *   req.method === 'POST'
 *   req.method === 'POST' && res.status === 200
 *
 * Full predicate functions remain supported:
 *   function filter(req, res) { return req.method === 'POST'; }
 *   (req, res) => req.host.includes('api')
 *
 * @param {string} source
 * @returns {{ ok: true, evaluate: Function } | { ok: false, error: string }}
 */
function compileFilter(source) {
  if (source == null || String(source).trim() === '') {
    return {
      ok: true,
      evaluate: () => ({ ok: true, pass: true }),
    };
  }

  const code = String(source);
  if (code.length > MAX_SCRIPT_LENGTH) {
    return { ok: false, error: `Filter script exceeds ${MAX_SCRIPT_LENGTH} characters.` };
  }

  // Expose req/res locally, then treat the supplied code as either a direct
  // predicate expression or a complete function for backwards compatibility.
  const wrapped = `
    "use strict";
    const req = __req;
    const res = __res;
    const __user = (${code});
    __result = typeof __user === 'function'
      ? Boolean(__user(req, res))
      : Boolean(__user);
  `;

  let script;
  try {
    script = new vm.Script(wrapped, {
      filename: 'user-filter.js',
      displayErrors: true,
    });
  } catch (err) {
    return { ok: false, error: `Compile error: ${err.message}` };
  }

  return {
    ok: true,
    evaluate(req, res, timeoutMs = DEFAULT_TIMEOUT_MS) {
      const sandbox = {
        __req: sanitizeForSandbox(req),
        __res: sanitizeForSandbox(res),
        __result: false,
      };

      const context = vm.createContext(sandbox, {
        name: 'smartnet-filter',
        codeGeneration: {
          strings: false,
          wasm: false,
        },
      });

      try {
        script.runInContext(context, {
          timeout: timeoutMs,
          displayErrors: true,
          breakOnSigint: true,
        });
        return { ok: true, pass: Boolean(sandbox.__result) };
      } catch (err) {
        return {
          ok: false,
          error: err && err.message ? err.message : String(err || 'Filter execution failed'),
          pass: false,
        };
      }
    },
  };
}

/**
 * Strip / freeze objects so the sandbox cannot mutate live traffic records
 * or access unexpected host objects.
 */
function sanitizeForSandbox(obj) {
  if (obj == null) return null;
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch {
    return {
      method: obj.method,
      url: obj.url,
      host: obj.host,
      path: obj.path,
      status: obj.status,
      contentType: obj.contentType,
      headers: obj.headers ? { ...obj.headers } : {},
      body: typeof obj.body === 'string' ? obj.body.slice(0, 256_000) : '',
    };
  }
}

/**
 * One-shot evaluation helper.
 */
function runFilter(source, req, res, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const compiled = compileFilter(source);
  if (!compiled.ok) {
    return { ok: false, pass: false, error: compiled.error };
  }
  return compiled.evaluate(req, res, timeoutMs);
}

function looksLikeFunctionSource(code) {
  const trimmed = String(code || '').trim();
  return /^(?:async\s+)?function[\s(]/.test(trimmed)
    || /^(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(trimmed);
}

/**
 * Compile a traffic transform. Preferred form is the body that would appear
 * inside `(req, res) => { ... }` — `req` and `res` are already in scope:
 *   req.body = '';
 *   res.body = res.body.replaceAll('old', 'new');
 *   return;
 *
 * The same script runs for requests and responses. Mutate `req` to change the
 * outbound request and `res` to change the browser response. Returning
 * undefined keeps the mutated `req`/`res` copies. Results may also be "close"
 * or "reset". Full functions remain supported for backwards compatibility.
 */
function compileResponseTransform(source) {
  const code = String(source || '').trim();
  if (!code) return { ok: false, error: 'Response transform code is empty.' };
  if (code.length > MAX_SCRIPT_LENGTH) {
    return { ok: false, error: `Transform script exceeds ${MAX_SCRIPT_LENGTH} characters.` };
  }

  const wrapped = looksLikeFunctionSource(code)
    ? `
      "use strict";
      const pause = () => { __pauseAll = true; };
      const req = __req;
      const res = __res;
      const phase = __phase;
      req.abort = (mode) => {
        __abortReq = mode === 'close' ? 'close' : 'reset';
      };
      const __user = (${code});
      __result = typeof __user === 'function'
        ? __user(req, res)
        : __user;
    `
    : `
      "use strict";
      const pause = () => { __pauseAll = true; };
      const req = __req;
      const res = __res;
      const phase = __phase;
      req.abort = (mode) => {
        __abortReq = mode === 'close' ? 'close' : 'reset';
      };
      __result = (function () {
        ${code}
      })();
    `;

  let script;
  try {
    script = new vm.Script(wrapped, {
      filename: 'response-transform.js',
      displayErrors: true,
    });
  } catch (err) {
    return { ok: false, error: `Compile error: ${err.message}` };
  }

  return {
    ok: true,
    evaluate(req, res, timeoutMs = DEFAULT_TIMEOUT_MS) {
      const phase = res == null ? 'request' : 'response';
      const sandbox = {
        __req: sanitizeForSandbox(req),
        __res:
          res == null
            ? { status: 0, headers: {}, body: '', contentType: '' }
            : sanitizeForSandbox(res),
        __phase: phase,
        __result: undefined,
        __pauseAll: false,
        __abortReq: null,
      };
      const context = vm.createContext(sandbox, {
        name: 'smartnet-response-transform',
        codeGeneration: { strings: false, wasm: false },
      });
      try {
        script.runInContext(context, {
          timeout: timeoutMs,
          displayErrors: true,
          breakOnSigint: true,
        });

        const returned = sandbox.__result;
        let abort =
          sandbox.__abortReq === 'close' || sandbox.__abortReq === 'reset'
            ? sandbox.__abortReq
            : null;
        // Drop non-JSON fields (e.g. abort()) before cloning mutations.
        if (sandbox.__req && typeof sandbox.__req === 'object') {
          delete sandbox.__req.abort;
        }
        // Read body from the live sandbox object first — this is the value the
        // user assigned with req.body = ... even if other cloning quirks occur.
        const liveBody = sandbox.__req ? sandbox.__req.body : undefined;
        let outReq = JSON.parse(JSON.stringify(sandbox.__req));
        let outRes = JSON.parse(JSON.stringify(sandbox.__res));
        if (outReq && typeof outReq === 'object' && liveBody !== undefined) {
          outReq.body = liveBody == null ? '' : String(liveBody);
        }

        if (returned === 'close' || returned === 'reset') {
          abort = returned;
        } else if (returned != null && typeof returned === 'object') {
          if (returned.req || returned.res || returned.abort) {
            if (returned.req && typeof returned.req === 'object') {
              outReq = JSON.parse(JSON.stringify(returned.req));
            }
            if (returned.res && typeof returned.res === 'object') {
              outRes = JSON.parse(JSON.stringify(returned.res));
            }
            if (returned.abort === 'close' || returned.abort === 'reset') {
              abort = returned.abort;
            }
          } else if (
            Object.prototype.hasOwnProperty.call(returned, 'method') ||
            Object.prototype.hasOwnProperty.call(returned, 'body') ||
            Object.prototype.hasOwnProperty.call(returned, 'headers') ||
            (Object.prototype.hasOwnProperty.call(returned, 'url') &&
              !Object.prototype.hasOwnProperty.call(returned, 'status'))
          ) {
            outReq = JSON.parse(JSON.stringify({ ...outReq, ...returned }));
          } else {
            outRes = JSON.parse(JSON.stringify(returned));
          }
        }

        if (outReq && typeof outReq === 'object' && Object.prototype.hasOwnProperty.call(outReq, 'body')) {
          outReq.body = outReq.body == null ? '' : String(outReq.body);
        }

        return {
          ok: true,
          phase,
          abort,
          pauseAll: Boolean(sandbox.__pauseAll),
          req: outReq,
          res: phase === 'request' ? null : outRes,
        };
      } catch (err) {
        // Keep request-phase mutations even when later lines throw (common when
        // scripts touch res.body/JSON without an `if (phase === 'request')` guard).
        if (phase === 'request' && sandbox.__req && typeof sandbox.__req === 'object') {
          try {
            delete sandbox.__req.abort;
            const outReq = JSON.parse(JSON.stringify(sandbox.__req));
            if (Object.prototype.hasOwnProperty.call(sandbox.__req, 'body')) {
              outReq.body =
                sandbox.__req.body == null ? '' : String(sandbox.__req.body);
            }
            return {
              ok: true,
              phase,
              abort:
                sandbox.__abortReq === 'close' || sandbox.__abortReq === 'reset'
                  ? sandbox.__abortReq
                  : null,
              pauseAll: Boolean(sandbox.__pauseAll),
              req: outReq,
              res: null,
              warning: err && err.message ? err.message : String(err || 'Transform failed'),
            };
          } catch {
            /* fall through to hard failure */
          }
        }
        return {
          ok: false,
          error: err && err.message ? err.message : String(err || 'Transform failed'),
        };
      }
    },
  };
}

/**
 * Compile-check and dry-run a response transform so editors can reject
 * broken hooks before they are enabled.
 */
function validateResponseTransform(source) {
  const compiled = compileResponseTransform(source);
  if (!compiled.ok) return { ok: false, error: compiled.error };

  const sampleReq = {
    id: 'validate',
    method: 'GET',
    url: 'https://example.com/',
    host: 'example.com',
    path: '/',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  };
  const sampleRes = {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: '{}',
    contentType: 'application/json',
  };

  const requestResult = compiled.evaluate(sampleReq, null);
  if (!requestResult.ok) {
    return {
      ok: false,
      error: `Request-phase error: ${requestResult.error || 'Transform failed'}`,
    };
  }

  const responseResult = compiled.evaluate(sampleReq, sampleRes);
  if (!responseResult.ok) {
    return {
      ok: false,
      error: `Response-phase error: ${responseResult.error || 'Transform failed'}`,
    };
  }

  const warnings = [];
  if (requestResult.warning) warnings.push(`Request-phase: ${requestResult.warning}`);
  if (responseResult.warning) warnings.push(`Response-phase: ${responseResult.warning}`);

  return {
    ok: true,
    warnings,
  };
}

module.exports = {
  compileFilter,
  compileResponseTransform,
  validateResponseTransform,
  runFilter,
  DEFAULT_TIMEOUT_MS,
  MAX_SCRIPT_LENGTH,
};
