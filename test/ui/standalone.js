// Opens dist/hyrdon-crm-demo.html straight from disk (file://) the way a user double-clicks it,
// and checks the main flows plus persistence across a reload. Run: npm run test:demo
const path = require('node:path');
const fs = require('node:fs');
const { chromium, devices } = require('playwright');

const FILE = 'file://' + path.join(__dirname, '..', '..', 'dist', 'hyrdon-crm-demo.html');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  ✔', name); } catch (e) { results.push(['FAIL', name]); console.log('  ✘', name, '\n     ', e.message.split('\n')[0]); }
}
const expect = (c, m) => { if (!c) throw new Error(m); };

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  for (const [label, opts] of [['Desktop', { viewport: { width: 1400, height: 900 } }], ['Mobil', { ...devices['iPhone 13'] }]]) {
    console.log(label + ' (file://):');
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    let leadId;
    await step('öppnar och visar demokonton', async () => {
      await page.goto(FILE);
      await page.waitForSelector('.demo-acc');
      expect((await page.locator('.demo-acc').count()) === 7, 'expected 7 demo accounts');
    });
    await step('logga in som säljare, ta lead', async () => {
      await page.click('.demo-acc:has-text("Johan Berg")');
      await page.click('button[type=submit]');
      await page.waitForSelector('.unassigned-hero');
      expect((await page.textContent('.demo-banner')).includes('denna webbläsare'), 'banner');
      const btn = page.locator('#unassigned .btn-claim').first();
      leadId = await btn.getAttribute('data-id');
      await btn.click();
      await page.waitForSelector('.toast.show:has-text("Leaden är din")');
    });
    await step('byt steg, logga samtal', async () => {
      await page.goto(`${FILE}#/lead/${leadId}`);
      await page.waitForSelector('.timeline');
      await page.click('.stage-btn:has-text("Kontaktförsök")');
      await page.waitForSelector('.stage-btn.current:has-text("Kontaktförsök")');
      await page.click('[data-ctab=call]');
      await page.click('.ctab-call button[type=submit]');
      await page.waitForSelector('.tl-call:has-text("Utgående samtal")');
    });
    await step('dubblettvarning vid ny lead', async () => {
      await page.click(label === 'Mobil' ? '.bottomnav .bn-new' : '.topbar [data-action=new-lead]');
      await page.fill('.modal input[name=phone]', '0046701234567');
      await page.waitForSelector('.dup-warn:has-text("Anna Svensson")');
      await page.click('[data-action=close-modal]');
    });
    await step('data finns kvar efter omladdning', async () => {
      await page.reload();
      await page.goto(`${FILE}#/lead/${leadId}`);
      await page.waitForSelector('.timeline');
      expect(await page.isVisible('.stage-btn.current:has-text("Kontaktförsök")'), 'stage lost after reload');
      expect(await page.isVisible('.tl-call:has-text("Utgående samtal")'), 'call lost after reload');
      expect((await page.textContent('.owner-line')).includes('Johan Berg'), 'owner lost');
    });
    await step('översikt som direktör', async () => {
      await page.click('[data-action=toggle-usermenu]');
      await page.click('[data-action=logout]');
      await page.click('.demo-acc:has-text("Karin Ek")');
      await page.click('button[type=submit]');
      await page.waitForSelector('.unassigned-hero');
      await page.goto(`${FILE}#/oversikt`);
      await page.waitForSelector('.tiles');
      await page.screenshot({ path: path.join(OUT, `standalone-${label}.png`) });
    });
    await ctx.close();
  }
  await browser.close();
  if (errors.length) { results.push(['FAIL', 'JS errors']); console.log('  ✘ JS errors:', errors.slice(0, 5)); }
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} steg godkända.`);
  process.exit(failed ? 1 : 0);
})();
