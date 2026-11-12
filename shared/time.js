// Europe/Stockholm date helpers shared by server and browser.
// All timestamps are stored as UTC ISO strings; display and day boundaries use Stockholm time.
(function (root) {
  const TZ = 'Europe/Stockholm';
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  });
  const WD = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

  function toDate(v) { return v instanceof Date ? v : new Date(v); }

  function parts(v) {
    const p = {};
    for (const x of dtf.formatToParts(toDate(v))) p[x.type] = x.value;
    return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second, wd: WD[p.weekday] };
  }

  function offsetMinutes(v) {
    const d = toDate(v);
    const p = parts(d);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
  }

  // Wall-clock time in Stockholm -> Date
  function zonedToUtc(y, m, d, h = 0, mi = 0) {
    const guess = Date.UTC(y, m - 1, d, h, mi);
    const off = offsetMinutes(new Date(guess));
    let t = guess - off * 60000;
    const off2 = offsetMinutes(new Date(t));
    if (off2 !== off) t = guess - off2 * 60000;
    return new Date(t);
  }

  const pad = (n) => String(n).padStart(2, '0');

  function dateStr(v) { const p = parts(v); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; }
  function timeStr(v) { const p = parts(v); return `${pad(p.h)}:${pad(p.mi)}`; }
  function inputValue(v) { return v ? `${dateStr(v)}T${timeStr(v)}` : ''; }

  // 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:mm' interpreted as Stockholm time
  function parseLocal(s) {
    if (!s) return null;
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/);
    if (!m) return null;
    return zonedToUtc(+m[1], +m[2], +m[3], m[4] ? +m[4] : 9, m[5] ? +m[5] : 0);
  }

  function addDaysStr(s, n) {
    const [y, m, d] = s.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  }

  function dayStart(s) { const [y, m, d] = s.split('-').map(Number); return zonedToUtc(y, m, d, 0, 0); }
  function todayStr(now) { return dateStr(now || new Date()); }
  function startOfToday(now) { return dayStart(todayStr(now)); }
  function startOfTomorrow(now) { return dayStart(addDaysStr(todayStr(now), 1)); }

  function fmtDate(v) { if (!v) return ''; const p = parts(v); return `${p.d} ${MONTHS[p.m - 1]}${p.y !== parts(new Date()).y ? ' ' + p.y : ''}`; }

  function fmtDateTime(v, now) {
    if (!v) return '';
    const today = todayStr(now);
    const ds = dateStr(v);
    let day;
    if (ds === today) day = 'idag';
    else if (ds === addDaysStr(today, -1)) day = 'igår';
    else if (ds === addDaysStr(today, 1)) day = 'imorgon';
    else day = fmtDate(v);
    return `${day} ${timeStr(v)}`;
  }

  function fmtAgo(v, now) {
    if (!v) return '';
    const diff = (toDate(now || new Date()) - toDate(v)) / 60000;
    if (diff < 1) return 'nyss';
    if (diff < 60) return `${Math.round(diff)} min sedan`;
    if (diff < 60 * 24) return `${Math.round(diff / 60)} tim sedan`;
    const days = Math.round(diff / 1440);
    if (days < 30) return `${days} d sedan`;
    return fmtDate(v);
  }

  function fmtDuration(minutes) {
    if (minutes == null || isNaN(minutes)) return '–';
    if (minutes < 60) return `${Math.round(minutes)} min`;
    if (minutes < 60 * 48) return `${(minutes / 60).toFixed(1).replace('.', ',')} tim`;
    return `${(minutes / 1440).toFixed(1).replace('.', ',')} dagar`;
  }

  const api = { TZ, parts, zonedToUtc, dateStr, timeStr, inputValue, parseLocal, addDaysStr, dayStart, todayStr,
    startOfToday, startOfTomorrow, fmtDate, fmtDateTime, fmtAgo, fmtDuration, offsetMinutes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TZ = api;
})(typeof window !== 'undefined' ? window : globalThis);
