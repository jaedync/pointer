// Browser E2E for the behaviors unit tests can't reach: the reveal/flip-back
// animation lifecycle, countdown overlay, clean-URL routing, back-button leave,
// token reconnect after reload, and XSS-safe rendering. Requires playwright.
//   npm run test:e2e
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');

const PORT = 3987;
process.env.PORT = String(PORT);
process.env.COUNTDOWN_MS = '2200'; // spans ~3 displayed seconds so the strobe check is meaningful
process.env.POINTER_STATE_FILE = ''; // never write a snapshot from a test run
const SHOTS = os.tmpdir();

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const server = require(path.join(__dirname, '..', 'server.js'));
  await sleep(300);
  const base = `http://localhost:${PORT}`;
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
  const errors = { host: [], guest: [] };

  const host = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();
  host.on('pageerror', e => errors.host.push(e.message));
  guest.on('pageerror', e => errors.guest.push(e.message));
  host.on('console', m => { if (m.type() === 'error') errors.host.push(m.text()); });
  guest.on('console', m => { if (m.type() === 'error') errors.guest.push(m.text()); });

  // Landing + create
  await host.goto(base, { waitUntil: 'networkidle' });
  check('landing renders', await host.locator('text=Pointer').first().isVisible());
  await host.evaluate(() => showLobbyModal());
  await host.fill('#lobby-player-name', 'Alice');
  await host.fill('#lobby-game-name', 'Sprint Demo');
  await host.click('#btn-create-game');
  await host.waitForFunction(() => document.getElementById('app').classList.contains('active'), { timeout: 5000 });
  const code = new URL(host.url()).pathname.slice(1);
  check('host created room + entered game', /^[a-z0-9]{5}$/.test(code), `code=${code}`);
  check('clean URL routing (/CODE, no hash)', !host.url().includes('#'));

  // Guest joins via landing
  await guest.goto(base, { waitUntil: 'networkidle' });
  await guest.fill('#landing-room-code', code.toUpperCase()); // case-insensitive
  await guest.evaluate(() => joinFromLanding());
  await guest.waitForSelector('#join-overlay:not(.hidden)', { timeout: 5000 });
  await guest.fill('#join-player-name', 'Bob');
  await guest.click('#btn-join-game');
  await guest.waitForFunction(() => document.getElementById('app').classList.contains('active'), { timeout: 5000 });
  await host.waitForFunction(() => document.querySelectorAll('#players-list .player-row').length === 2, { timeout: 5000 });
  check('both clients see 2 players',
    (await host.locator('#players-list .player-row').count()) === 2 &&
    (await guest.locator('#players-list .player-row').count()) === 2);

  // XSS safety: a player name with markup renders as text, not HTML.
  const xssLeaked = await guest.evaluate(() => !!document.querySelector('#pwn-probe'));
  check('no script injection from names (sanity)', !xssLeaked);

  // Vote + reveal
  await host.locator('#hand-cards .hand-card', { hasText: 'M' }).first().click();
  await guest.locator('#hand-cards .hand-card', { hasText: 'L' }).first().click();
  await sleep(300);
  // Your OWN vote must show as "voted" in your sidebar (server unmasks your own
  // value, so a strict ==='voted' check left it stuck on "waiting").
  check('own sidebar indicator shows voted after voting',
    (await host.locator('#players-list .player-row.is-you .player-vote-indicator.voted').count()) === 1 &&
    (await host.locator('#players-list .player-row.is-you .player-vote-indicator.waiting').count()) === 0);
  // And the guest sees the host as voted too (the other-player path).
  check('other players see your vote as voted',
    (await guest.locator('#players-list .player-vote-indicator.voted').count()) >= 1);
  // Count countdownPop animation (re)starts on the guest during the countdown:
  // a healthy ~2.2s countdown shows 3,2,1 → ~3 pops. The strobe bug restarted
  // the animation ~5x/sec (~11+). Anything above a few = regression.
  await guest.evaluate(() => {
    window.__pops = 0;
    document.addEventListener('animationstart', e => { if (e.animationName === 'countdownPop') window.__pops++; }, true);
  });
  await host.click('button.btn-reveal');
  await guest.waitForSelector('#countdown-overlay.show', { timeout: 3000 }).catch(() => {});
  check('guest sees countdown overlay (room-state driven)',
    (await guest.locator('#countdown-overlay.show').count()) > 0);
  await host.waitForFunction(() => state.room && state.room.revealed === true, { timeout: 5000 });
  const pops = await guest.evaluate(() => window.__pops);
  check('countdown does not strobe (≤5 pop animations over a 2.2s countdown)', pops <= 5, `${pops} countdownPop restarts`);
  await sleep(900);
  await host.screenshot({ path: path.join(SHOTS, 'pointer-e2e-revealed.png') });
  const revealed = await host.$$eval('#stage-cards .sc-value', els => els.map(e => e.textContent));
  check('revealed votes shown on stage', revealed.includes('M') && revealed.includes('L'), revealed.join(','));
  check('countdown overlay cleared after reveal', (await host.locator('#countdown-overlay.show').count()) === 0);
  check('exactly one host', await host.evaluate(() => state.room.players.filter(p => p.isHost).length) === 1);

  // New round → flip-back
  await host.click('button.btn-new-round');
  await host.waitForFunction(() => state.room && state.room.revealed === false, { timeout: 4000 });
  await sleep(700);
  check('new round flips all cards back to front',
    (await host.$$eval('#stage-cards .stage-card-inner', els => els.filter(e => e.classList.contains('flip')).length)) === 0);
  check('new round shows waiting faces', (await host.locator('#stage-cards .sc-waiting').count()) === 2);

  // Reconnect: reload host → reclaim seat, single host, no ghost
  await host.reload({ waitUntil: 'networkidle' });
  await host.waitForFunction(() => document.getElementById('app').classList.contains('active'), { timeout: 6000 });
  await host.waitForFunction(() => state.room && state.room.players.length === 2, { timeout: 5000 });
  check('host reconnect reclaims seat',
    (await host.evaluate(() => { const me = state.room.players.find(p => p.id === state.playerId); return me && me.name; })) === 'Alice');
  check('exactly one host after reconnect', (await host.evaluate(() => state.room.players.filter(p => p.isHost).length)) === 1);
  check('no ghost player after reconnect', (await guest.locator('#players-list .player-row').count()) === 2);
  // A reload must look like the same room, not a new arrival: no "You are now
  // the host" toast (you were already host) and no deal-in animation.
  await sleep(300);
  check('reload shows no host-change toast',
    !(await host.evaluate(() => !!document.getElementById('toast')?.classList.contains('show'))));
  // Look at the first frame that has cards: the deal-in runs for ~0.5 s.
  await host.reload({ waitUntil: 'commit' });
  const entering = await host.waitForFunction(() => {
    const cards = document.querySelectorAll('#stage-cards .stage-card');
    // An object, not a number: a count of 0 is falsy and would keep waiting.
    return cards.length ? { n: [...cards].filter(c => c.classList.contains('is-entering')).length } : false;
  }, null, { timeout: 6000, polling: 'raf' }).then(h => h.jsonValue()).then(v => v.n);
  check('reload does not deal the table cards in again', entering === 0, `${entering} card(s) dealing in`);
  await host.waitForFunction(() => state.room && state.room.players.length === 2, { timeout: 5000 });

  // Toasts center on the stage (right of the sidebar), not on the window.
  const offset = await host.evaluate(() => {
    showToast('Centering check');
    const t = document.getElementById('toast').getBoundingClientRect();
    const st = document.querySelector('.stage').getBoundingClientRect();
    return Math.abs((t.left + t.width / 2) - (st.left + st.width / 2));
  });
  check('toast is centered on the stage', offset < 2, `${offset.toFixed(1)}px off`);

  // Escape clears your vote, like Backspace.
  await host.click('.hand-card[data-value="M"]');
  await guest.waitForFunction(() => state.room.players.some(p => p.name === 'Alice' && p.vote), { timeout: 3000 });
  await host.keyboard.press('Escape');
  const cleared = await guest.waitForFunction(() => state.room.players.some(p => p.name === 'Alice' && !p.vote), null, { timeout: 3000 }).then(() => true, () => false);
  check('Escape clears your vote', cleared && (await host.evaluate(() => state.myVote)) === null);

  // Back button → leave room (no ghost)
  await guest.goBack();
  await sleep(500);
  check('back button returns guest to landing',
    await guest.evaluate(() => document.getElementById('landing').classList.contains('active')));
  await host.waitForFunction(() => state.room && state.room.players.length === 1, { timeout: 5000 }).catch(() => {});
  check('back leaves the room server-side', (await host.evaluate(() => state.room.players.length)) === 1);

  // Attribute XSS: a name with a quote must not break out of title="" in the
  // result chips (review finding: escapeHtml left quotes as-is).
  const mallory = await (await browser.newContext()).newPage();
  mallory.on('pageerror', e => errors.guest.push(e.message));
  await mallory.goto(`${base}/${code}`);
  await mallory.waitForSelector('#join-overlay:not(.hidden)', { timeout: 5000 });
  await mallory.fill('#join-player-name', '" onmouseover="window.__pwn=1" x="');
  await mallory.click('#btn-join-game');
  await mallory.waitForFunction(() => document.getElementById('app').classList.contains('active'), { timeout: 5000 });
  await mallory.click('.hand-card[data-value="M"]');
  await host.click('.hand-card[data-value="L"]');
  await host.waitForFunction(() => state.room.players.every(p => p.vote), { timeout: 5000 });
  await host.click('.btn-reveal');
  await host.waitForSelector('#round-stats .rs-chip', { timeout: 6000 });
  for (const chip of await host.locator('#round-stats .rs-chip').all()) await chip.hover();
  check('a quote in a name cannot add an event handler',
    (await host.evaluate(() => !document.querySelector('[onmouseover]') && window.__pwn === undefined)));
  await mallory.close();

  // Watch only on, then off: the hand must come back (review finding: a stale
  // render key skipped the rebuild).
  await host.click('.btn-new-round');
  await host.evaluate(() => setObserver(true));
  await host.waitForSelector('#hand-cards .hand-message', { timeout: 5000 });
  await host.evaluate(() => setObserver(false));
  await host.waitForSelector('#hand-cards .hand-card', { timeout: 5000 }).catch(() => {});
  check('hand comes back after watch-only is turned off', (await host.locator('#hand-cards .hand-card').count()) > 0);

  // Back while the "Switch rooms?" dialog is open: the dialog closes and the
  // user stays in the room (review finding: Stay then read a null room).
  await host.evaluate(() => navigate('/zzzzz'));
  await host.waitForSelector('#confirm-overlay:not(.hidden)', { timeout: 5000 });
  await host.goBack();
  await sleep(500);
  check('Back closes the switch dialog and keeps the room',
    (await host.evaluate(() => document.getElementById('confirm-overlay').classList.contains('hidden') && state.room?.id)) === code &&
    new URL(host.url()).pathname === `/${code}`);

  check('no host page errors', errors.host.length === 0, errors.host.join(' | '));
  check('no guest page errors', errors.guest.length === 0, errors.guest.join(' | '));

  await browser.close();
  server.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('E2E crashed:', e); process.exit(2); });
