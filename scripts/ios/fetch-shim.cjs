// fetch-shim.cjs v7 — undici-free fetch for Node on jailbroken iOS (A14).
// Minimal global surface: only WebAssembly is stubbed (wasm code-GC fatals on
// this device) and only `fetch` is overridden (node:http, no wasm). Native
// Request/Response/Headers/FormData stay intact so dsh's plugin tree sees the
// full WHATWG API surface.
'use strict';
const http = require('node:http');
const https = require('node:https');
const { ReadableStream } = require('node:stream/web');

// ---- unconditional WebAssembly stub: undici's lazy llhttp would compile wasm
//      which fatals on this device (instance alloc + code-GC). fetch below
//      never needs wasm. ----
globalThis.WebAssembly = {
  compile: function () { return new Promise(function () {}); },
  instantiate: function () { return new Promise(function () {}); },
  compileStreaming: function () { return new Promise(function () {}); },
  instantiateStreaming: function () { return new Promise(function () {}); },
  validate: function () { return false; },
};

// swallow any stray wasm-init unhandled rejection
process.on('unhandledRejection', (reason) => {
  const m = reason && reason.message ? String(reason.message) : String(reason);
  if (m.includes('WebAssembly')) return;
  console.error('>>> UHR (other): ' + m.slice(0, 120));
});

function nodeStreamToWeb(nodeStream) {
  return new ReadableStream({
    start(controller) {
      nodeStream.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk)));
      nodeStream.on('end', () => controller.close());
      nodeStream.on('error', (err) => controller.error(err));
      nodeStream.resume();
    },
    cancel() { if (nodeStream.destroy) nodeStream.destroy(); }
  });
}

// fetch via node:http. Uses the NATIVE Request/Response/Headers (undici's
// data classes, wasm-free) so dsh code sees full WHATWG semantics.
async function fetch(input, init = {}) {
  const req = new globalThis.Request(input, init);
  const url = new URL(req.url);
  const isHttps = url.protocol === 'https:';
  const mod = isHttps ? https : http;
  let bodyBuf = null;
  if (req.body != null) {
    if (Buffer.isBuffer(req.body)) bodyBuf = req.body;
    else if (typeof req.body === 'string') bodyBuf = Buffer.from(req.body, 'utf8');
    else if (req.body instanceof Uint8Array) bodyBuf = Buffer.from(req.body);
    else if (typeof req.body === 'object' && typeof req.body[Symbol.asyncIterator] === 'function') {
      const chunks = [];
      for await (const c of req.body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      bodyBuf = Buffer.concat(chunks);
    } else bodyBuf = Buffer.from(String(req.body), 'utf8');
  }
  const headers = {};
  req.headers.forEach((v, k) => { headers[k] = v; });
  // DeepSeek's governor rejects API calls with no User-Agent (bot fingerprint);
  // node:http sends none by default. Match undici's default UA.
  if (!req.headers.has('user-agent')) headers['user-agent'] = 'node';
  if (bodyBuf && !req.headers.has('content-length')) headers['content-length'] = String(bodyBuf.length);
  if (bodyBuf && !req.headers.has('content-type')) headers['content-type'] = 'application/octet-stream';
  return new Promise((resolve, reject) => {
    const options = {
      method: req.method, headers,
      hostname: url.hostname,
      port: url.port ? Number(url.port) : (isHttps ? 443 : 80),
      path: url.pathname + url.search,
    };
    const clientReq = mod.request(options, (res) => {
      const rheaders = new globalThis.Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (Array.isArray(v)) v.forEach((x) => rheaders.append(k, x));
        else rheaders.set(k, v);
      }
      resolve(new globalThis.Response(nodeStreamToWeb(res), {
        status: res.statusCode, statusText: res.statusMessage,
        headers: rheaders, url: req.url,
      }));
    });
    clientReq.on('error', (err) => reject(err));
    const sig = req.signal;
    if (sig) {
      if (sig.aborted) { clientReq.destroy(new Error('The operation was aborted')); return; }
      const onAbort = () => clientReq.destroy(new Error('The operation was aborted'));
      sig.addEventListener('abort', onAbort, { once: true });
      clientReq.on('close', () => sig.removeEventListener('abort', onAbort));
    }
    if (bodyBuf) clientReq.write(bodyBuf);
    clientReq.end();
  });
}

globalThis.fetch = fetch;
module.exports = { fetch };
