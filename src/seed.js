// Synthetic demo data. Every person, phone number, e-mail and conversation here is fictional.
// E-mail addresses use the reserved example.com domain; listing URLs use the reserved .invalid TLD.
const { tx, wipe } = require('./db');
const { hashPassword } = require('./auth');
const { normalizePhone, normalizeEmail, normalizeReg } = require('../shared/phone');
const C = require('../shared/constants');
const T = require('../shared/time');

const DEMO_PASSWORD = 'demo1234';
const DEMO_USERS = [
  { name: 'Karin Ek', email: 'karin@demo.local', role: 'admin' },
  { name: 'Johan Berg', email: 'johan@demo.local', role: 'sales' },
  { name: 'Sara Lind', email: 'sara@demo.local', role: 'sales' },
  { name: 'Ahmed Haddad', email: 'ahmed@demo.local', role: 'sales' },
  { name: 'Emma Nyström', email: 'emma@demo.local', role: 'sales' },
  { name: 'Oskar Holm', email: 'oskar@demo.local', role: 'sales' },
  { name: 'Lina Sjöberg', email: 'lina@demo.local', role: 'sales' },
  { name: 'Mikael Ström', email: 'mikael@demo.local', role: 'sales', inactive: true },
];
const PIPELINES = [
  { name: 'Hyrdon', description: 'Leasing / bilabonnemang' },
  { name: 'Premium Motors', description: 'Bilförsäljning (tidigare "Sales")' },
  { name: 'American Motors', description: 'Amerikanska bilar' },
];

function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const FIRST = ['Anders', 'Maria', 'Erik', 'Elin', 'Lars', 'Sofia', 'Karl', 'Ida', 'Mats', 'Hanna', 'Jonas', 'Frida', 'Niklas', 'Malin', 'Patrik', 'Jenny',
  'Fredrik', 'Linnea', 'Daniel', 'Camilla', 'Mohammed', 'Fatima', 'Ali', 'Leila', 'Viktor', 'Moa', 'Henrik', 'Therese', 'Gustav', 'Amanda', 'Stefan', 'Josefin',
  'Tobias', 'Matilda', 'Marcus', 'Sanna', 'Robin', 'Nora', 'Kristoffer', 'Elsa'];
const LAST = ['Johansson', 'Karlsson', 'Nilsson', 'Eriksson', 'Larsson', 'Olsson', 'Persson', 'Gustafsson', 'Pettersson', 'Jonsson', 'Jansson', 'Hansson',
  'Bengtsson', 'Lindberg', 'Jakobsson', 'Magnusson', 'Lindström', 'Axelsson', 'Lundgren', 'Mattsson', 'Berglund', 'Sandberg', 'Forsberg', 'Holmberg', 'Hussein', 'Yilmaz', 'Novak', 'Ali'];

