# Pointer UX Changes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship eight UX changes to Pointer — clean URLs, countdown voting, bigger revealed-card text, a relocated and grounded consensus headline, green agreement-highlighting, higher room-title contrast, a room-aware page title, and a scroll-overflow fix.

**Architecture:** Pointer is a single Node.js process — `server.js` (HTTP + WebSocket), `room.js` (pure room logic, unit-tested), and `public/index.html` (single-file SPA with inline CSS + JS). The consensus rule lands in `room.js` as a pure, unit-tested function and rides along on the serialized room; all other changes are in `index.html`. The server needs no changes.

**Tech Stack:** Node.js, `ws`, Node's built-in test runner (`node --test`). Frontend is vanilla ES modules with inline CSS. No build step.

**Testing note:** `room.js` changes are TDD with `node --test`. The project has no frontend test harness (only `room.test.js` and `server.test.js` exist), so `index.html` changes are verified by running the app and checking it in a browser with the Playwright MCP tools, plus confirming `npm test` still passes. This split was set in the design spec (`docs/superpowers/specs/2026-05-21-pointer-ux-changes-design.md`).

**Browser verification setup (used by Tasks 4–9):** start the app on a non-default port so it never collides with anything already on 3000:

```bash
PORT=4173 node server.js &
```

Navigate to `http://localhost:4173` with the Playwright browser tools. Kill the process (`kill %1` or by PID) when done with a task.

---

## Task 1: `computeConsensus()` in room.js

Pure function that classifies a revealed round into one of four consensus states. Excludes `?` votes and non-votes from the tally.

**Files:**
- Modify: `room.js` (add function near the other pure helpers, ~after `applyReveal`, and add to `module.exports`)
- Test: `room.test.js` (add a new `describe` block)

- [ ] **Step 1: Write the failing tests**

Add to the end of `room.test.js`, before nothing else depends on order — append at the bottom of the file:

```js
// ─── computeConsensus ────────────────────────────────────────────────────────

describe('computeConsensus', () => {
  // Build a room whose players carry the given votes. `null` = did not vote.
  function roomWithVotes(votes) {
    const room = createRoom('Test', 'fib');
    votes.forEach((v, i) => {
      const { playerId } = addPlayer(room, 'P' + i);
      if (v !== null) room.players.get(playerId).vote = v;
    });
    return room;
  }

  it('no consensus when every vote is different', () => {
    const r = computeConsensus(roomWithVotes(['1', '2', '3', '5']));
    assert.equal(r.state, 'none');
    assert.deepEqual(r.values, []);
  });

  it('no consensus with a single voter', () => {
    assert.equal(computeConsensus(roomWithVotes(['5'])).state, 'none');
  });

  it('no consensus when nobody voted', () => {
    assert.equal(computeConsensus(roomWithVotes([null, null])).state, 'none');
  });

  it('no consensus when every vote is "?"', () => {
    assert.equal(computeConsensus(roomWithVotes(['?', '?', '?'])).state, 'none');
  });

  it('unanimous when all players voted the same value', () => {
    const r = computeConsensus(roomWithVotes(['5', '5', '5']));
    assert.equal(r.state, 'unanimous');
    assert.deepEqual(r.values, ['5']);
  });

  it('consensus when one value leads but not everyone agrees', () => {
    const r = computeConsensus(roomWithVotes(['5', '5', '3']));
    assert.equal(r.state, 'consensus');
    assert.deepEqual(r.values, ['5']);
  });

  it('a "?" vote prevents unanimous, falls back to consensus', () => {
    const r = computeConsensus(roomWithVotes(['5', '5', '?']));
    assert.equal(r.state, 'consensus');
    assert.deepEqual(r.values, ['5']);
  });

  it('split on a two-way tie', () => {
    const r = computeConsensus(roomWithVotes(['3', '3', '5', '5']));
    assert.equal(r.state, 'split');
    assert.equal(r.values.length, 2);
    assert.ok(r.values.includes('3') && r.values.includes('5'));
  });

  it('split on a three-way tie', () => {
    const r = computeConsensus(roomWithVotes(['1', '1', '2', '2', '3', '3']));
    assert.equal(r.state, 'split');
    assert.equal(r.values.length, 3);
  });

  it('excludes "?" votes from the tally', () => {
    // 5,5 lead with count 2; the two "?" voters do not form a camp.
    const r = computeConsensus(roomWithVotes(['5', '5', '?', '?']));
    assert.equal(r.state, 'consensus');
    assert.deepEqual(r.values, ['5']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test room.test.js`
Expected: FAIL — `computeConsensus is not defined` (it is imported but does not exist yet; also add it to the import — see Step 3).

- [ ] **Step 3: Implement `computeConsensus` and export it**

In `room.js`, add this function immediately after `applyReveal` (after its closing `}` on the line `}` that ends `applyReveal`, before `function newRound`):

