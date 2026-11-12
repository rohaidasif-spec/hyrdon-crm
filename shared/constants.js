// Labels and enumerations shared by server and browser. Keys are stable (English); labels are Swedish.
(function (root) {
  const SOURCES = [
    { key: 'blocket', label: 'Blocket' },
    { key: 'website', label: 'Webbplats' },
    { key: 'phone', label: 'Telefon' },
    { key: 'email', label: 'E-post' },
    { key: 'other', label: 'Övrigt' },
  ];
  const LOST_REASONS = [
    { key: 'price', label: 'Pris / månadskostnad' },
    { key: 'unavailable', label: 'Bilen inte tillgänglig' },
    { key: 'other_seller', label: 'Valde annan säljare' },
    { key: 'timing', label: 'Timing / inte redo' },
    { key: 'financing', label: 'Finansiering / kreditprövning' },
    { key: 'unreachable', label: 'Fick inte tag på kunden' },
    { key: 'duplicate', label: 'Dubblett / spam' },
    { key: 'other', label: 'Annat' },
  ];
  const CALL_OUTCOMES = [
    { key: 'answered', label: 'Svarade' },
    { key: 'no_answer', label: 'Inget svar' },
    { key: 'voicemail', label: 'Röstbrevlåda' },
    { key: 'busy', label: 'Upptaget' },
    { key: 'wrong_number', label: 'Fel nummer' },
  ];
  const ROLES = [
    { key: 'admin', label: 'Direktör / Admin' },
    { key: 'sales', label: 'Säljare' },
  ];
  const OUTCOMES = [
    { key: 'open', label: 'Öppen' },
    { key: 'won', label: 'Vunnen' },
    { key: 'lost', label: 'Förlorad' },
  ];
  const DEFAULT_STAGES = [
    { name: 'Ny', outcome: 'open' },
    { name: 'Kontaktförsök', outcome: 'open' },
    { name: 'Kontakt etablerad', outcome: 'open' },
    { name: 'Såld / Avtal klart', outcome: 'won' },
    { name: 'Levererad', outcome: 'won' },
    { name: 'Förlorad / Ej aktuell', outcome: 'lost' },
  ];
  const label = (list, key) => (list.find((x) => x.key === key) || {}).label || key || '';
  const api = { SOURCES, LOST_REASONS, CALL_OUTCOMES, ROLES, OUTCOMES, DEFAULT_STAGES, label };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.C = api;
})(typeof window !== 'undefined' ? window : globalThis);
