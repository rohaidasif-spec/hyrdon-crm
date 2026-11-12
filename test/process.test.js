// Real server processes: persistence across restarts, and atomic claiming across two processes on one database file.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');
const { tmpDb, client } = require('./helpers');

const ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

async function startProcess(dbFile) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), CRM_DB: dbFile }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 15000);
    child.stdout.on('data', (d) => { out += d; if (out.includes('körs på')) { clearTimeout(t); resolve(); } });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => { clearTimeout(t); reject(new Error(`exited ${code}: ${out}`)); });
  });
  child.removeAllListeners('exit');
  const base = `http://127.0.0.1:${port}`;
  const stop = () => new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); });
  return { base, stop };
}

test('data survives a server restart', async () => {
  const dbFile = tmpDb('persist');
  let srv = await startProcess(dbFile);
  let c = client(srv.base);
  await c.login('emma@demo.local');
  const meta = (await c.get('/api/meta')).data;
  const created = (await c.post('/api/leads', { pipeline_id: meta.pipelines[1].id, name: 'Beständig Kund', phone: '070-777 66 55', claim: true })).data.lead;
  await c.post(`/api/leads/${created.id}/activities`, { type: 'note', body: 'Ska finnas kvar efter omstart' });
  await c.put(`/api/leads/${created.id}/next-action`, { text: 'Ring tillbaka', due: '2030-05-05T10:00' });
  const leadCount = (await c.get('/api/leads?owner=me')).data.leads.length;
  await srv.stop();

  srv = await startProcess(dbFile);
  c = client(srv.base);
  await c.login('emma@demo.local');
  const d = (await c.get(`/api/leads/${created.id}`)).data;
  assert.equal(d.lead.customer_name, 'Beständig Kund');
  assert.equal(d.lead.owner_name, 'Emma Nyström');
  assert.equal(d.lead.next_action, 'Ring tillbaka');
  assert.equal(d.lead.next_action_due, '2030-05-05T08:00:00.000Z', '10:00 Stockholm (CEST) stored as UTC');
  assert.ok(d.activities.some((a) => a.type === 'note' && a.body === 'Ska finnas kvar efter omstart'));
  assert.equal((await c.get('/api/leads?owner=me')).data.leads.length, leadCount, 'demo data was not re-seeded on restart');
  await srv.stop();
});

test('two server processes on the same database: a lead still gets exactly one owner', async () => {
  const dbFile = tmpDb('race');
  const s1 = await startProcess(dbFile);
  const s2 = await startProcess(dbFile);
  try {
    const sellers = ['johan', 'sara', 'ahmed', 'emma', 'oskar', 'lina'];
    const clients = [];
    for (let i = 0; i < sellers.length; i++) { const c = client(i % 2 ? s2.base : s1.base); await c.login(`${sellers[i]}@demo.local`); clients.push(c); }
    const admin = client(s1.base); await admin.login('karin@demo.local');
    const pid = (await admin.get('/api/meta')).data.pipelines[0].id;
    for (let round = 0; round < 10; round++) {
      const lead = (await admin.post('/api/leads', { pipeline_id: pid, name: `Process race ${round}` })).data.lead;
      const res = await Promise.all(clients.map((c) => c.post(`/api/leads/${lead.id}/claim`)));
      const winners = res.filter((r) => r.status === 200);
      assert.equal(winners.length, 1, `round ${round}`);
      assert.equal(res.filter((r) => r.status === 409).length, sellers.length - 1);
      const final = (await admin.get(`/api/leads/${lead.id}`)).data;
      assert.equal(final.lead.owner_id, winners[0].data.lead.owner_id);
      assert.equal(final.activities.filter((a) => a.type === 'owner_change').length, 1);
    }
  } finally { await s1.stop(); await s2.stop(); }
});

test('reset-demo requires admin and explicit confirmation', async () => {
  const dbFile = tmpDb('reset');
  const srv = await startProcess(dbFile);
  try {
    const admin = client(srv.base); await admin.login('karin@demo.local');
    const pid = (await admin.get('/api/meta')).data.pipelines[0].id;
    await admin.post('/api/leads', { pipeline_id: pid, name: 'Försvinner vid återställning' });
    assert.equal((await admin.post('/api/admin/reset-demo', {})).status, 400);
    assert.equal((await admin.post('/api/admin/reset-demo', { confirm: 'ja' })).status, 400);
    const sales = client(srv.base); await sales.login('lina@demo.local');
    assert.equal((await sales.post('/api/admin/reset-demo', { confirm: 'ÅTERSTÄLL' })).status, 403);
    assert.equal((await admin.post('/api/admin/reset-demo', { confirm: 'ÅTERSTÄLL' })).status, 200);
    const again = client(srv.base); await again.login('karin@demo.local');
    assert.equal((await again.get('/api/search?q=Försvinner')).data.leads.length, 0);
  } finally { await srv.stop(); }
});