```js
// Classify a revealed round. Excludes '?' votes and non-votes from the tally.
// Returns { state, values, maxCount } where state is one of:
//   'none'      — no value is shared by 2+ players (or too few votes)
//   'unanimous' — one value, and every voter chose it
//   'consensus' — one value leads but not everyone agrees
//   'split'     — two or more values tie for the lead
function computeConsensus(room) {
  const players = [...room.players.values()];
  const voters = players.filter(p => p.vote);            // voted anything, incl '?'
  const valueVotes = voters.map(p => p.vote).filter(v => v !== '?');

  const counts = {};
  for (const v of valueVotes) counts[v] = (counts[v] || 0) + 1;

  const values = Object.keys(counts);
  let maxCount = 0;
  for (const v of values) if (counts[v] > maxCount) maxCount = counts[v];

  if (maxCount < 2) return { state: 'none', values: [], maxCount };

  const topValues = values.filter(v => counts[v] === maxCount);
  if (topValues.length === 1 && maxCount === voters.length) {
    return { state: 'unanimous', values: topValues, maxCount };
  }
  if (topValues.length === 1) {
    return { state: 'consensus', values: topValues, maxCount };
  }
  return { state: 'split', values: topValues, maxCount };
}
```

In `room.js`, add `computeConsensus` to `module.exports` (insert after `applyReveal,`):

```js
  applyReveal,
  computeConsensus,
  newRound,
```

In `room.test.js`, add `computeConsensus` to the destructured import at the top (after `applyReveal,`):

```js
  applyReveal,
  computeConsensus,
  newRound,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test room.test.js`
Expected: PASS — all `computeConsensus` tests green, all existing tests still green.

- [ ] **Step 5: Commit**

```bash
git add room.js room.test.js
git commit -m "feat: add computeConsensus for revealed-round classification"
```

---

## Task 2: Include consensus in the serialized room

`serializeRoom` ships a `consensus` field so the client renders the headline and rings from one server-computed source.

**Files:**
- Modify: `room.js` — `serializeRoom`
- Test: `room.test.js` (add to a new `describe`)

- [ ] **Step 1: Write the failing tests**

Append to the bottom of `room.test.js`:

```js
// ─── serializeRoom consensus field ───────────────────────────────────────────

describe('serializeRoom consensus', () => {
  it('is null before reveal', () => {
    const room = createRoom('Test', 'fib');
    addPlayer(room, 'Alice');
    assert.equal(serializeRoom(room).consensus, null);
  });

  it('is populated after reveal', () => {
    const room = createRoom('Test', 'fib');
    const { playerId: a } = addPlayer(room, 'Alice');
    const { playerId: b } = addPlayer(room, 'Bob');
    vote(room, a, '5');
    vote(room, b, '5');
    applyReveal(room);
    const consensus = serializeRoom(room).consensus;
    assert.equal(consensus.state, 'unanimous');
    assert.deepEqual(consensus.values, ['5']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test room.test.js`
Expected: FAIL — `serializeRoom(room).consensus` is `undefined`, not `null` / not the expected object.

- [ ] **Step 3: Add the `consensus` field to `serializeRoom`**

In `room.js`, in the object returned by `serializeRoom`, add the `consensus` line immediately after `consensusCount: room.consensusCount,`:

```js
    revealed: room.revealed,
    roundNumber: room.roundNumber,
    consensusCount: room.consensusCount,
    consensus: room.revealed ? computeConsensus(room) : null,
    players: [...room.players.entries()].map(([sid, p]) => ({
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test room.test.js`
Expected: PASS — both new tests green, all existing green.

- [ ] **Step 5: Commit**

```bash
git add room.js room.test.js
git commit -m "feat: include consensus classification in serialized room"
```

---

## Task 3: Allow voting during the countdown

The server already accepts votes during the countdown (it blocks only on `revealed`). This task locks that guarantee with a `room.js` test and removes the client-side hand lock so the player can actually change a vote in those 3 seconds.

**Files:**
- Test: `room.test.js` (add to a new `describe`)
- Modify: `public/index.html` — `pickCard`, `renderHand`, `renderCountdown`

- [ ] **Step 1: Write the failing test**

Append to the bottom of `room.test.js`:

```js
// ─── voting during the reveal countdown ──────────────────────────────────────

describe('vote during countdown', () => {
  it('accepts a vote while a reveal countdown is pending', () => {
    const room = createRoom('Test', 'fib');
    const { playerId: host } = addPlayer(room, 'Host');
    const { playerId: bob } = addPlayer(room, 'Bob');
    vote(room, host, '3');
    vote(room, bob, '3');

    // Host initiates the reveal. The server then sets _countdownTimer and
    // calls applyReveal only when it fires — revealed is still false here.
    assert.equal(reveal(room, host).ok, true);
    room._countdownTimer = setTimeout(() => {}, 1000); // simulate pending countdown

    // A player changes their mind during the countdown window.
    assert.equal(vote(room, bob, '8'), true);
    assert.equal(room.players.get(bob).vote, '8');

    clearTimeout(room._countdownTimer);
  });
});
```

- [ ] **Step 2: Run the test to verify it passes immediately**

Run: `node --test room.test.js`
Expected: PASS — this test documents an existing server-side guarantee (`vote` checks only `revealed`). If it FAILS, stop: the server logic regressed and must be fixed before continuing.

- [ ] **Step 3: Remove the countdown lock from `pickCard`**

In `public/index.html`, find `pickCard` (~line 1517):

```js
  function pickCard(value) {
    if (state.room.revealed || state.countdown) return;
```

Replace the guard line with:

```js
  function pickCard(value) {
    if (state.room.revealed) return;
```

- [ ] **Step 4: Remove the countdown lock from `renderHand`**

In `public/index.html`, find `renderHand` (~line 1505):

```js
    const locked = state.room.revealed || state.countdown;
```

Replace with:

```js
    const locked = state.room.revealed;
```

- [ ] **Step 5: Remove the hand-lock block from `renderCountdown`**

