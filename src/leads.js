// Core lead / contact / activity logic. Every permission check lives here (backend-enforced).
const { tx } = require('./db');
const { normalizePhone, normalizeEmail, normalizeReg } = require('../shared/phone');
const C = require('../shared/constants');
const T = require('../shared/time');

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

const nowIso = () => new Date().toISOString();
const isAdmin = (u) => u && u.role === 'admin';
const keys = (list) => list.map((x) => x.key);
const clean = (v, max = 5000) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

const LEAD_SELECT = `
SELECT l.*, c.name AS customer_name, c.phone, c.email, c.phone_norm, c.email_norm,
  p.name AS pipeline_name, s.name AS stage_name, s.outcome AS stage_outcome,
  u.name AS owner_name, u.active AS owner_active,
  (SELECT MAX(a.occurred_at) FROM activities a WHERE a.lead_id = l.id AND a.type IN ('note','call','email','followup_done')) AS last_activity_at,
  (SELECT a.type || ':' || COALESCE(a.direction,'') || '|' || a.occurred_at || '|' || a.origin FROM activities a
     WHERE a.lead_id = l.id AND a.type IN ('call','email') ORDER BY a.occurred_at DESC, a.id DESC LIMIT 1) AS last_corr
FROM leads l
JOIN contacts c ON c.id = l.contact_id
JOIN pipelines p ON p.id = l.pipeline_id
JOIN stages s ON s.id = l.stage_id
LEFT JOIN users u ON u.id = l.owner_id`;

// SQL fragment: lead's latest customer correspondence is an inbound email -> customer awaits our reply
const AWAITING_SQL = `(l.outcome = 'open' AND (SELECT a.type || ':' || COALESCE(a.direction,'') FROM activities a
  WHERE a.lead_id = l.id AND a.type IN ('call','email') ORDER BY a.occurred_at DESC, a.id DESC LIMIT 1) = 'email:in')`;

function decorate(row, now = new Date()) {
  if (!row) return row;
  const r = { ...row };
  const [corr, corrAt, corrOrigin] = (r.last_corr || '').split('|');
  r.awaiting_reply = r.outcome === 'open' && corr === 'email:in';
  r.awaiting_since = r.awaiting_reply ? corrAt : null;
  r.awaiting_origin = r.awaiting_reply ? corrOrigin : null;
  r.overdue = r.outcome === 'open' && !!r.next_action_due && r.next_action_due < now.toISOString();
  r.due_today = r.outcome === 'open' && !!r.next_action_due && !r.overdue && r.next_action_due < T.startOfTomorrow(now).toISOString();
  delete r.last_corr;
  return r;
}

function phoneSearchPatterns(q) {
  const d = String(q).replace(/\D/g, '');
  if (d.length < 3 || /[a-zA-ZåäöÅÄÖ@]/.test(q)) return [];
  const out = new Set([d]);
  if (d.startsWith('00')) out.add(d.slice(2));
  else if (d.startsWith('0')) out.add('46' + d.slice(1));
  return [...out].map((x) => `%${x}%`);
}

// Shared filter builder (board, lists, search)
function buildFilters(f, user, now = new Date()) {
  const where = [];
  const params = [];
  if (f.pipeline) { where.push('l.pipeline_id = ?'); params.push(Number(f.pipeline)); }
  if (f.owner === 'me') { where.push('l.owner_id = ?'); params.push(user.id); }
  else if (f.owner === 'none') where.push('l.owner_id IS NULL');
  else if (f.owner) { where.push('l.owner_id = ?'); params.push(Number(f.owner)); }
  if (f.source) { where.push('l.source = ?'); params.push(f.source); }
  if (f.outcome) { where.push('l.outcome = ?'); params.push(f.outcome); }
  if (f.overdue === '1' || f.overdue === true) {
    where.push("l.outcome = 'open' AND l.next_action_due IS NOT NULL AND l.next_action_due < ?");
    params.push(now.toISOString());
  }
  if (f.contact) { where.push('l.contact_id = ?'); params.push(Number(f.contact)); }
  const q = clean(f.q, 200);
  if (q) {
    const like = `%${q}%`;
    const ors = ['c.name LIKE ?', 'c.email LIKE ?', 'c.phone LIKE ?', 'l.vehicle LIKE ?', 'l.listing_id LIKE ?', 'l.enquiry LIKE ?'];
    params.push(like, like, like, like, like, like);
    const reg = normalizeReg(q);
    if (reg && reg.length >= 2) { ors.push('l.reg_norm LIKE ?'); params.push(`%${reg}%`); }
    for (const p of phoneSearchPatterns(q)) { ors.push('c.phone_norm LIKE ?'); params.push(p); }
    where.push(`(${ors.join(' OR ')})`);
  }
  return { where, params };
}

