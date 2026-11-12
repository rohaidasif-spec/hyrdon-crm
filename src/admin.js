// Admin-only operations: users and pipelines. Every function asserts the admin role itself.
const { tx } = require('./db');
const { hashPassword } = require('./auth');
const { HttpError, isAdmin, clean } = require('./leads');
const C = require('../shared/constants');

const nowIso = () => new Date().toISOString();
function requireAdmin(user) { if (!isAdmin(user)) throw new HttpError(403, 'Endast för Direktör / Admin.'); }

function listUsers(db) {
  return db.prepare(`SELECT u.id, u.name, u.email, u.role, u.active, u.is_demo, u.created_at, u.deactivated_at,
    (SELECT COUNT(*) FROM leads l WHERE l.owner_id = u.id AND l.outcome = 'open') AS open_leads
    FROM users u ORDER BY u.active DESC, u.role, u.name`).all().map((r) => ({ ...r }));
}

function createUser(db, user, body) {
  requireAdmin(user);
  const name = clean(body.name, 100);
  const email = clean(body.email, 200);
  const password = String(body.password || '');
  if (!name || !email) throw new HttpError(400, 'Ange namn och e-post.');
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new HttpError(400, 'Ogiltig e-postadress.');
  if (password.length < 6) throw new HttpError(400, 'Lösenordet måste vara minst 6 tecken.');
  if (!['admin', 'sales'].includes(body.role)) throw new HttpError(400, 'Välj roll.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'E-postadressen används redan.');
  const id = db.prepare('INSERT INTO users (name, email, password_hash, role, active, created_at) VALUES (?,?,?,?,1,?)')
    .run(name, email, hashPassword(password), body.role, nowIso()).lastInsertRowid;
  return { id: Number(id) };
}

function updateUser(db, user, id, body) {
  requireAdmin(user);
  return tx(db, () => {
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
    if (!target) throw new HttpError(404, 'Användaren finns inte.');
    const sets = {};
    if ('name' in body) { const n = clean(body.name, 100); if (!n) throw new HttpError(400, 'Ange namn.'); sets.name = n; }
    if ('role' in body) {
      if (!['admin', 'sales'].includes(body.role)) throw new HttpError(400, 'Okänd roll.');
      if (target.id === user.id && body.role !== 'admin') throw new HttpError(400, 'Du kan inte ta bort din egen admin-roll.');
      sets.role = body.role;
    }
    if ('password' in body && body.password) {
      if (String(body.password).length < 6) throw new HttpError(400, 'Lösenordet måste vara minst 6 tecken.');
      sets.password_hash = hashPassword(body.password);
    }
    if ('active' in body) {
      const active = body.active ? 1 : 0;
      if (target.id === user.id && !active) throw new HttpError(400, 'Du kan inte inaktivera dig själv.');
      sets.active = active;
      sets.deactivated_at = active ? null : nowIso();
      if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    }
    const cols = Object.keys(sets);
    if (cols.length) db.prepare(`UPDATE users SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((k) => sets[k]), target.id);
    return { ok: true };
  });
}

function listPipelines(db, { includeArchived = false } = {}) {
  const ps = db.prepare(`SELECT * FROM pipelines ${includeArchived ? '' : 'WHERE archived_at IS NULL'} ORDER BY archived_at IS NOT NULL, position, id`).all();
  return ps.map((p) => ({
    ...p,
    stages: db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM leads l WHERE l.stage_id = s.id) AS lead_count FROM stages s
      WHERE s.pipeline_id = ? ${includeArchived ? '' : 'AND s.archived_at IS NULL'} ORDER BY s.archived_at IS NOT NULL, s.position, s.id`).all(p.id).map((s) => ({ ...s })),
    open_leads: db.prepare("SELECT COUNT(*) n FROM leads WHERE pipeline_id = ? AND outcome = 'open'").get(p.id).n,
  }));
}

function createPipeline(db, user, body) {
  requireAdmin(user);
  const name = clean(body.name, 100);
  if (!name) throw new HttpError(400, 'Ange ett namn.');
  return tx(db, () => {
    const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM pipelines').get().p;
    const id = Number(db.prepare('INSERT INTO pipelines (name, description, position, created_at) VALUES (?,?,?,?)')
      .run(name, clean(body.description, 300), pos, nowIso()).lastInsertRowid);
    const ins = db.prepare('INSERT INTO stages (pipeline_id, name, outcome, position) VALUES (?,?,?,?)');
    C.DEFAULT_STAGES.forEach((s, i) => ins.run(id, s.name, s.outcome, i + 1));
    return { id };
  });
}

function checkOutcomeCoverage(db, pipelineId) {
  const rows = db.prepare('SELECT outcome, COUNT(*) n FROM stages WHERE pipeline_id = ? AND archived_at IS NULL GROUP BY outcome').all(pipelineId);
  const have = Object.fromEntries(rows.map((r) => [r.outcome, r.n]));
  for (const o of ['open', 'won', 'lost']) {
    if (!have[o]) throw new HttpError(400, `Pipelinen måste ha minst ett aktivt steg med utfallet "${C.label(C.OUTCOMES, o)}".`);
  }
}