In `public/index.html`, find this block inside `renderCountdown` (~lines 1573–1576):

```js
      overlay.classList.add('show');
      // Also lock the hand
      const handCards = document.getElementById('hand-cards');
      if (handCards) handCards.classList.add('hand-locked');
    } else if (overlay) {
```

Replace it with (drop the lock, keep the rest):

```js
      overlay.classList.add('show');
    } else if (overlay) {
```

- [ ] **Step 6: Verify in the browser**

Start the app: `PORT=4173 node server.js &`. With the Playwright tools, open `http://localhost:4173` in two tabs/contexts. Create a room in tab 1, join it from tab 2. Both vote. In tab 1 (host), click Reveal — the 3s countdown starts. During the countdown, in tab 2 click a different hand card. Confirm the card selection changes (the hand is not greyed out / not locked). After the countdown, confirm tab 2's revealed card shows the changed value. Stop the server (`kill %1`).

- [ ] **Step 7: Commit**

```bash
git add room.test.js public/index.html
git commit -m "feat: allow players to change their vote during the countdown"
```

---

## Task 4: Clean URLs — History API routing

Replace hash routing (`#/`, `#/join/CODE`, `#/room/CODE`) with path routing: `/` for the landing page and `/CODE` for a room.

**Files:**
- Modify: `public/index.html` — `connect`, `handleMessage` (`room-created`, `joined`, `error`), `joinFromLanding`, `leaveRoom`, `copyInviteLink`, the router block, and init.

No server change: `server.js` already serves `index.html` for any path without a static-asset extension.

- [ ] **Step 1: Simplify the reconnect check in `connect`**

In `public/index.html`, find (~lines 1212–1218):

```js
    ws.onopen = () => {
      state.connected = true;
      const hash = location.hash;
      if (hash.startsWith('#/room/') && state.room) {
        send({ type: 'join-room', roomId: state.room.id, playerName: getMyName() });
      }
    };
```

Replace with:

```js
    ws.onopen = () => {
      state.connected = true;
      if (state.room) {
        send({ type: 'join-room', roomId: state.room.id, playerName: getMyName() });
      }
    };
```

- [ ] **Step 2: Update the `room-created` and `joined` handlers**

In `public/index.html`, find (~lines 1239–1248):

```js
      case 'room-created':
        state.playerId = msg.playerId;
        state.wasHost = true; // creator is host, don't toast
        location.hash = `#/room/${msg.roomId}`;
        break;
      case 'joined':
        state.playerId = msg.playerId;
        location.hash = `#/room/${msg.roomId}`;
        hideModals();
        break;
```

Replace with:

```js
      case 'room-created':
        state.playerId = msg.playerId;
        state.wasHost = true; // creator is host, don't toast
        history.pushState(null, '', `/${msg.roomId}`);
        hideModals();
        showGame();
        break;
      case 'joined':
        state.playerId = msg.playerId;
        history.pushState(null, '', `/${msg.roomId}`);
        hideModals();
        showGame();
        break;
```

- [ ] **Step 3: Update the `error` handler to detect the join modal directly**

In `public/index.html`, find (~lines 1275–1286):

```js
      case 'error': {
        const joinOverlay = document.getElementById('join-overlay');
        const isOnJoinRoute = location.hash.startsWith('#/join/');
        if (isOnJoinRoute && !joinOverlay.classList.contains('hidden')) {
          const errEl = document.getElementById('join-error');
          errEl.textContent = msg.message;
          errEl.style.display = 'block';
        } else {
          alert(msg.message);
        }
        break;
      }
```

Replace with:

```js
      case 'error': {
        const joinOverlay = document.getElementById('join-overlay');
        if (!joinOverlay.classList.contains('hidden')) {
          const errEl = document.getElementById('join-error');
          errEl.textContent = msg.message;
          errEl.style.display = 'block';
        } else {
          alert(msg.message);
        }
        break;
      }
```

- [ ] **Step 4: Update `joinFromLanding`**

In `public/index.html`, find (~lines 1318–1322):

```js
  function joinFromLanding() {
    const code = document.getElementById('landing-room-code').value.trim().toLowerCase();
    if (!code) { document.getElementById('landing-room-code').focus(); return; }
    location.hash = `#/join/${code}`;
  }
```

Replace with:

```js
  function joinFromLanding() {
    const code = document.getElementById('landing-room-code').value.trim().toLowerCase();
    if (!code) { document.getElementById('landing-room-code').focus(); return; }
    navigate(`/${code}`);
  }
```

- [ ] **Step 5: Update `leaveRoom`**

In `public/index.html`, find (~lines 1531–1539):

```js
  function leaveRoom() {
    if (!confirm('Leave this room?')) return;
    send({ type: 'leave-room' });
    state.room = null;
    state.playerId = null;
    state.myVote = null;
    state.wasHost = false;
    location.hash = '#/';
  }
```

Replace the last line:

```js
  function leaveRoom() {
    if (!confirm('Leave this room?')) return;
    send({ type: 'leave-room' });
    state.room = null;
    state.playerId = null;
    state.myVote = null;
    state.wasHost = false;
    navigate('/');
  }
```

- [ ] **Step 6: Update `copyInviteLink`**

In `public/index.html`, find (~line 1542):

```js
    const url = `${location.origin}${location.pathname}#/join/${state.room.id}`;
```

Replace with:

```js
    const url = `${location.origin}/${state.room.id}`;
