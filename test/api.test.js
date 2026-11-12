const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client, loggedIn } = require('./helpers');

let app; let admin; let johan; let sara; let pipes;
const SELLERS = ['johan', 'sara', 'ahmed', 'emma', 'oskar', 'lina'].map((n) => `${n}@demo.local`);

test.before(async () => {
  app = await startApp();
  admin = await loggedIn(app.base, 'karin@demo.local');
  johan = await loggedIn(app.base, 'johan@demo.local');
  sara = await loggedIn(app.base, 'sara@demo.local');
  pipes = (await johan.get('/api/meta')).data.pipelines;
});
test.after(() => app.close());

const pipe = (name) => pipes.find((p) => p.name === name);
const stage = (p, name) => p.stages.find((s) => s.name === name);
async function newLead(c, body = {}) {
  const r = await c.post('/api/leads', { pipeline_id: pipe('Hyrdon').id, name: 'Test Kund', ...body });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.lead;
}

test('seed: three pipelines with the initial stages, 1 director + 6 active sellers', async () => {
  assert.deepEqual(pipes.map((p) => p.name), ['Hyrdon', 'Premium Motors', 'American Motors']);
  for (const p of pipes) assert.deepEqual(p.stages.map((s) => s.name), ['Ny', 'Kontaktförsök', 'Kontakt etablerad', 'Såld / Avtal klart', 'Levererad', 'Förlorad / Ej aktuell']);
  const users = (await admin.get('/api/admin/users')).data.users;
  assert.equal(users.filter((u) => u.role === 'admin' && u.active).length, 1);
  assert.equal(users.filter((u) => u.role === 'sales' && u.active).length, 6);
});

