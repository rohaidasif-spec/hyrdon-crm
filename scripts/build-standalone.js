// Builds dist/hyrdon-crm-demo.html: the whole CRM in ONE file that opens directly in Chrome (file://).
// The same backend code (src/api.js and everything it uses) runs inside the browser on top of
// sql.js (SQLite in WebAssembly). Data is saved in the browser's localStorage.
// Usage: npm run build:demo
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const safe = (js) => js.replace(/<\/script/gi, '<\\/script');

const MODULES = ['shared/time', 'shared/constants', 'shared/phone', 'src/db', 'src/auth', 'src/leads', 'src/admin', 'src/reports', 'src/seed', 'src/api'];

const modulesJs = MODULES.map((m) => `  ${JSON.stringify(m)}: function (module, exports, require, Buffer) {\n${read(m + '.js')}\n  }`).join(',\n');

const runtime = `
(function () {
  'use strict';
  // ---------- browser shims for the few Node built-ins the backend uses ----------
  function hex(bytes) { return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''); }
  function sha256(str) { // compact SHA-256 (demo password hashing only)
    const K = [], H = [];
    let n = 2, c = 0;
    const frac = (x) => ((x - Math.floor(x)) * 4294967296) | 0;
    while (c < 64) { let p = true; for (let i = 2; i * i <= n; i++) if (n % i === 0) { p = false; break; } if (p) { if (c < 8) H[c] = frac(Math.pow(n, 1 / 2)); K[c++] = frac(Math.pow(n, 1 / 3)); } n++; }
    const bytes = new TextEncoder().encode(str);
    const l = bytes.length, words = [];
    for (let i = 0; i < l; i++) words[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
    words[l >> 2] |= 0x80 << (24 - (l % 4) * 8);
    words[(((l + 8) >> 6) + 1) * 16 - 1] = l * 8;
    const h = H.slice(), w = [];
    for (let j = 0; j < words.length; j += 16) {
      const o = h.slice();
      for (let i = 0; i < 64; i++) {
        if (i < 16) w[i] = words[j + i] | 0;
        else { const a = w[i - 15], b = w[i - 2]; w[i] = (((a >>> 7 | a << 25) ^ (a >>> 18 | a << 14) ^ (a >>> 3)) + w[i - 16] + ((b >>> 17 | b << 15) ^ (b >>> 19 | b << 13) ^ (b >>> 10)) + w[i - 7]) | 0; }
        const e = h[4], a0 = h[0];
        const t1 = (h[7] + ((e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7)) + ((e & h[5]) ^ (~e & h[6])) + K[i] + w[i]) | 0;
        const t2 = (((a0 >>> 2 | a0 << 30) ^ (a0 >>> 13 | a0 << 19) ^ (a0 >>> 22 | a0 << 10)) + ((a0 & h[1]) ^ (a0 & h[2]) ^ (h[1] & h[2]))) | 0;
        h.unshift((t1 + t2) | 0); h[4] = (h[4] + t1) | 0; h.pop();
      }
      for (let i = 0; i < 8; i++) h[i] = (h[i] + o[i]) | 0;
    }
    return h.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }
  const hexBuf = (s) => ({ hex: s, length: s.length / 2, toString: () => s });
  const BufferShim = { from: (s) => hexBuf(String(s)) };
  const cryptoShim = {
    randomBytes: (n) => { const b = new Uint8Array(n); crypto.getRandomValues(b); const s = hex(b); return { toString: () => s }; },
    scryptSync: (pw, salt) => hexBuf(sha256(salt + ':' + pw)),
    timingSafeEqual: (a, b) => a.hex === b.hex,
  };

  // ---------- node:sqlite DatabaseSync on top of sql.js ----------
  const STORE_KEY = 'hyrdon-crm-demo-db-v1';
  let sqlDb = null;
  const norm = (p) => p.map((v) => (v === undefined ? null : v === true ? 1 : v === false ? 0 : v));
  class DatabaseSync {
    constructor() {
      let saved = null;
      try { const b64 = localStorage.getItem(STORE_KEY); if (b64) saved = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)); } catch (e) { /* storage unavailable */ }
      try { this.db = saved ? new SQL.Database(saved) : new SQL.Database(); } catch (e) { this.db = new SQL.Database(); }
      sqlDb = this.db;
    }
    exec(sql) { this.db.exec(sql); }
    prepare(sql) {
      const db = this.db;
      const withStmt = (params, fn) => { const s = db.prepare(sql); try { s.bind(norm(params)); return fn(s); } finally { s.free(); } };
      return {
        get: (...p) => withStmt(p, (s) => (s.step() ? s.getAsObject() : undefined)),
        all: (...p) => withStmt(p, (s) => { const out = []; while (s.step()) out.push(s.getAsObject()); return out; }),
        run: (...p) => {
          withStmt(p, (s) => s.step());
          const changes = db.getRowsModified();
          const id = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
          return { changes, lastInsertRowid: id };
        },
      };
    }
    close() {}
  }
  function persist() {
    try {
      const bytes = sqlDb.export();
      sqlDb.exec('PRAGMA foreign_keys = ON;'); // export() resets pragmas
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      localStorage.setItem(STORE_KEY, btoa(bin));
    } catch (e) { console.warn('Kunde inte spara i webbläsaren', e); }
  }

  const SHIMS = {
    'node:sqlite': { DatabaseSync },
    'node:crypto': cryptoShim,
    'node:fs': { mkdirSync() {}, existsSync() { return false; } },
    'node:path': { dirname: () => '.', join: (...a) => a.join('/') },
  };

  // ---------- tiny CommonJS loader ----------
  const defs = {
${modulesJs}
  };
  const cache = {};
  function resolve(from, spec) {
    if (SHIMS[spec]) return spec;
    const parts = from.split('/').slice(0, -1);
    for (const seg of spec.replace(/\\.js$/, '').split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg); }
    return parts.join('/');
  }
  function load(id) {
    if (SHIMS[id]) return SHIMS[id];
    if (cache[id]) return cache[id].exports;
    if (!defs[id]) throw new Error('Module not bundled: ' + id);
    const module = { exports: {} };
    cache[id] = module;
    defs[id](module, module.exports, (spec) => load(resolve(id, spec)), BufferShim);
    return module.exports;
  }

  // ---------- boot: init SQLite, create API, route fetch('/api/...') to it ----------
  let SQL = null;
  let api = null;
  const TOKEN_KEY = 'hyrdon-crm-demo-token';
  let token = null;
  try { token = localStorage.getItem(TOKEN_KEY); } catch (e) { /* ignore */ }
  const ready = (async () => {
    const wasm = Uint8Array.from(atob(document.getElementById('sqljs-wasm').textContent.trim()), (ch) => ch.charCodeAt(0));
    SQL = await initSqlJs({ wasmBinary: wasm });
    const { openDb } = load('src/db');
    const { createApi } = load('src/api');
    const db = openDb('browser');
    const fresh = !db.prepare('SELECT 1 FROM users LIMIT 1').get();
    api = createApi(db);
    if (fresh) persist();
  })();

  const realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, 'http://crm.local');
    if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
    await ready;
    const method = (init.method || 'GET').toUpperCase();
    let body = {};
    try { body = init.body ? JSON.parse(init.body) : {}; } catch (e) { /* ignore */ }
    const r = await api.handle({ method, pathname: url.pathname, query: Object.fromEntries(url.searchParams), body, token });
    if (r.session !== undefined) { token = r.session; try { if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ } }
    if (method !== 'GET' && r.status === 200) persist();
    return new Response(JSON.stringify(r.data), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  };
  window.CRM_STANDALONE = true;
})();
`;

