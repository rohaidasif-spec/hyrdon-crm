const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePhone, normalizeEmail, normalizeReg } = require('../shared/phone');
const T = require('../shared/time');

test('Swedish local, +46 and 0046 formats normalise to the same value', () => {
  const variants = ['070-123 45 67', '0701234567', '+46 70 123 45 67', '+46701234567', '0046 70 123 45 67', '0046701234567', '+46 (0)70-123 45 67', '070.123.45.67', '(070) 123 45 67'];
  for (const v of variants) assert.equal(normalizePhone(v), '+46701234567', v);
});

test('Swedish landlines normalise', () => {
  assert.equal(normalizePhone('08-123 456 78'), '+46812345678');
  assert.equal(normalizePhone('+46 8 123 456 78'), '+46812345678');
  assert.equal(normalizePhone('031-12 34 56'), '+4631123456');
});

test('international numbers are preserved, not turned into Swedish numbers', () => {
  assert.equal(normalizePhone('+47 912 34 567'), '+4791234567');
  assert.equal(normalizePhone('0047 912 34 567'), '+4791234567');
  assert.equal(normalizePhone('+1 (212) 555-0100'), '+12125550100');
  assert.notEqual(normalizePhone('+47 912 34 567'), normalizePhone('0912 34 567'));
});

test('invalid or ambiguous numbers return null so they can never match', () => {
  for (const v of ['', '   ', null, undefined, '123', '070-12', 'abc', '0701234567890', 'ring mig', '070 123 45 67 ankn 12', '+46 70 12', '12345678', '+', '00', '0', '+46 70 123 45 6']) {
    assert.equal(normalizePhone(v), null, String(v));
  }
});

test('email and registration normalisation', () => {
  assert.equal(normalizeEmail('  Anna.Svensson@Example.COM '), 'anna.svensson@example.com');
  assert.equal(normalizeEmail('not-an-email'), null);
  assert.equal(normalizeReg('abc 12d'), 'ABC12D');
  assert.equal(normalizeReg('ABC-123'), 'ABC123');
});

test('Europe/Stockholm day boundaries handle DST', () => {
  // Winter (CET, UTC+1)
  assert.equal(T.dayStart('2026-01-15').toISOString(), '2026-01-14T23:00:00.000Z');
  // Summer (CEST, UTC+2)
  assert.equal(T.dayStart('2026-07-15').toISOString(), '2026-07-14T22:00:00.000Z');
  // DST switch day in March: midnight is still CET
  assert.equal(T.dayStart('2026-03-29').toISOString(), '2026-03-28T23:00:00.000Z');
  assert.equal(T.dayStart('2026-03-30').toISOString(), '2026-03-29T22:00:00.000Z');
  // A UTC instant late on 31 Dec is already 1 Jan in Stockholm
  assert.equal(T.dateStr('2026-12-31T23:30:00Z'), '2027-01-01');
  assert.equal(T.parseLocal('2026-11-12T09:00').toISOString(), '2026-11-12T08:00:00.000Z');
});
