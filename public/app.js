/* Hyrdon CRM – frontend (vanilla JS, no build step). Swedish UI, English code. */
(() => {
  'use strict';
  const S = { me: null, meta: null, routeToken: 0 };
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const app = $('#app');

  // ---------- utils ----------
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nl2br = (v) => esc(v).replace(/\n/g, '<br>');
  const isAdmin = () => S.me && S.me.role === 'admin';
  const isMobile = () => window.matchMedia('(max-width: 760px)').matches;
  const srcLabel = (k) => C.label(C.SOURCES, k);
  const reasonLabel = (k) => C.label(C.LOST_REASONS, k);
  const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)} %`);
  const qs = (o) => Object.entries(o).filter(([, v]) => v !== '' && v != null && v !== false).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const pipelines = () => (S.meta ? S.meta.pipelines : []);
  const sellers = () => (S.meta ? S.meta.users.filter((u) => u.role === 'sales') : []);
  const activeUsers = () => (S.meta ? S.meta.users.filter((u) => u.active) : []);

  async function api(method, path, body) {
    if (method !== 'GET' && body === undefined) body = {}; // writes are always JSON (server CSRF guard)
    const res = await fetch(path, {
      method, credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (res.status === 401 && path !== '/api/login') { S.me = null; renderLogin(); throw Object.assign(new Error(data.error || 'Inte inloggad'), { status: 401, silent: true }); }
    if (!res.ok) throw Object.assign(new Error(data.error || 'Något gick fel.'), { status: res.status, data });
    return data;
  }

  function toast(msg, type = 'ok') {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    $('#toast-root').appendChild(el);
    setTimeout(() => el.classList.add('show'), 10);
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, type === 'error' ? 5000 : 2600);
  }
  const fail = (e) => { if (!e.silent) toast(e.message, 'error'); };

  // ---------- dates ----------
  const now = () => new Date();
  const fmtDT = (v) => TZ.fmtDateTime(v);
  const nowInput = () => TZ.inputValue(new Date());
  function quickDue(kind) {
    const today = TZ.todayStr();
    if (kind === '2h') return TZ.inputValue(new Date(Date.now() + 2 * 3600000));
    if (kind === 'tomorrow') return `${TZ.addDaysStr(today, 1)}T09:00`;
    if (kind === '3d') return `${TZ.addDaysStr(today, 3)}T09:00`;
    if (kind === 'week') { const wd = TZ.parts(new Date()).wd; return `${TZ.addDaysStr(today, 8 - wd)}T09:00`; }
    return '';
  }
  const QUICK_DUE = [['2h', 'Om 2 tim'], ['tomorrow', 'Imorgon 09:00'], ['3d', 'Om 3 dagar'], ['week', 'Måndag 09:00']];

  // ---------- modal ----------
  function openModal(html, { wide = false } = {}) {
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal-backdrop" data-action="close-modal-bg"><div class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true">${html}</div></div>`;
    document.body.classList.add('modal-open');
    const first = $('.modal input:not([type=hidden]), .modal textarea, .modal select', root);
    if (first && !isMobile()) first.focus();
    return $('.modal', root);
  }
  function closeModal() { $('#modal-root').innerHTML = ''; document.body.classList.remove('modal-open'); }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#modal-root').innerHTML) closeModal(); });

  // ---------- routing ----------
  function parseHash() {
    const h = location.hash.replace(/^#/, '') || '/dag';
    const [path, query = ''] = h.split('?');
    return { path, query: Object.fromEntries(new URLSearchParams(query)) };
  }
  const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };
  window.addEventListener('hashchange', () => route());

  async function route() {
    if (!S.me) return;
    closeModal();
    const { path, query } = parseHash();
    const token = ++S.routeToken;
    const seg = path.split('/').filter(Boolean);
    const navKey = seg[0] === 'lead' || seg[0] === 'kund' || seg[0] === 'sok' ? '' : seg[0];
    renderShell(navKey);
    const view = $('#view');
    view.innerHTML = '<div class="loading">Laddar…</div>';
    try {
      if (seg[0] === 'dag') await viewMyDay(view, token);
      else if (seg[0] === 'pipelines') await viewBoard(view, query, token);
      else if (seg[0] === 'oversikt') await viewDashboard(view, query, token);
      else if (seg[0] === 'lista') await viewMetricList(view, query, token);
      else if (seg[0] === 'lead' && seg[1]) await viewLead(view, seg[1], token);
      else if (seg[0] === 'kund' && seg[1]) await viewCustomer(view, seg[1], token);
      else if (seg[0] === 'sok') await viewSearch(view, query, token);
      else if (seg[0] === 'admin') await viewAdmin(view, query, token);
      else go('#/dag');
    } catch (e) {
      if (token === S.routeToken && !e.silent) view.innerHTML = `<div class="empty error">${esc(e.message)}</div>`;
    }
    window.scrollTo(0, 0);
  }
  const stale = (token) => token !== S.routeToken;

  // ---------- login ----------
  async function renderLogin() {
    closeModal();
    let accounts = [];
    try { accounts = (await api('GET', '/api/demo-accounts')).accounts; } catch { /* ignore */ }
    app.innerHTML = `
      <div class="login-wrap">
        <form class="login-card" data-form="login">
          <div class="brand brand-lg"><span class="logo">H</span> Hyrdon CRM</div>
          <div class="demo-note">Lokal demoversion med syntetisk data. Inga integrationer är anslutna.</div>
          <label>E-post<input name="email" type="email" autocomplete="username" required></label>
          <label>Lösenord<input name="password" type="password" autocomplete="current-password" required></label>
          <button class="btn btn-primary btn-block" type="submit">Logga in</button>
          <div class="login-error" hidden></div>
          ${accounts.length ? `<div class="demo-accounts"><div class="muted small">Demokonton (lösenord <b>demo1234</b>) – klicka för att fylla i:</div>
            ${accounts.map((a) => `<button type="button" class="demo-acc" data-action="fill-login" data-email="${esc(a.email)}">
              <span>${esc(a.name)}</span><span class="pill ${a.role === 'admin' ? 'pill-dark' : ''}">${a.role === 'admin' ? 'Direktör/Admin' : 'Säljare'}</span></button>`).join('')}</div>` : ''}
        </form>
      </div>`;
  }

  async function boot() {
    try {
      const meta = await api('GET', '/api/meta');
      S.me = meta.user; S.meta = meta;
      if (!location.hash) location.hash = '#/dag';
      route();
    } catch (e) { if (e.status !== 401) app.innerHTML = `<div class="empty error">${esc(e.message)}</div>`; }
  }
  async function refreshMeta() { S.meta = await api('GET', '/api/meta'); S.me = S.meta.user; }

  // ---------- shell ----------
  function renderShell(active) {
    if (!$('#view')) {
      app.innerHTML = `
        <div class="demo-banner">DEMOLÄGE · syntetisk data · inga integrationer anslutna${window.CRM_STANDALONE ? ' · data sparas bara i denna webbläsare' : ''}</div>
        <header class="topbar">
          <a class="brand" href="#/dag"><span class="logo">H</span><span class="brand-text">Hyrdon CRM</span></a>
          <nav class="mainnav" id="mainnav"></nav>
          <div class="search-wrap">
            <input id="global-search" type="search" placeholder="Sök namn, telefon, e-post, regnr, bil…" autocomplete="off">
            <div id="search-results" class="search-results" hidden></div>
          </div>
          <button class="btn btn-primary hide-mobile" data-action="new-lead">+ Ny lead</button>
          <div class="usermenu">
            <button class="btn btn-ghost user-btn" data-action="toggle-usermenu"><span class="avatar">${esc(initials(S.me.name))}</span><span class="hide-mobile">${esc(S.me.name.split(' ')[0])}</span></button>
            <div class="usermenu-pop" hidden>
              <div class="muted small">${esc(S.me.name)}<br>${isAdmin() ? 'Direktör / Admin' : 'Säljare'}</div>
              ${isAdmin() ? '<a href="#/admin" class="menu-item">Admininställningar</a>' : ''}
              <button class="menu-item" data-action="logout">Logga ut</button>
            </div>
          </div>
        </header>
        <main id="view" class="view"></main>
        <nav class="bottomnav" id="bottomnav"></nav>`;
      const input = $('#global-search');
      input.addEventListener('input', debounce(() => liveSearch(input.value), 200));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { $('#search-results').hidden = true; go(`#/sok?q=${encodeURIComponent(input.value)}`); input.blur(); } });
      input.addEventListener('focus', () => { if (input.value) liveSearch(input.value); });
    }
    const items = [['dag', 'Min dag', iconDay], ['pipelines', 'Pipelines', iconBoard]];
    if (isAdmin()) items.push(['oversikt', 'Översikt', iconChart]);
    $('#mainnav').innerHTML = items.map(([k, l]) => `<a href="#/${k}" class="${active === k ? 'active' : ''}">${l}</a>`).join('')
      + (isAdmin() ? `<a href="#/admin" class="${active === 'admin' ? 'active' : ''} nav-admin">Admin</a>` : '');
    $('#bottomnav').innerHTML = items.map(([k, l, ic]) => `<a href="#/${k}" class="${active === k ? 'active' : ''}">${ic()}<span>${l}</span></a>`).join('')
      + `<a href="#/sok">${iconSearch()}<span>Sök</span></a><button data-action="new-lead" class="bn-new">${iconPlus()}<span>Ny lead</span></button>`;
  }
  const initials = (n) => String(n || '?').split(' ').map((x) => x[0]).slice(0, 2).join('').toUpperCase();
  const svg = (d) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const iconDay = () => svg('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>');
  const iconBoard = () => svg('<rect x="3" y="3" width="5" height="18" rx="1"/><rect x="10" y="3" width="5" height="12" rx="1"/><rect x="17" y="3" width="4" height="8" rx="1"/>');
  const iconChart = () => svg('<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>');
  const iconSearch = () => svg('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>');
  const iconPlus = () => svg('<path d="M12 5v14M5 12h14"/>');

  async function liveSearch(q) {
    const box = $('#search-results');
    if (!q || q.trim().length < 2) { box.hidden = true; return; }
    try {
      const { leads } = await api('GET', `/api/search?q=${encodeURIComponent(q)}`);
      if ($('#global-search').value !== q) return;
      box.innerHTML = leads.length ? leads.slice(0, 8).map((l) => `
        <a class="sr-item" href="#/lead/${l.id}"><div><b>${esc(l.customer_name || l.phone || l.email)}</b> <span class="muted">${esc(l.vehicle || '')}</span></div>
        <div class="small muted">${esc(l.pipeline_name)} · ${esc(l.stage_name)} · ${esc(l.owner_name || 'Ej tilldelad')}${l.phone ? ' · ' + esc(l.phone) : ''}${l.reg_number ? ' · ' + esc(l.reg_number) : ''}</div></a>`).join('')
        + (leads.length > 8 ? `<a class="sr-item sr-more" href="#/sok?q=${encodeURIComponent(q)}">Visa alla ${leads.length} träffar</a>` : '')
        : '<div class="sr-item muted">Inga träffar</div>';
      box.hidden = false;
    } catch (e) { fail(e); }
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) { const b = $('#search-results'); if (b) b.hidden = true; }
    if (e.target.closest('.sr-item')) { const b = $('#search-results'); if (b) b.hidden = true; }
    if (!e.target.closest('.usermenu')) { const p = $('.usermenu-pop'); if (p) p.hidden = true; }
  });

  // ---------- shared components ----------
  function ownerHtml(l) {
    if (!l.owner_id) return '<span class="owner owner-none">Ej tilldelad</span>';
    return `<span class="owner"><span class="avatar avatar-sm">${esc(initials(l.owner_name))}</span>${esc(l.owner_name)}${l.owner_active ? '' : ' <span class="pill pill-warn">inaktiv</span>'}</span>`;
  }
  function dueHtml(l) {
    if (l.outcome !== 'open') return '';
    if (!l.next_action) return '<span class="due due-none">Inget nästa steg</span>';
    if (!l.next_action_due) return `<span class="due">${esc(l.next_action)}</span>`;
    const cls = l.overdue ? 'due-over' : l.due_today ? 'due-today' : '';
    return `<span class="due ${cls}">${l.overdue ? 'Försenad · ' : ''}${esc(l.next_action)} · ${esc(fmtDT(l.next_action_due))}</span>`;
  }
  function outcomeBadge(l) {
    if (l.outcome === 'won') return '<span class="pill pill-won">Vunnen</span>';
    if (l.outcome === 'lost') return `<span class="pill pill-lost">Förlorad${l.lost_reason ? ' · ' + esc(reasonLabel(l.lost_reason)) : ''}</span>`;
    return '';
  }

  function leadCard(l, { board = false, stages = null, showPipeline = false } = {}) {
    const canMove = isAdmin() || l.owner_id === S.me.id;
    return `<div class="card ${l.overdue ? 'card-overdue' : ''}" data-lead="${l.id}" ${board && canMove ? 'draggable="true"' : ''}>
      <a class="card-link" href="#/lead/${l.id}">
        <div class="card-top"><b class="card-name">${esc(l.customer_name || l.phone || l.email || 'Okänd kund')}</b>
          ${l.awaiting_reply ? '<span class="pill pill-await" title="Senaste meddelandet kom från kunden">Väntar på svar</span>' : ''}</div>
        <div class="card-vehicle">${esc(l.vehicle || l.enquiry || '–')}</div>
        <div class="card-meta">${ownerHtml(l)}<span class="pill">${esc(srcLabel(l.source))}</span>${showPipeline ? `<span class="pill pill-pipe">${esc(l.pipeline_name)}</span>` : ''}${outcomeBadge(l)}</div>
        <div class="card-foot"><span class="muted">Senast: ${l.last_activity_at ? esc(TZ.fmtAgo(l.last_activity_at)) : 'ingen aktivitet'}</span>${dueHtml(l)}</div>
      </a>
      ${!l.owner_id && l.outcome === 'open' ? `<button class="btn btn-claim btn-sm" data-action="claim" data-id="${l.id}">Ta lead</button>` : ''}
      ${board && stages && canMove ? `<label class="card-move show-mobile">Flytta till
        <select data-move="${l.id}">${stages.map((s) => `<option value="${s.id}" ${s.id === l.stage_id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>` : ''}
    </div>`;
  }

  function leadRows(leads, empty = 'Inget här just nu.') {
    if (!leads.length) return `<div class="empty">${empty}</div>`;
    return `<div class="rows">${leads.map((l) => `
      <div class="row ${l.overdue ? 'row-overdue' : ''}">
        <a class="row-main" href="#/lead/${l.id}">
          <div class="row-title"><b>${esc(l.customer_name || l.phone || l.email || 'Okänd kund')}</b> <span class="muted">${esc(l.vehicle || '')}</span>
            ${l.awaiting_reply ? '<span class="pill pill-await">Väntar på svar</span>' : ''}</div>
          <div class="row-sub"><span class="pill pill-pipe">${esc(l.pipeline_name)}</span> <span class="muted">${esc(l.stage_name)} · ${esc(srcLabel(l.source))} · skapad ${esc(TZ.fmtAgo(l.created_at))}</span> ${dueHtml(l)}</div>
        </a>
        ${!l.owner_id && l.outcome === 'open' ? `<button class="btn btn-claim" data-action="claim" data-id="${l.id}">Ta lead</button>` : ''}
      </div>`).join('')}</div>`;
  }

  // ---------- claim ----------
  async function claim(id, after) {
    try {
      const r = await api('POST', `/api/leads/${id}/claim`);
      toast(r.already ? 'Du äger redan denna lead.' : 'Leaden är din!');
    } catch (e) {
      if (e.status === 409) toast(e.message, 'error'); else fail(e);
    }
    if (after) after(); else route();
  }

  // ---------- Min dag ----------
  async function viewMyDay(view, token) {
    const d = await api('GET', '/api/my-day');
    if (stale(token)) return;
    const first = S.me.name.split(' ')[0];
    const section = (id, title, leads, cls, empty) => `
      <section class="panel ${cls || ''}" id="${id}">
        <h2>${title} <span class="count">${leads.length}</span></h2>${leadRows(leads, empty)}</section>`;
    view.innerHTML = `
      <div class="page-head"><h1>Hej ${esc(first)}!</h1><div class="muted">${esc(TZ.fmtDate(new Date()))} · ${d.openCount} öppna leads är dina</div></div>
      <a class="unassigned-hero ${d.unassigned.length ? '' : 'zero'}" href="#unassigned">
        <div class="big">${d.unassigned.length}</div>
        <div><b>nya leads väntar på en säljare</b><div class="small">${d.unassigned.length ? `Äldsta kom in ${esc(TZ.fmtAgo(d.unassigned[0].created_at))}. Klicka "Ta lead" för att ta den.` : 'Alla leads är tilldelade.'}</div></div>
      </a>
      <div class="day-grid">
        ${section('overdue', 'Försenade uppföljningar', d.overdue, 'panel-danger', 'Inga försenade – snyggt!')}
        ${section('today', 'Att göra idag', d.today, '', 'Inga fler uppföljningar idag.')}
        ${section('awaiting', 'Kunder väntar på svar', d.awaiting, 'panel-await', 'Ingen kund väntar på svar.')}
        ${section('nonext', 'Mina öppna leads utan nästa steg', d.noNext, 'panel-warn', 'Alla dina leads har ett nästa steg.')}
      </div>
      <p class="small muted">"Väntar på svar" visas när det senaste registrerade meddelandet på leaden kommer från kunden (exempelkonversationer eller manuellt registrerade mejl).</p>
      ${section('unassigned', 'Ej tilldelade nya leads', d.unassigned, 'panel-primary', 'Inga ej tilldelade leads.')}`;
    $('.unassigned-hero').addEventListener('click', (e) => { e.preventDefault(); $('#unassigned').scrollIntoView({ behavior: 'smooth' }); });
  }

  // ---------- Board ----------
  let boardState = null;
  async function viewBoard(view, query, token) {
    const ps = pipelines();
    const p = ps.find((x) => String(x.id) === query.p) || ps[0];
    if (!p) { view.innerHTML = '<div class="empty">Inga pipelines.</div>'; return; }
    boardState = { p: p.id, owner: query.owner || '', source: query.source || '', overdue: query.overdue || '', q: query.q || '', stage: query.stage || '' };
    const ownerOpts = [['', 'Alla säljare'], ['me', 'Mina'], ['none', 'Ej tilldelade'], ...sellers().map((u) => [String(u.id), u.name + (u.active ? '' : ' (inaktiv)')])];
    view.innerHTML = `
      <div class="board-head">
        <div class="tabs pipe-tabs">${ps.map((x) => `<button class="tab ${x.id === p.id ? 'active' : ''}" data-action="board-pipe" data-id="${x.id}">${esc(x.name)}</button>`).join('')}</div>
        <div class="filters">
          <select data-bf="owner">${ownerOpts.map(([v, l]) => `<option value="${v}" ${boardState.owner === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
          <select data-bf="source"><option value="">Alla källor</option>${C.SOURCES.map((s) => `<option value="${s.key}" ${boardState.source === s.key ? 'selected' : ''}>${s.label}</option>`).join('')}</select>
          <label class="check"><input type="checkbox" data-bf="overdue" ${boardState.overdue ? 'checked' : ''}> Försenade</label>
          <input type="search" data-bf="q" placeholder="Filtrera…" value="${esc(boardState.q)}">
        </div>
      </div>
      <div id="board"></div>`;
    $$('[data-bf]', view).forEach((el) => {
      const h = () => { boardState[el.dataset.bf] = el.type === 'checkbox' ? (el.checked ? '1' : '') : el.value; syncBoardUrl(); loadBoard(token); };
      el.addEventListener(el.type === 'search' ? 'input' : 'change', el.type === 'search' ? debounce(h, 250) : h);
    });
    await loadBoard(token);
  }
  function syncBoardUrl() {
    const { p, owner, source, overdue, q, stage } = boardState;
    history.replaceState(null, '', `#/pipelines?${qs({ p, owner, source, overdue, q, stage })}`);
  }
  async function loadBoard(token) {
    const { p, owner, source, overdue, q } = boardState;
    const data = await api('GET', `/api/board?${qs({ pipeline: p, owner, source, overdue, q })}`);
    if (stale(token)) return;
    const el = $('#board');
    const stages = data.stages;
    const mobileStage = stages.find((s) => String(s.id) === boardState.stage) || stages[0];
    el.innerHTML = `
      <div class="stage-chips show-mobile">${stages.map((s) => `<button class="chip ${s.id === mobileStage.id ? 'active' : ''} chip-${s.outcome}" data-action="board-stage" data-id="${s.id}">${esc(s.name)} <b>${s.total}</b></button>`).join('')}</div>
      <div class="board">${stages.map((s) => `
        <div class="col col-${s.outcome} ${s.id === mobileStage.id ? 'mobile-active' : ''}" data-stage="${s.id}" data-outcome="${s.outcome}">
          <div class="col-head"><span>${esc(s.name)}</span><span class="count">${s.total}</span></div>
          <div class="col-body">${s.leads.map((l) => leadCard(l, { board: true, stages })).join('') || '<div class="col-empty">Inga leads</div>'}
          ${s.total > s.leads.length ? `<div class="col-more small muted">Visar de ${s.leads.length} senaste av ${s.total}. Använd sök för äldre.</div>` : ''}</div>
        </div>`).join('')}</div>`;
    bindBoardDnD(el, stages);
    $$('select[data-move]', el).forEach((sel) => sel.addEventListener('change', () => moveLead(Number(sel.dataset.move), Number(sel.value), stages, () => loadBoard(S.routeToken))));
  }
  function bindBoardDnD(el, stages) {
    let dragId = null;
    $$('.card[draggable]', el).forEach((c) => {
      c.addEventListener('dragstart', (e) => { dragId = Number(c.dataset.lead); c.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(dragId)); });
      c.addEventListener('dragend', () => { c.classList.remove('dragging'); $$('.col.drop', el).forEach((x) => x.classList.remove('drop')); });
    });
    $$('.col', el).forEach((col) => {
      col.addEventListener('dragover', (e) => { if (dragId) { e.preventDefault(); col.classList.add('drop'); } });
      col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drop'); });
      col.addEventListener('drop', (e) => {
        e.preventDefault(); col.classList.remove('drop');
        const id = dragId; dragId = null;
        if (id) moveLead(id, Number(col.dataset.stage), stages, () => loadBoard(S.routeToken));
      });
    });
  }

  async function moveLead(id, stageId, stages, after) {
    const stage = stages.find((s) => s.id === stageId);
    if (!stage) return;
    if (stage.outcome === 'lost') return lostModal(id, stageId, after);
    try {
      const { lead } = await api('POST', `/api/leads/${id}/stage`, { stage_id: stageId });
      toast(`Flyttad till ${lead.stage_name}`);
    } catch (e) { fail(e); }
    after && after();
  }

  function lostModal(id, stageId, after) {
    const m = openModal(`
      <form data-form="lost">
        <h2>Markera som förlorad</h2>
        <p class="muted">Varför blev det inget? Krävs för uppföljning av förlorade affärer.</p>
        <div class="radio-list">${C.LOST_REASONS.map((r) => `<label class="radio"><input type="radio" name="lost_reason" value="${r.key}" required> ${r.label}</label>`).join('')}</div>
        <label>Förklaring <span class="muted small" id="lost-note-hint">(valfri)</span><textarea name="lost_note" rows="2" placeholder="Kort förklaring"></textarea></label>
        <div class="form-error" hidden></div>
        <div class="modal-actions"><button type="button" class="btn" data-action="close-modal">Avbryt</button><button class="btn btn-danger" type="submit">Markera förlorad</button></div>
      </form>`);
    $$('input[name=lost_reason]', m).forEach((r) => r.addEventListener('change', () => {
      const other = $('input[name=lost_reason]:checked', m).value === 'other';
      $('#lost-note-hint', m).textContent = other ? '(krävs för "Annat")' : '(valfri)';
      $('textarea', m).required = other;
    }));
    m.querySelector('form').onsubmitHandler = async (fd, form) => {
      if (!fd.lost_reason) throw new Error('Välj en anledning.');
      if (fd.lost_reason === 'other' && !fd.lost_note.trim()) throw new Error('Beskriv anledningen när du väljer "Annat".');
      await api('POST', `/api/leads/${id}/stage`, { stage_id: stageId, lost_reason: fd.lost_reason, lost_note: fd.lost_note });
      closeModal(); toast('Leaden markerades som förlorad.');
      after && after();
    };
  }

  // ---------- Lead detail ----------
  async function viewLead(view, id, token) {
    const d = await api('GET', `/api/leads/${id}`);
    if (stale(token)) return;
    const { lead: l, contact: c, activities, otherLeads, stages, duplicates, can } = d;
    const lostStage = stages.find((s) => s.outcome === 'lost' && !s.archived_at);
    view.innerHTML = `
      <div class="lead-page">
        <div class="crumbs"><a href="javascript:history.back()">← Tillbaka</a> · <a href="#/pipelines?p=${l.pipeline_id}">${esc(l.pipeline_name)}</a></div>
        <div class="lead-head">
          <div>
            <h1><a href="#/kund/${c.id}" class="cust-link">${esc(c.name || c.phone || c.email || 'Okänd kund')}</a> ${l.is_demo ? '<span class="pill pill-demo">Demodata</span>' : ''} ${outcomeBadge(l)}</h1>
            <div class="lead-sub">${esc(l.vehicle || 'Ingen bil angiven')} · <span class="pill pill-pipe">${esc(l.pipeline_name)}</span> · ${esc(srcLabel(l.source))} · skapad ${esc(fmtDT(l.created_at))}</div>
            <div class="contact-line">
              ${c.phone ? `<a class="btn btn-sm" href="tel:${esc(c.phone_norm || c.phone)}" title="Ringer från din egen telefon – registrera samtalet nedan">📞 ${esc(c.phone)}</a>` : ''}
              ${c.email ? `<span class="btn btn-sm btn-static">✉ ${esc(c.email)}</span>` : ''}
            </div>
          </div>
          <div class="owner-box">
            <div class="small muted">Ägare</div>
            <div class="owner-line">${ownerHtml(l)}</div>
            <div class="owner-actions">
              ${can.claim ? `<button class="btn btn-claim" data-action="claim" data-id="${l.id}">Ta lead</button>` : ''}
              ${can.assign ? `<select data-action-change="assign" data-id="${l.id}" aria-label="Tilldela"><option value="">Tilldela…</option>
                  <option value="none">— Ej tilldelad —</option>
                  ${activeUsers().map((u) => `<option value="${u.id}" ${u.id === l.owner_id ? 'disabled' : ''}>${esc(u.name)}</option>`).join('')}</select>` : ''}
              ${l.owner_id === S.me.id ? `<button class="btn btn-sm btn-ghost" data-action="release" data-id="${l.id}">Släpp lead</button>` : ''}
            </div>
          </div>
        </div>

        <div class="stage-bar ${can.edit ? '' : 'disabled'}">
          ${stages.filter((s) => s.outcome !== 'lost').map((s) => `<button class="stage-btn ${s.id === l.stage_id ? 'current' : ''} stage-${s.outcome}" ${can.edit ? '' : 'disabled'}
            data-action="stage" data-id="${l.id}" data-stage="${s.id}">${esc(s.name)}</button>`).join('')}
          ${lostStage ? `<button class="stage-btn stage-lost ${l.stage_id === lostStage.id ? 'current' : ''}" ${can.edit ? '' : 'disabled'} data-action="stage" data-id="${l.id}" data-stage="${lostStage.id}">${esc(lostStage.name)}</button>` : ''}
        </div>
        ${!can.edit ? `<div class="hint">${l.owner_id ? `Ägs av ${esc(l.owner_name)}. Du kan läsa och lägga till anteckningar/aktiviteter, men inte ändra steg eller uppgifter.` : 'Ta leaden för att kunna ändra steg, nästa steg och uppgifter.'}</div>` : ''}
        ${l.outcome === 'lost' ? `<div class="hint hint-lost"><b>Förlorad:</b> ${esc(reasonLabel(l.lost_reason))}${l.lost_note ? ' – ' + esc(l.lost_note) : ''} (${esc(fmtDT(l.lost_at))})</div>` : ''}
        ${l.outcome === 'won' ? `<div class="hint hint-won"><b>Vunnen</b> ${esc(fmtDT(l.won_at))}. Att flytta till Levererad räknas inte som en ny försäljning.</div>` : ''}

        <div class="lead-grid">
          <div class="lead-main">
            ${nextActionPanel(l, can)}
            ${composer(l)}
            <section class="panel"><h2>Tidslinje</h2>${timeline(activities)}</section>
          </div>
          <aside class="lead-side">
            <section class="panel">
              <div class="panel-head"><h2>Förfrågan & bil</h2>${can.edit ? `<button class="btn btn-sm" data-action="edit-lead" data-id="${l.id}">Ändra</button>` : ''}</div>
              <dl class="dl">
                <dt>Kundens förfrågan</dt><dd>${l.enquiry ? nl2br(l.enquiry) : '<span class="muted">–</span>'}</dd>
                <dt>Bil / titel</dt><dd>${esc(l.vehicle || '–')}</dd>
                <dt>Regnr</dt><dd>${esc(l.reg_number || '–')}</dd>
                <dt>Annons-ID</dt><dd>${esc(l.listing_id || '–')}</dd>
                <dt>Annonslänk</dt><dd>${l.listing_url ? `<a href="${esc(l.listing_url)}" target="_blank" rel="noopener noreferrer">${esc(l.listing_url)}</a>` : '–'}</dd>
                <dt>Källa</dt><dd>${esc(srcLabel(l.source))} <span class="muted small">(manuell etikett)</span></dd>
                <dt>Skapad</dt><dd>${esc(fmtDT(l.created_at))}</dd>
              </dl>
            </section>
            <section class="panel">
              <div class="panel-head"><h2>Kund</h2><a class="btn btn-sm" href="#/kund/${c.id}">Öppna kund</a></div>
              <dl class="dl"><dt>Namn</dt><dd>${esc(c.name || '–')}</dd><dt>Telefon</dt><dd>${esc(c.phone || '–')}${c.phone && !c.phone_norm ? ' <span class="pill pill-warn" title="Numret kunde inte tolkas och används inte för dubblettkontroll">ej verifierat nr</span>' : ''}</dd>
                <dt>E-post</dt><dd>${esc(c.email || '–')}</dd></dl>
              ${duplicates.length ? dupWarning(duplicates) : ''}
              <h3>Kundens andra leads (${otherLeads.length})</h3>
              ${otherLeads.length ? otherLeads.map((o) => `<a class="mini-lead" href="#/lead/${o.id}"><span class="pill pill-pipe">${esc(o.pipeline_name)}</span> ${esc(o.vehicle || '–')}<span class="small muted"> · ${esc(o.stage_name)} · ${esc(o.owner_name || 'Ej tilldelad')}</span></a>`).join('') : '<div class="muted small">Inga andra leads.</div>'}
              <button class="btn btn-sm btn-block" data-action="new-lead" data-contact="${c.id}">+ Ny lead för denna kund</button>
            </section>
          </aside>
        </div>
      </div>`;
    bindComposer(view, l);
  }

  function dupWarning(dups) {
    return `<div class="dup-warn"><b>Möjlig dubblett:</b> ${dups.map((m) => `<a href="#/kund/${m.id}">${esc(m.name || m.phone || m.email)}</a> (${m.matched_on.map((x) => (x === 'phone' ? 'samma telefon' : 'samma e-post')).join(', ')}, ${m.leads.length} leads)`).join('; ')}.
      <div class="small">Kunder slås inte ihop automatiskt.</div></div>`;
  }

  function nextActionPanel(l, can) {
    if (l.outcome === 'lost') return '';
    const has = !!l.next_action;
    return `<section class="panel next-panel ${l.overdue ? 'next-over' : has ? '' : 'next-none'}" id="next-panel">
      <div class="panel-head"><h2>Nästa steg</h2></div>
      ${has ? `<div class="next-text">${esc(l.next_action)}</div>
        <div class="next-due">${l.next_action_due ? `${l.overdue ? '<b>Försenad</b> · ' : l.due_today ? '<b>Idag</b> · ' : ''}${esc(fmtDT(l.next_action_due))}` : 'Ingen tid satt'}</div>
        ${can.edit ? `<div class="btn-row"><button class="btn btn-primary" data-action="complete-next">✓ Klar</button><button class="btn" data-action="edit-next">Ändra</button></div>` : ''}`
      : `<div class="muted">Inget nästa steg planerat.</div>${can.edit ? '<div class="btn-row"><button class="btn btn-primary" data-action="edit-next">+ Planera nästa steg</button></div>' : ''}`}
      <div id="next-form"></div>
    </section>`;
  }

  function nextForm({ complete, l }) {
    return `<form data-form="${complete ? 'complete-next' : 'set-next'}" class="next-form">
      ${complete ? `<label>Resultat <span class="muted small">(valfritt)</span><input name="result" placeholder="T.ex. pratade med kunden, skickar offert"></label>
        <div class="small muted">Klarmarkerat steg sparas i tidslinjen.</div><h3>Vad är nästa steg?</h3>` : ''}
      <label>Nästa steg<input name="text" value="${complete ? '' : esc(l.next_action || '')}" placeholder="T.ex. Ring upp, skicka offert" list="next-suggest"></label>
      <datalist id="next-suggest"><option>Ring upp</option><option>Följ upp offert</option><option>Boka provkörning</option><option>Skicka avtal</option><option>Bekräfta leverans</option></datalist>
      <div class="chips">${QUICK_DUE.map(([k, t]) => `<button type="button" class="chip" data-action="quick-due" data-k="${k}">${t}</button>`).join('')}</div>
      <label>När<input type="datetime-local" name="due" value="${complete ? '' : esc(TZ.inputValue(l.next_action_due))}"></label>
      <div class="btn-row">
        <button class="btn btn-primary" type="submit">${complete ? 'Spara' : 'Spara nästa steg'}</button>
        ${complete ? '<button class="btn" type="submit" name="none" value="1">Klar utan nytt steg</button>' : (l.next_action ? '<button class="btn" type="submit" name="clear" value="1">Ta bort</button>' : '')}
        <button class="btn btn-ghost" type="button" data-action="cancel-next">Avbryt</button>
      </div>
      <div class="form-error" hidden></div>
    </form>`;
  }

  function composer(l) {
    return `<section class="panel composer">
      <div class="tabs comp-tabs">
        <button class="tab active" data-ctab="note">Anteckning</button>
        <button class="tab" data-ctab="call">Samtal</button>
        <button class="tab" data-ctab="email">E-post (manuell)</button>
      </div>
      <form data-form="act-note" class="ctab ctab-note">
        <textarea name="body" rows="2" placeholder="Intern anteckning – syns bara för kollegor, inte för kunden" required></textarea>
        <div class="btn-row"><button class="btn btn-primary" type="submit">Spara anteckning</button></div>
      </form>
      <form data-form="act-call" class="ctab ctab-call" hidden>
        <div class="seg"><label><input type="radio" name="direction" value="out" checked><span>Utgående</span></label><label><input type="radio" name="direction" value="in"><span>Inkommande</span></label></div>
        <div class="chips chips-radio">${C.CALL_OUTCOMES.map((o, i) => `<label class="chip"><input type="radio" name="call_outcome" value="${o.key}" ${i === 0 ? 'checked' : ''}><span>${o.label}</span></label>`).join('')}</div>
        <div class="form-row"><label>Tid<input type="datetime-local" name="occurred_at" value="${nowInput()}"></label><label>Längd (min)<input type="number" name="duration_min" min="0" max="600" step="1" inputmode="numeric" placeholder="valfritt"></label></div>
        <textarea name="body" rows="2" placeholder="Vad sades? (valfritt)"></textarea>
        <div class="small muted">Samtal registreras manuellt. Ingen telefonintegration i denna version.</div>
        <div class="btn-row"><button class="btn btn-primary" type="submit">Spara samtal</button></div>
      </form>
      <form data-form="act-email" class="ctab ctab-email" hidden>
        <div class="notice">Registrera ett mejl som skickats eller tagits emot <b>utanför CRM</b>. Det skickas inget mejl härifrån.</div>
        <div class="seg"><label><input type="radio" name="direction" value="out" checked><span>Skickat till kund</span></label><label><input type="radio" name="direction" value="in"><span>Från kund</span></label></div>
        <div class="form-row"><label>Ämne<input name="subject"></label><label>Tid<input type="datetime-local" name="occurred_at" value="${nowInput()}"></label></div>
        <textarea name="body" rows="4" placeholder="Klistra in mejlets innehåll"></textarea>
        <div class="btn-row"><button class="btn btn-primary" type="submit">Spara mejl</button>
          <button class="btn" type="button" disabled title="Inte tillgängligt i denna version">Skicka e-post från CRM – ej tillgängligt i denna version</button></div>
      </form>
    </section>`;
  }

  function bindComposer(view, l) {
    $$('[data-ctab]', view).forEach((t) => t.addEventListener('click', () => {
      $$('[data-ctab]', view).forEach((x) => x.classList.toggle('active', x === t));
      $$('.ctab', view).forEach((f) => { f.hidden = !f.classList.contains(`ctab-${t.dataset.ctab}`); });
    }));
    const submitAct = (type) => async (fd) => {
      await api('POST', `/api/leads/${l.id}/activities`, { type, ...fd });
      toast(type === 'note' ? 'Anteckning sparad' : type === 'call' ? 'Samtal registrerat' : 'Mejl registrerat');
      route();
    };
    $('[data-form=act-note]', view).onsubmitHandler = submitAct('note');
    $('[data-form=act-call]', view).onsubmitHandler = submitAct('call');
    $('[data-form=act-email]', view).onsubmitHandler = submitAct('email');
    view.__lead = l;
  }

  const FIELD_LABELS = { vehicle: 'bil', enquiry: 'förfrågan', reg_number: 'regnr', listing_id: 'annons-ID', listing_url: 'annonslänk', source: 'källa', pipeline: 'pipeline', kunduppgifter: 'kunduppgifter' };
  function originBadge(a) {
    if (a.origin === 'sample') return '<span class="pill pill-demo">Exempeldata</span>';
    if (a.type === 'email') return '<span class="pill">Manuellt registrerat</span>';
    if (a.type === 'call') return '<span class="pill">Manuellt registrerat</span>';
    return '';
  }
  function who(a) { return a.user_name ? `${esc(a.user_name)}${a.user_active === 0 ? ' <span class="pill pill-warn">inaktiv</span>' : ''}` : ''; }

  function timeline(acts) {
    if (!acts.length) return '<div class="empty">Ingen aktivitet ännu.</div>';
    return `<ol class="timeline">${acts.map((a) => {
      const when = `<time title="${esc(new Date(a.occurred_at).toISOString())}">${esc(fmtDT(a.occurred_at))}</time>`;
      if (a.type === 'note') {
        return `<li class="tl tl-note"><div class="tl-label">🔒 Intern anteckning · ${who(a)} · ${when} ${originBadge(a)}</div><div class="tl-body">${nl2br(a.body)}</div></li>`;
      }
      if (a.type === 'email') {
        const inbound = a.direction === 'in';
        return `<li class="tl tl-email ${inbound ? 'tl-in' : 'tl-out'}"><div class="tl-label">✉ ${inbound ? 'Mejl från kund' : `Mejl till kund · ${who(a)}`} · ${when} ${originBadge(a)}</div>
          ${a.subject ? `<div class="tl-subject">${esc(a.subject)}</div>` : ''}<div class="tl-body">${nl2br(a.body)}</div></li>`;
      }
      if (a.type === 'call') {
        const dur = a.duration_sec ? ` · ${Math.round(a.duration_sec / 60)} min` : '';
        return `<li class="tl tl-call ${a.direction === 'in' ? 'tl-in' : 'tl-out'}"><div class="tl-label">📞 ${a.direction === 'in' ? 'Inkommande' : 'Utgående'} samtal · <b>${esc(C.label(C.CALL_OUTCOMES, a.call_outcome))}</b>${dur} · ${who(a)} · ${when} ${originBadge(a)}</div>
          ${a.body ? `<div class="tl-body">${nl2br(a.body)}</div>` : ''}</li>`;
      }
      if (a.type === 'followup_done') {
        return `<li class="tl tl-done"><div class="tl-label">✓ Nästa steg klart · ${who(a)} · ${when}</div><div class="tl-body"><b>${esc(a.body)}</b>${a.due_at ? ` <span class="muted small">(planerat ${esc(fmtDT(a.due_at))})</span>` : ''}${a.subject ? `<div>${esc(a.subject)}</div>` : ''}</div></li>`;
      }
      let text = '';
      if (a.type === 'created') text = 'Lead skapad';
      else if (a.type === 'stage_change') text = a.body && !a.lost_reason ? esc(a.body) : `Steg: ${esc(a.from_stage_name || '–')} → <b>${esc(a.to_stage_name)}</b>${a.lost_reason ? ` · Anledning: ${esc(reasonLabel(a.lost_reason))}${a.body ? ' – ' + esc(a.body) : ''}` : ''}`;
      else if (a.type === 'owner_change') {
        if (a.body === 'claim') text = `${esc(a.to_user_name)} tog leaden`;
        else if (a.body === 'release') text = `${esc(a.from_user_name)} släppte leaden`;
        else text = `Tilldelad ${a.to_user_name ? esc(a.to_user_name) : '“Ej tilldelad”'}${a.from_user_name ? ` (från ${esc(a.from_user_name)})` : ''}`;
      } else if (a.type === 'edit') text = `Uppgifter ändrade: ${esc((a.body || '').split(', ').map((k) => FIELD_LABELS[k] || k).join(', '))}`;
      else text = esc(a.type);
      return `<li class="tl tl-sys"><span>${text}</span> <span class="muted small">· ${a.user_name && a.type !== 'owner_change' ? who(a) + ' · ' : a.type === 'owner_change' && a.body === 'assign' && a.user_name ? 'av ' + who(a) + ' · ' : ''}${when}</span></li>`;
    }).join('')}</ol>`;
  }

  // ---------- lead form (new / edit) ----------
  async function leadFormModal({ lead = null, contactId = null } = {}) {
    const edit = !!lead;
    let contact = null;
    if (contactId) contact = (await api('GET', `/api/contacts/${contactId}`)).contact;
    const ps = pipelines();
    const lastPipe = localStorageGet('lastPipe');
    const selPipe = edit ? lead.pipeline_id : (ps.find((p) => String(p.id) === lastPipe) || ps[0] || {}).id;
    const m = openModal(`
      <form data-form="${edit ? 'edit-lead' : 'new-lead'}" class="lead-form">
        <h2>${edit ? 'Ändra lead' : 'Ny lead'}</h2>
        <div class="field-label">Pipeline *</div>
        <div class="seg seg-wrap">${ps.map((p) => `<label><input type="radio" name="pipeline_id" value="${p.id}" ${p.id === selPipe ? 'checked' : ''} required><span>${esc(p.name)}</span></label>`).join('')}</div>
        <div id="contact-fields" ${contact ? 'hidden' : ''}>
          <label>Kundens namn<input name="name" value="${esc(edit ? lead.customer_name : '')}" autocomplete="off"></label>
          <div class="form-row">
            <label>Telefon<input name="phone" type="tel" value="${esc(edit ? lead.phone : '')}" autocomplete="off" inputmode="tel"></label>
            <label>E-post<input name="email" type="email" value="${esc(edit ? lead.email : '')}" autocomplete="off"></label>
          </div>
          <div class="small muted">Namn, telefon eller e-post räcker.${edit ? ' Ändringar gäller kunden på alla dess leads.' : ''}</div>
          <div id="dup-box"></div>
        </div>
        <div id="chosen-contact" ${contact ? '' : 'hidden'}>${contact ? chosenContactHtml(contact) : ''}</div>
        <input type="hidden" name="contact_id" value="${contact ? contact.id : ''}">
        <div class="field-label">Källa</div>
        <div class="seg seg-wrap">${C.SOURCES.map((s) => `<label><input type="radio" name="source" value="${s.key}" ${(edit ? lead.source : 'other') === s.key ? 'checked' : ''}><span>${s.label}</span></label>`).join('')}</div>
        <label>Bil / titel<input name="vehicle" value="${esc(edit ? lead.vehicle : '')}" placeholder="T.ex. Volvo XC60 B4 2022"></label>
        <label>Kundens förfrågan<textarea name="enquiry" rows="2">${esc(edit ? lead.enquiry : '')}</textarea></label>
        <details ${edit && (lead.reg_number || lead.listing_id || lead.listing_url) ? 'open' : ''}><summary>Regnr och annons (valfritt)</summary>
          <div class="form-row"><label>Regnr<input name="reg_number" value="${esc(edit ? lead.reg_number : '')}" style="text-transform:uppercase"></label>
          <label>Annons-ID<input name="listing_id" value="${esc(edit ? lead.listing_id : '')}"></label></div>
          <label>Annonslänk<input name="listing_url" type="url" value="${esc(edit ? lead.listing_url : '')}" placeholder="https://…"></label>
        </details>
        ${edit ? '' : `<details><summary>Nästa steg (valfritt)</summary>
          <label>Nästa steg<input name="next_action" placeholder="T.ex. Ring upp"></label>
          <div class="chips">${QUICK_DUE.map(([k, t]) => `<button type="button" class="chip" data-action="quick-due" data-k="${k}">${t}</button>`).join('')}</div>
          <label>När<input type="datetime-local" name="next_action_due"></label></details>
          <label class="check"><input type="checkbox" name="claim" value="1"> Jag tar denna lead själv</label>`}
        <div class="form-error" hidden></div>
        <div class="modal-actions"><button type="button" class="btn" data-action="close-modal">Avbryt</button><button class="btn btn-primary" type="submit">${edit ? 'Spara' : 'Skapa lead'}</button></div>
      </form>`, { wide: true });
    const form = $('form', m);
    const check = debounce(async () => {
      const phone = form.phone.value; const email = form.email.value;
      const box = $('#dup-box', m);
      if (!phone && !email) { box.innerHTML = ''; return; }
      try {
        const { matches } = await api('GET', `/api/contacts/match?${qs({ phone, email, exclude: edit ? lead.contact_id : '' })}`);
        box.innerHTML = matches.length ? `<div class="dup-warn"><b>Möjlig befintlig kund</b> – kontrollera innan du sparar. Inget slås ihop automatiskt.
          ${matches.map((c) => `<div class="dup-item"><div><b>${esc(c.name || '–')}</b> · ${esc(c.phone || '')} ${esc(c.email || '')}
            <div class="small">${c.matched_on.map((x) => (x === 'phone' ? 'Samma telefonnummer' : 'Samma e-post')).join(' + ')} · ${c.leads.length} leads: ${c.leads.slice(0, 3).map((x) => `${esc(x.pipeline_name)} (${esc(x.stage_name)})`).join(', ')}</div></div>
            ${edit ? '' : `<button type="button" class="btn btn-sm" data-action="use-contact" data-id="${c.id}">Koppla till denna kund</button>`}</div>`).join('')}
          ${edit ? '' : '<div class="small muted">Vill du hellre skapa en ny kund? Fortsätt bara – en separat förfrågan sparas som egen lead.</div>'}</div>` : '';
      } catch (e) { /* ignore */ }
    }, 300);
    if (form.phone) { form.phone.addEventListener('input', check); form.email.addEventListener('input', check); if (edit) check(); }
    form.onsubmitHandler = async (fd) => {
      if (edit) {
        await api('PATCH', `/api/leads/${lead.id}`, { ...fd, pipeline_id: Number(fd.pipeline_id) });
        closeModal(); toast('Sparat'); route();
      } else {
        if (!fd.contact_id && !fd.name.trim() && !fd.phone.trim() && !fd.email.trim()) throw new Error('Ange kundens namn, telefon eller e-post.');
        const body = { ...fd, pipeline_id: Number(fd.pipeline_id), contact_id: fd.contact_id ? Number(fd.contact_id) : null, claim: !!fd.claim };
        const { lead: created } = await api('POST', '/api/leads', body);
        localStorageSet('lastPipe', String(fd.pipeline_id));
        closeModal(); toast('Lead skapad'); go(`#/lead/${created.id}`);
      }
    };
    m.__useContact = async (id) => {
      const c = (await api('GET', `/api/contacts/${id}`)).contact;
      form.contact_id.value = c.id;
      $('#contact-fields', m).hidden = true;
      const ch = $('#chosen-contact', m); ch.hidden = false; ch.innerHTML = chosenContactHtml(c);
    };
    m.__clearContact = () => {
      form.contact_id.value = '';
      $('#contact-fields', m).hidden = false; $('#chosen-contact', m).hidden = true;
    };
  }
  function chosenContactHtml(c) {
    return `<div class="chosen"><div class="small muted">Befintlig kund</div><b>${esc(c.name || '–')}</b> · ${esc(c.phone || '')} ${esc(c.email || '')}
      <div class="small">Leaden skapas som en separat förfrågan för denna kund.</div><button type="button" class="btn btn-sm btn-ghost" data-action="clear-contact">Byt / ny kund</button></div>`;
  }
  function localStorageGet(k) { try { return localStorage.getItem('crm.' + k); } catch { return null; } }
  function localStorageSet(k, v) { try { localStorage.setItem('crm.' + k, v); } catch { /* ignore */ } }

  // ---------- Customer ----------
  async function viewCustomer(view, id, token) {
    const { contact: c, leads, duplicates } = await api('GET', `/api/contacts/${id}`);
    if (stale(token)) return;
    view.innerHTML = `
      <div class="crumbs"><a href="javascript:history.back()">← Tillbaka</a></div>
      <div class="page-head"><h1>${esc(c.name || c.phone || c.email || 'Okänd kund')} ${c.is_demo ? '<span class="pill pill-demo">Demodata</span>' : ''}</h1>
        <div class="muted">Kund sedan ${esc(TZ.fmtDate(c.created_at))} · ${leads.length} leads</div></div>
      <div class="lead-grid">
        <div class="lead-main">
          <section class="panel"><div class="panel-head"><h2>Leads</h2><button class="btn btn-primary btn-sm" data-action="new-lead" data-contact="${c.id}">+ Ny lead</button></div>
            ${leadRows(leads, 'Inga leads.')}</section>
        </div>
        <aside class="lead-side">
          <section class="panel"><h2>Kontaktuppgifter</h2>
            <form data-form="contact" data-id="${c.id}">
              <label>Namn<input name="name" value="${esc(c.name || '')}"></label>
              <label>Telefon<input name="phone" type="tel" value="${esc(c.phone || '')}"></label>
              ${c.phone && !c.phone_norm ? '<div class="small warn-text">Numret kunde inte tolkas – används inte för dubblettkontroll.</div>' : ''}
              <label>E-post<input name="email" type="email" value="${esc(c.email || '')}"></label>
              <div class="form-error" hidden></div>
              <button class="btn btn-primary" type="submit">Spara</button>
            </form>
            ${duplicates.length ? dupWarning(duplicates) : ''}
          </section>
        </aside>
      </div>`;
    $('[data-form=contact]', view).onsubmitHandler = async (fd) => { await api('PATCH', `/api/contacts/${c.id}`, fd); toast('Kund sparad'); route(); };
  }

  // ---------- Search page ----------
  async function viewSearch(view, query, token) {
    view.innerHTML = `<div class="page-head"><h1>Sök</h1></div>
      <input id="page-search" type="search" class="big-search" placeholder="Namn, telefon, e-post, regnr, bil…" value="${esc(query.q || '')}" autocomplete="off">
      <div id="page-results"></div>`;
    const input = $('#page-search');
    const run = async () => {
      const q = input.value.trim();
      history.replaceState(null, '', `#/sok?q=${encodeURIComponent(q)}`);
      if (q.length < 2) { $('#page-results').innerHTML = '<div class="empty">Skriv minst två tecken.</div>'; return; }
      const { leads } = await api('GET', `/api/search?q=${encodeURIComponent(q)}`);
      if (stale(token) || input.value.trim() !== q) return;
      $('#page-results').innerHTML = `<div class="muted small">${leads.length} träffar</div>${leadRows(leads, 'Inga träffar.')}`;
    };
    input.addEventListener('input', debounce(run, 200));
    if (!isMobile() || query.q) input.focus();
    await run();
  }

  // ---------- Dashboard ----------
  async function viewDashboard(view, query, token) {
    const d = await api('GET', `/api/reports/dashboard?${qs(query)}`);
    if (stale(token)) return;
    const f = d.filters;
    const fq = { from: f.from, to: f.to, pipeline: f.pipeline || '', owner: f.owner || '', source: f.source || '' };
    const link = (metric, extra = {}) => `#/lista?${qs({ metric, ...fq, ...extra })}`;
    const tile = (metric, n, label, sub = '', cls = '') => `<a class="tile ${cls}" href="${link(metric)}"><div class="tile-n">${n}</div><div class="tile-l">${label}</div>${sub ? `<div class="tile-s">${sub}</div>` : ''}</a>`;
    const today = TZ.todayStr();
    const presets = [['7 dagar', TZ.addDaysStr(today, -6), today], ['30 dagar', TZ.addDaysStr(today, -29), today], ['90 dagar', TZ.addDaysStr(today, -89), today],
      ['Denna månad', today.slice(0, 8) + '01', today]];
    const maxLost = Math.max(1, ...d.lostReasons.map((r) => Math.max(r.current, r.previous)));
    const convTable = (rows, keyName) => `<table class="tbl"><thead><tr><th>${keyName}</th><th class="num">Leads</th><th class="num">Vunna</th><th class="num">Förlorade</th><th class="num">Öppna</th><th class="num">Konvertering</th><th class="num" title="Vunna / (vunna + förlorade)">Vinst­andel avslutade</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${esc(r.label)}</td><td class="num"><a href="${link('cohort', keyName === 'Källa' ? { source: r.key } : { owner: r.key })}">${r.total}</a></td>
        <td class="num"><a href="${link('cohort_won', keyName === 'Källa' ? { source: r.key } : { owner: r.key })}">${r.won}</a></td><td class="num">${r.lost}</td><td class="num">${r.open}</td>
        <td class="num"><b>${pct(r.conversion)}</b></td><td class="num">${pct(r.win_rate)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Inga leads</td></tr>'}</tbody></table>`;

    view.innerHTML = `
      <div class="page-head"><h1>Översikt</h1><div class="muted">Period: ${esc(TZ.fmtDate(TZ.dayStart(f.from)))} – ${esc(TZ.fmtDate(TZ.dayStart(f.to)))} (Europe/Stockholm)</div></div>
      <form class="filters dash-filters" data-form="dash">
        <label>Från<input type="date" name="from" value="${f.from}"></label>
        <label>Till<input type="date" name="to" value="${f.to}"></label>
        <label>Pipeline<select name="pipeline"><option value="">Alla</option>${pipelines().map((p) => `<option value="${p.id}" ${f.pipeline === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
        <label>Säljare<select name="owner"><option value="">Alla</option><option value="none" ${f.owner === 'none' ? 'selected' : ''}>Ej tilldelad</option>${sellers().map((u) => `<option value="${u.id}" ${f.owner === u.id ? 'selected' : ''}>${esc(u.name)}${u.active ? '' : ' (inaktiv)'}</option>`).join('')}</select></label>
        <label>Källa<select name="source"><option value="">Alla</option>${C.SOURCES.map((s) => `<option value="${s.key}" ${f.source === s.key ? 'selected' : ''}>${s.label}</option>`).join('')}</select></label>
        <div class="chips">${presets.map(([l, a, b]) => `<button type="button" class="chip ${f.from === a && f.to === b ? 'active' : ''}" data-action="dash-preset" data-from="${a}" data-to="${b}">${l}</button>`).join('')}</div>
      </form>
      <div class="notice">Aktivitetsmått (samtal, mejl, tid till första kontakt) bygger enbart på <b>manuellt registrerad aktivitet</b> och exempeldata i denna version. Ingen e-post eller telefoni är ansluten. Anteckningar och ägarbyten räknas inte som kundkontakt.</div>

      <h2 class="sec">Läget just nu</h2>
      <div class="tiles">
        ${tile('unassigned', d.counts.unassigned, 'Ej tilldelade', d.oldestUnassigned ? `Äldsta: ${esc(TZ.fmtAgo(d.oldestUnassigned.created_at))}` : '', d.counts.unassigned ? 'tile-primary' : '')}
        ${tile('open', d.counts.open, 'Öppna leads')}
        ${tile('overdue', d.counts.overdue, 'Försenade uppföljningar', '', d.counts.overdue ? 'tile-danger' : '')}
        ${tile('due_today', d.counts.due_today, 'Uppföljning kvar idag')}
        ${tile('no_next', d.counts.no_next, 'Tilldelade utan nästa steg', '', d.counts.no_next ? 'tile-warn' : '')}
        ${tile('awaiting', d.counts.awaiting, 'Kund väntar på svar')}
      </div>
      ${d.oldestUnassigned ? `<div class="small muted">Äldsta ej tilldelade: <a href="#/lead/${d.oldestUnassigned.id}">${esc(d.oldestUnassigned.customer_name || '–')} · ${esc(d.oldestUnassigned.vehicle || '')} (${esc(d.oldestUnassigned.pipeline_name)})</a>, inkom ${esc(fmtDT(d.oldestUnassigned.created_at))}</div>` : ''}

      <h2 class="sec">Händelser under perioden</h2>
      <div class="tiles">
        ${tile('new', d.counts.new, 'Nya leads')}
        ${tile('won', d.counts.won, 'Vunna', 'Vinster som skedde under perioden', 'tile-won')}
        ${tile('lost', d.counts.lost, 'Förlorade', 'Exkl. dubblett/spam', 'tile-lost')}
        ${tile('spam', d.counts.spam, 'Dubblett / spam', 'Räknas inte i konvertering')}
      </div>

      <section class="panel">
        <h2>Konvertering – leads skapade under perioden</h2>
        <p class="small muted">Kohort: alla leads som skapades under perioden (exkl. dubblett/spam), <b>inklusive de som fortfarande är öppna</b>. Skiljer sig från "Vunna" ovan, som räknar vinster som inträffade under perioden oavsett när leaden skapades.</p>
        <div class="tiles tiles-sm">
          ${tile('cohort', d.cohort.total, 'Leads i kohorten')}
          ${tile('cohort_won', d.cohort.won, 'Vunna')}
          ${tile('cohort_lost', d.cohort.lost, 'Förlorade')}
          ${tile('cohort_open', d.cohort.open, 'Fortfarande öppna')}
          <div class="tile tile-static"><div class="tile-n">${pct(d.cohort.conversion)}</div><div class="tile-l">Konvertering hittills</div></div>
        </div>
        <div class="two-col">
          <div><h3>Per källa</h3><div class="tbl-wrap">${convTable(d.bySource, 'Källa')}</div></div>
          <div><h3>Per säljare (nuvarande ägare)</h3><div class="tbl-wrap">${convTable(d.bySeller, 'Säljare')}</div></div>
        </div>
      </section>

      <section class="panel">
        <h2>Öppna leads per säljare och steg <span class="muted small">(just nu)</span></h2>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Säljare</th>${d.stageNames.map((s) => `<th class="num">${esc(s)}</th>`).join('')}<th class="num">Totalt</th><th class="num">Försenade</th><th class="num">Idag</th><th class="num">Utan nästa steg</th></tr></thead>
        <tbody>${d.openByOwner.map((o) => { const ow = o.owner_id == null ? 'none' : o.owner_id; return `<tr><td>${esc(o.name)}</td>${d.stageNames.map((s) => `<td class="num">${o.stages[s] ? `<a href="${link('open', { owner: ow, stage_name: s })}">${o.stages[s]}</a>` : '<span class="muted">0</span>'}</td>`).join('')}
          <td class="num"><a href="${link('open', { owner: ow })}"><b>${o.total}</b></a></td><td class="num ${o.overdue ? 'neg' : ''}"><a href="${link('overdue', { owner: ow })}">${o.overdue}</a></td>
          <td class="num"><a href="${link('due_today', { owner: ow })}">${o.due_today}</a></td><td class="num ${o.no_next ? 'warn-text' : ''}">${o.owner_id == null ? '–' : `<a href="${link('no_next', { owner: ow })}">${o.no_next}</a>`}</td></tr>`; }).join('') || '<tr><td class="muted">Inga öppna leads</td></tr>'}</tbody></table></div>
      </section>

      <div class="two-col">
        <section class="panel">
          <h2>Tid till första kontaktförsök</h2>
          <p class="small muted">Från att leaden skapades till första registrerade utgående samtal eller mejl. Leads skapade under perioden.</p>
          <div class="kv"><div><span class="kv-n">${TZ.fmtDuration(d.firstContact.median_min)}</span><span>median</span></div>
            <div><span class="kv-n">${TZ.fmtDuration(d.firstContact.avg_min)}</span><span>snitt</span></div>
            <div><span class="kv-n">${d.firstContact.with_attempt ? Math.round((d.firstContact.within_1h / d.firstContact.with_attempt) * 100) : 0} %</span><span>inom 1 tim</span></div>
            <div><a class="kv-n" href="${link('no_contact')}">${d.firstContact.without_attempt}</a><span>utan försök</span></div></div>
          <table class="tbl"><thead><tr><th>Första kontakt av</th><th class="num">Leads</th><th class="num">Median</th></tr></thead>
            <tbody>${d.firstContact.by_user.map((u) => `<tr><td>${esc(u.name)}</td><td class="num">${u.count}</td><td class="num">${TZ.fmtDuration(u.median_min)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Ingen data</td></tr>'}</tbody></table>
        </section>
        <section class="panel">
          <h2>Registrerad aktivitet under perioden</h2>
          <p class="small muted">Manuellt registrerade samtal och mejl${d.activity.totals.sample ? ` (varav ${d.activity.totals.sample} exempeldata)` : ''}. Samtal och utgående mejl redovisas separat.</p>
          <div class="kv"><div><span class="kv-n">${d.activity.totals.calls_out}</span><span>utgående samtal</span></div><div><span class="kv-n">${d.activity.totals.calls_in}</span><span>inkommande samtal</span></div>
            <div><span class="kv-n">${d.activity.totals.emails_out}</span><span>utgående mejl</span></div></div>
          <table class="tbl"><thead><tr><th>Säljare</th><th class="num">Samtal ut</th><th class="num">Samtal in</th><th class="num">Mejl ut</th></tr></thead>
            <tbody>${d.activity.by_user.map((u) => `<tr><td>${esc(u.name)}</td><td class="num">${u.calls_out}</td><td class="num">${u.calls_in}</td><td class="num">${u.emails_out}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Ingen aktivitet</td></tr>'}</tbody></table>
        </section>
      </div>

      <section class="panel">
        <h2>Förlustorsaker</h2>
        <p class="small muted">Förlorade under perioden jämfört med föregående lika lång period (${esc(TZ.fmtDate(TZ.dayStart(f.prev_from)))} – ${esc(TZ.fmtDate(TZ.dayStart(f.prev_to)))}).</p>
        <div class="bars">${d.lostReasons.map((r) => `<a class="bar-row" href="${link(r.key === 'duplicate' ? 'spam' : 'lost', { reason: r.key })}">
          <span class="bar-l">${esc(r.label)}</span>
          <span class="bar-track"><span class="bar bar-cur" style="width:${(r.current / maxLost) * 100}%"></span><span class="bar bar-prev" style="width:${(r.previous / maxLost) * 100}%"></span></span>
          <span class="bar-n"><b>${r.current}</b> <span class="muted">(${r.previous})</span> ${r.current > r.previous ? '<span class="neg">▲</span>' : r.current < r.previous ? '<span class="pos">▼</span>' : ''}</span></a>`).join('')}</div>
        <div class="legend small"><span class="lg lg-cur"></span> Perioden <span class="lg lg-prev"></span> Föregående period</div>
      </section>`;
    const form = $('[data-form=dash]', view);
    $$('input,select', form).forEach((el) => el.addEventListener('change', () => go(`#/oversikt?${qs(Object.fromEntries(new FormData(form)))}`)));
    view.__dashForm = form;
  }

  async function viewMetricList(view, query, token) {
    const d = await api('GET', `/api/reports/leads?${qs(query)}`);
    if (stale(token)) return;
    const back = qs({ from: query.from, to: query.to, pipeline: query.pipeline, owner: query.owner, source: query.source });
    const extra = [];
    if (query.owner) extra.push(query.owner === 'none' ? 'Ej tilldelad' : (S.meta.users.find((u) => String(u.id) === query.owner) || {}).name);
    if (query.pipeline) extra.push((pipelines().find((p) => String(p.id) === query.pipeline) || {}).name);
    if (query.source) extra.push(srcLabel(query.source));
    if (query.stage_name) extra.push(query.stage_name);
    if (query.reason) extra.push(reasonLabel(query.reason));
    view.innerHTML = `<div class="crumbs"><a href="#/oversikt?${back}">← Översikt</a></div>
      <div class="page-head"><h1>${esc(d.label)} <span class="count">${d.leads.length}</span></h1>
      <div class="muted">${esc(query.from || '')} – ${esc(query.to || '')}${extra.length ? ' · ' + extra.filter(Boolean).map(esc).join(' · ') : ''}</div></div>
      ${leadRowsWithOwner(d.leads)}`;
  }
  function leadRowsWithOwner(leads) {
    if (!leads.length) return '<div class="empty">Inga leads.</div>';
    return `<div class="tbl-wrap"><table class="tbl tbl-leads"><thead><tr><th>Kund</th><th>Bil</th><th>Pipeline</th><th>Steg</th><th>Ägare</th><th>Källa</th><th>Skapad</th><th>Nästa steg</th></tr></thead><tbody>
      ${leads.map((l) => `<tr data-href="#/lead/${l.id}" class="${l.overdue ? 'row-overdue' : ''}"><td><a href="#/lead/${l.id}"><b>${esc(l.customer_name || l.phone || l.email || '–')}</b></a></td><td>${esc(l.vehicle || '')}</td>
        <td>${esc(l.pipeline_name)}</td><td>${esc(l.stage_name)} ${outcomeBadge(l)}</td><td>${esc(l.owner_name || 'Ej tilldelad')}</td><td>${esc(srcLabel(l.source))}</td><td>${esc(fmtDT(l.created_at))}</td><td>${dueHtml(l)}</td></tr>`).join('')}
      </tbody></table></div>`;
  }

  // ---------- Admin ----------
  async function viewAdmin(view, query, token) {
    if (!isAdmin()) { view.innerHTML = '<div class="empty error">Endast för Direktör / Admin.</div>'; return; }
    const tab = query.tab || 'users';
    const tabs = `<div class="tabs">${[['users', 'Användare'], ['pipelines', 'Pipelines'], ['demo', 'Demodata']].map(([k, l]) => `<a class="tab ${tab === k ? 'active' : ''}" href="#/admin?tab=${k}">${l}</a>`).join('')}</div>`;
    if (tab === 'users') {
      const { users } = await api('GET', '/api/admin/users');
      if (stale(token)) return;
      view.innerHTML = `<div class="page-head"><h1>Admininställningar</h1></div>${tabs}
        <section class="panel"><h2>Användare</h2>
          <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Namn</th><th>E-post</th><th>Roll</th><th>Status</th><th class="num">Öppna leads</th><th></th></tr></thead><tbody>
          ${users.map((u) => `<tr class="${u.active ? '' : 'inactive'}"><td>${esc(u.name)}</td><td>${esc(u.email)}</td>
            <td><select data-action-change="user-role" data-id="${u.id}" ${u.id === S.me.id ? 'disabled' : ''}>${C.ROLES.map((r) => `<option value="${r.key}" ${u.role === r.key ? 'selected' : ''}>${r.label}</option>`).join('')}</select></td>
            <td>${u.active ? '<span class="pill pill-won">Aktiv</span>' : `<span class="pill pill-warn">Inaktiv</span>`}</td>
            <td class="num">${u.open_leads ? `<a href="#/pipelines?owner=${u.id}">${u.open_leads}</a>` : 0}${!u.active && u.open_leads ? ' <span class="warn-text small">– tilldela om</span>' : ''}</td>
            <td class="actions">${u.id === S.me.id ? '<span class="muted small">Du</span>' : `<button class="btn btn-sm" data-action="user-active" data-id="${u.id}" data-active="${u.active ? 0 : 1}">${u.active ? 'Inaktivera' : 'Aktivera'}</button>`}
              <button class="btn btn-sm btn-ghost" data-action="user-password" data-id="${u.id}" data-name="${esc(u.name)}">Nytt lösenord</button></td></tr>`).join('')}
          </tbody></table></div>
          <p class="small muted">Inaktiverade användare kan inte logga in. Deras historik och aktiviteter finns kvar.</p>
        </section>
        <section class="panel"><h2>Skapa användare</h2>
          <form data-form="new-user" class="form-grid">
            <label>Namn<input name="name" required></label><label>E-post (inloggning)<input name="email" type="email" required></label>
            <label>Roll<select name="role">${C.ROLES.map((r) => `<option value="${r.key}" ${r.key === 'sales' ? 'selected' : ''}>${r.label}</option>`).join('')}</select></label>
            <label>Lösenord<input name="password" type="text" minlength="6" required placeholder="minst 6 tecken"></label>
            <div class="form-error" hidden></div>
            <div><button class="btn btn-primary" type="submit">Skapa användare</button></div>
          </form>
          <p class="small muted">Inga inbjudningsmejl skickas. Ge personen e-post och lösenord direkt.</p>
        </section>`;
      $('[data-form=new-user]', view).onsubmitHandler = async (fd) => { await api('POST', '/api/admin/users', fd); toast('Användare skapad'); await refreshMeta(); route(); };
    } else if (tab === 'pipelines') {
      const { pipelines: ps } = await api('GET', '/api/admin/pipelines');
      if (stale(token)) return;
      view.innerHTML = `<div class="page-head"><h1>Admininställningar</h1></div>${tabs}
        <p class="muted">Steg kan heta olika i olika pipelines. Utfallet (Öppen / Vunnen / Förlorad) styr rapporteringen – inte stegets namn. Arkiverade steg och pipelines döljs men all historik finns kvar.</p>
        ${ps.map((p, pi) => `<section class="panel ${p.archived_at ? 'archived' : ''}">
          <div class="panel-head"><h2>${esc(p.name)} ${p.archived_at ? '<span class="pill pill-warn">Arkiverad</span>' : ''} <span class="muted small">${esc(p.description || '')}</span></h2>
            <div class="btn-row">
              <button class="btn btn-sm btn-ghost" data-action="pipe-move" data-id="${p.id}" data-dir="-1" ${pi === 0 ? 'disabled' : ''} title="Flytta upp">↑</button>
              <button class="btn btn-sm btn-ghost" data-action="pipe-move" data-id="${p.id}" data-dir="1" ${pi === ps.length - 1 ? 'disabled' : ''} title="Flytta ner">↓</button>
              <button class="btn btn-sm" data-action="pipe-rename" data-id="${p.id}" data-name="${esc(p.name)}">Byt namn</button>
              <button class="btn btn-sm" data-action="pipe-archive" data-id="${p.id}" data-archived="${p.archived_at ? 0 : 1}">${p.archived_at ? 'Återställ' : 'Arkivera'}</button></div></div>
          <div class="tbl-wrap"><table class="tbl stage-tbl"><thead><tr><th>Ordning</th><th>Steg</th><th>Utfall</th><th class="num">Leads</th><th></th></tr></thead><tbody>
            ${p.stages.map((s, i) => `<tr class="${s.archived_at ? 'inactive' : ''}"><td class="nowrap">
                <button class="btn btn-sm btn-ghost" data-action="stage-move" data-pipe="${p.id}" data-id="${s.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''}>↑</button>
                <button class="btn btn-sm btn-ghost" data-action="stage-move" data-pipe="${p.id}" data-id="${s.id}" data-dir="1" ${i === p.stages.length - 1 ? 'disabled' : ''}>↓</button></td>
              <td>${esc(s.name)} ${s.archived_at ? '<span class="pill pill-warn">Arkiverat</span>' : ''}</td>
              <td><select data-action-change="stage-outcome" data-id="${s.id}" ${s.lead_count ? 'disabled title="Steget har leads – utfallet kan inte ändras"' : ''}>${C.OUTCOMES.map((o) => `<option value="${o.key}" ${s.outcome === o.key ? 'selected' : ''}>${o.label}</option>`).join('')}</select></td>
              <td class="num">${s.lead_count}</td>
              <td class="actions"><button class="btn btn-sm" data-action="stage-rename" data-id="${s.id}" data-name="${esc(s.name)}">Byt namn</button>
                <button class="btn btn-sm btn-ghost" data-action="stage-archive" data-id="${s.id}" data-archived="${s.archived_at ? 0 : 1}">${s.archived_at ? 'Återställ' : 'Arkivera'}</button></td></tr>`).join('')}
          </tbody></table></div>
          <form data-form="add-stage" data-id="${p.id}" class="inline-form"><input name="name" placeholder="Nytt steg" required>
            <select name="outcome">${C.OUTCOMES.map((o) => `<option value="${o.key}">${o.label}</option>`).join('')}</select><button class="btn btn-sm" type="submit">Lägg till steg</button><div class="form-error" hidden></div></form>
        </section>`).join('')}
        <section class="panel"><h2>Ny pipeline</h2>
          <form data-form="add-pipe" class="inline-form"><input name="name" placeholder="Namn, t.ex. nytt varumärke" required><input name="description" placeholder="Beskrivning (valfri)"><button class="btn btn-primary btn-sm" type="submit">Skapa</button><div class="form-error" hidden></div></form>
          <p class="small muted">Nya pipelines får standardstegen, som du sedan kan byta namn på.</p></section>`;
      view.__pipes = ps;
      $$('[data-form=add-stage]', view).forEach((f) => { f.onsubmitHandler = async (fd) => { await api('POST', `/api/admin/pipelines/${f.dataset.id}/stages`, fd); await refreshMeta(); route(); }; });
      $('[data-form=add-pipe]', view).onsubmitHandler = async (fd) => { await api('POST', '/api/admin/pipelines', fd); toast('Pipeline skapad'); await refreshMeta(); route(); };
    } else {
      view.innerHTML = `<div class="page-head"><h1>Admininställningar</h1></div>${tabs}
        <section class="panel"><h2>Återställ demodata</h2>
          <p>All data i denna lokala databas ersätts med ny syntetisk demodata: leads, kunder, aktiviteter, pipelines <b>och användare</b> (även sådana du skapat själv). Alla loggas ut.</p>
          ${S.meta.demo.seeded_at ? `<p class="small muted">Demodata laddades senast ${esc(fmtDT(S.meta.demo.seeded_at))}.</p>` : ''}
          <form data-form="reset-demo" class="inline-form"><input name="confirm" placeholder="Skriv ÅTERSTÄLL" autocomplete="off" required><button class="btn btn-danger" type="submit">Återställ demodata</button><div class="form-error" hidden></div></form>
        </section>`;
      $('[data-form=reset-demo]', view).onsubmitHandler = async (fd) => {
        if (fd.confirm !== 'ÅTERSTÄLL') throw new Error('Skriv ÅTERSTÄLL (versaler) för att bekräfta.');
        if (!confirm('Är du säker? All lokal data ersätts med demodata.')) return;
        await api('POST', '/api/admin/reset-demo', { confirm: fd.confirm });
        S.me = null; location.hash = ''; renderLogin(); toast('Demodata återställd. Logga in igen.');
      };
    }
  }

  async function promptName(title, current) {
    const v = window.prompt(title, current || '');
    return v == null ? null : v.trim();
  }

  // ---------- global events ----------
  const actions = {
    'fill-login': (el) => { const f = $('[data-form=login]'); f.email.value = el.dataset.email; f.password.value = 'demo1234'; f.password.focus(); },
    logout: async () => { await api('POST', '/api/logout', {}); S.me = null; location.hash = ''; renderLogin(); },
    'toggle-usermenu': () => { const p = $('.usermenu-pop'); p.hidden = !p.hidden; },
    'close-modal': () => closeModal(),
    'close-modal-bg': (el, e) => { if (e.target === el) closeModal(); },
    'new-lead': (el) => leadFormModal({ contactId: el.dataset.contact || null }).catch(fail),
    'edit-lead': () => leadFormModal({ lead: $('#view').__lead }).catch(fail),
    'use-contact': (el) => $('.modal').__useContact(el.dataset.id).catch(fail),
    'clear-contact': () => $('.modal').__clearContact(),
    claim: (el, e) => { e.preventDefault(); e.stopPropagation(); el.disabled = true; claim(el.dataset.id, $('#board') ? () => loadBoard(S.routeToken) : null); },
    release: async (el) => { if (!confirm('Släppa leaden så att den blir ej tilldelad?')) return; try { await api('POST', `/api/leads/${el.dataset.id}/release`, {}); toast('Leaden släppt'); route(); } catch (e) { fail(e); } },
    stage: async (el) => {
      const l = $('#view').__lead;
      const stageId = Number(el.dataset.stage);
      const d = await api('GET', `/api/leads/${l.id}`).catch(fail);
      if (d) moveLead(l.id, stageId, d.stages, () => route());
    },
    'board-pipe': (el) => { boardState = { ...boardState, p: Number(el.dataset.id), stage: '' }; go(`#/pipelines?${qs({ ...boardState, p: el.dataset.id, stage: '' })}`); },
    'board-stage': (el) => { boardState.stage = el.dataset.id; syncBoardUrl(); $$('.stage-chips .chip').forEach((c) => c.classList.toggle('active', c === el)); $$('.board .col').forEach((c) => c.classList.toggle('mobile-active', c.dataset.stage === el.dataset.id)); },
    'complete-next': () => { $('#next-form').innerHTML = nextForm({ complete: true, l: $('#view').__lead }); bindNextForm(true); },
    'edit-next': () => { $('#next-form').innerHTML = nextForm({ complete: false, l: $('#view').__lead }); bindNextForm(false); },
    'cancel-next': () => { $('#next-form').innerHTML = ''; },
    'quick-due': (el) => { const f = el.closest('form'); const inp = f.due || f.next_action_due; inp.value = quickDue(el.dataset.k); $$('.chip', el.parentElement).forEach((c) => c.classList.toggle('active', c === el)); const t = f.text || f.next_action; if (t && !t.value) t.value = 'Följ upp'; },
    'dash-preset': (el) => { const f = $('[data-form=dash]'); f.from.value = el.dataset.from; f.to.value = el.dataset.to; go(`#/oversikt?${qs(Object.fromEntries(new FormData(f)))}`); },
    'user-active': async (el) => { const act = el.dataset.active === '1'; if (!act && !confirm('Inaktivera användaren? Personen loggas ut och kan inte logga in. Historiken sparas.')) return; try { await api('PATCH', `/api/admin/users/${el.dataset.id}`, { active: act }); toast(act ? 'Aktiverad' : 'Inaktiverad'); await refreshMeta(); route(); } catch (e) { fail(e); } },
    'user-password': async (el) => { const pw = window.prompt(`Nytt lösenord för ${el.dataset.name} (minst 6 tecken):`); if (!pw) return; try { await api('PATCH', `/api/admin/users/${el.dataset.id}`, { password: pw }); toast('Lösenord uppdaterat'); } catch (e) { fail(e); } },
    'pipe-rename': async (el) => { const n = await promptName('Nytt namn på pipelinen:', el.dataset.name); if (!n) return; try { await api('PATCH', `/api/admin/pipelines/${el.dataset.id}`, { name: n }); await refreshMeta(); route(); } catch (e) { fail(e); } },
    'pipe-archive': async (el) => { const a = el.dataset.archived === '1'; if (a && !confirm('Arkivera pipelinen? Den döljs från tavlan och för nya leads. Befintliga leads och historik finns kvar.')) return; try { await api('PATCH', `/api/admin/pipelines/${el.dataset.id}`, { archived: a }); await refreshMeta(); route(); } catch (e) { fail(e); } },
    'pipe-move': async (el) => { const ps = $('#view').__pipes; const ids = ps.map((p) => p.id); const i = ids.indexOf(Number(el.dataset.id)); const j = i + Number(el.dataset.dir); [ids[i], ids[j]] = [ids[j], ids[i]]; try { await api('POST', '/api/admin/pipelines/reorder', { ids }); await refreshMeta(); route(); } catch (e) { fail(e); } },
    'stage-move': async (el) => { const p = $('#view').__pipes.find((x) => x.id === Number(el.dataset.pipe)); const ids = p.stages.map((s) => s.id); const i = ids.indexOf(Number(el.dataset.id)); const j = i + Number(el.dataset.dir); [ids[i], ids[j]] = [ids[j], ids[i]]; try { await api('PATCH', `/api/admin/pipelines/${p.id}`, { stage_order: ids }); await refreshMeta(); route(); } catch (e) { fail(e); } },
    'stage-rename': async (el) => { const n = await promptName('Nytt namn på steget:', el.dataset.name); if (!n) return; try { await api('PATCH', `/api/admin/stages/${el.dataset.id}`, { name: n }); await refreshMeta(); route(); } catch (e) { fail(e); } },
    'stage-archive': async (el) => { try { await api('PATCH', `/api/admin/stages/${el.dataset.id}`, { archived: el.dataset.archived === '1' }); await refreshMeta(); route(); } catch (e) { fail(e); } },
  };
  const changeActions = {
    assign: async (el) => { if (!el.value) return; try { await api('POST', `/api/leads/${el.dataset.id}/assign`, { owner_id: el.value === 'none' ? null : Number(el.value) }); toast('Leaden tilldelades'); route(); } catch (e) { fail(e); el.value = ''; } },
    'user-role': async (el) => { try { await api('PATCH', `/api/admin/users/${el.dataset.id}`, { role: el.value }); toast('Roll ändrad'); await refreshMeta(); } catch (e) { fail(e); route(); } },
    'stage-outcome': async (el) => { try { await api('PATCH', `/api/admin/stages/${el.dataset.id}`, { outcome: el.value }); toast('Utfall ändrat'); await refreshMeta(); } catch (e) { fail(e); route(); } },
  };

  function bindNextForm(complete) {
    const form = $('#next-form form');
    const l = $('#view').__lead;
    form.onsubmitHandler = async (fd, f, submitter) => {
      if (complete) {
        const none = submitter && submitter.name === 'none';
        await api('POST', `/api/leads/${l.id}/next-action/complete`, { result: fd.result, next_text: none ? '' : fd.text, next_due: none ? '' : fd.due });
        toast('Klart! Sparat i tidslinjen.');
      } else {
        const clear = submitter && submitter.name === 'clear';
        if (!clear && !fd.text.trim() && !fd.due) throw new Error('Skriv vad nästa steg är eller välj en tid.');
        await api('PUT', `/api/leads/${l.id}/next-action`, clear ? { text: '', due: '' } : { text: fd.text, due: fd.due });
        toast(clear ? 'Nästa steg borttaget' : 'Nästa steg sparat');
      }
      route();
    };
    const t = form.text; if (t && !isMobile()) t.focus();
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) {
      const tr = e.target.closest('tr[data-href]');
      if (tr && !e.target.closest('a')) go(tr.dataset.href);
      return;
    }
    const fn = actions[el.dataset.action];
    if (fn) { if (el.tagName === 'A') e.preventDefault(); fn(el, e); }
  });
  document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-action-change]');
    if (el && changeActions[el.dataset.actionChange]) changeActions[el.dataset.actionChange](el, e);
  });
  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const err = $('.form-error', form);
    if (err) err.hidden = true;
    const fd = Object.fromEntries(new FormData(form));
    if (form.dataset.form === 'login') {
      try {
        const r = await api('POST', '/api/login', fd);
        S.me = r.user; app.innerHTML = ''; await boot();
      } catch (ex) { const le = $('.login-error'); le.textContent = ex.message; le.hidden = false; }
      return;
    }
    if (!form.onsubmitHandler) return;
    const btns = $$('button[type=submit], button:not([type])', form);
    btns.forEach((b) => { b.disabled = true; });
    try { await form.onsubmitHandler(fd, form, e.submitter); } catch (ex) {
      if (err) { err.textContent = ex.message; err.hidden = false; } else fail(ex);
    } finally { btns.forEach((b) => { b.disabled = false; }); }
  });

  boot();
})();