```

- [ ] **Step 7: Replace the router block**

In `public/index.html`, find the whole router block (~lines 1606–1636), from the comment `// ─── Hash Router + Init ───` through the closing `}` of `handleRoute`:

```js
  // ─── Hash Router + Init ───────────────────────────────────────────────────────
  function handleRoute() {
    const hash = location.hash || '#/';
    if (hash === '#/' || hash === '') {
      showLanding();
    } else if (hash.startsWith('#/join/')) {
      const roomId = (hash.split('/')[2] || '').toLowerCase();
      // Already in this room? Just stay
      if (state.room && state.room.id === roomId) {
        location.hash = `#/room/${roomId}`;
        return;
      }
      // In a different room? Confirm before switching
      if (state.room) {
        if (!confirm('Leave your current room to join a different one?')) {
          location.hash = `#/room/${state.room.id}`;
          return;
        }
        send({ type: 'leave-room' });
        state.room = null;
        state.playerId = null;
        state.myVote = null;
        state.wasHost = false;
      }
      showLanding();
      showJoinModal(roomId);
    } else if (hash.startsWith('#/room/')) {
      showGame();
      hideModals();
    }
  }
```

Replace the entire block with:

```js
  // ─── Path Router + Init ───────────────────────────────────────────────────────
  // Routes: '/' = landing, '/CODE' = a room.
  function navigate(path) {
    if (location.pathname !== path) history.pushState(null, '', path);
    handleRoute();
  }

  function handleRoute() {
    const code = location.pathname.slice(1).toLowerCase();
    if (!code) {
      showLanding();
      return;
    }
    // Already in this room — just show it.
    if (state.room && state.room.id === code) {
      showGame();
      hideModals();
      return;
    }
    // In a different room — confirm before switching.
    if (state.room) {
      if (!confirm('Leave your current room to join a different one?')) {
        navigate(`/${state.room.id}`);
        return;
      }
      send({ type: 'leave-room' });
      state.room = null;
      state.playerId = null;
      state.myVote = null;
      state.wasHost = false;
    }
    // Not in this room yet — show the landing page with the join modal.
    showLanding();
    showJoinModal(code);
  }
```

- [ ] **Step 8: Swap the `hashchange` listener for `popstate`**

In `public/index.html`, find (~line 1649):

```js
  window.addEventListener('hashchange', handleRoute);
```

Replace with:

```js
  window.addEventListener('popstate', handleRoute);
```

- [ ] **Step 9: Run the backend tests**

Run: `npm test`
Expected: PASS — no backend regressions (routing is client-only; `server.test.js` "serves index.html" still passes since the server is unchanged).

- [ ] **Step 10: Verify in the browser**

Start: `PORT=4173 node server.js &`. With the Playwright tools:
- Open `http://localhost:4173/` — landing page shows, URL has no `#`.
- Create a room — URL becomes `http://localhost:4173/<code>`, game view shows.
- Click "Copy link", read the clipboard (or inspect `copyInviteLink`) — link is `http://localhost:4173/<code>`, no `#`.
- Open the copied `/<code>` URL in a second context — the join modal appears.
- Join, then click browser Back — landing shows; Forward — room shows again.
- Open `http://localhost:4173/zzzzz` (nonexistent), enter a name, click Join — the inline "Room not found" error appears in the join modal.
Stop the server (`kill %1`).

- [ ] **Step 11: Commit**

```bash
git add public/index.html
git commit -m "feat: clean URLs via History API routing (/CODE instead of #/room/CODE)"
```

---

## Task 5: Bigger revealed-card text

Option C from the design: score 42px, name 14px, name-bar 36px, with a more legible name-bar weight/opacity. Plus a scaled-down set of values for the mobile card.

**Files:**
- Modify: `public/index.html` — `.stage-card-back` CSS rules, and the mobile `@media` block.

- [ ] **Step 1: Update the desktop revealed-card text rules**

In `public/index.html`, find (~lines 609–627):

```css
  .stage-card-back .sc-value {
    font-family: 'Recursive', sans-serif;
    font-size: 30px; font-weight: 800;
    color: var(--text);
    font-variation-settings: 'CASL' 0.5;
    line-height: 1;
  }
  .stage-card-back .sc-name-bar {
    height: 26px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 0 0 12px 12px;
    padding: 0 8px;
  }
  .stage-card-back .sc-name {
    font-size: 9px; font-weight: 600;
    color: rgba(255,255,255,0.7);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    max-width: 100%;
  }
```

Replace with:

```css
  .stage-card-back .sc-value {
    font-family: 'Recursive', sans-serif;
    font-size: 42px; font-weight: 800;
    color: var(--text);
    font-variation-settings: 'CASL' 0.5;
    line-height: 1;
  }
  .stage-card-back .sc-name-bar {
    height: 36px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 0 0 12px 12px;
    padding: 0 8px;
  }
  .stage-card-back .sc-name {
    font-size: 14px; font-weight: 700;
    color: rgba(255,255,255,0.95);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    max-width: 100%;
  }
```

- [ ] **Step 2: Remove the stray closing brace below `.sc-name`**

Directly after the `.sc-name` rule there is a stray extra `}` (~line 628) — a leftover that closes nothing. Find:

```css
    max-width: 100%;
  }
  }

  .stage-action {
```

Replace with (drop the extra brace):

```css
    max-width: 100%;
  }

  .stage-action {
```

- [ ] **Step 3: Add scaled-down values for the mobile card**

In `public/index.html`, find the mobile rule (~line 1012):