const VEHICLES = {
  Hyrdon: ['Volvo EX30 – privatleasing 36 mån', 'Kia EV6 – bilabonnemang', 'Tesla Model Y – privatleasing 24 mån', 'Volkswagen ID.4 – företagsleasing', 'Polestar 2 – bilabonnemang',
    'Toyota RAV4 Hybrid – privatleasing', 'Skoda Enyaq – företagsleasing 36 mån', 'BMW i4 – privatleasing', 'MG4 – bilabonnemang', 'Volvo XC40 Recharge – företagsleasing'],
  'Premium Motors': ['BMW X5 xDrive45e 2021', 'Mercedes-Benz GLC 300e 2022', 'Audi Q7 55 TFSI 2020', 'Porsche Macan S 2019', 'Volvo XC90 T8 Inscription 2022',
    'Audi e-tron 55 2021', 'Mercedes-Benz E 220d 2020', 'BMW 530e Touring 2021', 'Land Rover Defender 110 2021', 'Volvo V90 Cross Country 2020'],
  'American Motors': ['Ford Mustang GT 5.0 2019', 'Dodge RAM 1500 Laramie 2020', 'Chevrolet Camaro SS 2018', 'Jeep Grand Cherokee 4xe 2021', 'Cadillac Escalade 2019',
    'Ford F-150 Raptor 2021', 'Chevrolet Silverado 2019', 'Dodge Challenger R/T 2020', 'Jeep Wrangler Rubicon 2020', 'Ford Bronco 2022'],
};
const ENQUIRY = {
  Hyrdon: ['Intresserad av privatleasing, vill veta månadskostnad med 1500 mil/år.', 'Vad ingår i abonnemanget? Försäkring och service?',
    'Söker företagsleasing för två bilar till vår firma.', 'Hur snabbt kan ni leverera? Min nuvarande leasing går ut i januari.',
    'Kan man byta bil under avtalstiden?', 'Har ni vinterdäck inkluderat?'],
  'Premium Motors': ['Är bilen kvar? Vill gärna provköra i helgen.', 'Kan ni ta min nuvarande bil i inbyte?', 'Finns det servicehistorik?',
    'Vad blir bästa kontantpris?', 'Går det att finansiera med 20 % kontantinsats?', 'Har bilen dragkrok?'],
  'American Motors': ['Är bilen besiktigad och svensk-registrerad?', 'Hur är förbrukningen i verkligheten?', 'Kan ni leverera till Göteborg?',
    'Vill byta in min Volvo V70. Intresserade?', 'Finns det garanti på bilen?', 'Är det originalavgaser?'],
};
const SOURCE_BY_PIPE = {
  Hyrdon: ['website', 'website', 'website', 'phone', 'email', 'other'],
  'Premium Motors': ['blocket', 'blocket', 'blocket', 'website', 'phone', 'email'],
  'American Motors': ['blocket', 'blocket', 'website', 'phone', 'email', 'other'],
};

function phoneFormats(r, i) {
  const n = `7${Math.floor(r() * 4)}${String(Math.floor(r() * 10000000)).padStart(7, '0')}`; // 9-digit Swedish mobile
  const f = i % 4;
  if (f === 0) return `0${n.slice(0, 2)}-${n.slice(2, 5)} ${n.slice(5, 7)} ${n.slice(7)}`;
  if (f === 1) return `+46 ${n.slice(0, 2)} ${n.slice(2, 5)} ${n.slice(5, 7)} ${n.slice(7)}`;
  if (f === 2) return `0${n}`;
  return `0046${n}`;
}

function regNo(r) {
  const L = 'BCDFGHJKLMNPRSTWXYZ';
  const ch = () => L[Math.floor(r() * L.length)];
  return `${ch()}${ch()}${ch()} ${Math.floor(r() * 10)}${Math.floor(r() * 10)}${r() < 0.5 ? Math.floor(r() * 10) : ch()}`;
}

