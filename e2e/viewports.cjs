// Viewport matrix: the game must work and fit at phone, tablet and desktop
// sizes, with no serious accessibility violations. The first audit found the
// phone layout broken because the only browser test ran at 1280x720.
//   npm run test:e2e:viewports        (screenshots in $SHOTS or the OS tmp dir)
const path = require('path');
const os = require('os');
const fs = require('fs');
const { chromium, devices } = require('playwright');
const { AxeBuilder } = require('@axe-core/playwright');

const PORT = 3988;
process.env.PORT = String(PORT);
process.env.COUNTDOWN_MS = '400';
process.env.POINTER_STATE_FILE = '';
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'pointer-viewports');
fs.mkdirSync(SHOTS, { recursive: true });

const VIEWPORTS = [
  { name: 'phone-375', ctx: { viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
  { name: 'phone-390', ctx: { ...devices['iPhone 13'] } },
  { name: 'tablet-768', ctx: { viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
  { name: 'laptop-1280', ctx: { viewport: { width: 1280, height: 720 } } },
  { name: 'desktop-1440', ctx: { viewport: { width: 1440, height: 900 } } },
];
const GUESTS = ['Priya', 'Marcus', 'Alexandria Montgomery-Fitzgerald', 'Wen', 'Diego', 'Sam', 'Oluwaseun'];

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function axeSerious(page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  return r.violations.filter(v => v.impact === 'serious' || v.impact === 'critical')
    .map(v => `${v.id}(${v.nodes.length}): ${v.nodes.slice(0, 2).map(n => n.target.join(' ')).join(' | ')}`);
}

async function fits(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const out = [];
    if (document.documentElement.scrollWidth > vw + 1) out.push(`page ${document.documentElement.scrollWidth}px wide`);
    for (const sel of ['.header-right', '.hand-card', '.btn-reveal', '.stage-status']) {
      for (const el of document.querySelectorAll(sel)) {
        if (el.offsetParent === null) continue;
        const b = el.getBoundingClientRect();
        if (b.right > vw + 1 || b.left < -1 || b.bottom > vh + 1) out.push(`${sel} at ${Math.round(b.left)},${Math.round(b.top)}-${Math.round(b.right)},${Math.round(b.bottom)}`);
      }
    }
    return out;
  });
}

(async () => {
  require(path.join(__dirname, '..', 'server.js'));
  const base = `http://localhost:${PORT}`;
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
  const guestCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });

  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext(vp.ctx);
    const host = await ctx.newPage();
    const errors = [];
    host.on('pageerror', e => errors.push(e.message));
    await host.goto(base, { waitUntil: 'networkidle' });
    await host.waitForTimeout(900);
    await host.screenshot({ path: `${SHOTS}/${vp.name}-1-landing.png` });
    check(`${vp.name}: landing fits`, (await fits(host)).length === 0, (await fits(host)).join('; '));
    if (vp.name === 'desktop-1440' || vp.name === 'phone-390') {
      const a = await axeSerious(host);
      check(`${vp.name}: landing axe clean`, a.length === 0, a.join('; '));
    }

    await host.click('text=Start a new game');
    await host.waitForTimeout(400);
    await host.screenshot({ path: `${SHOTS}/${vp.name}-2-create.png` });
    if (vp.name === 'desktop-1440') {
      const a = await axeSerious(host);
      check(`${vp.name}: create dialog axe clean`, a.length === 0, a.join('; '));
    }
    await host.fill('#lobby-player-name', 'Jaedyn');
    await host.fill('#lobby-game-name', 'Sprint 42 Planning');
    await host.selectOption('#lobby-voting-system', 'fib');
    await host.click('#btn-create-game');
    await host.waitForSelector('#app.active');
    await host.waitForTimeout(600);
    const code = (await host.textContent('#room-code-display')).trim().toLowerCase();
    await host.screenshot({ path: `${SHOTS}/${vp.name}-3-alone.png` });
    check(`${vp.name}: invite panel shown when alone`, await host.isVisible('#invite-panel'));

    const guests = [];
    for (const name of GUESTS) {
      const g = await guestCtx.newPage();
      await g.goto(`${base}/${code}`);
      await g.waitForSelector('#join-overlay:not(.hidden)');
      await g.fill('#join-player-name', name);
      await g.click('#btn-join-game');
      await g.waitForSelector('#app.active');
      guests.push(g);
    }
    for (let i = 0; i < guests.length - 2; i++) await guests[i].click(`.hand-card[data-value="${['3', '5', '3', '8', '3'][i]}"]`);
    await host.waitForTimeout(500);
    check(`${vp.name}: invite panel hidden once others join`, !(await host.isVisible('#invite-panel')));

    // Tap (touch) or click a card the way a user would at this size.
    const card = host.locator('.hand-card[data-value="3"]');
    if (vp.ctx.hasTouch) await card.tap(); else await card.click();
    const registered = await guests[0].waitForFunction(
      () => document.querySelector('.stage-card[data-player-id] .stage-card-front:not(.sc-waiting)') &&
        [...document.querySelectorAll('#players-list .player-row')].some(r => r.textContent.includes('Jaedyn') && r.querySelector('.player-vote-indicator.voted')),
      null, { timeout: 3000 }).then(() => true, () => false);
    check(`${vp.name}: host vote registers via ${vp.ctx.hasTouch ? 'tap' : 'click'}`, registered);
    await host.waitForTimeout(500);
    const f = await fits(host);
    check(`${vp.name}: room fits (no overflow, hand on screen)`, f.length === 0, f.join('; '));
    await host.screenshot({ path: `${SHOTS}/${vp.name}-4-voting.png` });
    const a = await axeSerious(host);
    check(`${vp.name}: room axe clean`, a.length === 0, a.join('; '));

    await host.click('.btn-reveal');
    await host.waitForTimeout(250);
    await host.screenshot({ path: `${SHOTS}/${vp.name}-5-countdown.png` });
    await host.waitForSelector('.consensus-pill.show');
    await host.waitForTimeout(1300);
    await host.screenshot({ path: `${SHOTS}/${vp.name}-6-revealed.png` });
    const f2 = await fits(host);
    check(`${vp.name}: revealed fits`, f2.length === 0, f2.join('; '));
    const a2 = await axeSerious(host);
    check(`${vp.name}: revealed axe clean`, a2.length === 0, a2.join('; '));
    check(`${vp.name}: round stats shown`, await host.isVisible('#round-stats .rs-chip'));

    if (vp.ctx.isMobile) {
      await host.click('#btn-players');
      await host.waitForTimeout(400);
      await host.screenshot({ path: `${SHOTS}/${vp.name}-7-drawer.png` });
      check(`${vp.name}: players drawer opens`, await host.isVisible('#players-list .player-row'));
      await host.click('#drawer-backdrop', { position: { x: vp.ctx.viewport.width - 10, y: 300 } });
    }
    check(`${vp.name}: no page errors`, errors.length === 0, errors.join('; '));
    for (const g of guests) await g.close();
    await ctx.close();
  }

  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${SHOTS}`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('Viewport E2E crashed:', e); process.exit(1); });