```css
    .stage-card { width: 60px; height: 84px; }
```

Replace with (add the proportionally smaller text for the 60×84 card):

```css
    .stage-card { width: 60px; height: 84px; }
    .stage-card-back .sc-value { font-size: 30px; }
    .stage-card-back .sc-name { font-size: 11px; }
    .stage-card-back .sc-name-bar { height: 28px; }
```

- [ ] **Step 4: Verify in the browser**

Start: `PORT=4173 node server.js &`. With the Playwright tools, create a room, join from a second context with a long player name (e.g. "Priyanka"), both vote, reveal. Confirm: score is clearly larger, the name is readable (~14px) and ellipsizes if long, nothing overflows the card. Resize the viewport to ~390px wide and confirm the mobile card text still fits. Stop the server.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat: enlarge revealed-card score and name for readability"
```

---

## Task 6: Consensus above the cards — layout, pill, and green rings

Move the consensus headline above the card row, pin the card row to the stage's vertical center, drop the "Results" status line, render the new filled pill, and ring the most-common cards green. The HTML, CSS, and `renderStage` change together so the app is never left in a broken state.

**Files:**
- Modify: `public/index.html` — stage HTML block, stage/`.big-average` CSS, `renderStage`.

- [ ] **Step 1: Restructure the stage HTML**

In `public/index.html`, find the stage block (~lines 1098–1106):

```html
    <div class="stage">
      <div class="stage-status" id="stage-status">Waiting for players...</div>
      <div class="stage-cards" id="stage-cards"></div>
      <div class="big-average" id="big-average">
        <div class="big-average-label" id="avg-label">Consensus</div>
        <div class="big-average-value" id="avg-value">—</div>
      </div>
      <div class="stage-action" id="stage-action"></div>
    </div>
```

Replace with:

```html
    <div class="stage">
      <div class="stage-top">
        <div class="stage-status" id="stage-status">Waiting for players...</div>
        <div class="consensus-pill" id="consensus-pill"></div>
      </div>
      <div class="stage-cards" id="stage-cards"></div>
      <div class="stage-action" id="stage-action"></div>
    </div>
```

- [ ] **Step 2: Replace the stage layout CSS**

In `public/index.html`, find the `.stage` rule (~lines 511–514):

```css
  .stage {
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    padding: 48px 32px; position: relative; overflow: hidden;
  }
```

Replace with (block layout; the three zones are absolutely placed so the card row is pinned to the exact vertical center):

```css
  .stage {
    display: block;
    padding: 48px 32px; position: relative; overflow: hidden;
  }
  .stage-top {
    position: absolute; top: 52px; left: 0; right: 0;
    display: flex; align-items: center; justify-content: center;
    min-height: 64px;
  }
```

- [ ] **Step 3: Pin the card row and update the status / action rules**

In `public/index.html`, find the `.stage-status` rule (~lines 522–528):

```css
  .stage-status {
    font-family: 'Karla', sans-serif;
    font-size: 13px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.12em;
    color: var(--text-muted);
    margin-bottom: 32px; position: relative; z-index: 1;
  }
```

Replace with (drop the now-meaningless `margin-bottom`):

```css
  .stage-status {
    font-family: 'Karla', sans-serif;
    font-size: 13px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.12em;
    color: var(--text-muted);
    position: relative; z-index: 1;
  }
```

Find the `.stage-cards` rule (~lines 531–535):

```css
  .stage-cards {
    display: flex; gap: 16px;
    align-items: flex-end; justify-content: center;
    min-height: 200px; position: relative; z-index: 1;
  }
```

Replace with:

```css
  .stage-cards {
    position: absolute; top: 50%; left: 0; right: 0;
    transform: translateY(-50%);
    display: flex; gap: 16px;
    align-items: flex-end; justify-content: center;
    z-index: 1;
  }
```

Find the `.stage-action` rule (~lines 630–634):

```css
  .stage-action {
    margin-top: 36px; position: relative; z-index: 1;
    min-height: 52px;
    display: flex; align-items: center; justify-content: center;
  }
```

Replace with:

```css
  .stage-action {
    position: absolute; bottom: 52px; left: 0; right: 0;
    min-height: 52px; z-index: 1;
    display: flex; align-items: center; justify-content: center;
  }