function listLeads(db, user, f = {}, opts = {}) {
  const { where, params } = buildFilters(f, user);
  if (opts.extraWhere) { where.push(opts.extraWhere); params.push(...(opts.extraParams || [])); }
  const sql = `${LEAD_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${opts.order || 'l.created_at DESC'} LIMIT ${Number(opts.limit) || 500}`;
  return db.prepare(sql).all(...params).map((r) => decorate(r));
}

function getLeadRow(db, id) {
  const row = db.prepare(`${LEAD_SELECT} WHERE l.id = ?`).get(Number(id));
  if (!row) throw new HttpError(404, 'Leaden finns inte.');
  return decorate(row);
}

function canEdit(user, lead) { return isAdmin(user) || (lead.owner_id != null && lead.owner_id === user.id); }
function requireEdit(user, lead) {
  if (!canEdit(user, lead)) {
    throw new HttpError(403, lead.owner_id ? `Endast ägaren (${lead.owner_name}) eller admin kan ändra denna lead.`
      : 'Ta leaden först för att kunna ändra den.');
  }
}

function addActivity(db, a) {
  const now = nowIso();
  const r = db.prepare(`INSERT INTO activities (lead_id, user_id, type, origin, direction, occurred_at, call_outcome, duration_sec,
    subject, body, due_at, from_stage_id, to_stage_id, from_user_id, to_user_id, lost_reason, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    a.lead_id, a.user_id ?? null, a.type, a.origin || 'system', a.direction ?? null, a.occurred_at || now,
    a.call_outcome ?? null, a.duration_sec ?? null, a.subject ?? null, a.body ?? null, a.due_at ?? null,
    a.from_stage_id ?? null, a.to_stage_id ?? null, a.from_user_id ?? null, a.to_user_id ?? null, a.lost_reason ?? null, now);
  return Number(r.lastInsertRowid);
}

function parseWhen(v, fallback) {
  if (!v) return fallback;
  if (/Z$|[+-]\d{2}:\d{2}$/.test(v)) { const d = new Date(v); return isNaN(d) ? fallback : d.toISOString(); }
  const d = T.parseLocal(v);
  if (!d) throw new HttpError(400, 'Ogiltigt datum.');
  return d.toISOString();
}

function activeStages(db, pipelineId) {
  return db.prepare('SELECT * FROM stages WHERE pipeline_id = ? AND archived_at IS NULL ORDER BY position, id').all(pipelineId);
}

// ---------- contacts ----------
function findMatches(db, { phone, email, exclude }) {
  const pn = normalizePhone(phone);
  const en = normalizeEmail(email);
  if (!pn && !en) return [];
  const conds = [];
  const params = [];
  if (pn) { conds.push('phone_norm = ?'); params.push(pn); }
  if (en) { conds.push('email_norm = ?'); params.push(en); }
  let sql = `SELECT * FROM contacts WHERE (${conds.join(' OR ')})`;
  if (exclude) { sql += ' AND id <> ?'; params.push(Number(exclude)); }
  return db.prepare(sql + ' ORDER BY id LIMIT 10').all(...params).map((c) => ({
    ...c,
    matched_on: [pn && c.phone_norm === pn ? 'phone' : null, en && c.email_norm === en ? 'email' : null].filter(Boolean),
    leads: db.prepare(`SELECT l.id, l.vehicle, l.outcome, l.created_at, p.name AS pipeline_name, s.name AS stage_name, u.name AS owner_name
      FROM leads l JOIN pipelines p ON p.id = l.pipeline_id JOIN stages s ON s.id = l.stage_id LEFT JOIN users u ON u.id = l.owner_id
      WHERE l.contact_id = ? ORDER BY l.created_at DESC`).all(c.id),
  }));
}

function contactFields(body) {
  const out = {};
  if ('name' in body) out.name = clean(body.name, 200);
  if ('phone' in body) { out.phone = clean(body.phone, 50); out.phone_norm = normalizePhone(out.phone); }
  if ('email' in body) { out.email = clean(body.email, 200); out.email_norm = normalizeEmail(out.email); }
  return out;
}

function getContact(db, id) {
  const c = db.prepare('SELECT * FROM contacts WHERE id = ?').get(Number(id));
  if (!c) throw new HttpError(404, 'Kunden finns inte.');
  return c;
}

function updateContact(db, user, id, body) {
  const c = getContact(db, id);
  if (!isAdmin(user)) {
    const owns = db.prepare('SELECT 1 FROM leads WHERE contact_id = ? AND owner_id = ? LIMIT 1').get(c.id, user.id);
    if (!owns) throw new HttpError(403, 'Du kan bara ändra kunder där du äger en lead.');
  }
  const f = contactFields(body);
  const merged = { ...c, ...f };
  if (!merged.name && !merged.phone && !merged.email) throw new HttpError(400, 'Kunden behöver namn, telefon eller e-post.');
  const cols = Object.keys(f);
  if (!cols.length) return c;
  db.prepare(`UPDATE contacts SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...cols.map((k) => f[k]), nowIso(), c.id);
  return getContact(db, c.id);
}