test('authentication and role restrictions are enforced by the backend', async () => {
  const anon = client(app.base);
  assert.equal((await anon.get('/api/my-day')).status, 401);
  assert.equal((await anon.post('/api/leads', { pipeline_id: 1, name: 'x' })).status, 401);
  assert.equal((await anon.post('/api/login', { email: 'johan@demo.local', password: 'fel' })).status, 401);
  assert.equal((await anon.post('/api/login', { email: 'mikael@demo.local', password: 'demo1234' })).status, 403, 'inactive user cannot log in');

  const lead = await newLead(admin);
  const forbidden = [
    ['GET', '/api/reports/dashboard'], ['GET', '/api/reports/leads?metric=new'], ['GET', '/api/admin/users'],
    ['POST', '/api/admin/users', { name: 'X', email: 'x@demo.local', password: 'secret1', role: 'admin' }],
    ['PATCH', '/api/admin/users/3', { active: false }], ['POST', '/api/admin/pipelines', { name: 'Hack' }],
    ['PATCH', `/api/admin/pipelines/${pipe('Hyrdon').id}`, { name: 'Hack' }], ['PATCH', `/api/admin/stages/${stage(pipe('Hyrdon'), 'Ny').id}`, { name: 'Hack' }],
    ['POST', '/api/admin/reset-demo', { confirm: 'ÅTERSTÄLL' }], ['POST', `/api/leads/${lead.id}/assign`, { owner_id: johan.user.id }],
  ];
  for (const [m, p, b] of forbidden) assert.equal((await johan.req(m, p, b)).status, 403, `${m} ${p}`);

  // Sales sees every pipeline and the conversations attached to leads
  for (const p of pipes) assert.equal((await johan.get(`/api/board?pipeline=${p.id}`)).status, 200);
  const other = (await johan.get('/api/leads?owner=' + sara.user.id)).data.leads[0];
  const detail = (await johan.get(`/api/leads/${other.id}`)).data;
  assert.ok(detail.activities.length > 0);
  assert.equal(detail.can.edit, false);
  // ...but cannot change someone else's lead
  assert.equal((await johan.post(`/api/leads/${other.id}/stage`, { stage_id: other.stage_id })).status, 403);
  assert.equal((await johan.patch(`/api/leads/${other.id}`, { vehicle: 'X' })).status, 403);
  assert.equal((await johan.put(`/api/leads/${other.id}/next-action`, { text: 'X' })).status, 403);
  assert.equal((await johan.post(`/api/leads/${other.id}/release`)).status, 403);
  // Notes on a colleague's lead are allowed
  assert.equal((await johan.post(`/api/leads/${other.id}/activities`, { type: 'note', body: 'Kollega-notering' })).status, 200);
  // Unassigned lead: must claim before editing
  assert.equal((await johan.patch(`/api/leads/${lead.id}`, { vehicle: 'X' })).status, 403);

  // Non-JSON state-changing requests are rejected (basic CSRF guard)
  const res = await fetch(app.base + '/api/logout', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' });
  assert.equal(res.status, 415);
});

test('admin creates and deactivates accounts; history of deactivated users is kept', async () => {
  const r = await admin.post('/api/admin/users', { name: 'Ny Säljare', email: 'ny@demo.local', password: 'hemligt1', role: 'sales' });
  assert.equal(r.status, 200);
  assert.equal((await admin.post('/api/admin/users', { name: 'Dup', email: 'ny@demo.local', password: 'hemligt1', role: 'sales' })).status, 409);
  const ny = await loggedIn(app.base, 'ny@demo.local').catch(() => null);
  assert.ok(ny === null, 'demo password must not work');
  const nyc = client(app.base); await nyc.login('ny@demo.local', 'hemligt1');
  const lead = await newLead(nyc);
  assert.equal((await nyc.post(`/api/leads/${lead.id}/claim`)).status, 200);
  await nyc.post(`/api/leads/${lead.id}/activities`, { type: 'call', direction: 'out', call_outcome: 'answered' });

  assert.equal((await admin.patch(`/api/admin/users/${r.data.id}`, { active: false })).status, 200);
  assert.equal((await nyc.get('/api/my-day')).status, 401, 'existing session is revoked');
  assert.equal((await client(app.base).post('/api/login', { email: 'ny@demo.local', password: 'hemligt1' })).status, 403);
  assert.equal((await admin.patch(`/api/admin/users/${admin.user.id}`, { active: false })).status, 400, 'cannot deactivate self');

  const d = (await admin.get(`/api/leads/${lead.id}`)).data;
  assert.equal(d.lead.owner_id, r.data.id, 'ownership kept');
  assert.equal(d.lead.owner_active, 0);
  const call = d.activities.find((a) => a.type === 'call');
  assert.equal(call.user_name, 'Ny Säljare');
  // Admin reassigns; ownership history preserved
  assert.equal((await admin.post(`/api/leads/${lead.id}/assign`, { owner_id: johan.user.id })).status, 200);
  assert.equal((await admin.post(`/api/leads/${lead.id}/assign`, { owner_id: r.data.id })).status, 400, 'cannot assign to inactive user');
  const owners = (await admin.get(`/api/leads/${lead.id}`)).data.activities.filter((a) => a.type === 'owner_change');
  assert.deepEqual(owners.map((a) => [a.from_user_name, a.to_user_name]).reverse(), [[null, 'Ny Säljare'], ['Ny Säljare', 'Johan Berg']]);
});

test('create with minimal data, edit, claim, move and release', async () => {
  assert.equal((await johan.post('/api/leads', { name: 'Utan pipeline' })).status, 400);
  assert.equal((await johan.post('/api/leads', { pipeline_id: pipe('Hyrdon').id })).status, 400, 'needs a name or contact method');
  const onlyPhone = await newLead(johan, { name: '', phone: '070-999 88 77' });
  assert.equal(onlyPhone.customer_name, null);
  assert.equal(onlyPhone.phone, '070-999 88 77');

  const l = await newLead(johan, { name: 'Minimal Kund' });
  assert.equal(l.owner_id, null, 'new leads start unassigned');
  assert.equal(l.stage_name, 'Ny');
  assert.equal(l.outcome, 'open');

  const c = await johan.post(`/api/leads/${l.id}/claim`);
  assert.equal(c.status, 200);
  assert.equal(c.data.lead.owner_id, johan.user.id);

  const e = await johan.patch(`/api/leads/${l.id}`, { vehicle: 'Volvo XC60', reg_number: 'abc 123', listing_id: '123', listing_url: 'https://exempel.invalid/1', enquiry: 'Pris?', source: 'blocket' });
  assert.equal(e.status, 200, JSON.stringify(e.data));
  assert.equal(e.data.lead.reg_number, 'abc 123');
  assert.equal(e.data.lead.reg_norm, 'ABC123');
  assert.equal(e.data.lead.source, 'blocket');
  assert.equal((await johan.patch(`/api/leads/${l.id}`, { listing_url: 'javascript:alert(1)' })).status, 400);

  const p = pipe('Hyrdon');
  const m = await johan.post(`/api/leads/${l.id}/stage`, { stage_id: stage(p, 'Kontaktförsök').id });
  assert.equal(m.status, 200);
  assert.equal(m.data.lead.stage_name, 'Kontaktförsök');
  assert.equal((await johan.post(`/api/leads/${l.id}/stage`, { stage_id: stage(pipe('Premium Motors'), 'Ny').id })).status, 400, 'stage of another pipeline');

  // search by reg number, vehicle and phone in another format
  assert.ok((await johan.get('/api/search?q=ABC123')).data.leads.some((x) => x.id === l.id));
  assert.ok((await johan.get('/api/search?q=xc60')).data.leads.some((x) => x.id === l.id));
  assert.ok((await johan.get('/api/search?q=%2B46%2070%20999%2088%2077')).data.leads.some((x) => x.id === onlyPhone.id));
  assert.ok((await johan.get('/api/search?q=0709998877')).data.leads.some((x) => x.id === onlyPhone.id));

  const d = (await johan.get(`/api/leads/${l.id}`)).data;
  const types = d.activities.map((a) => a.type);
  for (const t of ['created', 'owner_change', 'edit', 'stage_change']) assert.ok(types.includes(t), t);

  assert.equal((await johan.post(`/api/leads/${l.id}/release`)).data.lead.owner_id, null);
  // board filters
  const b = (await johan.get(`/api/board?pipeline=${p.id}&owner=none&q=Minimal`)).data;
  assert.equal(b.stages.flatMap((s) => s.leads).length, 1);
});

test('claiming is atomic: simultaneous attempts give exactly one owner', async () => {
  const clients = await Promise.all(SELLERS.map((e) => loggedIn(app.base, e)));
  clients.push(admin);
  for (let round = 0; round < 15; round++) {
    const lead = await newLead(admin, { name: `Race ${round}` });
    const results = await Promise.all(clients.map((c) => c.post(`/api/leads/${lead.id}/claim`)));
    const ok = results.filter((r) => r.status === 200);
    const lost = results.filter((r) => r.status === 409);
    assert.equal(ok.length, 1, `round ${round}: exactly one winner`);
    assert.equal(lost.length, clients.length - 1);
    const winner = ok[0].data.lead;
    for (const r of lost) {
      assert.equal(r.data.owner_name, winner.owner_name);
      assert.match(r.data.error, new RegExp(`${winner.owner_name} tog redan`));
    }
    const claims = (await admin.get(`/api/leads/${lead.id}`)).data.activities.filter((a) => a.type === 'owner_change');
    assert.equal(claims.length, 1, 'only one claim recorded');
  }
});

test('follow-ups: overdue indicators, completion keeps history, easy next step', async () => {
  const l = await newLead(sara, { name: 'Uppföljning', claim: true });
  assert.equal(l.owner_id, sara.user.id);
  const past = new Date(Date.now() - 3 * 3600000).toISOString();
  let r = await sara.put(`/api/leads/${l.id}/next-action`, { text: 'Ring upp', due: past });
  assert.equal(r.data.lead.overdue, true);
  let day = (await sara.get('/api/my-day')).data;
  assert.ok(day.overdue.some((x) => x.id === l.id));
  assert.ok(!day.noNext.some((x) => x.id === l.id));
  const board = (await sara.get(`/api/board?pipeline=${pipe('Hyrdon').id}&overdue=1&owner=me`)).data;
  assert.ok(board.stages.flatMap((s) => s.leads).every((x) => x.overdue));

  const soon = new Date(Date.now() + 10 * 60000).toISOString();
  r = await sara.post(`/api/leads/${l.id}/next-action/complete`, { result: 'Pratade med kunden', next_text: 'Skicka offert', next_due: soon });
  assert.equal(r.status, 200);
  assert.equal(r.data.lead.next_action, 'Skicka offert');
  assert.equal(r.data.lead.overdue, false);
  const done = (await sara.get(`/api/leads/${l.id}`)).data.activities.find((a) => a.type === 'followup_done');
  assert.equal(done.body, 'Ring upp');
  assert.equal(done.due_at, past);
  assert.equal(done.subject, 'Pratade med kunden');

  r = await sara.post(`/api/leads/${l.id}/next-action/complete`, {});
  assert.equal(r.data.lead.next_action, null);
  day = (await sara.get('/api/my-day')).data;
  assert.ok(day.noNext.some((x) => x.id === l.id), 'appears in "utan nästa steg"');
  assert.equal((await sara.post(`/api/leads/${l.id}/next-action/complete`, {})).status, 400);
  const hist = (await sara.get(`/api/leads/${l.id}`)).data.activities.filter((a) => a.type === 'followup_done');
  assert.equal(hist.length, 2);
});

test('duplicate warnings use normalised phone/email and never auto-merge', async () => {
  const a = await newLead(johan, { name: 'Dubblett Ett', phone: '070-555 12 34', email: 'Dubb@Example.com' });
  for (const phone of ['+46705551234', '0046 70 555 12 34', '0705551234']) {
    const m = (await johan.get(`/api/contacts/match?phone=${encodeURIComponent(phone)}`)).data.matches;
    assert.ok(m.some((x) => x.id === a.contact_id && x.matched_on.includes('phone')), phone);
  }
  const em = (await johan.get('/api/contacts/match?email=dubb%40example.com')).data.matches;
  assert.ok(em.some((x) => x.id === a.contact_id && x.matched_on.includes('email')));
  for (const bad of ['555', '1234', 'abc', '705551234']) {
    assert.equal((await johan.get(`/api/contacts/match?phone=${bad}`)).data.matches.length, 0, bad);
  }
  // Same digits but a foreign country code must not match the Swedish number
  assert.equal((await johan.get(`/api/contacts/match?phone=${encodeURIComponent('+47 70 555 12 34')}`)).data.matches.length, 0);

  // Creating another lead with the same phone (no contact_id) creates a separate contact – no automatic merge
  const b = await newLead(johan, { name: 'Dubblett Två', phone: '+46 70 555 12 34' });
  assert.notEqual(b.contact_id, a.contact_id);
  const d = (await johan.get(`/api/leads/${b.id}`)).data;
  assert.ok(d.duplicates.some((x) => x.id === a.contact_id), 'lead detail warns about the duplicate');
  assert.equal(d.contact.phone, '+46 70 555 12 34', 'original display value preserved');
  assert.equal(d.contact.phone_norm, '+46705551234');

  // Invalid numbers are stored for display but never match each other
  const x1 = await newLead(johan, { name: 'Ogiltig 1', phone: 'ring efter 17' });
  const x2 = await newLead(johan, { name: 'Ogiltig 2', phone: 'ring efter 17' });
  assert.equal(x1.phone_norm, null);
  assert.equal((await johan.get(`/api/leads/${x2.id}`)).data.duplicates.length, 0);
});

test('one customer can have multiple separate leads across businesses', async () => {
  const first = await newLead(johan, { name: 'Flera Leads', phone: '073-111 22 33' });
  const second = (await johan.post('/api/leads', { pipeline_id: pipe('American Motors').id, contact_id: first.contact_id, vehicle: 'Ford Mustang' })).data.lead;
  const third = (await johan.post('/api/leads', { pipeline_id: pipe('Premium Motors').id, contact_id: first.contact_id })).data.lead;
  assert.equal(second.contact_id, first.contact_id);
  const c = (await johan.get(`/api/contacts/${first.contact_id}`)).data;
  assert.equal(c.leads.length, 3);
  assert.deepEqual(new Set(c.leads.map((l) => l.pipeline_name)), new Set(['Hyrdon', 'American Motors', 'Premium Motors']));
  const d = (await johan.get(`/api/leads/${third.id}`)).data;
  assert.equal(d.otherLeads.length, 2);
  // each lead keeps its own stage/owner
  await johan.post(`/api/leads/${second.id}/claim`);
  const after = (await johan.get(`/api/contacts/${first.contact_id}`)).data.leads;
  assert.equal(after.filter((l) => l.owner_id).length, 1);
});

test('losing a lead requires a reason, and an explanation for "Annat"', async () => {
  const p = pipe('Premium Motors');
  const lost = stage(p, 'Förlorad / Ej aktuell').id;
  const l = (await johan.post('/api/leads', { pipeline_id: p.id, name: 'Förlorad Kund', claim: true, next_action: 'Ring', next_action_due: '2030-01-01T09:00' })).data.lead;
  assert.equal((await johan.post(`/api/leads/${l.id}/stage`, { stage_id: lost })).status, 400);
  assert.equal((await johan.post(`/api/leads/${l.id}/stage`, { stage_id: lost, lost_reason: 'nonsense' })).status, 400);
  assert.equal((await johan.post(`/api/leads/${l.id}/stage`, { stage_id: lost, lost_reason: 'other' })).status, 400);
  assert.equal((await johan.post(`/api/leads/${l.id}/stage`, { stage_id: lost, lost_reason: 'other', lost_note: '   ' })).status, 400);
  const r = await johan.post(`/api/leads/${l.id}/stage`, { stage_id: lost, lost_reason: 'other', lost_note: 'Flyttar utomlands' });
  assert.equal(r.status, 200);
  assert.equal(r.data.lead.outcome, 'lost');
  assert.equal(r.data.lead.lost_reason, 'other');
  assert.ok(r.data.lead.lost_at);
  assert.equal(r.data.lead.next_action, null, 'closed leads have no pending follow-up');
  const r2 = await johan.post(`/api/leads/${l.id}/stage`, { stage_id: lost, lost_reason: 'price' });
  assert.equal(r2.data.lead.lost_at, r.data.lead.lost_at, 'changing the reason keeps the original loss date');
  // Reopen clears loss
  const r3 = await johan.post(`/api/leads/${l.id}/stage`, { stage_id: stage(p, 'Kontakt etablerad').id });
  assert.equal(r3.data.lead.outcome, 'open');
  assert.equal(r3.data.lead.lost_reason, null);
});

test('moving a won lead to Levererad does not count another sale', async () => {
  const p = pipe('American Motors');
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date());
  const q = `/api/reports/dashboard?from=${today}&to=${today}&pipeline=${p.id}`;
  const base = (await admin.get(q)).data.counts;
  const l = (await johan.post('/api/leads', { pipeline_id: p.id, name: 'Vinnare', claim: true })).data.lead;
  const won = await johan.post(`/api/leads/${l.id}/stage`, { stage_id: stage(p, 'Såld / Avtal klart').id });
  assert.equal(won.data.lead.outcome, 'won');
  const wonAt = won.data.lead.won_at;
  let c = (await admin.get(q)).data.counts;
  assert.equal(c.won, base.won + 1);
  assert.equal(c.cohort_won, base.cohort_won + 1);

  const del = await johan.post(`/api/leads/${l.id}/stage`, { stage_id: stage(p, 'Levererad').id });
  assert.equal(del.data.lead.won_at, wonAt, 'won_at unchanged');
  c = (await admin.get(q)).data.counts;
  assert.equal(c.won, base.won + 1, 'still one sale');
  assert.equal(c.cohort_won, base.cohort_won + 1);
  // and back again
  await johan.post(`/api/leads/${l.id}/stage`, { stage_id: stage(p, 'Såld / Avtal klart').id });
  await johan.post(`/api/leads/${l.id}/stage`, { stage_id: stage(p, 'Levererad').id });
  assert.equal((await admin.get(q)).data.counts.won, base.won + 1);
});