```

- [ ] **Step 4: Replace the `.big-average` CSS with the consensus pill CSS**

In `public/index.html`, find the `.big-average` rules (~lines 668–681):

```css
  .big-average {
```

through the end of `.big-average-value { ... }`. The block is:

```css
  .big-average {
    opacity: 0;
    transition: opacity 0.3s;
    text-align: center;
    min-height: 70px;
  }
  .big-average.show { opacity: 1; }
  .big-average-label {
    font-family: 'Karla', sans-serif;
    font-size: 11px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.14em;
    color: var(--text-muted);
  }
  .big-average-value {
    font-family: 'Recursive', sans-serif;
    font-size: 44px; font-weight: 800;
    color: var(--accent);
    line-height: 1;
  }
```

Replace the whole block with:

```css
  .consensus-pill { opacity: 0; transition: opacity 0.3s; }
  .consensus-pill.show { opacity: 1; }
  .cpill {
    display: inline-flex; align-items: center; gap: 12px;
    border-radius: 999px; padding: 8px 14px 8px 22px;
  }
  .cpill-real { background: var(--accent); box-shadow: 0 6px 20px var(--accent-glow); }
  .cpill-good { background: #6aad8c; box-shadow: 0 6px 20px rgba(106,173,140,0.34); }
  .cpill-none { background: var(--waiting); box-shadow: 0 6px 18px rgba(181,168,152,0.3); }
  .cpill-label {
    font-family: 'Karla', sans-serif;
    font-size: 11px; font-weight: 800;
    text-transform: uppercase; letter-spacing: 0.13em;
    color: rgba(255,255,255,0.85);
  }
  .cpill-val {
    font-family: 'Recursive', sans-serif;
    font-weight: 800; font-size: 25px; color: #fff; line-height: 1;
    background: rgba(255,255,255,0.16); border-radius: 999px;
    min-width: 44px; height: 44px;
    display: flex; align-items: center; justify-content: center;
    padding: 0 11px;
  }
  .cpill-dash { color: rgba(255,255,255,0.7); }
```

- [ ] **Step 5: Add the green-ring rule for matching cards**

In `public/index.html`, find the `.stage-card-back` rule (~lines 588–596) and add a `.match` rule directly after its closing `}`. Find:

```css
  .stage-card-back {
    background: var(--card-face);
    border: 2px solid var(--border);
    box-shadow: 0 4px 20px rgba(0,0,0,0.08);
    transform: rotateY(180deg);
    flex-direction: column;
    align-items: stretch;
    overflow: hidden;
  }
```

Insert immediately after it:

```css
  .stage-card-back.match {
    border-color: #6aad8c;
    box-shadow: 0 0 0 2.5px #6aad8c, 0 4px 12px rgba(106,173,140,0.30);
  }
```

- [ ] **Step 6: Add the `consensusPillHTML` helper**

In `public/index.html`, add this function immediately before `function renderStage()` (~line 1437):

```js
  function consensusPillHTML(consensus) {
    if (!consensus || consensus.state === 'none') {
      return `<div class="cpill cpill-none"><span class="cpill-label">No consensus</span>` +
             `<span class="cpill-val cpill-dash">—</span></div>`;
    }
    const stateClass = consensus.state === 'unanimous' ? 'cpill-good' : 'cpill-real';
    const label = consensus.state === 'unanimous' ? 'Unanimous'
                : consensus.state === 'split' ? 'Split' : 'Consensus';
    const vals = consensus.values
      .map(v => `<span class="cpill-val">${escapeHtml(String(v))}</span>`)
      .join('');
    return `<div class="cpill ${stateClass}"><span class="cpill-label">${label}</span>${vals}</div>`;
  }
```

- [ ] **Step 7: Rewrite the body of `renderStage`**

In `public/index.html`, find `renderStage` (~lines 1437–1503). The current body, from the line after `function renderStage() {` to its closing `}`, is:

```js
    const cards = document.getElementById('stage-cards');
    const status = document.getElementById('stage-status');
    const action = document.getElementById('stage-action');
    const avg = document.getElementById('big-average');
    const votedCount = state.room.players.filter(p => p.vote).length;
    const totalCount = state.room.players.length;
    const me = state.room.players.find(p => p.id === state.playerId);
    const isHost = me?.isHost;

    if (state.room.revealed) {
      status.innerHTML = 'Results';
    } else {
      status.innerHTML = `<span class="count">${votedCount}</span> of ${totalCount} voted`;
    }

    cards.innerHTML = state.room.players.map((p, i) => {
      const color = COLORS[p.color];
      const isWaiting = !p.vote || p.vote === null;
      const displayVote = state.room.revealed ? (p.vote || '—') : '';
      const flipClass = state.room.revealed ? 'flip' : '';
      const delay = state.room.revealed ? `transition-delay: ${i * 0.1}s` : '';
      return `
        <div class="stage-card" style="animation-delay:${i * 0.06}s">
          <div class="stage-card-inner ${flipClass}" style="${delay}">
            <div class="stage-card-front ${isWaiting && !state.room.revealed ? 'sc-waiting' : ''}" style="background:${isWaiting && !state.room.revealed ? '' : color}">
              <span class="sc-init">${isWaiting && !state.room.revealed ? '?' : p.name[0].toUpperCase()}</span>
            </div>
            <div class="stage-card-back" style="color:${color}">
              <div class="sc-inlay"></div>
              <div class="sc-val-area"><span class="sc-value">${displayVote}</span></div>
              <div class="sc-name-bar" style="background:${color}"><span class="sc-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span></div>
            </div>
          </div>
        </div>
      `;
    }).join('');

    if (state.room.revealed) {
      if (isHost) {
        action.innerHTML = '<button class="btn-new-round" onclick="newRound()">Start New Round</button>';
      } else {
        action.innerHTML = '<span class="stage-hint">Waiting for host to start new round...</span>';
      }
      const numericVotes = state.room.players.map(p => p.vote).filter(v => v && v !== '?' && v !== '—');
      avg.classList.add('show');
      if (numericVotes.length > 0 && !isNaN(Number(numericVotes[0]))) {
        const sum = numericVotes.reduce((a, b) => a + Number(b), 0);
        document.getElementById('avg-label').textContent = 'Average';
        document.getElementById('avg-value').textContent = (sum / numericVotes.length).toFixed(1);
      } else {
        const counts = {};
        numericVotes.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
        const mode = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
        document.getElementById('avg-label').textContent = 'Consensus';
        document.getElementById('avg-value').textContent = mode ? mode[0] : '—';
      }
    } else {
      avg.classList.remove('show');
      if (isHost) {
        const allVoted = votedCount === totalCount && totalCount > 0;
        action.innerHTML = `<button class="btn-reveal ${allVoted ? 'all-in' : ''}" onclick="reveal()" ${votedCount === 0 ? 'disabled style="opacity:0.5;cursor:default;"' : ''}>Reveal Cards</button>`;
      } else {
        action.innerHTML = '<span class="stage-hint">Waiting for host to reveal...</span>';
      }
    }
  }
