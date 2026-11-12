// Director dashboard. Every headline number is produced by a named metric whose WHERE clause is also
// used by the drill-down list, so a count and the list behind it can never disagree.
const T = require('../shared/time');
const C = require('../shared/constants');
const { LEAD_SELECT, AWAITING_SQL, decorate, HttpError } = require('./leads');

function parseFilters(q, now = new Date()) {
  const today = T.todayStr(now);
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const to = re.test(q.to || '') ? q.to : today;
  const from = re.test(q.from || '') ? q.from : T.addDaysStr(to, -29);
  if (from > to) throw new HttpError(400, 'Från-datum måste vara före till-datum.');
  const start = T.dayStart(from).toISOString();
  const end = T.dayStart(T.addDaysStr(to, 1)).toISOString();
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 86400000);
  const prevStart = T.dayStart(T.addDaysStr(from, -days)).toISOString();
  return {
    from, to, start, end, prevStart,
    pipeline: q.pipeline ? Number(q.pipeline) : null,
    owner: q.owner === 'none' ? 'none' : q.owner ? Number(q.owner) : null,
    source: q.source || null,
    stage: q.stage ? Number(q.stage) : null,
    stage_name: q.stage_name || null,
    reason: q.reason || null,
    now: now.toISOString(),
    tomorrow: T.startOfTomorrow(now).toISOString(),
  };
}

const NOT_SPAM = "NOT (l.outcome = 'lost' AND l.lost_reason = 'duplicate')";
const FIRST_OUT = `(SELECT MIN(a.occurred_at) FROM activities a WHERE a.lead_id = l.id AND a.type IN ('call','email') AND a.direction = 'out' AND a.origin <> 'system')`;

const METRICS = {
  new: { label: 'Nya leads', w: (f) => [['l.created_at >= ? AND l.created_at < ?', f.start, f.end]] },
  unassigned: { label: 'Ej tilldelade (öppna)', ignoreOwner: true, w: () => [["l.outcome = 'open' AND l.owner_id IS NULL"]] },
  open: { label: 'Öppna leads', w: () => [["l.outcome = 'open'"]] },
  due_today: { label: 'Uppföljning idag', w: (f) => [["l.outcome = 'open' AND l.next_action_due >= ? AND l.next_action_due < ?", f.now, f.tomorrow]] },
  overdue: { label: 'Försenade uppföljningar', w: (f) => [["l.outcome = 'open' AND l.next_action_due IS NOT NULL AND l.next_action_due < ?", f.now]] },
  no_next: { label: 'Tilldelade öppna utan nästa steg', w: () => [["l.outcome = 'open' AND l.owner_id IS NOT NULL AND (l.next_action IS NULL OR l.next_action = '')"]] },
  awaiting: { label: 'Kund väntar på svar', w: () => [[AWAITING_SQL]] },
  won: { label: 'Vunna under perioden', w: (f) => [["l.outcome = 'won' AND l.won_at >= ? AND l.won_at < ?", f.start, f.end]] },
  lost: { label: 'Förlorade under perioden (exkl. dubblett/spam)', w: (f) => [["l.outcome = 'lost' AND l.lost_reason <> 'duplicate' AND l.lost_at >= ? AND l.lost_at < ?", f.start, f.end]] },
  spam: { label: 'Dubblett / spam under perioden', w: (f) => [["l.outcome = 'lost' AND l.lost_reason = 'duplicate' AND l.lost_at >= ? AND l.lost_at < ?", f.start, f.end]] },
  cohort: { label: 'Leads skapade under perioden (exkl. dubblett/spam)', w: (f) => [['l.created_at >= ? AND l.created_at < ?', f.start, f.end], [NOT_SPAM]] },
  cohort_won: { label: 'Skapade under perioden – vunna', w: (f) => [...METRICS.cohort.w(f), ["l.outcome = 'won'"]] },
  cohort_lost: { label: 'Skapade under perioden – förlorade', w: (f) => [...METRICS.cohort.w(f), ["l.outcome = 'lost'"]] },
  cohort_open: { label: 'Skapade under perioden – fortfarande öppna', w: (f) => [...METRICS.cohort.w(f), ["l.outcome = 'open'"]] },
  no_contact: { label: 'Skapade under perioden utan registrerat kontaktförsök', w: (f) => [...METRICS.cohort.w(f), [`${FIRST_OUT} IS NULL`]] },
};

function metricWhere(metric, f) {
  const m = METRICS[metric];
  if (!m) throw new HttpError(400, 'Okänt mått.');
  const where = [];
  const params = [];
  const add = ([sql, ...p]) => { where.push(sql); params.push(...p); };
  m.w(f).forEach(add);
  if (f.pipeline) add(['l.pipeline_id = ?', f.pipeline]);
  if (f.source) add(['l.source = ?', f.source]);
  if (!m.ignoreOwner) {
    if (f.owner === 'none') add(['l.owner_id IS NULL']);
    else if (f.owner) add(['l.owner_id = ?', f.owner]);
  }
  if (f.stage) add(['l.stage_id = ?', f.stage]);
  if (f.stage_name) add(['s.name = ?', f.stage_name]);
  if (f.reason) add(['l.lost_reason = ?', f.reason]);
  return { where, params, label: m.label };
}