// ---------- leads ----------
const LEAD_TEXT_FIELDS = { vehicle: 300, enquiry: 5000, reg_number: 20, listing_id: 100, listing_url: 1000 };

function validateUrl(u) {
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) throw new HttpError(400, 'Annonslänken måste börja med http:// eller https://');
  return u;
}

function createLead(db, user, body) {
  return tx(db, () => {
    const pipeline = db.prepare('SELECT * FROM pipelines WHERE id = ? AND archived_at IS NULL').get(Number(body.pipeline_id));
    if (!pipeline) throw new HttpError(400, 'Välj en pipeline.');
    const stage = activeStages(db, pipeline.id).find((s) => s.outcome === 'open');
    if (!stage) throw new HttpError(400, 'Pipelinen saknar ett öppet steg.');
    const source = body.source || 'other';
    if (!keys(C.SOURCES).includes(source)) throw new HttpError(400, 'Okänd källa.');
    const now = nowIso();

    let contactId = body.contact_id ? getContact(db, body.contact_id).id : null;
    if (!contactId) {
      const cf = contactFields({ name: body.name, phone: body.phone, email: body.email });
      if (!cf.name && !cf.phone && !cf.email) throw new HttpError(400, 'Ange kundens namn, telefon eller e-post.');
      contactId = Number(db.prepare(`INSERT INTO contacts (name, phone, phone_norm, email, email_norm, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?)`).run(cf.name, cf.phone, cf.phone_norm, cf.email, cf.email_norm, now, now).lastInsertRowid);
    }
    const t = {};
    for (const [k, max] of Object.entries(LEAD_TEXT_FIELDS)) t[k] = clean(body[k], max);
    t.listing_url = validateUrl(t.listing_url);
    const nextAction = clean(body.next_action, 300);
    const nextDue = body.next_action_due ? parseWhen(body.next_action_due) : null;
    const id = Number(db.prepare(`INSERT INTO leads (contact_id, pipeline_id, stage_id, owner_id, source, vehicle, enquiry, reg_number, reg_norm,
      listing_id, listing_url, outcome, next_action, next_action_due, created_by, created_at, updated_at)
      VALUES (?,?,?,NULL,?,?,?,?,?,?,?, 'open', ?,?,?,?,?)`).run(
      contactId, pipeline.id, stage.id, source, t.vehicle, t.enquiry, t.reg_number, normalizeReg(t.reg_number), t.listing_id, t.listing_url,
      nextAction || (nextDue ? 'Följ upp' : null), nextDue, user.id, now, now).lastInsertRowid);
    addActivity(db, { lead_id: id, user_id: user.id, type: 'created', origin: 'system', to_stage_id: stage.id });
    if (body.claim) {
      db.prepare('UPDATE leads SET owner_id = ? WHERE id = ?').run(user.id, id);
      addActivity(db, { lead_id: id, user_id: user.id, type: 'owner_change', origin: 'system', from_user_id: null, to_user_id: user.id, body: 'claim' });
    }
    return getLeadRow(db, id);
  });
}