```

Replace that entire body with:

```js
    const cards = document.getElementById('stage-cards');
    const status = document.getElementById('stage-status');
    const action = document.getElementById('stage-action');
    const pill = document.getElementById('consensus-pill');
    const votedCount = state.room.players.filter(p => p.vote).length;
    const totalCount = state.room.players.length;
    const me = state.room.players.find(p => p.id === state.playerId);
    const isHost = me?.isHost;
    const revealed = state.room.revealed;
    const consensus = state.room.consensus;

    // Top zone: voting status while voting, consensus pill once revealed.
    if (revealed) {
      status.style.display = 'none';
      pill.innerHTML = consensusPillHTML(consensus);
      pill.classList.add('show');
    } else {
      status.style.display = '';
      status.innerHTML = `<span class="count">${votedCount}</span> of ${totalCount} voted`;
      pill.classList.remove('show');
    }

    cards.innerHTML = state.room.players.map((p, i) => {
      const color = COLORS[p.color];
      const isWaiting = !p.vote || p.vote === null;
      const displayVote = revealed ? (p.vote || '—') : '';
      const flipClass = revealed ? 'flip' : '';
      const delay = revealed ? `transition-delay: ${i * 0.1}s` : '';
      const isMatch = revealed && consensus && consensus.values.includes(String(p.vote));
      return `
        <div class="stage-card" style="animation-delay:${i * 0.06}s">
          <div class="stage-card-inner ${flipClass}" style="${delay}">
            <div class="stage-card-front ${isWaiting && !revealed ? 'sc-waiting' : ''}" style="background:${isWaiting && !revealed ? '' : color}">
              <span class="sc-init">${isWaiting && !revealed ? '?' : p.name[0].toUpperCase()}</span>
            </div>
            <div class="stage-card-back ${isMatch ? 'match' : ''}" style="color:${color}">
              <div class="sc-inlay"></div>
              <div class="sc-val-area"><span class="sc-value">${displayVote}</span></div>
              <div class="sc-name-bar" style="background:${color}"><span class="sc-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span></div>
            </div>
          </div>
        </div>
      `;
    }).join('');

    if (revealed) {
      if (isHost) {
        action.innerHTML = '<button class="btn-new-round" onclick="newRound()">Start New Round</button>';
      } else {
        action.innerHTML = '<span class="stage-hint">Waiting for host to start new round...</span>';
      }
    } else {
      if (isHost) {
        const allVoted = votedCount === totalCount && totalCount > 0;
        action.innerHTML = `<button class="btn-reveal ${allVoted ? 'all-in' : ''}" onclick="reveal()" ${votedCount === 0 ? 'disabled style="opacity:0.5;cursor:default;"' : ''}>Reveal Cards</button>`;
      } else {
        action.innerHTML = '<span class="stage-hint">Waiting for host to reveal...</span>';
      }
    }
  }
```

- [ ] **Step 8: Run the backend tests**

Run: `npm test`
Expected: PASS — no regressions.

- [ ] **Step 9: Verify in the browser**

Start: `PORT=4173 node server.js &`. With the Playwright tools, exercise each consensus state with multiple joined contexts and screenshot each:
- **Consensus:** votes like 3, 5, 5 → peach pill "Consensus 5", the two 5-cards have a green ring, the 3-card is plain.
- **Unanimous:** all the same value → green pill "Unanimous", all cards ringed.
- **Split:** votes 3, 3, 5, 5 → peach pill "Split" listing 3 and 5, all four cards ringed.
- **No consensus:** all different values → grey pill "No consensus" with an em-dash, no rings.
Confirm the consensus pill sits **above** the card row, the card row stays vertically centered and does not jump between the voting and revealed states, and there is no "Results" text. Stop the server.

- [ ] **Step 10: Commit**

```bash
git add public/index.html
git commit -m "feat: consensus pill above cards with green agreement highlighting"
```

---

## Task 7: Room title contrast

**Files:**
- Modify: `public/index.html` — `.room-name` color.

- [ ] **Step 1: Raise the room-name color**

In `public/index.html`, find the `.room-name` rule (~lines 270–273):

```css
  .room-name {
    font-size: 13px; color: #8a7a6e;
    padding-left: 16px; border-left: 1px solid #4a3e36;
  }
```

Replace with:

```css
  .room-name {
    font-size: 13px; color: #c9bcae;
    padding-left: 16px; border-left: 1px solid #4a3e36;
  }
```

- [ ] **Step 2: Verify in the browser**

Start: `PORT=4173 node server.js &`. Create a room, confirm the room name next to the logo in the header is clearly readable against the dark header (noticeably lighter than before). Stop the server.

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "fix: raise room-title contrast in the header"
```

---

## Task 8: Room-aware page title

`document.title` leads with the room name in a room, and is `"Pointer · Scrum Poker"` on the landing page.

**Files:**
- Modify: `public/index.html` — static `<title>`, add `updatePageTitle`, call it from `render` and `showLanding`.

