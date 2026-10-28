// Viewport matrix: the game must work and fit at phone, tablet and desktop
// sizes, with no serious accessibility violations. The first audit found the
// phone layout broken because the only browser test ran at 1280x720.
//   npm run test:e2e:viewports        (screenshots in $SHOTS or .tmp/viewports)
const path = require('path');
const fs = require('fs');
const { chromium, devices } = require('playwright');
const { AxeBuilder } = require('@axe-core/playwright');

const PORT = 3988;
process.env.PORT = String(PORT);
process.env.COUNTDOWN_MS = '400';
process.env.POINTER_STATE_FILE = '';
const SHOTS = process.env.SHOTS || path.join(__dirname, '..', '.tmp', 'viewports');
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

// Layout fixtures use the real room renderer, valid input lengths, and real
// controls. No server broadcasts run while the fixture geometry is measured.
async function layoutRegressions(browser, base) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, hasTouch: true });
  const page = await ctx.newPage();
  const sizes = [[320, 568], [375, 667], [667, 375], [769, 768], [927, 768], [928, 768], [1280, 600], [1280, 720], [1366, 620], [1440, 900]];
  const shot = async (w, h, state) => page.screenshot({ path: `${SHOTS}/layout-${w}x${h}-${state}.png` });
  const boxFits = (b, outer) => b.left >= outer.left - 1 && b.right <= outer.right + 1;
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  for (const [w, h] of sizes) {
    await page.setViewportSize({ width: w, height: h });
    if (h === 375) {
      await page.locator('.landing-btn-join').scrollIntoViewIfNeeded();
      const hit = await page.locator('.landing-btn-join').evaluate(el => {
        const r = el.getBoundingClientRect();
        return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el;
      });
      check('layout 4: landscape Join center is clickable', hit);
    }
    await shot(w, h, 'landing');
    await page.evaluate(() => showLobbyModal());
    await page.waitForTimeout(350);
    if (h === 375) {
      const dialog = page.locator('#lobby-overlay .lobby-card');
      await dialog.hover();
      await page.mouse.wheel(0, 1000);
      await page.waitForTimeout(300);
      const reachable = await dialog.evaluate(el => {
        const d = el.getBoundingClientRect(), b = document.getElementById('btn-create-game').getBoundingClientRect();
        return el.scrollTop > 0 && b.top >= d.top && b.bottom <= d.bottom;
      });
      check('layout 1: landscape Create game is reachable by wheel', reachable);
    }
    await shot(w, h, 'create');
    await page.evaluate(() => hideModals());
    await page.waitForTimeout(350);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => showLobbyModal());
  await page.fill('#lobby-player-name', 'Host');
  await page.selectOption('#lobby-voting-system', 'fib');
  await page.click('#btn-create-game');
  await page.waitForSelector('#app.active');
  await page.waitForTimeout(500);
  // Save a real room, then render deterministic layout data without changing
  // the server. The 20-player limit, deck, names, and topic are all valid.
  await page.evaluate(() => { window.layoutRoom = structuredClone(state.room); });
  async function fixture(kind) {
    await page.evaluate(kind => {
      document.activeElement?.blur();
      document.querySelector('.stage').scrollTop = 0;
      document.getElementById('sidebar').scrollTop = 0;
      state.room = structuredClone(window.layoutRoom);
      state.myVote = null;
      const me = state.room.players[0];
      const values = ['0', '1', '2', '3', '5', '8', '13', '21'];
      if (kind !== 'alone') state.room.players = Array.from({ length: 20 }, (_, i) => ({
        ...me, id: i ? `fixture-${i}` : me.id, isHost: i === 0, color: i % 12,
        name: i < 2 ? 'W'.repeat(39) + i : `Player ${i + 1}`,
        vote: kind === 'split' ? (i < 16 ? values[Math.floor(i / 2)] : null) : null,
      }));
      if (kind === 'split') {
        state.room.revealed = true;
        state.room.consensus = { state: 'split', values };
        state.room.history = [{ round: 1, topic: 'A useful history topic', state: 'split', values, voters: 16, average: 6.63 }];
      }
      if (kind === 'topic') {
        state.room.players[0].isHost = false;
        state.room.topic = 'T'.repeat(120);
      }
      state.wasHost = !!state.room.players.find(p => p.id === state.playerId)?.isHost;
      document.getElementById('toast')?.classList.remove('show');
      resetStage();
      render();
    }, kind);
    await page.waitForTimeout(650);
  }
  // Measure the actual desktop intrinsic width before selecting the breakpoint.
  await fixture('voting');
  const boundary = [];
  for (const width of [926, 927, 928, 929]) {
    await page.setViewportSize({ width, height: 768 });
    boundary.push(await page.evaluate(() => ({ width: innerWidth, pageWidth: document.documentElement.scrollWidth,
      stageWidth: document.querySelector('.stage').getBoundingClientRect().width,
      handWidth: document.querySelector('.hand').getBoundingClientRect().width })));
  }
  fs.writeFileSync(path.join(SHOTS, 'desktop-boundary.json'), JSON.stringify(boundary, null, 2));
  console.log('Desktop boundary geometry:', JSON.stringify(boundary));
  for (const [w, h] of sizes) {
    await page.setViewportSize({ width: w, height: h });
    await fixture('alone');
    await shot(w, h, 'alone');
    const centered = await page.evaluate(() => {
      const p = document.getElementById('invite-panel').getBoundingClientRect(), m = document.querySelector('.stage-middle').getBoundingClientRect();
      return Math.abs(p.x + p.width / 2 - m.x - m.width / 2) < 2 && Math.abs(p.y + p.height / 2 - m.y - m.height / 2) < 2;
    });
    check(`layout guard ${w}: invite stays centered over table`, centered);
    await fixture('voting');
    if ([769, 927, 928].includes(w)) {
      const geometry = await page.evaluate(() => {
        const stage = document.querySelector('.stage').getBoundingClientRect();
        const side = document.querySelector('.sidebar').getBoundingClientRect();
        const freeLeft = document.getElementById('btn-players').offsetParent === null ? side.right : 0;
        return { width: innerWidth, pageWidth: document.documentElement.scrollWidth,
          outsideCards: [...document.querySelectorAll('.hand-card')].filter(el => {
            const r = el.getBoundingClientRect();
            return r.left < 0 || r.right > innerWidth || r.top < 0 || r.bottom > innerHeight;
          }).length,
          stageOffset: Math.abs(stage.x + stage.width / 2 - (freeLeft + (innerWidth - freeLeft) / 2)) };
      });
      check(`layout 2 ${w}: page, all hand cards, and stage center fit`, geometry.pageWidth <= w && geometry.outsideCards === 0 && geometry.stageOffset < 2, JSON.stringify(geometry));
    }
    await shot(w, h, 'voting');
    if (w === 320) {
      const header = await page.evaluate(() => {
        const a = document.querySelector('.header-left').getBoundingClientRect(), b = document.querySelector('.header-right').getBoundingClientRect();
        const logo = document.querySelector('.header .logo');
        return { right: a.right, left: b.left, logoRight: logo.offsetParent ? logo.getBoundingClientRect().right : 0,
          copyHeight: document.getElementById('btn-copy-link').getBoundingClientRect().height };
      });
      check('layout 11: 320px header groups do not overlap or wrap', header.right < header.left && header.logoRight < header.left && header.copyHeight < 36, JSON.stringify(header));
    }
    const narrow = await page.locator('#btn-players').isVisible();
    if (narrow) {
      await page.focus('#btn-players');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      const inside = await page.evaluate(() => document.getElementById('sidebar').contains(document.activeElement));
      await page.keyboard.press('Shift+Tab');
      const trappedBack = await page.evaluate(() => document.getElementById('sidebar').contains(document.activeElement));
      await page.keyboard.press('Tab');
      const trappedForward = await page.evaluate(() => document.getElementById('sidebar').contains(document.activeElement));
      check(`layout 8 ${w}: drawer receives and traps keyboard focus`, inside && trappedBack && trappedForward);
      await shot(w, h, 'drawer-focus');
    }
    const nameFits = await page.locator('.player-name-text').first().evaluate(el => el.scrollWidth <= el.clientWidth + 1 && el.clientHeight > 20);
    check(`layout 10 ${w}: full sidebar names wrap`, nameFits);
    const keyboardColors = await page.evaluate(() => {
      const trigger = document.querySelector('.color-edit');
      trigger.click();
      const buttons = [trigger, ...document.querySelectorAll('.color-swatch')];
      return buttons.length === 13 && buttons.every(el => el.tagName === 'BUTTON' && el.tabIndex >= 0 && el.getAttribute('aria-label')) && trigger.getBoundingClientRect().width >= 28;
    });
    check(`layout 9 ${w}: color controls have labels and keyboard targets`, keyboardColors);
    const colorLook = await page.evaluate(() => {
      const trigger = document.querySelector('.color-edit'), pseudo = getComputedStyle(trigger, '::before');
      const hasDot = !['none', 'normal'].includes(pseudo.content);
      const dotWidth = hasDot ? parseFloat(pseudo.width) + (pseudo.boxSizing === 'border-box' ? 0 : parseFloat(pseudo.borderLeftWidth) + parseFloat(pseudo.borderRightWidth)) : trigger.getBoundingClientRect().width;
      return Math.abs(dotWidth - 14) < 0.1 && [...document.querySelectorAll('.color-swatch')].every(el => {
        const r = el.getBoundingClientRect();
        return r.width === 28 && r.height === 28;
      });
    });
    check(`layout guard ${w}: color dot and swatches keep original visible sizes`, colorLook);
    let keyboardWorks = false;
    if (keyboardColors) {
      // Close the pointer-opened palette, then operate it with real keys.
      await page.keyboard.press('Escape');
      await page.focus('.color-edit');
      await page.keyboard.press('Enter');
      const keyboardOpen = await page.evaluate(() => document.activeElement.matches('.color-swatch') &&
        document.querySelector('.color-picker-popover').classList.contains('show') &&
        getComputedStyle(document.activeElement).outlineStyle !== 'none');
      await page.keyboard.press('Tab');
      const tabbed = await page.evaluate(() => document.activeElement.matches('.color-swatch'));
      await page.evaluate(() => renderSidebar());
      const retained = await page.evaluate(() => document.activeElement.matches('.color-swatch') &&
        document.querySelector('.color-picker-popover').classList.contains('show'));
      keyboardWorks = keyboardOpen && tabbed && retained;
    }
    check(`layout 9 ${w}: keyboard opens palette, tabs swatches, and retains focus on updates`, keyboardWorks);
    await shot(w, h, 'drawer-palette');
    if (keyboardColors) await page.keyboard.press('Escape');
    else await page.evaluate(() => document.getElementById('color-picker-popover').classList.remove('show'));
    if (narrow) {
      await page.keyboard.press('Escape');
      const restored = await page.evaluate(() => document.activeElement === document.getElementById('btn-players'));
      check(`layout 8 ${w}: drawer restores Players focus`, restored);
      await page.waitForTimeout(50);
      const hidden = await page.locator('.player-vote-indicator').evaluateAll(els => els.every(el => getComputedStyle(el).visibility === 'hidden'));
      check(`layout 12 ${w}: vote indicators hide as drawer closes`, hidden);
      await shot(w, h, 'drawer-closing');
      await page.waitForTimeout(300);
    }
    await fixture('split');
    await shot(w, h, 'split');
    const note = await page.locator('.rs-note').evaluate(el => ({
      box: el.getBoundingClientRect().toJSON(), stage: document.querySelector('.stage').getBoundingClientRect().toJSON(),
      scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
    }));
    check(`layout 6 ${w}: long result note wraps inside stage`, note.scrollWidth <= note.clientWidth + 1 && boxFits(note.box, note.stage), JSON.stringify(note));
    const pill = await page.evaluate(() => ({
      outer: document.querySelector('.stage').getBoundingClientRect().toJSON(),
      boxes: [...document.querySelectorAll('.cpill, .cpill-label, .cpill-val')].map(el => el.getBoundingClientRect().toJSON()),
      values: document.querySelectorAll('.cpill-val').length,
    }));
    check(`layout 5 ${w}: eight-way split preserves all values inside stage`, pill.values === 8 && pill.boxes.every(b => boxFits(b, pill.outer)));
    // A complete row must be visible at every size, not just landscape.
    // scrollIntoView exposes the first row, but cannot repair a collapsed box.
    await page.locator('.stage-card').first().scrollIntoViewIfNeeded();
    const row = await page.evaluate(() => {
      const stage = document.querySelector('.stage').getBoundingClientRect();
      const table = document.querySelector('.stage-cards').getBoundingClientRect();
      const card = document.querySelector('.stage-card').getBoundingClientRect();
      const action = document.querySelector('.stage-action').getBoundingClientRect();
      const firstRow = [...document.querySelectorAll('.stage-card')].map(el => el.getBoundingClientRect()).filter(r => Math.abs(r.top - card.top) < 1);
      const visibleTop = Math.max(table.top, stage.top), visibleBottom = Math.min(table.bottom, stage.bottom);
      return { cardHeight: card.height, tableHeight: table.height,
        rowVisible: firstRow.every(r => r.top >= visibleTop - 1 && r.bottom <= visibleBottom + 1), overlap: table.bottom - action.top };
    });
    check(`layout 3 ${w}x${h}: results show one complete card row`, row.rowVisible && row.overlap <= 1, JSON.stringify(row));
    // Wheel over the stage padding so its inner card scroller cannot consume
    // this input. The final action must be visible and receive pointer input.
    const stage = await page.locator('.stage').boundingBox();
    await page.mouse.move(stage.x + 3, stage.y + stage.height / 2);
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(300);
    const actionReachable = await page.locator('#stage-action button').first().evaluate(el => {
      const r = el.getBoundingClientRect(), s = document.querySelector('.stage').getBoundingClientRect();
      return r.top >= s.top && r.bottom <= s.bottom + 1 && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el;
    });
    check(`layout 3 ${w}x${h}: result action is reachable by wheel`, actionReachable);
    await shot(w, h, 'split-scrolled');
    if (narrow) { await page.evaluate(() => toggleDrawer(true)); await page.waitForTimeout(300); }
    await page.locator('.history-item').scrollIntoViewIfNeeded();
    const history = await page.locator('.history-topic').evaluate(el => {
      const item = el.closest('.history-item').getBoundingClientRect(), result = el.nextElementSibling.getBoundingClientRect();
      return { width: el.getBoundingClientRect().width, resultRight: result.right, itemRight: item.right };
    });
    check(`layout 7 ${w}: history keeps useful topic width and contains result`, history.width >= 64 && history.resultRight <= history.itemRight + 1, JSON.stringify(history));
    await shot(w, h, 'history');
    if (narrow) { await page.evaluate(() => toggleDrawer(false)); await page.waitForTimeout(300); }
    await fixture('topic');
    const topic = await page.locator('.topic-text').evaluate(el => el.scrollWidth <= el.clientWidth + 1);
    check(`layout 6 ${w}: unbroken guest topic wraps`, topic);
    await shot(w, h, 'topic');
    const topicStage = await page.locator('.stage').boundingBox();
    await page.mouse.move(topicStage.x + 3, topicStage.y + topicStage.height / 2);
    await page.mouse.wheel(0, 1000);
    await page.waitForTimeout(200);
    const scrollBeforeCountdown = await page.locator('.stage').evaluate(el => el.scrollTop);
    await page.evaluate(() => {
      state.room.countdownBy = 'Z'.repeat(40);
      state.room.countdownEndsAt = Date.now() + 60000;
      updateCountdown();
    });
    await page.waitForTimeout(450); // let countdownPop settle before geometry checks
    await page.mouse.wheel(0, -1); // the overlay must also follow scrolling while open
    await page.waitForTimeout(100);
    const countdown = await page.locator('.countdown-label').evaluate(el => {
      const r = el.getBoundingClientRect(), s = document.querySelector('.stage').getBoundingClientRect();
      return r.left >= s.left && r.right <= s.right && el.scrollWidth <= el.clientWidth + 1;
    });
    check(`layout 6 ${w}: long countdown name wraps inside stage`, countdown);
    const countdownCenter = await page.evaluate(() => {
      const stage = document.querySelector('.stage'), s = stage.getBoundingClientRect();
      const overlay = document.getElementById('countdown-overlay').getBoundingClientRect();
      const number = document.querySelector('.countdown-number').getBoundingClientRect();
      const label = document.querySelector('.countdown-label').getBoundingClientRect();
      return { scrollTop: stage.scrollTop, offset: Math.abs(overlay.top + overlay.height / 2 - s.top - s.height / 2),
        inside: [number, label].every(r => r.top >= s.top && r.bottom <= s.bottom && r.left >= s.left && r.right <= s.right) };
    });
    countdownCenter.scrollBefore = scrollBeforeCountdown;
    check(`layout guard ${w}x${h}: countdown stays centered after stage scroll`, countdownCenter.offset < 2 && countdownCenter.inside && (h !== 375 || scrollBeforeCountdown > 0), JSON.stringify(countdownCenter));
    await shot(w, h, 'countdown');
    const cleared = await page.evaluate(() => {
      state.room.countdownEndsAt = null;
      state.room.topic = '';
      stopCountdown();
      renderStage();
      const stage = document.querySelector('.stage'), overlay = document.getElementById('countdown-overlay');
      return { scrollTop: stage.scrollTop, scrollHeight: stage.scrollHeight, clientHeight: stage.clientHeight,
        transform: overlay.style.transform, showing: overlay.classList.contains('show') };
    });
    check(`layout guard ${w}x${h}: normal voting clears countdown scroll range`, cleared.scrollTop === 0 && cleared.scrollHeight === cleared.clientHeight && !cleared.transform && !cleared.showing, JSON.stringify(cleared));
  }
  await ctx.close();
}

(async () => {
  require(path.join(__dirname, '..', 'server.js'));
  const base = `http://localhost:${PORT}`;
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
  const guestCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });

  await layoutRegressions(browser, base);
  for (const vp of process.env.LAYOUT_ONLY ? [] : VIEWPORTS) {
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