function updateLead(db, user, id, body) {
  return tx(db, () => {
    const lead = getLeadRow(db, id);
    requireEdit(user, lead);
    const sets = {};
    const changed = [];
    for (const [k, max] of Object.entries(LEAD_TEXT_FIELDS)) {
      if (k in body) { const v = clean(body[k], max); if (v !== lead[k]) { sets[k] = v; changed.push(k); } }
    }
    if ('listing_url' in sets) sets.listing_url = validateUrl(sets.listing_url);
    if ('reg_number' in sets) sets.reg_norm = normalizeReg(sets.reg_number);
    if ('source' in body && body.source !== lead.source) {
      if (!keys(C.SOURCES).includes(body.source)) throw new HttpError(400, 'Okänd källa.');
      sets.source = body.source; changed.push('source');
    }
    if (body.pipeline_id && Number(body.pipeline_id) !== lead.pipeline_id) {
      const p = db.prepare('SELECT * FROM pipelines WHERE id = ? AND archived_at IS NULL').get(Number(body.pipeline_id));
      if (!p) throw new HttpError(400, 'Okänd pipeline.');
      const st = activeStages(db, p.id).find((s) => s.outcome === lead.outcome) || activeStages(db, p.id).find((s) => s.outcome === 'open');
      if (!st || st.outcome !== lead.outcome) throw new HttpError(400, 'Målpipelinen saknar ett passande steg.');
      sets.pipeline_id = p.id; sets.stage_id = st.id; changed.push('pipeline');
      addActivity(db, { lead_id: lead.id, user_id: user.id, type: 'stage_change', origin: 'system', from_stage_id: lead.stage_id, to_stage_id: st.id,
        body: `Flyttad från ${lead.pipeline_name} till ${p.name}` });
    }
    const cf = contactFields(body);
    const contactChanged = Object.keys(cf).some((k) => !k.endsWith('_norm') && cf[k] !== lead[k === 'name' ? 'customer_name' : k]);
    if (contactChanged) {
      const c = getContact(db, lead.contact_id);
      const merged = { ...c, ...cf };
      if (!merged.name && !merged.phone && !merged.email) throw new HttpError(400, 'Kunden behöver namn, telefon eller e-post.');
      const cols = Object.keys(cf);
      db.prepare(`UPDATE contacts SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map((k) => cf[k]), nowIso(), c.id);
      changed.push('kunduppgifter');
    }
    const cols = Object.keys(sets);
    if (cols.length) {
      db.prepare(`UPDATE leads SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map((k) => sets[k]), nowIso(), lead.id);
    }
    if (changed.length) addActivity(db, { lead_id: lead.id, user_id: user.id, type: 'edit', origin: 'system', body: changed.join(', ') });
    return getLeadRow(db, lead.id);
  });
}

