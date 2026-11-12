// Phone / email normalisation used for duplicate warnings and search.
// Swedish numbers in local (070…), +46 and 0046 formats normalise to the same E.164 value (+4670…).
// International numbers are kept as +<country><number>. Anything ambiguous or invalid returns null,
// so it can never produce a false match. The original display value is always stored separately.
(function (root) {
  function normalizePhone(raw) {
    if (raw == null) return null;
    let s = String(raw).trim();
    if (!s) return null;
    if (/[^\d\s+\-().\/]/.test(s)) return null; // letters or odd characters -> not a phone number
    s = s.replace(/\(0\)/g, ''); // "+46 (0)70 …"
    const plus = s.startsWith('+');
    if (s.indexOf('+') > 0 || (s.match(/\+/g) || []).length > 1) return null;
    const digits = s.replace(/\D/g, '');
    let intl;
    if (plus) intl = digits;
    else if (digits.startsWith('00')) intl = digits.slice(2);
    else if (digits.startsWith('0')) intl = '46' + digits.slice(1);
    else return null; // no country / trunk prefix: ambiguous
    if (intl.startsWith('46')) {
      let nat = intl.slice(2);
      if (nat.startsWith('0')) nat = nat.slice(1); // "+46 070…" written by mistake
      if (!/^[1-9]\d{6,8}$/.test(nat)) return null;
      if (nat.startsWith('7') && nat.length !== 9) return null; // Swedish mobiles: 07X XXX XX XX
      return '+46' + nat;
    }
    if (!/^[1-9]\d{6,14}$/.test(intl)) return null;
    return '+' + intl;
  }

  function normalizeEmail(raw) {
    if (raw == null) return null;
    const s = String(raw).trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
  }

  function normalizeReg(raw) {
    if (raw == null) return null;
    const s = String(raw).toUpperCase().replace(/[\s-]/g, '');
    return s || null;
  }

  const api = { normalizePhone, normalizeEmail, normalizeReg };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Phone = api;
})(typeof window !== 'undefined' ? window : globalThis);
