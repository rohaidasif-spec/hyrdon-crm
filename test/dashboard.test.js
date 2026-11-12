// Dashboard numbers checked against a small, fully controlled data set.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, loggedIn } = require('./helpers');

let app; let admin; let johan; let sara; let P; let st;
const FROM = '2026-10-01';
const TO = '2026-10-31';
const q = (extra = '') => `/api/reports/dashboard?from=${FROM}&to=${TO}${extra}`;

test.before(async () => {
  app = await startApp();
  // Keep users and pipelines from the seed, remove all demo leads.
  app.db.exec('DELETE FROM activities; DELETE FROM leads; DELETE FROM contacts;');
  admin = await loggedIn(app.base, 'karin@demo.local');
  johan = await loggedIn(app.base, 'johan@demo.local');
  sara = await loggedIn(app.base, 'sara@demo.local');
  P = (await admin.get('/api/meta')).data.pipelines.find((p) => p.name === 'Hyrdon');
  st = Object.fromEntries(P.stages.map((s) => [s.name, s.id]));
});
test.after(() => app.close());

function setTimes(id, fields) {
  const cols = Object.keys(fields);
  app.db.prepare(`UPDATE leads SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => fields[c]), id);
}
async function lead(c, body, createdAt) {
  const r = await c.post('/api/leads', { pipeline_id: P.id, ...body });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const id = r.data.lead.id;
  setTimes(id, { created_at: createdAt });
  app.db.prepare("UPDATE activities SET occurred_at = ? WHERE lead_id = ? AND type IN ('created','owner_change')").run(createdAt, id);
  return id;
}

test('period events vs created-in-period conversion, spam exclusion, first contact, activity counts', async () => {
  // A: created in period (web), claimed by Johan, first outbound call 30 min later, won in period
  const A = await lead(johan, { name: 'A', source: 'website', claim: true }, '2026-10-05T08:00:00.000Z');
  await johan.post(`/api/leads/${A}/activities`, { type: 'note', body: 'note does not count', occurred_at: '2026-10-05T08:05:00.000Z' });
  await johan.post(`/api/leads/${A}/activities`, { type: 'call', direction: 'in', call_outcome: 'answered', occurred_at: '2026-10-05T08:10:00.000Z' });
  await johan.post(`/api/leads/${A}/activities`, { type: 'call', direction: 'out', call_outcome: 'no_answer', occurred_at: '2026-10-05T08:30:00.000Z' });
  await johan.post(`/api/leads/${A}/activities`, { type: 'email', direction: 'out', subject: 'Offert', occurred_at: '2026-10-05T09:00:00.000Z' });
  await johan.post(`/api/leads/${A}/stage`, { stage_id: st['Såld / Avtal klart'] });
  setTimes(A, { won_at: '2026-10-10T10:00:00.000Z' });
  await johan.post(`/api/leads/${A}/stage`, { stage_id: st['Levererad'] }); // must not count again

  // B: created BEFORE period, won IN period -> counts in "won" but not in cohort
  const B = await lead(johan, { name: 'B', source: 'blocket', claim: true }, '2026-09-10T08:00:00.000Z');
  await johan.post(`/api/leads/${B}/stage`, { stage_id: st['Såld / Avtal klart'] });
  setTimes(B, { won_at: '2026-10-02T10:00:00.000Z' });

  // C: created in period (blocket), Sara, lost (price) in period, first outbound email after 90 min
  const C = await lead(sara, { name: 'C', source: 'blocket', claim: true }, '2026-10-06T08:00:00.000Z');
  await sara.post(`/api/leads/${C}/activities`, { type: 'email', direction: 'out', subject: 'Hej', occurred_at: '2026-10-06T09:30:00.000Z' });
  await sara.post(`/api/leads/${C}/stage`, { stage_id: st['Förlorad / Ej aktuell'], lost_reason: 'price' });
  setTimes(C, { lost_at: '2026-10-08T10:00:00.000Z' });

  // D: created in period, duplicate/spam -> excluded from cohort/conversion and from "lost"
  const D = await lead(sara, { name: 'D', source: 'blocket', claim: true }, '2026-10-07T08:00:00.000Z');
  await sara.post(`/api/leads/${D}/stage`, { stage_id: st['Förlorad / Ej aktuell'], lost_reason: 'duplicate' });
  setTimes(D, { lost_at: '2026-10-07T09:00:00.000Z' });

  // E: created in period, still open, unassigned, no contact attempt
  const E = await lead(admin, { name: 'E', source: 'website' }, '2026-10-20T08:00:00.000Z');

  // F: created 2026-10-31 23:30 UTC = 1 Nov 00:30 Stockholm -> OUTSIDE the October period
  const F = await lead(admin, { name: 'F', source: 'phone' }, '2026-10-31T23:30:00.000Z');
  // G: created 2026-09-30 22:30 UTC = 1 Oct 00:30 Stockholm -> INSIDE the period
  const G = await lead(johan, { name: 'G', source: 'phone', claim: true }, '2026-09-30T22:30:00.000Z');
  await johan.put(`/api/leads/${G}/next-action`, { text: 'Ring', due: new Date(Date.now() - 3600000).toISOString() }); // overdue

  const d = (await admin.get(q())).data;
  const c = d.counts;
  assert.equal(c.new, 5, 'A, C, D, E, G created in Stockholm-October');
  assert.equal(c.won, 2, 'A and B won during the period (Levererad does not add)');
  assert.equal(c.lost, 1, 'C lost; duplicate excluded');
  assert.equal(c.spam, 1);
  assert.equal(c.cohort, 4, 'A, C, E, G (D is spam)');
  assert.equal(c.cohort_won, 1);
  assert.equal(c.cohort_lost, 1);
  assert.equal(c.cohort_open, 2, 'includes still-open leads');
  assert.equal(d.cohort.conversion, 0.25);
  assert.equal(c.unassigned, 2, 'E and F (snapshot, ignores the period)');
  assert.equal(d.oldestUnassigned.id, E);
  assert.equal(c.overdue, 1);
  assert.equal(c.no_next, 0, 'G has a next action; A/B/C/D are closed; E/F unassigned');

  // Conversion by source (cohort)
  const src = Object.fromEntries(d.bySource.map((r) => [r.key, r]));
  assert.deepEqual([src.website.total, src.website.won, src.website.open], [2, 1, 1]);
  assert.equal(src.website.conversion, 0.5);
  assert.deepEqual([src.blocket.total, src.blocket.lost, src.blocket.won], [1, 1, 0], 'duplicate D excluded');
  assert.equal(src.phone.total, 1, 'G only; F is outside the period');
  // Conversion by salesperson
  const bySeller = Object.fromEntries(d.bySeller.map((r) => [String(r.key), r]));
  assert.equal(bySeller[String(johan.user.id)].total, 2);
  assert.equal(bySeller[String(johan.user.id)].won, 1);
  assert.equal(bySeller[String(sara.user.id)].total, 1);

  // Time to first recorded human contact attempt: A=30 min (note/incoming call/claim ignored), C=90 min
  assert.equal(d.firstContact.with_attempt, 2);
  assert.equal(d.firstContact.without_attempt, 2, 'E and G');
  assert.equal(d.firstContact.median_min, 60);
  assert.equal(d.firstContact.within_1h, 1);

  // Activity: calls and outgoing emails reported separately; notes are not outreach
  assert.equal(d.activity.totals.calls_out, 1);
  assert.equal(d.activity.totals.calls_in, 1);
  assert.equal(d.activity.totals.emails_out, 2);

  // Lost reasons
  const lr = Object.fromEntries(d.lostReasons.map((r) => [r.key, r.current]));
  assert.equal(lr.price, 1);
  assert.equal(lr.duplicate, 1);

  // Headline counts open exactly the matching leads
  for (const [metric, n] of Object.entries(c)) {
    const list = (await admin.get(`/api/reports/leads?metric=${metric}&from=${FROM}&to=${TO}`)).data;
    assert.equal(list.leads.length, n, `drill-down for ${metric}`);
  }
  const wonIds = (await admin.get(`/api/reports/leads?metric=won&from=${FROM}&to=${TO}`)).data.leads.map((l) => l.id).sort();
  assert.deepEqual(wonIds, [A, B].sort());

  // Filters: salesperson, source, pipeline
  const dj = (await admin.get(q(`&owner=${johan.user.id}`))).data.counts;
  assert.equal(dj.new, 2);
  assert.equal(dj.won, 2);
  assert.equal((await admin.get(q('&source=blocket'))).data.counts.new, 2);
  const other = (await admin.get('/api/meta')).data.pipelines.find((p) => p.name === 'Premium Motors');
  assert.equal((await admin.get(q(`&pipeline=${other.id}`))).data.counts.new, 0);
  // Moving the November-boundary: F is inside 1 Nov
  assert.equal((await admin.get('/api/reports/dashboard?from=2026-11-01&to=2026-11-01')).data.counts.new, 1);
  assert.ok(F);
});

test('notes and ownership changes do not count as customer outreach', async () => {
  const id = await lead(johan, { name: 'Only notes', claim: true }, '2026-10-15T08:00:00.000Z');
  await johan.post(`/api/leads/${id}/activities`, { type: 'note', body: 'x', occurred_at: '2026-10-15T08:01:00.000Z' });
  await admin.post(`/api/leads/${id}/assign`, { owner_id: sara.user.id });
  const list = (await admin.get(`/api/reports/leads?metric=no_contact&from=${FROM}&to=${TO}`)).data.leads;
  assert.ok(list.some((l) => l.id === id));
});
