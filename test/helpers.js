const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');

function tmpDb(name = 'crm') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyrdon-crm-test-'));
  return path.join(dir, `${name}.sqlite`);
}

async function startApp(opts = {}) {
  const dbFile = opts.dbFile || tmpDb();
  const app = createApp({ dbFile, seedIfEmpty: opts.seed !== false });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { ...app, base, dbFile, close: () => new Promise((r) => { app.server.closeAllConnections?.(); app.server.close(r); app.db.close(); }) };
}

function client(base) {
  let cookie = '';
  const req = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch { /* not json */ }
    return { status: res.status, data };
  };
  return {
    req,
    get: (p) => req('GET', p),
    post: (p, b = {}) => req('POST', p, b),
    patch: (p, b = {}) => req('PATCH', p, b),
    put: (p, b = {}) => req('PUT', p, b),
    login: async (email, password = 'demo1234') => { const r = await req('POST', '/api/login', { email, password }); if (r.status !== 200) throw new Error(`login failed ${email}: ${r.status}`); return r.data.user; },
  };
}

async function loggedIn(base, email) { const c = client(base); c.user = await c.login(email); return c; }

module.exports = { tmpDb, startApp, client, loggedIn };
