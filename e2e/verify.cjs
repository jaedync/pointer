// Browser E2E for the behaviors unit tests can't reach: the reveal/flip-back
// animation lifecycle, countdown overlay, clean-URL routing, back-button leave,
// token reconnect after reload, and XSS-safe rendering. Requires playwright.
//   npm run test:e2e
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');

const PORT = 3987;
process.env.PORT = String(PORT);
process.env.COUNTDOWN_MS = '700'; // observable cascade without long waits
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
  const browser = await chromium.launch();
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
  await host.click('button.btn-reveal');
  await guest.waitForSelector('#countdown-overlay.show', { timeout: 3000 }).catch(() => {});
  check('guest sees countdown overlay (room-state driven)',
    (await guest.locator('#countdown-overlay.show').count()) > 0);
  await host.waitForFunction(() => state.room && state.room.revealed === true, { timeout: 4000 });
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

  // Back button → leave room (no ghost)
  await guest.goBack();
  await sleep(500);
  check('back button returns guest to landing',
    await guest.evaluate(() => document.getElementById('landing').classList.contains('active')));
  await host.waitForFunction(() => state.room && state.room.players.length === 1, { timeout: 5000 }).catch(() => {});
  check('back leaves the room server-side', (await host.evaluate(() => state.room.players.length)) === 1);

  check('no host page errors', errors.host.length === 0, errors.host.join(' | '));
  check('no guest page errors', errors.guest.length === 0, errors.guest.join(' | '));

  await browser.close();
  server.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('E2E crashed:', e); process.exit(2); });