const favicon = 'data:image/svg+xml,' + encodeURIComponent(read('public/favicon.svg').trim());
const wasmB64 = fs.readFileSync(path.join(ROOT, 'vendor/sqljs/sql-wasm.wasm')).toString('base64');

const html = `<!doctype html>
<html lang="sv">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#f2f2f7" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
  <meta name="color-scheme" content="light dark">
  <title>Hyrdon CRM – demo</title>
  <link rel="icon" href="${favicon}">
  <!-- Single-file demo build of Hyrdon CRM. Generated by scripts/build-standalone.js – do not edit by hand.
       Includes sql.js 1.10.3 (MIT, https://github.com/sql-js/sql.js). Synthetic demo data only; no external connections. -->
  <style>
${read('public/styles.css')}
  </style>
</head>
<body>
  <div id="app"></div>
  <div id="modal-root"></div>
  <div id="toast-root" aria-live="polite"></div>
  <script type="application/octet-stream" id="sqljs-wasm">${wasmB64}</script>
  <script>${safe(read('vendor/sqljs/sql-wasm.js'))}</script>
  <script>${safe(read('shared/time.js'))}</script>
  <script>${safe(read('shared/constants.js'))}</script>
  <script>${safe(read('shared/phone.js'))}</script>
  <script>${safe(runtime)}</script>
  <script>${safe(read('public/app.js'))}</script>
</body>
</html>
`;

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const out = path.join(ROOT, 'dist', 'hyrdon-crm-demo.html');
fs.writeFileSync(out, html);
console.log(`Skapade ${path.relative(ROOT, out)} (${(html.length / 1024 / 1024).toFixed(2)} MB)`);
