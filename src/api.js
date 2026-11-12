// Transport-independent JSON API. Used by the Node HTTP server (src/server.js) and by the
// single-file browser demo (scripts/build-standalone.js), so both run exactly the same logic.
const auth = require('./auth');
const L = require('./leads');
const A = require('./admin');
const R = require('./reports');
const { seedDemo } = require('./seed');
const C = require('../shared/constants');

const SESSION_COOKIE_MAX_AGE = 14 * 86400;

function createApi(db, { seedIfEmpty = true } = {}) {
  if (seedIfEmpty && !db.prepare('SELECT 1 FROM users LIMIT 1').get()) seedDemo(db);

  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, ...opts });
  };

  // ---- auth ----
  route('POST', '/api/login', ({ body, setSession }) => {
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(body.email || '').trim());
    if (!u || !auth.verifyPassword(body.password || '', u.password_hash)) throw new L.HttpError(401, 'Fel e-post eller lösenord.');
    if (!u.active) throw new L.HttpError(403, 'Kontot är inaktiverat. Kontakta admin.');
    setSession(auth.createSession(db, u.id));
    return { user: { id: u.id, name: u.name, email: u.email, role: u.role } };
  }, { public: true });
  route('POST', '/api/logout', ({ token, setSession }) => {
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    setSession(null);
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

  // Handle one request. Returns { status, data, session } where session is
  // undefined (unchanged), null (clear) or a new session token.
  async function handle({ method, pathname, query = {}, body = {}, token = null }) {
    let session;
    try {
      const match = routes.map((r) => ({ r, m: r.method === method && pathname.match(r.re) })).find((x) => x.m);
      if (!match) throw new L.HttpError(404, 'Okänd adress.');
      const { r, m } = match;
      const user = auth.userForToken(db, token);
      if (!r.public && !user) throw new L.HttpError(401, 'Du är inte inloggad.');
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const data = await r.handler({ body, params, query, user, token, setSession: (t) => { session = t; } });
      return { status: 200, data, session };
    } catch (e) {
      if (e instanceof L.HttpError) return { status: e.status, data: { error: e.message, ...(e.extra || {}) }, session };
      console.error(e);
      return { status: 500, data: { error: 'Något gick fel på servern.' }, session };
    }
  }

  return { handle };
}

module.exports = { createApi, SESSION_COOKIE_MAX_AGE };