function seedDemo(db, { now = new Date(), seed = 20261112 } = {}) {
  const r = rng(seed);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const between = (a, b) => a + r() * (b - a);
  const NOW = now.getTime();
  const MIN = 60000;
  const D = 86400000;
  const iso = (t) => new Date(Math.min(t, NOW - MIN)).toISOString();

  return tx(db, () => {
    wipe(db);
    const created = now.toISOString();
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('demo_seeded_at', ?)").run(created);
    const pw = hashPassword(DEMO_PASSWORD);
    const users = DEMO_USERS.map((u) => ({
      ...u,
      id: Number(db.prepare('INSERT INTO users (name, email, password_hash, role, active, is_demo, created_at, deactivated_at) VALUES (?,?,?,?,?,1,?,?)')
        .run(u.name, u.email, pw, u.role, u.inactive ? 0 : 1, iso(NOW - 200 * 86400000), u.inactive ? iso(NOW - 20 * 86400000) : null).lastInsertRowid),
    }));
    const director = users[0];
    const sellers = users.filter((u) => u.role === 'sales' && !u.inactive);
    const former = users.find((u) => u.inactive);

    const pipes = PIPELINES.map((p, i) => {
      const id = Number(db.prepare('INSERT INTO pipelines (name, description, position, created_at) VALUES (?,?,?,?)').run(p.name, p.description, i + 1, iso(NOW - 200 * 86400000)).lastInsertRowid);
      const stages = C.DEFAULT_STAGES.map((s, j) => ({ ...s, id: Number(db.prepare('INSERT INTO stages (pipeline_id, name, outcome, position) VALUES (?,?,?,?)').run(id, s.name, s.outcome, j + 1).lastInsertRowid) }));
      return { ...p, id, stages, byName: Object.fromEntries(stages.map((s) => [s.name, s])) };
    });
    const P = Object.fromEntries(pipes.map((p) => [p.name, p]));

    const insContact = db.prepare('INSERT INTO contacts (name, phone, phone_norm, email, email_norm, is_demo, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?)');
    const usedNames = new Set();
    let ci = 0;
    function contact(opts = {}) {
      let name = opts.name;
      while (!name) { const n = `${pick(FIRST)} ${pick(LAST)}`; if (!usedNames.has(n)) name = n; }
      usedNames.add(name);
      const phone = opts.phone !== undefined ? opts.phone : (r() < 0.9 ? phoneFormats(r, ci) : null);
      const slug = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]+/g, '.');
      const email = opts.email !== undefined ? opts.email : (r() < 0.8 ? `${slug}@example.com` : null);
      ci++;
      const at = iso(opts.at || NOW - 90 * 86400000);
      return { id: Number(insContact.run(name, phone, normalizePhone(phone), email, normalizeEmail(email), at, at).lastInsertRowid), name, phone, email };
    }

    const insLead = db.prepare(`INSERT INTO leads (contact_id, pipeline_id, stage_id, owner_id, source, vehicle, enquiry, reg_number, reg_norm, listing_id, listing_url,
      outcome, won_at, lost_at, lost_reason, lost_note, next_action, next_action_due, is_demo, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`);
    const insAct = db.prepare(`INSERT INTO activities (lead_id, user_id, type, origin, direction, occurred_at, call_outcome, duration_sec, subject, body, due_at,
      from_stage_id, to_stage_id, from_user_id, to_user_id, lost_reason, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const act = (leadId, a) => insAct.run(leadId, a.user ?? null, a.type, a.origin || 'sample', a.direction ?? null, iso(a.at), a.call_outcome ?? null,
      a.duration_sec ?? null, a.subject ?? null, a.body ?? null, a.due_at ?? null, a.from_stage ?? null, a.to_stage ?? null, a.from_user ?? null, a.to_user ?? null,
      a.lost_reason ?? null, iso(a.at));

    const startTomorrow = T.startOfTomorrow(now).getTime();
    // Keep salesperson activity inside office hours (08–18 Stockholm) so the demo timeline looks realistic.
    const bh = (t) => {
      const p = T.parts(t);
      if (p.h < 8) return T.zonedToUtc(p.y, p.m, p.d, 8, p.mi).getTime();
      if (p.h >= 18) { const nd = T.addDaysStr(T.dateStr(t), 1).split('-').map(Number); return T.zonedToUtc(nd[0], nd[1], nd[2], 8, p.mi).getTime(); }
      return t;
    };

    // state: unassigned | attempt | established | won | delivered | lost
    function makeLead(spec) {
      const pipe = P[spec.pipeline];
      const ct = spec.contact || contact({ at: spec.createdAt });
      const source = spec.source || pick(SOURCE_BY_PIPE[pipe.name]);
      const vehicle = spec.vehicle || pick(VEHICLES[pipe.name]);
      const enquiry = spec.enquiry || pick(ENQUIRY[pipe.name]);
      const usedCar = pipe.name !== 'Hyrdon';
      const reg = usedCar && r() < 0.85 ? regNo(r) : null;
      const listingId = usedCar && source === 'blocket' ? String(1000000 + Math.floor(r() * 8999999)) : null;
      const listingUrl = listingId ? `https://annons.exempel.invalid/blocket/${listingId}` : null;
      const owner = spec.owner === undefined ? (spec.state === 'unassigned' ? null : pick(sellers)) : spec.owner;
      let t = spec.createdAt;
      const st = pipe.byName;
      const events = [];
      const firstName = (ct.name || 'kund').split(' ')[0];
      const ownerFirst = owner ? owner.name.split(' ')[0] : '';
      events.push({ type: 'created', origin: 'system', at: t, to_stage: st['Ny'].id, user: owner && source === 'phone' ? owner.id : null });
      // inbound first touch
      if (source === 'email' || source === 'website' || (source === 'blocket' && r() < 0.6)) {
        events.push({ type: 'email', direction: 'in', at: t, subject: `Förfrågan: ${vehicle}`, body: `Hej!\n\n${enquiry}\n\nMvh ${ct.name || ''}` });
      } else if (source === 'phone') {
        events.push({ type: 'call', direction: 'in', at: t, call_outcome: 'answered', duration_sec: 180 + Math.floor(r() * 300), user: owner ? owner.id : null,
          body: `Kunden ringde in. ${enquiry}` });
      }
      let stage = st['Ny'];
      let wonAt = null; let lostAt = null; let lostReason = null; let lostNote = null;
      let nextAction = null; let nextDue = null;
      const firstOwner = spec.history ? spec.history : owner;
      if (spec.state !== 'unassigned' && owner) {
        t = bh(t + between(4, spec.slow ? 1400 : 180) * MIN);
        events.push({ type: 'owner_change', origin: 'system', at: t, user: firstOwner.id, from_user: null, to_user: firstOwner.id, body: 'claim' });
        if (spec.history) {
          // Former (now inactive) salesperson worked the lead, then the director reassigned it.
          t = bh(t + between(5, 60) * MIN);
          events.push({ type: 'call', direction: 'out', at: t, user: firstOwner.id, call_outcome: 'answered', duration_sec: 240, body: 'Gick igenom önskemål och budget.' });
          events.push({ type: 'note', at: t + 2 * MIN, user: firstOwner.id, body: `${firstName} vill fundera över helgen. Ring tillbaka nästa vecka.` });
          t = bh(t + between(1, 3) * 86400000);
          events.push({ type: 'owner_change', origin: 'system', at: t, user: director.id, from_user: firstOwner.id, to_user: owner.id, body: 'assign' });
        }
        // first outreach
        t = bh(t + between(3, spec.slow ? 900 : 120) * MIN);
        const reached = spec.state !== 'attempt' && r() < 0.6;
        events.push({ type: 'call', direction: 'out', at: t, user: owner.id, call_outcome: reached ? 'answered' : pick(['no_answer', 'voicemail', 'busy']),
          duration_sec: reached ? 120 + Math.floor(r() * 600) : null, body: reached ? 'Bra samtal, kunden är intresserad.' : null });
        events.push({ type: 'stage_change', origin: 'system', at: t + MIN, user: owner.id, from_stage: stage.id, to_stage: st['Kontaktförsök'].id });
        stage = st['Kontaktförsök'];
        if (!reached) {
          t = bh(t + between(20, 300) * MIN);
          if (ct.email) {
            events.push({ type: 'email', direction: 'out', at: t, user: owner.id, subject: `Sv: ${vehicle}`,
              body: `Hej ${firstName}!\n\nTack för din förfrågan. Jag försökte nå dig på telefon. När passar det att jag ringer?\n\nVänliga hälsningar\n${owner.name}` });
          }
          if (spec.state !== 'attempt') {
            t = bh(t + between(60, 1500) * MIN);
            events.push({ type: 'call', direction: 'out', at: t, user: owner.id, call_outcome: 'answered', duration_sec: 300 + Math.floor(r() * 400), body: 'Fick tag på kunden.' });
          }
        }
        if (['established', 'won', 'delivered', 'lost'].includes(spec.state) && !(spec.state === 'lost' && spec.reason === 'unreachable')) {
          events.push({ type: 'stage_change', origin: 'system', at: t + 2 * MIN, user: owner.id, from_stage: stage.id, to_stage: st['Kontakt etablerad'].id });
          stage = st['Kontakt etablerad'];
          events.push({ type: 'note', at: t + 3 * MIN, user: owner.id, body: pick([
            `${firstName} har budget runt ${pick(['4 500', '5 900', '7 200'])} kr/mån. Vill ha besked snabbt.`,
            'Har inbytesbil, vill ha värdering innan beslut.', 'Provkörning bokad. Kunden jämför med en annan handlare.',
            'Frågar om leveranstid och vinterhjul. Skickar offert.', 'Partnern ska också vara med vid nästa möte.']) });
          if (ct.email && r() < 0.8) {
            t = bh(t + between(30, 600) * MIN);
            events.push({ type: 'email', direction: 'out', at: t, user: owner.id, subject: `Offert – ${vehicle}`,
              body: `Hej ${firstName}!\n\nHär kommer offerten vi pratade om. Hör av dig om du har frågor.\n\nMvh ${owner.name}` });
            if (r() < 0.7 || spec.awaiting) {
              t = bh(t + between(60, 1800) * MIN);
              events.push({ type: 'email', direction: 'in', at: t, subject: `Sv: Offert – ${vehicle}`,
                body: pick(['Tack! Går det att få lite bättre pris om jag bestämmer mig denna vecka?', 'Ser bra ut. Kan vi ses på torsdag?',
                  'Tack för offerten. Vad gäller vid förtida lösen?', 'Kan ni inkludera vinterhjul i priset?']) });
              if (!spec.awaiting || spec.state !== 'established') {
                t = bh(t + between(30, 600) * MIN);
                events.push({ type: 'email', direction: 'out', at: t, user: owner.id, subject: `Sv: Sv: Offert – ${vehicle}`,
                  body: `Hej igen!\n\nJa, det löser vi. Jag ringer dig så går vi igenom detaljerna.\n\n/${ownerFirst}` });
              }
            }
          }
        }
        if (spec.awaiting && spec.state !== 'unassigned') {
          // Make sure the very last correspondence is the customer writing to us, recently.
          const at = NOW - between(spec.awaitingHours || 2, (spec.awaitingHours || 2) + 20) * 60 * MIN;
          t = Math.max(t + MIN, Math.min(at, NOW - 30 * MIN));
          events.push({ type: 'email', direction: 'in', at: t, subject: `Sv: ${vehicle}`,
            body: pick(['Hej, jag har inte hört något – är bilen fortfarande kvar?', 'Hej! Kan du skicka ett nytt förslag med längre avtalstid?',
              'Vi har bestämt oss och vill gå vidare. Vad behöver ni från oss?', 'Kan jag hämta bilen på lördag?']) });
        }
        if (spec.state === 'won' || spec.state === 'delivered') {
          t = bh(t + between(1, 6) * 86400000 * (spec.fast ? 0.2 : 1));
          if (spec.wonAt) t = spec.wonAt;
          wonAt = t;
          events.push({ type: 'stage_change', origin: 'system', at: t, user: owner.id, from_stage: stage.id, to_stage: st['Såld / Avtal klart'].id });
          stage = st['Såld / Avtal klart'];
          events.push({ type: 'note', at: t + 5 * MIN, user: owner.id, body: 'Avtal signerat. Leverans planeras.' });
          if (spec.state === 'delivered') {
            t = bh(t + between(2, 8) * 86400000);
            events.push({ type: 'stage_change', origin: 'system', at: t, user: owner.id, from_stage: stage.id, to_stage: st['Levererad'].id });
            stage = st['Levererad'];
          }
        }
        if (spec.state === 'lost') {
          t = bh(t + between(1, 8) * 86400000);
          if (spec.lostAt) t = spec.lostAt;
          lostAt = t; lostReason = spec.reason; lostNote = spec.note || null;
          if (spec.reason === 'unreachable') {
            events.push({ type: 'call', direction: 'out', at: t - 60 * MIN, user: owner.id, call_outcome: 'no_answer' });
          } else if (spec.reason !== 'duplicate') {
            events.push({ type: 'call', direction: 'out', at: t - 30 * MIN, user: owner.id, call_outcome: 'answered', duration_sec: 200, body: 'Kunden tackade nej.' });
          }
          events.push({ type: 'stage_change', origin: 'system', at: t, user: owner.id, from_stage: stage.id, to_stage: st['Förlorad / Ej aktuell'].id,
            lost_reason: lostReason, body: lostNote });
          stage = st['Förlorad / Ej aktuell'];
        }
        if (spec.state === 'attempt' || spec.state === 'established') {
          if (spec.follow === 'overdue') {
            nextAction = pick(['Ring upp igen', 'Följ upp offert', 'Skicka nytt förslag', 'Boka provkörning']);
            nextDue = bh(NOW - between(1, 96) * 60 * MIN);
            while (nextDue >= NOW - 15 * MIN) nextDue -= D;
          } else if (spec.follow === 'today') {
            nextAction = pick(['Ring kunden', 'Följ upp offert', 'Bekräfta provkörning']);
            const p = T.parts(now);
            const fivePm = T.zonedToUtc(p.y, p.m, p.d, 17, 0).getTime();
            nextDue = fivePm - NOW > 60 * MIN ? NOW + between(30, (fivePm - NOW) / MIN) * MIN : Math.min(NOW + 45 * MIN, startTomorrow - 5 * MIN);
          }
          else if (spec.follow === 'future') { nextAction = pick(['Följ upp efter helgen', 'Ring om finansiering', 'Kontrollera inbytesvärdering', 'Skicka avtal']); nextDue = bh(NOW + between(1, 9) * D); }
          if (nextDue) { nextDue = Math.round(nextDue / (15 * MIN)) * 15 * MIN; if (spec.follow === 'today' && nextDue < NOW) nextDue += 15 * MIN; }
          // completed follow-up in history
          if (r() < 0.5) events.push({ type: 'followup_done', origin: 'sample', at: Math.min(t + 60 * MIN, NOW - 2 * MIN), user: owner.id, body: 'Ring kunden', due_at: iso(t + 30 * MIN) });
        }
      }
      events.sort((a, b) => a.at - b.at);
      const last = events.length ? events[events.length - 1].at : spec.createdAt;
      const leadId = Number(insLead.run(ct.id, pipe.id, stage.id, owner ? owner.id : null, source, vehicle, enquiry, reg, normalizeReg(reg), listingId, listingUrl,
        stage.outcome, wonAt ? iso(wonAt) : null, lostAt ? iso(lostAt) : null, lostReason, lostNote, nextAction,
        nextDue ? new Date(nextDue).toISOString() : null, owner ? owner.id : director.id, iso(spec.createdAt), iso(last)).lastInsertRowid);
      for (const e of events) act(leadId, e);
      return { id: leadId, contact: ct };
    }

    const pipeNames = PIPELINES.map((p) => p.name);
    const ago = (days) => NOW - days * D;

    // Known repeat customer for demos: Anna Svensson (try creating a lead with 070-123 45 67 to see the duplicate warning)
    const anna = contact({ name: 'Anna Svensson', phone: '+46 70 123 45 67', email: 'anna.svensson@example.com', at: ago(70) });
    makeLead({ pipeline: 'Hyrdon', state: 'delivered', contact: anna, createdAt: ago(62), owner: sellers[1], source: 'website', vehicle: 'Volvo EX30 – privatleasing 36 mån' });
    makeLead({ pipeline: 'Premium Motors', state: 'established', contact: anna, createdAt: ago(3), owner: sellers[1], source: 'phone', follow: 'today', vehicle: 'Volvo XC90 T8 Inscription 2022' });
    const per = contact({ name: 'Per Andersson', phone: '0708-55 44 33', email: 'per.andersson@example.com', at: ago(80) });
    makeLead({ pipeline: 'American Motors', state: 'lost', reason: 'price', contact: per, createdAt: ago(48), owner: sellers[4], source: 'blocket', vehicle: 'Ford Mustang GT 5.0 2019' });
    makeLead({ pipeline: 'Premium Motors', state: 'won', contact: per, createdAt: ago(20), owner: sellers[0], source: 'blocket' });
    makeLead({ pipeline: 'Hyrdon', state: 'attempt', contact: per, createdAt: ago(1.2), owner: sellers[2], source: 'website', follow: 'overdue' });
    // Unassigned repeat customer (new enquiry from someone who bought before)
    const lars = contact({ name: 'Lars Holmqvist', phone: '0046 73 222 11 00', email: null, at: ago(90) });
    makeLead({ pipeline: 'American Motors', state: 'delivered', contact: lars, createdAt: ago(75), owner: sellers[3], source: 'phone', vehicle: 'Dodge RAM 1500 Laramie 2020' });
    makeLead({ pipeline: 'American Motors', state: 'unassigned', contact: lars, createdAt: NOW - 50 * MIN, source: 'phone', vehicle: 'Ford F-150 Raptor 2021' });
    // International customer (number kept as-is, not mistaken for a Swedish number)
    const nils = contact({ name: 'Nils Hansen', phone: '+47 912 34 567', email: 'nils.hansen@example.com', at: ago(10) });
    makeLead({ pipeline: 'Premium Motors', state: 'established', contact: nils, createdAt: ago(9), owner: sellers[5], source: 'email', follow: 'future' });

    // Unassigned new leads
    const unassignedAges = [0.02, 0.06, 0.15, 0.3, 0.7, 1.1, 2.4, 4.5];
    unassignedAges.forEach((a, i) => makeLead({ pipeline: pipeNames[i % 3], state: 'unassigned', createdAt: ago(a) }));

    // Open assigned leads with a mix of follow-up states
    const follows = ['overdue', 'overdue', 'today', 'today', 'future', 'future', 'future', 'none'];
    for (let i = 0; i < 36; i++) {
      makeLead({ pipeline: pipeNames[i % 3], state: i % 4 === 0 ? 'attempt' : 'established', owner: sellers[Math.floor(i / 6) % sellers.length], createdAt: ago(between(0.5, 24)),
        follow: follows[i % follows.length], awaiting: i % 7 === 2, slow: i % 5 === 4 });
    }
    // One open lead still owned by the inactive former salesperson (needs reassignment)
    makeLead({ pipeline: 'Premium Motors', state: 'established', owner: former, createdAt: ago(25), follow: 'overdue' });
    // Ownership history: worked by the former salesperson, then reassigned
    makeLead({ pipeline: 'Hyrdon', state: 'established', owner: sellers[3], history: former, createdAt: ago(30), follow: 'future' });
    makeLead({ pipeline: 'American Motors', state: 'won', owner: sellers[0], history: former, createdAt: ago(35) });

    // Won and delivered, spread over ~80 days
    for (let i = 0; i < 26; i++) {
      makeLead({ pipeline: pipeNames[i % 3], state: i % 2 ? 'delivered' : 'won', owner: pick(sellers), createdAt: ago(between(6, 80)) });
    }
    // Lost with a realistic reason mix
    const reasons = ['price', 'price', 'price', 'other_seller', 'other_seller', 'timing', 'timing', 'financing', 'unavailable', 'unreachable', 'unreachable', 'duplicate', 'duplicate', 'other',
      'price', 'other_seller', 'timing', 'financing', 'unreachable', 'price', 'unavailable', 'other'];
    reasons.forEach((reason, i) => makeLead({ pipeline: pipeNames[i % 3], state: 'lost', reason, owner: pick(sellers), createdAt: ago(between(4, 80)),
      note: reason === 'other' ? pick(['Kunden flyttar utomlands.', 'Bolaget valde att behålla befintliga bilar.']) : null }));

    return { users: users.length, leads: db.prepare('SELECT COUNT(*) n FROM leads').get().n };
  });
}

module.exports = { seedDemo, DEMO_USERS, DEMO_PASSWORD };
