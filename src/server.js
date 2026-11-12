// Minimal HTTP server: JSON API (src/api.js) + static files. No external dependencies.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./db');
const { createApi, SESSION_COOKIE_MAX_AGE } = require('./api');
const L = require('./leads');

const ROOT = path.join(__dirname, '..');
const STATIC = { '/': 'public/index.html' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

function createApp({ dbFile, seedIfEmpty = true } = {}) {
  const db = openDb(dbFile);
  const api = createApi(db, { seedIfEmpty });

  function serveStatic(req, res, pathname) {
    let rel = STATIC[pathname];
    if (!rel && (pathname.startsWith('/public/') || pathname.startsWith('/shared/'))) rel = pathname.slice(1);
    if (!rel && /^\/[\w.-]+\.(js|css|svg)$/.test(pathname)) rel = 'public' + pathname;
    if (!rel) rel = 'public/index.html'; // SPA fallback
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) { size += c.length; if (size > 1e6) throw new L.HttpError(413, 'För stor förfrågan.'); chunks.push(c); }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new L.HttpError(400, 'Ogiltig JSON.'); }
  }

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
    const send = (status, obj, session) => {
      const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
      if (session !== undefined) {
        headers['Set-Cookie'] = session ? `crm_sid=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_COOKIE_MAX_AGE}`
          : 'crm_sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';
      }
      res.writeHead(status, headers);
      res.end(JSON.stringify(obj));
    };
    let body = {};
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Basic CSRF guard: state-changing requests must be JSON from our own origin.
      if (!(req.headers['content-type'] || '').includes('application/json')) return send(415, { error: 'Förväntade JSON.' });
      try { body = await readBody(req); } catch (e) { return send(e.status || 400, { error: e.message }); }
    }
    const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((x) => x[0]));
    const r = await api.handle({ method: req.method, pathname: url.pathname, query: Object.fromEntries(url.searchParams), body, token: cookies.crm_sid || null });
    send(r.status, r.data, r.session);
  };

  return { db, handler, server: http.createServer(handler) };
}

module.exports = { createApp };