// Atomic claim: the conditional UPDATE only succeeds while owner_id IS NULL, so of any number of
// simultaneous attempts exactly one gets changes === 1. The rest learn who took it.
function claimLead(db, user, id) {
  return tx(db, () => {
    const r = db.prepare("UPDATE leads SET owner_id = ?, updated_at = ? WHERE id = ? AND owner_id IS NULL AND outcome = 'open'")
      .run(user.id, nowIso(), Number(id));
    if (r.changes !== 1) {
      const lead = getLeadRow(db, id);
      if (lead.owner_id === user.id) return { lead, already: true };
      if (lead.owner_id) throw new HttpError(409, `${lead.owner_name} tog redan denna lead.`, { owner_id: lead.owner_id, owner_name: lead.owner_name });
      throw new HttpError(409, 'Leaden är stängd och kan inte tas.');
    }
    addActivity(db, { lead_id: Number(id), user_id: user.id, type: 'owner_change', origin: 'system', from_user_id: null, to_user_id: user.id, body: 'claim' });
    return { lead: getLeadRow(db, id) };
  });
}

function releaseLead(db, user, id) {
  return tx(db, () => {
    const lead = getLeadRow(db, id);
    requireEdit(user, lead);
    if (!lead.owner_id) return lead;
    db.prepare('UPDATE leads SET owner_id = NULL, updated_at = ? WHERE id = ?').run(nowIso(), lead.id);
    addActivity(db, { lead_id: lead.id, user_id: user.id, type: 'owner_change', origin: 'system', from_user_id: lead.owner_id, to_user_id: null, body: 'release' });
    return getLeadRow(db, lead.id);
  });
}

function assignLead(db, user, id, ownerId) {
  if (!isAdmin(user)) throw new HttpError(403, 'Endast admin kan tilldela leads.');
  return tx(db, () => {
    const lead = getLeadRow(db, id);
    let target = null;
    if (ownerId) {
      target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(ownerId));
      if (!target || !target.active) throw new HttpError(400, 'Användaren finns inte eller är inaktiv.');
    }
    const to = target ? target.id : null;
    if (to === lead.owner_id) return lead;
    db.prepare('UPDATE leads SET owner_id = ?, updated_at = ? WHERE id = ?').run(to, nowIso(), lead.id);
    addActivity(db, { lead_id: lead.id, user_id: user.id, type: 'owner_change', origin: 'system', from_user_id: lead.owner_id, to_user_id: to, body: 'assign' });
    return getLeadRow(db, lead.id);
  });
}