- [ ] **Step 1: Update the static `<title>`**

In `public/index.html`, find (~line 6):

```html
<title>Pointer – Scrum Poker</title>
```

Replace with:

```html
<title>Pointer · Scrum Poker</title>
```

- [ ] **Step 2: Add the `updatePageTitle` helper**

In `public/index.html`, add this function immediately before `function renderHeader()` (~line 1386):

```js
  function updatePageTitle() {
    if (state.room && document.getElementById('app').classList.contains('active')) {
      document.title = `${state.room.name} · Pointer`;
    } else {
      document.title = 'Pointer · Scrum Poker';
    }
  }
```

- [ ] **Step 3: Call it from `render`**

In `public/index.html`, find the end of `render` (~lines 1374–1378):

```js
    renderHeader();
    renderSidebar();
    renderStage();
    renderHand();
  }
```

Replace with:

```js
    renderHeader();
    renderSidebar();
    renderStage();
    renderHand();
    updatePageTitle();
  }
```

- [ ] **Step 4: Call it from `showLanding`**

In `public/index.html`, find `showLanding` (~lines 1291–1295):

```js
  function showLanding() {
    document.getElementById('landing').classList.add('active');
    document.getElementById('app').classList.remove('active');
    hideModals();
  }
```

Replace with:

```js
  function showLanding() {
    document.getElementById('landing').classList.add('active');
    document.getElementById('app').classList.remove('active');
    hideModals();
    updatePageTitle();
  }
```

- [ ] **Step 5: Verify in the browser**

Start: `PORT=4173 node server.js &`. On the landing page, confirm the browser tab title is "Pointer · Scrum Poker". Create a room named e.g. "Sprint 42" and confirm the tab title becomes "Sprint 42 · Pointer". Leave the room and confirm it reverts. Stop the server.

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "feat: room-aware page title"
```

---

## Task 9: Fix the scroll sliver

The page is marginally scrollable — a thin strip of overflow at the bottom. Diagnose the real cause, then fix it at the root rather than masking it.

**Files:**
- Modify: `public/index.html` — CSS (exact rule determined by diagnosis).

- [ ] **Step 1: Reproduce and measure**

Start: `PORT=4173 node server.js &`. With the Playwright tools, load `http://localhost:4173/` and evaluate in the page:

```js
({
  docScroll: document.documentElement.scrollHeight,
  docClient: document.documentElement.clientHeight,
  bodyScroll: document.body.scrollHeight,
  innerH: window.innerHeight,
})
```

Confirm `docScroll > docClient` (the overflow). Then create a room and measure again in the game view — note which view(s) overflow and by how many pixels.

- [ ] **Step 2: Identify the overflowing element**

In the page, walk the layout to find the element whose box exceeds the viewport. Evaluate:

```js
[...document.querySelectorAll('body *')]
  .map(el => ({ el: el.className || el.tagName, bottom: el.getBoundingClientRect().bottom }))
  .filter(x => x.bottom > window.innerHeight + 0.5)
  .slice(0, 20)
```

The likely culprits, in order of probability:
- **Double `100vh`:** `body` has `min-height: 100vh` (with `display: flex; flex-direction: column`) and `.landing` *also* has `min-height: 100vh` while being a flex child of `body`. If the landing view overflows, this is it.
- **Missing `box-sizing`:** there is no global `* { box-sizing: border-box }` reset. An element sized in `vh`/`%` that also has a border (e.g. `.header` has `border-bottom: 1px`) overflows by the border width.

- [ ] **Step 3: Apply the root-cause fix**

Apply whichever the diagnosis points to:

**If it is the double `100vh`** — the landing should fill its flex parent, not independently demand a viewport height. In `public/index.html` find the `.landing` rule (~lines 796–805) and change `min-height: 100vh;` to `flex: 1;`:

```css
  .landing {
    background: var(--header-bg);
    color: var(--header-text);
    flex: 1;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    position: relative; z-index: 1;
    position: relative;
    overflow: hidden;
  }
```

**If it is a missing `box-sizing` reset** — add a global reset. In `public/index.html`, immediately after the opening `<style>` tag's first rule, add at the very top of the stylesheet:

```css
  *, *::before, *::after { box-sizing: border-box; }
```

Apply only the fix the measurement supports. If both contribute, apply both. Do not paper over it with `overflow: hidden` on `body`/`html`.

- [ ] **Step 4: Verify the fix**

Reload `http://localhost:4173/` and re-run the Step 1 measurement — `docScroll` must now equal `docClient` (no overflow). Check both the landing and the in-room views, and at a narrow (~390px) and wide viewport. Confirm the page no longer scrolls. Stop the server.

- [ ] **Step 5: Run the backend tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "fix: remove vertical scroll overflow"
```

---

## Final verification

- [ ] **Run the full test suite**

Run: `npm test`
Expected: PASS — all `room.test.js` and `server.test.js` tests green.

- [ ] **Full manual smoke test**

Start: `PORT=4173 node server.js &`. With the Playwright tools, run one full game across two contexts: create a room (clean `/CODE` URL), join via the copied link, vote, change a vote during the countdown, reveal, confirm the consensus pill sits above centered cards with green rings, start a new round, leave. Confirm no scroll, correct page title, readable room title. Stop the server.

- [ ] **Confirm the deploy note**

`htz` runs the app from `/root/pointer/` via rsync + Docker (no git remote there). These changes ship the same way — flag to the user that deployment is a separate manual step, not part of this plan.