function updatePipeline(db, user, id, body) {
  requireAdmin(user);
  return tx(db, () => {
    const p = db.prepare('SELECT * FROM pipelines WHERE id = ?').get(Number(id));
    if (!p) throw new HttpError(404, 'Pipelinen finns inte.');
    if ('name' in body) { const n = clean(body.name, 100); if (!n) throw new HttpError(400, 'Ange ett namn.'); db.prepare('UPDATE pipelines SET name = ? WHERE id = ?').run(n, p.id); }
    if ('description' in body) db.prepare('UPDATE pipelines SET description = ? WHERE id = ?').run(clean(body.description, 300), p.id);
    if ('archived' in body) {
      if (body.archived) {
        const active = db.prepare('SELECT COUNT(*) n FROM pipelines WHERE archived_at IS NULL AND id <> ?').get(p.id).n;
        if (!active) throw new HttpError(400, 'Minst en pipeline måste vara aktiv.');
      }
      db.prepare('UPDATE pipelines SET archived_at = ? WHERE id = ?').run(body.archived ? nowIso() : null, p.id);
    }
    if (Array.isArray(body.stage_order)) {
      const ids = db.prepare('SELECT id FROM stages WHERE pipeline_id = ?').all(p.id).map((r) => r.id);
      const order = body.stage_order.map(Number);
      if (order.some((x) => !ids.includes(x))) throw new HttpError(400, 'Ogiltig stegordning.');
      const upd = db.prepare('UPDATE stages SET position = ? WHERE id = ?');
      order.forEach((sid, i) => upd.run(i + 1, sid));
    }
    return { ok: true };
  });
}

function reorderPipelines(db, user, ids) {
  requireAdmin(user);
  return tx(db, () => {
    const upd = db.prepare('UPDATE pipelines SET position = ? WHERE id = ?');
    (ids || []).map(Number).forEach((id, i) => upd.run(i + 1, id));
    return { ok: true };
  });
}

function addStage(db, user, pipelineId, body) {
  requireAdmin(user);
  const name = clean(body.name, 100);
  if (!name) throw new HttpError(400, 'Ange ett namn på steget.');
  const outcome = body.outcome || 'open';
  if (!['open', 'won', 'lost'].includes(outcome)) throw new HttpError(400, 'Okänt utfall.');
  return tx(db, () => {
    const p = db.prepare('SELECT * FROM pipelines WHERE id = ?').get(Number(pipelineId));
    if (!p) throw new HttpError(404, 'Pipelinen finns inte.');
    const stages = db.prepare('SELECT * FROM stages WHERE pipeline_id = ? ORDER BY position, id').all(p.id);
    // Insert before the first closed stage for open stages, otherwise at the end.
    let pos = stages.length + 1;
    if (outcome === 'open') {
      const firstClosed = stages.findIndex((s) => s.outcome !== 'open' && !s.archived_at);
      if (firstClosed >= 0) pos = firstClosed + 1;
    }
    const upd = db.prepare('UPDATE stages SET position = ? WHERE id = ?');
    stages.forEach((s, i) => upd.run(i + 1 >= pos ? i + 2 : i + 1, s.id));
    const id = db.prepare('INSERT INTO stages (pipeline_id, name, outcome, position) VALUES (?,?,?,?)').run(p.id, name, outcome, pos).lastInsertRowid;
    return { id: Number(id) };
  });
}

function updateStage(db, user, id, body) {
  requireAdmin(user);
  return tx(db, () => {
    const s = db.prepare('SELECT * FROM stages WHERE id = ?').get(Number(id));
    if (!s) throw new HttpError(404, 'Steget finns inte.');
    const leadCount = db.prepare('SELECT COUNT(*) n FROM leads WHERE stage_id = ?').get(s.id).n;
    if ('name' in body) { const n = clean(body.name, 100); if (!n) throw new HttpError(400, 'Ange ett namn.'); db.prepare('UPDATE stages SET name = ? WHERE id = ?').run(n, s.id); }
    if ('outcome' in body && body.outcome !== s.outcome) {
      if (!['open', 'won', 'lost'].includes(body.outcome)) throw new HttpError(400, 'Okänt utfall.');
      if (leadCount) throw new HttpError(400, 'Utfallet kan inte ändras när steget innehåller leads. Skapa ett nytt steg i stället.');
      db.prepare('UPDATE stages SET outcome = ? WHERE id = ?').run(body.outcome, s.id);
    }
    if ('archived' in body) {
      const openCount = db.prepare("SELECT COUNT(*) n FROM leads WHERE stage_id = ? AND outcome = 'open'").get(s.id).n;
      if (body.archived && openCount) throw new HttpError(400, `Steget har ${openCount} öppna leads. Flytta dem innan du arkiverar steget.`);
      db.prepare('UPDATE stages SET archived_at = ? WHERE id = ?').run(body.archived ? nowIso() : null, s.id);
    }
    checkOutcomeCoverage(db, s.pipeline_id);
    return { ok: true };
  });
}

module.exports = { requireAdmin, listUsers, createUser, updateUser, listPipelines, createPipeline, updatePipeline, reorderPipelines, addStage, updateStage };