test('admin pipeline management: add, rename, reorder, archive without losing history', async () => {
  const r = await admin.post('/api/admin/pipelines', { name: 'Testmärke' });
  const id = r.data.id;
  let ps = (await admin.get('/api/admin/pipelines')).data.pipelines;
  let p = ps.find((x) => x.id === id);
  assert.equal(p.stages.length, 6);
  assert.equal((await admin.patch(`/api/admin/pipelines/${id}`, { name: 'Testmärke 2' })).status, 200);
  // Stage names can differ per pipeline
  const ny = p.stages.find((s) => s.name === 'Ny');
  await admin.patch(`/api/admin/stages/${ny.id}`, { name: 'Inkommen' });
  const add = await admin.post(`/api/admin/pipelines/${id}/stages`, { name: 'Provkörning', outcome: 'open' });
  assert.equal(add.status, 200);
  ps = (await admin.get('/api/admin/pipelines')).data.pipelines;
  p = ps.find((x) => x.id === id);
  assert.deepEqual(p.stages.map((s) => s.name), ['Inkommen', 'Kontaktförsök', 'Kontakt etablerad', 'Provkörning', 'Såld / Avtal klart', 'Levererad', 'Förlorad / Ej aktuell']);
  const order = p.stages.map((s) => s.id);
  [order[0], order[1]] = [order[1], order[0]];
  await admin.patch(`/api/admin/pipelines/${id}`, { stage_order: order });
  p = (await admin.get('/api/admin/pipelines')).data.pipelines.find((x) => x.id === id);
  assert.equal(p.stages[0].name, 'Kontaktförsök');
  assert.equal(pipe('Hyrdon').stages[0].name, 'Ny', 'other pipelines unaffected');

  // Stage with an open lead cannot be archived; outcome of a used stage cannot change
  const lead = (await admin.post('/api/leads', { pipeline_id: id, name: 'Arkivtest' })).data.lead;
  assert.equal((await admin.patch(`/api/admin/stages/${lead.stage_id}`, { archived: true })).status, 400);
  assert.equal((await admin.patch(`/api/admin/stages/${lead.stage_id}`, { outcome: 'won' })).status, 400);
  // Last lost stage cannot be archived (losing needs a lost stage)
  const lostSt = p.stages.find((s) => s.outcome === 'lost');
  assert.equal((await admin.patch(`/api/admin/stages/${lostSt.id}`, { archived: true })).status, 400);
  // Archive an unused stage
  const prov = p.stages.find((s) => s.name === 'Provkörning');
  assert.equal((await admin.patch(`/api/admin/stages/${prov.id}`, { archived: true })).status, 200);
  // Archive the pipeline: hidden from meta/new leads, but the lead and its history remain
  assert.equal((await admin.patch(`/api/admin/pipelines/${id}`, { archived: true })).status, 200);
  const meta = (await johan.get('/api/meta')).data.pipelines;
  assert.ok(!meta.some((x) => x.id === id));
  assert.equal((await johan.post('/api/leads', { pipeline_id: id, name: 'X' })).status, 400);
  const d = (await johan.get(`/api/leads/${lead.id}`)).data;
  assert.equal(d.lead.pipeline_name, 'Testmärke 2');
  assert.ok(d.activities.length >= 1);
  await admin.patch(`/api/admin/pipelines/${id}`, { archived: false });
});
