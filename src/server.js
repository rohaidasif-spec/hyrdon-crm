// Minimal HTTP server: JSON API + static files. No external dependencies.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./db');
const auth = require('./auth');
const L = require('./leads');
const A = require('./admin');
const R = require('./reports');
const { seedDemo } = require('./seed');
const C = require('../shared/constants');

const ROOT = path.join(__dirname, '..');
const STATIC = { '/': 'public/index.html' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

function createApp({ dbFile, seedIfEmpty = true } = {}) {
  const db = openDb(dbFile);
  if (seedIfEmpty && !db.prepare('SELECT 1 FROM users LIMIT 1').get()) seedDemo(db);

  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, ...opts });
  };

  // ---- auth ----
  route('POST', '/api/login', ({ body, res }) => {
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(body.email || '').trim());
    if (!u || !auth.verifyPassword(body.password || '', u.password_hash)) throw new L.HttpError(401, 'Fel e-post eller lösenord.');
    if (!u.active) throw new L.HttpError(403, 'Kontot är inaktiverat. Kontakta admin.');
    const token = auth.createSession(db, u.id);
    res.setHeader('Set-Cookie', `crm_sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${14 * 86400}`);
    return { user: { id: u.id, name: u.name, email: u.email, role: u.role } };
  }, { public: true });
  route('POST', '/api/logout', ({ token, res }) => {
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    res.setHeader('Set-Cookie', 'crm_sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return { ok: true };
  }, { public: true });
  route('GET', '/api/demo-accounts', () => ({
    // Local demo only: lets the login screen list the synthetic accounts.
    accounts: db.prepare('SELECT name, email, role FROM users WHERE is_demo = 1 AND active = 1 ORDER BY role, name').all().map((x) => ({ ...x })),
  }), { public: true });
  route('GET', '/api/me', ({ user }) => ({ user }));

  // ---- meta ----
  route('GET', '/api/meta', ({ user }) => ({
    user,
    pipelines: A.listPipelines(db),
    users: db.prepare('SELECT id, name, role, active FROM users ORDER BY active DESC, name').all().map((x) => ({ ...x })),
    sources: C.SOURCES, lostReasons: C.LOST_REASONS, callOutcomes: C.CALL_OUTCOMES, roles: C.ROLES,
    demo: { seeded_at: (db.prepare("SELECT value FROM app_meta WHERE key = 'demo_seeded_at'").get() || {}).value || null },
  }));

  // ---- leads ----
  route('GET', '/api/my-day', ({ user }) => L.myDay(db, user));
  route('GET', '/api/board', ({ user, query }) => L.board(db, user, query));
  route('GET', '/api/search', ({ user, query }) => L.search(db, user, query.q));
  route('GET', '/api/leads', ({ user, query }) => ({ leads: L.listLeads(db, user, query, { limit: 300 }) }));
  route('POST', '/api/leads', ({ user, body }) => ({ lead: L.createLead(db, user, body) }));
  route('GET', '/api/leads/:id', ({ user, params }) => L.getLeadDetail(db, user, params.id));
  route('PATCH', '/api/leads/:id', ({ user, params, body }) => ({ lead: L.updateLead(db, user, params.id, body) }));
  route('POST', '/api/leads/:id/claim', ({ user, params }) => L.claimLead(db, user, params.id));
  route('POST', '/api/leads/:id/release', ({ user, params }) => ({ lead: L.releaseLead(db, user, params.id) }));
  route('POST', '/api/leads/:id/assign', ({ user, params, body }) => ({ lead: L.assignLead(db, user, params.id, body.owner_id) }));
  route('POST', '/api/leads/:id/stage', ({ user, params, body }) => ({ lead: L.moveStage(db, user, params.id, body) }));
  route('PUT', '/api/leads/:id/next-action', ({ user, params, body }) => ({ lead: L.setNextAction(db, user, params.id, body) }));
  route('POST', '/api/leads/:id/next-action/complete', ({ user, params, body }) => ({ lead: L.completeNextAction(db, user, params.id, body) }));
  route('POST', '/api/leads/:id/activities', ({ user, params, body }) => L.logActivity(db, user, params.id, body));

  // ---- contacts ----
  route('GET', '/api/contacts/match', ({ query }) => ({ matches: L.findMatches(db, query) }));
  route('GET', '/api/contacts/:id', ({ user, params }) => {
    const contact = { ...L.getContact(db, params.id) };
    return { contact, leads: L.listLeads(db, user, { contact: contact.id }), duplicates: L.findMatches(db, { phone: contact.phone, email: contact.email, exclude: contact.id }) };
  });
  route('PATCH', '/api/contacts/:id', ({ user, params, body }) => ({ contact: { ...L.updateContact(db, user, params.id, body) } }));

  // ---- reports (director/admin) ----
  route('GET', '/api/reports/dashboard', ({ user, query }) => { A.requireAdmin(user); return R.dashboard(db, query); });
  route('GET', '/api/reports/leads', ({ user, query }) => { A.requireAdmin(user); return R.metricLeads(db, query.metric, R.parseFilters(query)); });

  // ---- admin ----
  route('GET', '/api/admin/users', ({ user }) => { A.requireAdmin(user); return { users: A.listUsers(db) }; });
  route('POST', '/api/admin/users', ({ user, body }) => A.createUser(db, user, body));
  route('PATCH', '/api/admin/users/:id', ({ user, params, body }) => A.updateUser(db, user, params.id, body));
  route('GET', '/api/admin/pipelines', ({ user }) => { A.requireAdmin(user); return { pipelines: A.listPipelines(db, { includeArchived: true }) }; });
  route('POST', '/api/admin/pipelines', ({ user, body }) => A.createPipeline(db, user, body));
  route('POST', '/api/admin/pipelines/reorder', ({ user, body }) => A.reorderPipelines(db, user, body.ids));
  route('PATCH', '/api/admin/pipelines/:id', ({ user, params, body }) => A.updatePipeline(db, user, params.id, body));
  route('POST', '/api/admin/pipelines/:id/stages', ({ user, params, body }) => A.addStage(db, user, params.id, body));
  route('PATCH', '/api/admin/stages/:id', ({ user, params, body }) => A.updateStage(db, user, params.id, body));
  route('POST', '/api/admin/reset-demo', ({ user, body }) => {
    A.requireAdmin(user);
    if (body.confirm !== 'ÅTERSTÄLL') throw new L.HttpError(400, 'Skriv ÅTERSTÄLL för att bekräfta.');
    return { ok: true, ...seedDemo(db) };
  });

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
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
    const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
    try {
      const match = routes.map((r) => ({ r, m: r.method === req.method && pathname.match(r.re) })).find((x) => x.m);
      if (!match) throw new L.HttpError(404, 'Okänd adress.');
      const { r, m } = match;
      const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((x) => x[0]));
      const token = cookies.crm_sid;
      const user = auth.userForToken(db, token);
      if (!r.public && !user) throw new L.HttpError(401, 'Du är inte inloggad.');
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // Basic CSRF guard: state-changing requests must be JSON from our own origin.
        const ct = req.headers['content-type'] || '';
        if (!ct.includes('application/json')) throw new L.HttpError(415, 'Förväntade JSON.');
      }
      const body = req.method === 'GET' ? {} : await readBody(req);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const result = await r.handler({ req, res, body, params, query: Object.fromEntries(url.searchParams), user, token });
      send(200, result);
    } catch (e) {
      if (e instanceof L.HttpError) return send(e.status, { error: e.message, ...(e.extra || {}) });
      console.error(e);
      send(500, { error: 'Något gick fel på servern.' });
    }
  };

  return { db, handler, server: http.createServer(handler) };
}

module.exports = { createApp };
