// Browser test of the main daily workflows. Phone (iPhone 13 emulation) + desktop drag-and-drop.
// Run: npm run test:ui   (requires Playwright + Chromium installed locally)
const path = require('node:path');
const fs = require('node:fs');
const { chromium, devices } = require('playwright');
const { startApp } = require('../helpers');

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  ✔', name); } catch (e) { results.push(['FAIL', name, e.message]); console.log('  ✘', name, '\n     ', e.message.split('\n')[0]); }
}
function expect(cond, msg) { if (!cond) throw new Error(msg); }

async function login(page, base, name) {
  await page.goto(base + '/');
  await page.click(`.demo-acc:has-text("${name}")`);
  await page.click('button[type=submit]');
  await page.waitForSelector('.unassigned-hero');
}
async function noHorizontalScroll(page, label) {
  const { sw, iw } = await page.evaluate(() => ({ sw: Math.max(document.documentElement.scrollWidth, window.innerWidth), iw: window.visualViewport.width }));
  expect(sw <= iw + 1, `${label}: horizontal overflow (${sw} > ${iw})`);
}
const toastText = async (page) => (await page.waitForSelector('.toast.show')).textContent();
async function clearToasts(page) { await page.evaluate(() => { document.querySelector('#toast-root').innerHTML = ''; }); }