function metricLeads(db, metric, f) {
  const { where, params, label } = metricWhere(metric, f);
  const rows = db.prepare(`${LEAD_SELECT} WHERE ${where.join(' AND ')} ORDER BY l.created_at DESC`).all(...params).map((r) => decorate(r));
  return { label, leads: rows };
}

function countMetric(db, metric, f) {
  const { where, params } = metricWhere(metric, f);
  return db.prepare(`SELECT COUNT(*) n FROM leads l JOIN stages s ON s.id = l.stage_id WHERE ${where.join(' AND ')}`).get(...params).n;
}

function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function dashboard(db, query) {
  const f = parseFilters(query);
  const counts = {};
  for (const k of Object.keys(METRICS)) counts[k] = countMetric(db, k, f);

  // Oldest unassigned
  const un = metricWhere('unassigned', f);
  const oldestUnassigned = db.prepare(`SELECT l.id, l.created_at, c.name AS customer_name, l.vehicle, p.name AS pipeline_name
    FROM leads l JOIN contacts c ON c.id = l.contact_id JOIN pipelines p ON p.id = l.pipeline_id JOIN stages s ON s.id = l.stage_id
    WHERE ${un.where.join(' AND ')} ORDER BY l.created_at ASC LIMIT 1`).get(...un.params) || null;

  const users = db.prepare('SELECT id, name, role, active FROM users ORDER BY name').all().map((u) => ({ ...u }));
  const userName = (id) => (id == null ? 'Ej tilldelad' : (users.find((u) => u.id === id) || {}).name || `#${id}`);

  // Open leads by salesperson x stage (snapshot)
  const op = metricWhere('open', f);
  const openRows = db.prepare(`SELECT l.owner_id, s.name AS stage_name, MIN(s.position) AS pos, COUNT(*) n,
      SUM(CASE WHEN l.next_action_due < ? THEN 1 ELSE 0 END) AS overdue,
      SUM(CASE WHEN l.next_action_due >= ? AND l.next_action_due < ? THEN 1 ELSE 0 END) AS due_today,
      SUM(CASE WHEN l.owner_id IS NOT NULL AND (l.next_action IS NULL OR l.next_action = '') THEN 1 ELSE 0 END) AS no_next
    FROM leads l JOIN stages s ON s.id = l.stage_id WHERE ${op.where.join(' AND ')} GROUP BY l.owner_id, s.name`).all(f.now, f.now, f.tomorrow, ...op.params);
  const stageNames = [...new Map(openRows.sort((a, b) => a.pos - b.pos).map((r) => [r.stage_name, r.pos])).keys()];
  const byOwner = new Map();
  for (const r of openRows) {
    const k = r.owner_id ?? 'none';
    if (!byOwner.has(k)) byOwner.set(k, { owner_id: r.owner_id, name: userName(r.owner_id), stages: {}, total: 0, overdue: 0, due_today: 0, no_next: 0 });
    const o = byOwner.get(k);
    o.stages[r.stage_name] = (o.stages[r.stage_name] || 0) + r.n;
    o.total += r.n; o.overdue += r.overdue; o.due_today += r.due_today; o.no_next += r.no_next;
  }
  const openByOwner = [...byOwner.values()].sort((a, b) => (a.owner_id == null) - (b.owner_id == null) || a.name.localeCompare(b.name, 'sv'));

  // Cohort: leads created in period (excl. duplicate/spam), including still-open ones
  const co = metricWhere('cohort', f);
  const cohort = db.prepare(`SELECT l.id, l.source, l.owner_id, l.outcome, l.created_at, ${FIRST_OUT} AS first_out,
      (SELECT a.user_id FROM activities a WHERE a.lead_id = l.id AND a.type IN ('call','email') AND a.direction = 'out' AND a.origin <> 'system'
        ORDER BY a.occurred_at, a.id LIMIT 1) AS first_out_user
    FROM leads l JOIN stages s ON s.id = l.stage_id WHERE ${co.where.join(' AND ')}`).all(...co.params);
  const conv = (rows, keyFn, labelFn) => {
    const m = new Map();
    for (const r of rows) {
      const k = keyFn(r);
      if (!m.has(k)) m.set(k, { key: k, label: labelFn(k), total: 0, won: 0, lost: 0, open: 0 });
      const x = m.get(k);
      x.total++; x[r.outcome]++;
    }
    return [...m.values()].map((x) => ({ ...x, conversion: x.total ? x.won / x.total : null, win_rate: x.won + x.lost ? x.won / (x.won + x.lost) : null }))
      .sort((a, b) => b.total - a.total);
  };
  const bySource = conv(cohort, (r) => r.source, (k) => C.label(C.SOURCES, k));
  const bySeller = conv(cohort, (r) => r.owner_id ?? 'none', (k) => userName(k === 'none' ? null : k));

  // Time to first recorded human contact attempt (outgoing call or email; notes and ownership changes do not count)
  const mins = [];
  const perUser = new Map();
  for (const r of cohort) {
    if (!r.first_out) continue;
    const m = Math.max(0, (Date.parse(r.first_out) - Date.parse(r.created_at)) / 60000);
    mins.push(m);
    if (!perUser.has(r.first_out_user)) perUser.set(r.first_out_user, []);
    perUser.get(r.first_out_user).push(m);
  }
  const firstContact = {
    leads: cohort.length,
    with_attempt: mins.length,
    without_attempt: cohort.length - mins.length,
    median_min: median(mins),
    avg_min: mins.length ? mins.reduce((a, b) => a + b, 0) / mins.length : null,
    within_1h: mins.filter((m) => m <= 60).length,
    by_user: [...perUser.entries()].map(([uid, arr]) => ({ user_id: uid, name: userName(uid), count: arr.length, median_min: median(arr) }))
      .sort((a, b) => a.median_min - b.median_min),
  };

  // Manually recorded activity in period (calls and outgoing emails reported separately)
  const aw = ['a.occurred_at >= ? AND a.occurred_at < ?', "a.type IN ('call','email')", "a.origin <> 'system'"];
  const ap = [f.start, f.end];
  if (f.pipeline) { aw.push('l.pipeline_id = ?'); ap.push(f.pipeline); }
  if (f.source) { aw.push('l.source = ?'); ap.push(f.source); }
  if (f.owner && f.owner !== 'none') { aw.push('a.user_id = ?'); ap.push(f.owner); }
  const actRows = db.prepare(`SELECT a.user_id, a.type, a.direction, a.origin, COUNT(*) n FROM activities a JOIN leads l ON l.id = a.lead_id
    WHERE ${aw.join(' AND ')} GROUP BY a.user_id, a.type, a.direction, a.origin`).all(...ap);
  const act = new Map();
  const totals = { calls_out: 0, calls_in: 0, emails_out: 0, emails_in: 0, sample: 0 };
  for (const r of actRows) {
    const k = r.user_id ?? 'none';
    if (!act.has(k)) act.set(k, { user_id: r.user_id, name: r.user_id == null ? 'Kund / okänd' : userName(r.user_id), calls_out: 0, calls_in: 0, emails_out: 0, emails_in: 0 });
    const key = `${r.type === 'call' ? 'calls' : 'emails'}_${r.direction}`;
    act.get(k)[key] += r.n;
    totals[key] += r.n;
    if (r.origin === 'sample') totals.sample += r.n;
  }
  const activity = { totals, by_user: [...act.values()].filter((x) => x.user_id != null).sort((a, b) => (b.calls_out + b.emails_out) - (a.calls_out + a.emails_out)) };

  // Lost reasons, this period vs previous equal-length period
  const lw = ["l.outcome = 'lost'"];
  const lp = [];
  if (f.pipeline) { lw.push('l.pipeline_id = ?'); lp.push(f.pipeline); }
  if (f.source) { lw.push('l.source = ?'); lp.push(f.source); }
  if (f.owner === 'none') lw.push('l.owner_id IS NULL'); else if (f.owner) { lw.push('l.owner_id = ?'); lp.push(f.owner); }
  const lostCur = db.prepare(`SELECT lost_reason, COUNT(*) n FROM leads l WHERE ${lw.join(' AND ')} AND l.lost_at >= ? AND l.lost_at < ? GROUP BY lost_reason`).all(...lp, f.start, f.end);
  const lostPrev = db.prepare(`SELECT lost_reason, COUNT(*) n FROM leads l WHERE ${lw.join(' AND ')} AND l.lost_at >= ? AND l.lost_at < ? GROUP BY lost_reason`).all(...lp, f.prevStart, f.start);
  const lostReasons = C.LOST_REASONS.map((r) => ({
    key: r.key, label: r.label,
    current: (lostCur.find((x) => x.lost_reason === r.key) || {}).n || 0,
    previous: (lostPrev.find((x) => x.lost_reason === r.key) || {}).n || 0,
  }));

  const cohortTotals = { total: counts.cohort, won: counts.cohort_won, lost: counts.cohort_lost, open: counts.cohort_open };
  cohortTotals.conversion = cohortTotals.total ? cohortTotals.won / cohortTotals.total : null;

  return {
    filters: { from: f.from, to: f.to, pipeline: f.pipeline, owner: f.owner, source: f.source, prev_from: T.dateStr(f.prevStart), prev_to: T.addDaysStr(f.from, -1) },
    counts, oldestUnassigned, stageNames, openByOwner, bySource, bySeller, firstContact, activity, lostReasons, cohort: cohortTotals,
  };
}

module.exports = { dashboard, metricLeads, parseFilters, METRICS, countMetric };