function moveStage(db, user, id, body) {
  return tx(db, () => {
    const lead = getLeadRow(db, id);
    requireEdit(user, lead);
    const stage = db.prepare('SELECT * FROM stages WHERE id = ?').get(Number(body.stage_id));
    if (!stage || stage.pipeline_id !== lead.pipeline_id || stage.archived_at) throw new HttpError(400, 'Ogiltigt steg för denna pipeline.');
    if (stage.id === lead.stage_id && stage.outcome !== 'lost') return getLeadRow(db, lead.id);
    const now = nowIso();
    const s = { stage_id: stage.id, outcome: stage.outcome };
    if (stage.outcome === 'lost') {
      const reason = body.lost_reason;
      if (!keys(C.LOST_REASONS).includes(reason)) throw new HttpError(400, 'Välj en anledning till att leaden förlorades.');
      const note = clean(body.lost_note, 1000);
      if (reason === 'other' && !note) throw new HttpError(400, 'Beskriv anledningen när du väljer "Annat".');
      s.lost_reason = reason; s.lost_note = note;
      s.lost_at = lead.outcome === 'lost' ? lead.lost_at : now;
      s.won_at = null;
      s.next_action = null; s.next_action_due = null;
    } else {
      s.lost_reason = null; s.lost_note = null; s.lost_at = null;
      // A win is recorded once: moving between won stages (e.g. Såld -> Levererad) keeps the original won_at.
      s.won_at = stage.outcome === 'won' ? (lead.outcome === 'won' ? lead.won_at : now) : null;
    }
    const cols = Object.keys(s);
    db.prepare(`UPDATE leads SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map((k) => s[k]), now, lead.id);
    addActivity(db, { lead_id: lead.id, user_id: user.id, type: 'stage_change', origin: 'system', from_stage_id: lead.stage_id, to_stage_id: stage.id,
      lost_reason: s.lost_reason || null, body: s.lost_note || null });
    return getLeadRow(db, lead.id);
  });
}

function setNextAction(db, user, id, body) {
  return tx(db, () => {
    const lead = getLeadRow(db, id);
    requireEdit(user, lead);
    const text = clean(body.text, 300);
    const due = body.due ? parseWhen(body.due) : null;
    db.prepare('UPDATE leads SET next_action = ?, next_action_due = ?, updated_at = ? WHERE id = ?')
      .run(text || (due ? 'Följ upp' : null), text || due ? due : null, nowIso(), lead.id);
    return getLeadRow(db, lead.id);
  });
}

function completeNextAction(db, user, id, body) {
  return tx(db, () => {
    const lead = getLeadRow(db, id);
    requireEdit(user, lead);
    if (!lead.next_action) throw new HttpError(400, 'Det finns inget nästa steg att klarmarkera.');
    addActivity(db, { lead_id: lead.id, user_id: user.id, type: 'followup_done', origin: 'manual', body: lead.next_action,
      due_at: lead.next_action_due, subject: clean(body.result, 1000) });
    const text = clean(body.next_text, 300);
    const due = body.next_due ? parseWhen(body.next_due) : null;
    db.prepare('UPDATE leads SET next_action = ?, next_action_due = ?, updated_at = ? WHERE id = ?')
      .run(text || (due ? 'Följ upp' : null), text || due ? due : null, nowIso(), lead.id);
    return getLeadRow(db, lead.id);
  });
}

function logActivity(db, user, id, body) {
  return tx(db, () => {
    const lead = getLeadRow(db, id);
    const type = body.type;
    const now = nowIso();
    if (type === 'note') {
      const text = clean(body.body);
      if (!text) throw new HttpError(400, 'Skriv en anteckning.');
      addActivity(db, { lead_id: lead.id, user_id: user.id, type: 'note', origin: 'manual', body: text, occurred_at: now });
    } else if (type === 'call') {
      if (!['in', 'out'].includes(body.direction)) throw new HttpError(400, 'Välj in- eller utgående samtal.');
      if (!keys(C.CALL_OUTCOMES).includes(body.call_outcome)) throw new HttpError(400, 'Välj utfall för samtalet.');
      const mins = body.duration_min === '' || body.duration_min == null ? null : Number(body.duration_min);
      if (mins != null && (!isFinite(mins) || mins < 0 || mins > 600)) throw new HttpError(400, 'Ogiltig samtalslängd.');
      addActivity(db, { lead_id: lead.id, user_id: user.id, type: 'call', origin: 'manual', direction: body.direction,
        occurred_at: parseWhen(body.occurred_at, now), call_outcome: body.call_outcome, duration_sec: mins == null ? null : Math.round(mins * 60),
        body: clean(body.body) });
    } else if (type === 'email') {
      if (!['in', 'out'].includes(body.direction)) throw new HttpError(400, 'Välj in- eller utgående e-post.');
      const text = clean(body.body, 20000);
      if (!text && !clean(body.subject)) throw new HttpError(400, 'Ange ämne eller innehåll.');
      addActivity(db, { lead_id: lead.id, user_id: user.id, type: 'email', origin: 'manual', direction: body.direction,
        occurred_at: parseWhen(body.occurred_at, now), subject: clean(body.subject, 300), body: text });
    } else {
      throw new HttpError(400, 'Okänd aktivitetstyp.');
    }
    db.prepare('UPDATE leads SET updated_at = ? WHERE id = ?').run(now, lead.id);
    return getLeadDetail(db, user, lead.id);
  });
}

function getLeadDetail(db, user, id) {
  const lead = getLeadRow(db, id);
  const activities = db.prepare(`SELECT a.*, u.name AS user_name, u.active AS user_active,
      fs.name AS from_stage_name, ts.name AS to_stage_name, fu.name AS from_user_name, tu.name AS to_user_name
    FROM activities a LEFT JOIN users u ON u.id = a.user_id
    LEFT JOIN stages fs ON fs.id = a.from_stage_id LEFT JOIN stages ts ON ts.id = a.to_stage_id
    LEFT JOIN users fu ON fu.id = a.from_user_id LEFT JOIN users tu ON tu.id = a.to_user_id
    WHERE a.lead_id = ? ORDER BY a.occurred_at DESC, a.id DESC`).all(lead.id).map((a) => ({ ...a }));
  const otherLeads = listLeads(db, user, { contact: lead.contact_id }).filter((l) => l.id !== lead.id);
  const stages = activeStages(db, lead.pipeline_id).map((s) => ({ ...s }));
  if (!stages.find((s) => s.id === lead.stage_id)) {
    stages.push({ ...db.prepare('SELECT * FROM stages WHERE id = ?').get(lead.stage_id) });
  }
  const contact = { ...getContact(db, lead.contact_id) };
  const duplicates = findMatches(db, { phone: contact.phone, email: contact.email, exclude: contact.id });
  return { lead, contact, activities, otherLeads, stages, duplicates, can: { edit: canEdit(user, lead), assign: isAdmin(user), claim: !lead.owner_id && lead.outcome === 'open' } };
}

function myDay(db, user) {
  const now = new Date();
  const nowS = now.toISOString();
  const tomorrow = T.startOfTomorrow(now).toISOString();
  const unassigned = listLeads(db, user, { owner: 'none', outcome: 'open' }, { order: 'l.created_at ASC', limit: 200 });
  const mine = { owner: 'me', outcome: 'open' };
  const overdue = listLeads(db, user, mine, { extraWhere: 'l.next_action_due IS NOT NULL AND l.next_action_due < ?', extraParams: [nowS], order: 'l.next_action_due ASC' });
  const today = listLeads(db, user, mine, { extraWhere: 'l.next_action_due >= ? AND l.next_action_due < ?', extraParams: [nowS, tomorrow], order: 'l.next_action_due ASC' });
  const noNext = listLeads(db, user, mine, { extraWhere: "(l.next_action IS NULL OR l.next_action = '')", order: 'l.created_at ASC' });
  const awaiting = listLeads(db, user, mine, { extraWhere: AWAITING_SQL, order: 'l.updated_at ASC' });
  const openCount = db.prepare("SELECT COUNT(*) n FROM leads WHERE owner_id = ? AND outcome = 'open'").get(user.id).n;
  return { unassigned, overdue, today, noNext, awaiting, openCount };
}

function search(db, user, q) {
  if (!clean(q)) return { leads: [] };
  return { leads: listLeads(db, user, { q }, { limit: 30, order: "CASE l.outcome WHEN 'open' THEN 0 ELSE 1 END, l.created_at DESC" }) };
}

function board(db, user, f) {
  const pipeline = db.prepare('SELECT * FROM pipelines WHERE id = ?').get(Number(f.pipeline));
  if (!pipeline) throw new HttpError(404, 'Pipelinen finns inte.');
  const stages = activeStages(db, pipeline.id).map((s) => ({ ...s }));
  const leads = listLeads(db, user, { ...f, pipeline: pipeline.id }, { limit: 2000, order: 'l.created_at DESC' });
  const CLOSED_LIMIT = 30;
  const cols = stages.map((s) => {
    const all = leads.filter((l) => l.stage_id === s.id);
    const shown = s.outcome === 'open' ? all : all.slice(0, CLOSED_LIMIT);
    return { ...s, total: all.length, leads: shown };
  });
  return { pipeline: { ...pipeline }, stages: cols };
}

module.exports = {
  HttpError, LEAD_SELECT, AWAITING_SQL, decorate, buildFilters, listLeads, getLeadRow, getLeadDetail, canEdit,
  createLead, updateLead, claimLead, releaseLead, assignLead, moveStage, setNextAction, completeNextAction, logActivity,
  findMatches, getContact, updateContact, myDay, search, board, addActivity, isAdmin, activeStages, clean,
};