(async () => {
  const app = await startApp();
  const base = app.base;
  const browser = await chromium.launch();
  const errors = [];
  try {
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    const page = await ctx.newPage();
    page.setDefaultTimeout(8000);
    page.on('pageerror', (e) => errors.push(e.message));
    console.log('Mobil (iPhone 13):');
    let leadId;

    await step('logga in som säljare och se Min dag', async () => {
      await login(page, base, 'Johan Berg');
      await noHorizontalScroll(page, 'Min dag');
      await page.screenshot({ path: path.join(OUT, 'm1-min-dag.png') });
    });

    await step('ta en ej tilldelad lead från Min dag', async () => {
      const before = Number(await page.textContent('.unassigned-hero .big'));
      expect(before > 0, 'no unassigned leads');
      const btn = page.locator('#unassigned .btn-claim').first();
      leadId = await btn.getAttribute('data-id');
      await btn.click();
      expect((await toastText(page)).includes('Leaden är din'), 'no success toast');
      await page.waitForFunction((b) => Number(document.querySelector('.unassigned-hero .big').textContent) === b - 1, before);
    });

    await step('öppna leaden och byt steg med stegväljaren', async () => {
      await page.goto(`${base}/#/lead/${leadId}`);
      await page.waitForSelector('.timeline');
      await noHorizontalScroll(page, 'Lead');
      await clearToasts(page);
      await page.click('.stage-btn:has-text("Kontaktförsök")');
      expect((await toastText(page)).includes('Kontaktförsök'), 'no move toast');
      await page.waitForSelector('.stage-btn.current:has-text("Kontaktförsök")');
    });

    await step('registrera ett samtal manuellt', async () => {
      await page.click('[data-ctab=call]');
      await page.click('.ctab-call .chip:has-text("Inget svar")');
      await page.fill('.ctab-call input[name=duration_min]', '2');
      await page.click('.ctab-call button[type=submit]');
      await page.waitForSelector('.tl-call:has-text("Utgående samtal")');
      const t = await page.textContent('.tl-call');
      expect(t.includes('Inget svar') && t.includes('Manuellt registrerat'), 'call not labelled as manual: ' + t);
    });

    await step('intern anteckning visas tydligt skild från kundkorrespondens', async () => {
      await page.click('[data-ctab=note]');
      await page.fill('.ctab-note textarea', 'Kunden vill ha svar före fredag.');
      await page.click('.ctab-note button[type=submit]');
      await page.waitForSelector('.tl-note:has-text("Intern anteckning")');
    });

    await step('planera nästa steg med snabbval', async () => {
      await page.click('[data-action=edit-next]');
      await page.click('.next-form [data-k=tomorrow]');
      await page.fill('.next-form input[name=text]', 'Ring upp igen');
      await page.click('.next-form button[type=submit]');
      await page.waitForSelector('.next-text:has-text("Ring upp igen")');
      expect((await page.textContent('.next-due')).includes('imorgon 09:00'), 'due not tomorrow 09:00');
    });

    await step('klarmarkera nästa steg och sätt ett nytt direkt', async () => {
      await page.click('[data-action=complete-next]');
      await page.fill('.next-form input[name=result]', 'Inget svar, skickade sms');
      await page.fill('.next-form input[name=text]', 'Skicka offert');
      await page.click('.next-form [data-k="3d"]');
      await page.click('.next-form button[type=submit]:not([name])');
      await page.waitForSelector('.next-text:has-text("Skicka offert")');
      await page.waitForSelector('.tl-done:has-text("Ring upp igen")');
      await page.screenshot({ path: path.join(OUT, 'm2-lead.png'), fullPage: true });
    });

    await step('förlorad kräver anledning och förklaring för "Annat"', async () => {
      await page.click('.stage-btn.stage-lost');
      await page.waitForSelector('.modal [data-form=lost]');
      await page.click('.modal button[type=submit]');
      const stillOpen = await page.isVisible('.modal [data-form=lost]');
      expect(stillOpen, 'modal closed without reason');
      await page.check('.modal input[value=other]');
      await page.evaluate(() => { document.querySelector('.modal textarea').required = false; }); // bypass browser validation to hit our own check
      await page.click('.modal button[type=submit]');
      await page.waitForSelector('.modal .form-error:not([hidden])');
      await page.fill('.modal textarea', 'Kunden flyttar utomlands');
      await page.click('.modal button[type=submit]');
      await page.waitForSelector('.hint-lost:has-text("Annat")');
    });

    await step('tavlan på mobil: stegchips + flytta via väljare', async () => {
      await page.goto(`${base}/#/pipelines`);
      await page.waitForSelector('.stage-chips');
      await noHorizontalScroll(page, 'Pipelines');
      // filter to my leads, then move one with the select
      await page.selectOption('[data-bf=owner]', 'me');
      await page.click('.stage-chips .chip:has-text("Kontaktförsök")');
      const sel = page.locator('.col.mobile-active select[data-move]').first();
      expect(await sel.count() > 0, 'no movable card');
      const id = await sel.getAttribute('data-move');
      await clearToasts(page);
      await sel.selectOption({ label: 'Kontakt etablerad' });
      expect((await toastText(page)).includes('Kontakt etablerad'), 'no move toast');
      await page.click('.stage-chips .chip:has-text("Kontakt etablerad")');
      await page.waitForSelector(`.col.mobile-active .card[data-lead="${id}"]`);
      await page.screenshot({ path: path.join(OUT, 'm3-tavla.png') });
    });

    await step('ny lead: dubblettvarning på telefon i annat format + koppla till befintlig kund', async () => {
      await page.click('.bottomnav .bn-new');
      await page.waitForSelector('.modal [data-form=new-lead]');
      await page.click('.modal .seg label:has-text("American Motors")');
      await page.fill('.modal input[name=phone]', '070-123 45 67');
      await page.waitForSelector('.dup-warn:has-text("Anna Svensson")');
      await page.screenshot({ path: path.join(OUT, 'm4-dubblett.png') });
      await page.click('[data-action=use-contact]');
      await page.waitForSelector('.chosen:has-text("Anna Svensson")');
      await page.fill('.modal input[name=vehicle]', 'Jeep Wrangler Rubicon 2020');
      await page.click('.modal button[type=submit]');
      await page.waitForSelector('.lead-head h1:has-text("Anna Svensson")');
      const other = await page.textContent('.lead-side');
      expect(/Kundens andra leads \(2\)/.test(other), 'expected 2 other leads');
    });

    await step('sök på telefonnummer i annat format', async () => {
      await page.goto(`${base}/#/sok`);
      await page.fill('#page-search', '0046701234567');
      await page.waitForSelector('#page-results .row:has-text("Anna Svensson")');
      await noHorizontalScroll(page, 'Sök');
    });

    await step('samtidigt "Ta lead": förloraren ser vem som tog den', async () => {
      const ctx2 = await browser.newContext({ ...devices['iPhone 13'] });
      const sara = await ctx2.newPage();
      sara.setDefaultTimeout(8000);
      await login(sara, base, 'Sara Lind');
      await page.goto(`${base}/#/dag`);
      await page.waitForSelector('#unassigned .btn-claim');
      const id = await page.locator('#unassigned .btn-claim').first().getAttribute('data-id');
      await sara.waitForSelector(`#unassigned .btn-claim[data-id="${id}"]`);
      await page.click(`#unassigned .btn-claim[data-id="${id}"]`); // Johan first
      await page.waitForSelector('.toast.show');
      await sara.click(`#unassigned .btn-claim[data-id="${id}"]`); // Sara's stale screen
      const msg = await toastText(sara);
      expect(msg.includes('Johan Berg tog redan'), 'loser message: ' + msg);
      await sara.screenshot({ path: path.join(OUT, 'm5-redan-tagen.png') });
      await ctx2.close();
    });
    await ctx.close();

    console.log('Desktop:');
    const dctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const d = await dctx.newPage();
    d.setDefaultTimeout(8000);
    d.on('pageerror', (e) => errors.push(e.message));
    await step('dra och släpp på tavlan (admin)', async () => {
      await login(d, base, 'Karin Ek');
      await d.goto(`${base}/#/pipelines`);
      await d.waitForSelector('.board .card[draggable]');
      const col = (name) => d.locator(`.col:has(.col-head span:text-is("${name}"))`);
      const card = col('Kontaktförsök').locator('.card[draggable]').first();
      const id = await card.getAttribute('data-lead');
      await card.dragTo(col('Kontakt etablerad').locator('.col-body'));
      await d.waitForSelector(`.col[data-stage] .card[data-lead="${id}"]`);
      await d.waitForFunction((leadId) => {
        const c = document.querySelector(`.card[data-lead="${leadId}"]`);
        return c && c.closest('.col').querySelector('.col-head span').textContent === 'Kontakt etablerad';
      }, id);
    });
    await step('dra till Förlorad öppnar anledningsdialog', async () => {
      const col = (name) => d.locator(`.col:has(.col-head span:text-is("${name}"))`);
      await col('Kontaktförsök').locator('.card[draggable]').first().dragTo(col('Förlorad / Ej aktuell').locator('.col-body'));
      await d.waitForSelector('.modal [data-form=lost]');
      await d.click('[data-action=close-modal]');
    });
    await step('översikt: siffra öppnar matchande lista', async () => {
      await d.goto(`${base}/#/oversikt`);
      await d.waitForSelector('.tiles');
      const tile = d.locator('a.tile:has-text("Nya leads")');
      const n = Number(await tile.locator('.tile-n').textContent());
      await tile.click();
      await d.waitForSelector('.page-head .count');
      const listN = Number(await d.textContent('.page-head .count'));
      expect(n === listN, `tile ${n} vs list ${listN}`);
      await d.goto(`${base}/#/oversikt`);
      await d.waitForSelector('.tiles');
      await d.screenshot({ path: path.join(OUT, 'd1-oversikt.png'), fullPage: true });
    });
    await step('säljare ser inte Översikt/Admin', async () => {
      const c3 = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      const s = await c3.newPage();
      await login(s, base, 'Lina Sjöberg');
      expect(!(await s.isVisible('.mainnav a[href="#/oversikt"]')), 'Översikt visible for sales');
      await s.goto(`${base}/#/oversikt`);
      await s.waitForSelector('.empty.error');
      await c3.close();
    });
    await dctx.close();
  } finally {
    await browser.close();
    await app.close();
  }
  if (errors.length) { results.push(['FAIL', 'inga JavaScript-fel i webbläsaren', errors.join('; ')]); console.log('  ✘ JS errors:', errors); }
  const failed = results.filter((r) => r[0] === 'FAIL');
  console.log(`\n${results.length - failed.length}/${results.length} UI-steg godkända. Skärmbilder: ${OUT}`);
  process.exit(failed.length ? 1 : 0);
})();
