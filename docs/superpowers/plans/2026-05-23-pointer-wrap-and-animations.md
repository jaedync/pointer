# Pointer — Stage Card Wrapping & Animation Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-row wrapping to the stage card area, replace the "?" waiting glyph with a low-contrast player initial, switch the stage from full-`innerHTML` re-render to an incremental diff so only changing cards animate, and replace the current cascade reveal with a snappier center-out cascade capped at ≤700ms.

**Architecture:** Extract a single pure-JS module `public/render.js` that exposes `computeStageDiff(prev, next)` and `computeRevealDelays(n, windowMs)`. The module loads in the browser via a regular `<script>` tag and in Node tests via `require()` (UMD-style guard so the same file works in both). `renderStage()` in `index.html` is rewritten to apply the diff operations to existing DOM nodes (creating, removing, or class-toggling) rather than rebuilding the `innerHTML`. CSS keyframes `pt-place` / `pt-clear` are added once; the diff applier adds and removes the animation class.

**Tech Stack:** Vanilla JS (no framework, no bundler), Node 20 built-in `node:test` runner, single-file SPA in `public/index.html`, WebSocket via `ws` for the server (unchanged).

**Spec:** `docs/superpowers/specs/2026-05-23-pointer-wrap-and-animations-design.md`

---

## Prerequisites

The repo currently has uncommitted spot-check changes in `public/index.html` (lobby-overlay hidden, btn-invite/room-code min-widths, voted indicator simplification, hand-card revert). These do not conflict with the planned changes but should be committed or stashed first so the working tree is clean.

Run:

```bash
cd ~/development/pointer
git status --short
```

If `public/index.html` shows as modified, either commit those spot-check fixes (separate commit, not part of this plan) or stash them. Then proceed.

---

## File Structure

| File | Responsibility | New / Modified |
| --- | --- | --- |
| `public/render.js` | Pure logic: diff two stage snapshots into ops; compute center-out reveal delays. | **NEW** |
| `render.test.js` | Unit tests for `computeStageDiff` and `computeRevealDelays`. | **NEW** |
| `public/index.html` | CSS for wrapping, waiting card, place/clear keyframes; JS rewrite of `renderStage()` to apply diff ops; `<script src="render.js"></script>` include. | Modified |
| `package.json` | Add `render.test.js` to the `test` and `test:unit` scripts. | Modified |
| `room.js` / `server.js` | No changes. | — |

---

## Task 1: Wrap stage cards into multiple rows

**Files:**
- Modify: `public/index.html` (CSS rules `.stage`, `.stage-cards`, `.stage-card`, `.stage-top`, `.stage-action`)

This is a CSS-only change. Cards keep their full 80×112 dimensions; the row wraps; `.stage-top` and `.stage-action` move from `±80px from center` to fixed `top: 32px` / `bottom: 32px` anchors so they never overlap the wrapped card block.

- [ ] **Step 1: Confirm current CSS lines**

Run:

```bash
grep -n "^  \.stage-top\|^  \.stage-cards\|^  \.stage-card {\|^  \.stage-action {\|^  \.stage {" public/index.html
```

Expected output includes (line numbers may shift slightly):

```
518:  .stage {
523:  .stage-top {
543:  .stage-cards {
550:  .stage-card {
647:  .stage-action {
```

- [ ] **Step 2: Modify `.stage-top` to anchor at top**

Replace the existing `.stage-top { ... }` block (currently `bottom: calc(50% + 80px)`):

```css
.stage-top {
  position: absolute; left: 0; right: 0;
  top: 32px;
  display: flex; justify-content: center;
  z-index: 1;
}
```

- [ ] **Step 3: Modify `.stage-cards` to wrap**

Replace the existing `.stage-cards { ... }` block. Note: `position: absolute; top: 50%; transform: translateY(-50%)` is kept so single-row layouts remain vertically centered.

```css
.stage-cards {
  position: absolute; top: 50%; left: 0; right: 0;
  transform: translateY(-50%);
  display: flex; gap: 16px;
  row-gap: 24px;
  flex-wrap: wrap;
  align-items: flex-end; justify-content: center;
  z-index: 1;
}
```

- [ ] **Step 4: Add `flex-shrink: 0` to `.stage-card`**

Modify the existing `.stage-card { ... }` block. Keep all current properties; add `flex-shrink: 0;`:

```css
.stage-card {
  width: 80px; height: 112px;
  perspective: 800px; position: relative;
  flex-shrink: 0;
  opacity: 0; animation: cardIn 0.4s ease-out forwards;
}
```

- [ ] **Step 5: Modify `.stage-action` to anchor at bottom**

Replace the existing `.stage-action { ... }` block (currently `top: calc(50% + 80px)`):

```css
.stage-action {
  position: absolute; left: 0; right: 0;
  bottom: 32px;
  z-index: 1;
  display: flex; justify-content: center;
}
```

- [ ] **Step 6: Manual verification**

Run:

```bash
cd ~/development/pointer && PORT=4173 node server.js &
```

Open `http://localhost:4173` in browser. Create a game. Open the same URL in 13 additional browser tabs (or use 13 incognito windows), join each as a different name. Confirm:

- Cards wrap to 2 rows around 9-10 players (depends on viewport width).
- Stage status text stays anchored near the top.
- Reveal button stays anchored near the bottom.
- Neither overlaps cards at any player count up to 24.
- At 5 players (single row), layout looks like before.

Stop the server:

```bash
kill %1
```

- [ ] **Step 7: Commit**

```bash
git add public/index.html
git commit -m "feat: wrap stage cards into multiple rows"
```

---

## Task 2: Waiting card uses player initial at low contrast (drop "?")

**Files:**
- Modify: `public/index.html` (CSS rules under `.stage-card-front.sc-waiting`; JS in `renderStage()`)

- [ ] **Step 1: Confirm current waiting CSS lines**

Run:

```bash
grep -n "sc-waiting" public/index.html
```

Expected output includes (line numbers may shift):

```
594:  .stage-card-front.sc-waiting {
598:  .stage-card-front.sc-waiting::after { border-color: rgba(255,255,255,0.15); }
599:  .stage-card-front.sc-waiting .sc-init {
1524:            <div class="stage-card-front ${isWaiting && !revealed ? 'sc-waiting' : ''}" style="background:${isWaiting && !revealed ? '' : color}">
1525:              <span class="sc-init">${isWaiting && !revealed ? '?' : p.name[0].toUpperCase()}</span>
```

- [ ] **Step 2: Replace the three `.sc-waiting` CSS rules**

Replace the three existing rules (between `.stage-card-front.sc-waiting { ... }` and `.stage-card-front.sc-waiting .sc-init { ... }` inclusive) with:

```css
.stage-card-front.sc-waiting {
  background: rgba(212,196,184,0.5) !important;
  box-shadow: none;
}
.stage-card-front.sc-waiting::after { border-color: rgba(255,255,255,0.1); }
.stage-card-front.sc-waiting .sc-init {
  color: rgba(181,168,152,0.55);
  font-size: 22px;
  font-weight: 700;
}
```

Notes:
- The `!important` on `background` stays because `renderStage()` writes `style="background:${color}"` inline on the front element; we override it when the `.sc-waiting` class is present.
- `font-size: 22px` matches the voted state (was 24px on the question mark).
- `font-weight: 700` (was 800).

- [ ] **Step 3: Update `renderStage()` to always render the player initial**

Find the line in `renderStage()` (around `index.html:1525`):

```js
<span class="sc-init">${isWaiting && !revealed ? '?' : p.name[0].toUpperCase()}</span>
```

Replace with:

```js
<span class="sc-init">${p.name[0].toUpperCase()}</span>
```

Also simplify the front-element line just above. Current:

```js
<div class="stage-card-front ${isWaiting && !revealed ? 'sc-waiting' : ''}" style="background:${isWaiting && !revealed ? '' : color}">
```

Keep as-is — the `sc-waiting` class still drives the styling, and the inline `background` is overridden by `!important` when waiting. No change needed.

- [ ] **Step 4: Manual verification**

Run server, open two browser tabs, join as "Alex" and "Pat":

```bash
PORT=4173 node server.js &
```

Open `http://localhost:4173`. Confirm:

- Both player cards show a faded tan card with the player's actual initial ("A" and "P") at low contrast — no "?".
- Click a hand-card value on one client. That player's card transitions to a colored bg with the white initial. The other player's card stays faded with the dim initial.

Stop the server:

```bash
kill %1
```

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat: waiting card shows player initial at low contrast"
```

---

## Task 3: Create `public/render.js` with `computeStageDiff` (test-driven)

**Files:**
- Create: `public/render.js`
- Create: `render.test.js`
- Modify: `package.json` (add `render.test.js` to test scripts)

The diff function is pure: take `prev` and `next` serialized room snapshots, return an array of operations.

### Operation types

- `{ type: 'reveal' }` — `revealed` changed from false → true
- `{ type: 'unreveal' }` — `revealed` changed from true → false
- `{ type: 'add', player }` — player was not in prev
- `{ type: 'remove', playerId }` — player was in prev but not in next
- `{ type: 'update', subtype: 'place', player }` — player went waiting → voted, OR voted-A → voted-B
- `{ type: 'update', subtype: 'clear', player }` — player went voted → waiting
- `{ type: 'update', subtype: 'data', player }` — name / color / isHost changed but vote state same

Ops are produced in this order: `reveal`/`unreveal` first, then `remove` ops (in prev order), then `add`/`update` ops in next-player order. This order ensures the DOM ends up matching the next player list.

- [ ] **Step 1: Write the failing test file**

Create `render.test.js`:

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeStageDiff, computeRevealDelays } = require('./public/render.js');

function snapshot({ revealed = false, players = [] } = {}) {
  return { revealed, players };
}
function player(id, overrides = {}) {
  return {
    id,
    name: id.toUpperCase(),
    color: 0,
    vote: null,
    isHost: false,
    ...overrides,
  };
}

describe('computeStageDiff', () => {
  it('returns empty ops when nothing changed', () => {
    const s = snapshot({ players: [player('a'), player('b')] });
    assert.deepEqual(computeStageDiff(s, s), []);
  });

  it('emits add op for a new player at the end of next.players', () => {
    const prev = snapshot({ players: [player('a')] });
    const next = snapshot({ players: [player('a'), player('b')] });
    assert.deepEqual(computeStageDiff(prev, next), [
      { type: 'add', player: player('b') },
    ]);
  });

  it('emits remove op for a player no longer in next.players', () => {
    const prev = snapshot({ players: [player('a'), player('b')] });
    const next = snapshot({ players: [player('a')] });
    assert.deepEqual(computeStageDiff(prev, next), [
      { type: 'remove', playerId: 'b' },
    ]);
  });

  it('emits update/place when player goes from waiting to voted', () => {
    const prev = snapshot({ players: [player('a', { vote: null })] });
    const next = snapshot({ players: [player('a', { vote: '5' })] });
    assert.deepEqual(computeStageDiff(prev, next), [
      { type: 'update', subtype: 'place', player: player('a', { vote: '5' }) },
    ]);
  });

  it('emits update/clear when player goes from voted to waiting', () => {
    const prev = snapshot({ players: [player('a', { vote: '5' })] });
    const next = snapshot({ players: [player('a', { vote: null })] });
    assert.deepEqual(computeStageDiff(prev, next), [
      { type: 'update', subtype: 'clear', player: player('a', { vote: null }) },
    ]);
  });

  it('emits update/place when player changes vote (voted A to voted B)', () => {
    const prev = snapshot({ players: [player('a', { vote: '3' })] });
    const next = snapshot({ players: [player('a', { vote: '8' })] });
    assert.deepEqual(computeStageDiff(prev, next), [
      { type: 'update', subtype: 'place', player: player('a', { vote: '8' }) },
    ]);
  });

  it('emits update/data when only name/color/isHost change', () => {
    const prev = snapshot({ players: [player('a', { color: 0, isHost: false })] });
    const next = snapshot({ players: [player('a', { color: 0, isHost: true })] });
    assert.deepEqual(computeStageDiff(prev, next), [
      { type: 'update', subtype: 'data', player: player('a', { isHost: true }) },
    ]);
  });

  it('emits reveal op when revealed flips false to true', () => {
    const prev = snapshot({ revealed: false, players: [player('a', { vote: '5' })] });
    const next = snapshot({ revealed: true,  players: [player('a', { vote: '5' })] });
    assert.deepEqual(computeStageDiff(prev, next), [
      { type: 'reveal' },
    ]);
  });

  it('emits unreveal op when revealed flips true to false', () => {
    const prev = snapshot({ revealed: true,  players: [player('a', { vote: '5' })] });
    const next = snapshot({ revealed: false, players: [player('a', { vote: null })] });
    // New round: revealed flips and all votes clear. Order: unreveal, then per-player clear.
    assert.deepEqual(computeStageDiff(prev, next), [
      { type: 'unreveal' },
      { type: 'update', subtype: 'clear', player: player('a', { vote: null }) },
    ]);
  });

  it('orders ops as: reveal/unreveal, removes, then adds/updates in next order', () => {
    const prev = snapshot({
      revealed: true,
      players: [player('a', { vote: '5' }), player('b', { vote: '5' })],
    });
    const next = snapshot({
      revealed: false,
      players: [player('a', { vote: null }), player('c', { vote: null })],
    });
    assert.deepEqual(computeStageDiff(prev, next), [
      { type: 'unreveal' },
      { type: 'remove', playerId: 'b' },
      { type: 'update', subtype: 'clear', player: player('a', { vote: null }) },
      { type: 'add', player: player('c', { vote: null }) },
    ]);
  });
});

describe('computeRevealDelays', () => {
  it('returns [0] for one player', () => {
    assert.deepEqual(computeRevealDelays(1, 250), [0]);
  });

  it('returns symmetric delays for two players (both at edge)', () => {
    // center = 0.5, maxDist = 0.5, step = 250/0.5 = 500
    // |0-0.5|*500 = 250, |1-0.5|*500 = 250
    assert.deepEqual(computeRevealDelays(2, 250), [250, 250]);
  });

  it('places centermost cards at delay 0 for odd N', () => {
    // n=3, center=1, maxDist=1, step=250
    // |0-1|=1 -> 250, |1-1|=0 -> 0, |2-1|=1 -> 250
    assert.deepEqual(computeRevealDelays(3, 250), [250, 0, 250]);
  });

  it('caps total: max delay equals cascade window regardless of N', () => {
    for (const n of [5, 12, 24, 50]) {
      const delays = computeRevealDelays(n, 250);
      assert.equal(Math.max(...delays), 250, `expected max=250 for n=${n}`);
      assert.equal(Math.min(...delays), 0,   `expected min=0 for n=${n}`);
    }
  });

  it('center-out: delays monotonically increase from center outward', () => {
    const delays = computeRevealDelays(12, 250);
    const center = (12 - 1) / 2;
    for (let i = 1; i < delays.length; i++) {
      const distA = Math.abs((i - 1) - center);
      const distB = Math.abs(i - center);
      if (distA < distB) assert.ok(delays[i - 1] < delays[i], `pair ${i - 1},${i}`);
    }
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:

```bash
cd ~/development/pointer && node --test render.test.js
```

Expected: fails with `Cannot find module './public/render.js'`.

- [ ] **Step 3: Create the minimal `public/render.js` to make tests pass**

Create `public/render.js`:

```js
// Pure helpers for stage rendering. Loaded both in the browser (regular <script>)
// and in Node tests (require()). The UMD-style guard at the bottom binds the
// exports to either `module.exports` or `window.renderUtils`.

(function (root) {
  'use strict';

  function playersEqualForData(a, b) {
    return a.name === b.name && a.color === b.color && a.isHost === b.isHost;
  }

  function classifyUpdate(before, after) {
    const wasWaiting = !before.vote;
    const isWaiting  = !after.vote;
    if (wasWaiting && !isWaiting) return 'place';
    if (!wasWaiting && isWaiting) return 'clear';
    if (!wasWaiting && !isWaiting && before.vote !== after.vote) return 'place';
    if (!playersEqualForData(before, after)) return 'data';
    return null;
  }

  function computeStageDiff(prev, next) {
    const ops = [];

    // 1. Room-level reveal toggle (always first)
    if (!prev.revealed && next.revealed)       ops.push({ type: 'reveal' });
    else if (prev.revealed && !next.revealed)  ops.push({ type: 'unreveal' });

    const prevById = new Map(prev.players.map(p => [p.id, p]));
    const nextById = new Map(next.players.map(p => [p.id, p]));

    // 2. Removed players (in prev order)
    for (const p of prev.players) {
      if (!nextById.has(p.id)) ops.push({ type: 'remove', playerId: p.id });
    }

    // 3. Added / updated players (in next order)
    for (const player of next.players) {
      const before = prevById.get(player.id);
      if (!before) {
        ops.push({ type: 'add', player });
        continue;
      }
      const subtype = classifyUpdate(before, player);
      if (subtype) ops.push({ type: 'update', subtype, player });
    }

    return ops;
  }

  function computeRevealDelays(playerCount, cascadeWindowMs) {
    if (playerCount <= 1) return [0];
    const center  = (playerCount - 1) / 2;
    const maxDist = center;
    const step    = cascadeWindowMs / maxDist;
    const out = new Array(playerCount);
    for (let i = 0; i < playerCount; i++) {
      out[i] = Math.abs(i - center) * step;
    }
    return out;
  }

  root.computeStageDiff    = computeStageDiff;
  root.computeRevealDelays = computeRevealDelays;
})(
  typeof module !== 'undefined' && module.exports
    ? module.exports
    : (typeof window !== 'undefined'
        ? (window.renderUtils = window.renderUtils || {})
        : {})
);
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
node --test render.test.js
```

Expected: all 15 tests pass.

- [ ] **Step 5: Update `package.json` to include the new test file**

Edit `package.json` — change the `test` and `test:unit` scripts to include `render.test.js`:

```json
"scripts": {
  "start": "node server.js",
  "dev": "node --watch server.js",
  "test": "node --test --test-force-exit room.test.js render.test.js server.test.js",
  "test:unit": "node --test room.test.js render.test.js",
  "test:integration": "node --test --test-force-exit server.test.js"
}
```

- [ ] **Step 6: Run the full test suite to confirm nothing else broke**

```bash
npm test
```

Expected: all tests pass (previous count from room.test.js + server.test.js + 15 new from render.test.js).

- [ ] **Step 7: Commit**

```bash
git add public/render.js render.test.js package.json
git commit -m "feat: pure helpers for stage diff and reveal cascade timing"
```

---

## Task 4: Load `render.js` in the browser and rewrite `renderStage()` to apply the diff

**Files:**
- Modify: `public/index.html` (add `<script src="render.js"></script>` tag, rewrite `renderStage()` body, track `lastStageState`)

This task replaces the full `innerHTML` rebuild with per-card DOM mutation driven by the diff ops. Animation classes are NOT added yet (that comes in Task 5) — this task just makes the render incremental and idempotent.

- [ ] **Step 1: Add the script tag**

Find the existing inline `<script>` block in `public/index.html` (around line 1200, near `const COLORS`). Just before that block, add:

```html
<script src="render.js"></script>
```

- [ ] **Step 2: Add per-card helpers and a state cache**

Critical design note: keep the `.stage-card-inner` element stable across updates. CSS transitions do not fire when the target element is freshly created — they only fire when a property changes on an existing element. So the inner element is created once via `makeStageCardNode` and reused. Subsequent updates rewrite only its children (the front and back) and toggle the `.flip` class on the inner; this preserves the transition target.

Inside the existing inline `<script>` block, near other rendering helpers (just above `function renderStage()`), add:

```js
let lastStageState = null;

function stageCardInnerHTML(p, revealed, consensus) {
  const color = COLORS[p.color];
  const isWaiting = !p.vote;
  const displayVote = p.vote || '—';
  const isMatch = revealed && consensus && consensus.values.includes(String(p.vote));
  return `
    <div class="stage-card-front ${isWaiting ? 'sc-waiting' : ''}" style="background:${isWaiting ? '' : color}">
      <span class="sc-init">${p.name[0].toUpperCase()}</span>
    </div>
    <div class="stage-card-back ${isMatch ? 'match' : ''}" style="color:${color}">
      <div class="sc-inlay"></div>
      <div class="sc-val-area"><span class="sc-value">${displayVote}</span></div>
      <div class="sc-name-bar" style="background:${color}"><span class="sc-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span></div>
    </div>
  `;
}

function makeStageCardNode(p, revealed, consensus) {
  const wrap = document.createElement('div');
  wrap.className = 'stage-card';
  wrap.dataset.playerId = p.id;
  const inner = document.createElement('div');
  inner.className = 'stage-card-inner';
  if (revealed) inner.classList.add('flip');
  inner.innerHTML = stageCardInnerHTML(p, revealed, consensus);
  wrap.appendChild(inner);
  return wrap;
}

function updateStageCardNode(node, p, revealed, consensus) {
  const inner = node.querySelector('.stage-card-inner');
  if (!inner) return;
  inner.innerHTML = stageCardInnerHTML(p, revealed, consensus);
  inner.classList.toggle('flip', !!revealed);
}
```

Note: the back content always reflects `p.vote || '—'` regardless of `revealed`. The back is only visible when `.flip` is on the inner (it's rotated 180° behind the front otherwise), so rendering an "—" placeholder in the back when no vote exists is harmless.

- [ ] **Step 3: Rewrite the body of `renderStage()`**

Replace the current `renderStage()` function with:

```js
function renderStage() {
  const cards   = document.getElementById('stage-cards');
  const status  = document.getElementById('stage-status');
  const action  = document.getElementById('stage-action');
  const pill    = document.getElementById('consensus-pill');
  const votedCount = state.room.players.filter(p => p.vote).length;
  const totalCount = state.room.players.length;
  const me      = state.room.players.find(p => p.id === state.playerId);
  const isHost  = me?.isHost;
  const revealed  = state.room.revealed;
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

  // Compute diff against last snapshot and apply incrementally.
  const next = { revealed, players: state.room.players };
  const prev = lastStageState || { revealed: false, players: [] };
  const ops  = renderUtils.computeStageDiff(prev, next);
  applyStageOps(cards, ops, revealed, consensus);
  // Re-order DOM children to match next.players order (handles new joins,
  // ensures the visual order always matches the server-truth order).
  reorderStageChildren(cards, state.room.players);
  lastStageState = JSON.parse(JSON.stringify(next));

  // Action row (unchanged behavior).
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

function applyStageOps(container, ops, revealed, consensus) {
  for (const op of ops) {
    if (op.type === 'reveal' || op.type === 'unreveal') {
      // Re-render every card's INNER CONTENT (front + back) so vote values and
      // match-class are correct. Toggle .flip on the (stable) inner element so
      // the CSS transition on transform actually fires.
      for (const card of container.querySelectorAll('.stage-card')) {
        const pid = card.dataset.playerId;
        const p = state.room.players.find(pp => pp.id === pid);
        if (p) updateStageCardNode(card, p, revealed, consensus);
      }
      continue;
    }
    if (op.type === 'add') {
      container.appendChild(makeStageCardNode(op.player, revealed, consensus));
      continue;
    }
    if (op.type === 'remove') {
      const node = container.querySelector(`.stage-card[data-player-id="${CSS.escape(op.playerId)}"]`);
      if (node) node.remove();
      continue;
    }
    if (op.type === 'update') {
      const node = container.querySelector(`.stage-card[data-player-id="${CSS.escape(op.player.id)}"]`);
      if (node) updateStageCardNode(node, op.player, revealed, consensus);
      continue;
    }
  }
}

function reorderStageChildren(container, players) {
  for (const p of players) {
    const node = container.querySelector(`.stage-card[data-player-id="${CSS.escape(p.id)}"]`);
    if (node) container.appendChild(node); // appendChild on existing node moves it to end
  }
}
```

- [ ] **Step 4: Manual verification (idempotent render)**

Run the server:

```bash
cd ~/development/pointer && PORT=4173 node server.js &
```

Open `http://localhost:4173` in 4 browser tabs. Join the same room as Alex, Pat, Sam, Drew. Confirm:

- All 4 cards appear, in join order.
- Alex votes "5". Only Alex's card transitions (no flicker on the other 3).
- Pat votes "8". Only Pat's card transitions; Alex's stays voted.
- Drew leaves the tab. Drew's card disappears smoothly.
- Sam votes "3", clears, votes "13". Each change updates only Sam's card.
- Reveal: cards flip (no animation class yet — just the existing flip transition).
- New round: cards reset to waiting state.

Stop the server:

```bash
kill %1
```

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "refactor: render stage incrementally via diff ops"
```

---

## Task 5: Add P1 place and C4 clear animations

**Files:**
- Modify: `public/index.html` (new CSS keyframes + `.is-animating-*` rules; `applyStageOps` toggles the class)

- [ ] **Step 1: Add the two keyframes and animation-class rules**

In the `<style>` block, immediately after the `.stage-card { ... }` rule (around line 559), add:

```css
.stage-card.is-animating-place {
  animation: pt-place 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.stage-card.is-animating-clear {
  animation: pt-clear 0.45s ease-out;
}
@keyframes pt-place {
  0%   { transform: rotate(0) translateY(0); }
  25%  { transform: rotate(-8deg) translateY(-10px); }
  60%  { transform: rotate(3deg) translateY(2px); }
  100% { transform: rotate(0) translateY(0); }
}
@keyframes pt-clear {
  0%   { transform: rotate(0); }
  25%  { transform: rotate(-3deg); }
  50%  { transform: rotate(2deg); }
  75%  { transform: rotate(-1deg); }
  100% { transform: rotate(0); }
}
```

Note: the existing `.stage-card` rule already has `animation: cardIn 0.4s ease-out forwards` for the entry. The `.is-animating-*` rules override the animation property while active; once the class is removed they revert to no animation (the entry has already completed).

- [ ] **Step 2: Add a helper that plays the animation and auto-removes the class**

Inside the inline `<script>` block, near `applyStageOps`, add:

```js
function playCardAnimation(node, subtype) {
  if (!node) return;
  const cls = subtype === 'place' ? 'is-animating-place'
            : subtype === 'clear' ? 'is-animating-clear'
            : null;
  if (!cls) return;
  // Remove first to restart if already playing.
  node.classList.remove('is-animating-place', 'is-animating-clear');
  void node.offsetWidth; // force reflow so the next class triggers a fresh animation
  node.classList.add(cls);
  node.addEventListener('animationend', function handler(e) {
    if (e.animationName === 'pt-place' || e.animationName === 'pt-clear') {
      node.classList.remove(cls);
      node.removeEventListener('animationend', handler);
    }
  });
}
```

- [ ] **Step 3: Wire `applyStageOps` to call `playCardAnimation` on update ops**

In the `applyStageOps` function added in Task 4, update the `op.type === 'update'` branch:

```js
if (op.type === 'update') {
  const node = container.querySelector(`.stage-card[data-player-id="${CSS.escape(op.player.id)}"]`);
  if (node) {
    updateStageCardNode(node, op.player, revealed, consensus);
    if (op.subtype === 'place' || op.subtype === 'clear') {
      playCardAnimation(node, op.subtype);
    }
  }
  continue;
}
```

- [ ] **Step 4: Manual verification**

Run the server, join with two clients (Alex and Pat):

```bash
cd ~/development/pointer && PORT=4173 node server.js &
```

Confirm in both browser tabs:

- Alex picks "5" from hand. Alex's card on BOTH tabs plays the P1 tilt-and-snap (~0.5s).
- Pat picks "8". Pat's card plays P1 on both tabs.
- Alex changes to "13". Alex's card plays P1 again.
- Alex clicks "13" again to clear. Alex's card plays C4 gentle wiggle.
- Other cards never animate during these actions.

Stop the server:

```bash
kill %1
```

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat: P1 place and C4 clear animations on individual cards"
```

---

## Task 6: Snappy center-out reveal cascade (≤700ms)

**Files:**
- Modify: `public/index.html` (CSS for `.stage-card-inner` transition uses a CSS var; JS in reveal op uses `computeRevealDelays`)

- [ ] **Step 1: Change the inner-card transition to read a CSS var**

Find `.stage-card-inner { ... }` (around line 565). Replace its `transition:` line:

Before:

```css
transition: transform 0.7s cubic-bezier(0.34, 1.56, 0.64, 1);
```

After:

```css
transition: transform var(--flip-duration, 0.45s) cubic-bezier(0.34, 1.56, 0.64, 1);
```

The default fallback is 0.45s. The reveal op overrides this on a per-cascade basis below.

- [ ] **Step 2: Update the reveal branch in `applyStageOps`**

Find the `op.type === 'reveal'` branch added in Task 4. Replace it with:

```js
if (op.type === 'reveal') {
  const FLIP_MS = 450;
  const CASCADE_MS = 250;
  container.style.setProperty('--flip-duration', (FLIP_MS / 1000) + 's');
  // Render the new (revealed) markup for every card.
  const cards = [...container.querySelectorAll('.stage-card')];
  cards.forEach(card => {
    const pid = card.dataset.playerId;
    const p = state.room.players.find(pp => pp.id === pid);
    if (p) card.innerHTML = stageCardHTML(p, revealed, consensus);
  });
  // Compute and apply per-card stagger by array index.
  const delays = renderUtils.computeRevealDelays(cards.length, CASCADE_MS);
  cards.forEach((card, i) => {
    const inner = card.querySelector('.stage-card-inner');
    if (inner) inner.style.transitionDelay = delays[i] + 'ms';
  });
  continue;
}
```

- [ ] **Step 3: Clean the transition-delay after reveal completes**

In the same branch, before `continue;`, add a timeout to clear the delays so they don't carry over to other transitions:

```js
setTimeout(() => {
  cards.forEach(card => {
    const inner = card.querySelector('.stage-card-inner');
    if (inner) inner.style.transitionDelay = '';
  });
}, FLIP_MS + CASCADE_MS + 50);
```

The final reveal branch:

```js
if (op.type === 'reveal') {
  const FLIP_MS = 450;
  const CASCADE_MS = 250;
  container.style.setProperty('--flip-duration', (FLIP_MS / 1000) + 's');
  const cards = [...container.querySelectorAll('.stage-card')];
  const delays = renderUtils.computeRevealDelays(cards.length, CASCADE_MS);
  // 1. Update each card's INNER CONTENT and consensus match class while .flip is still off
  //    (back content + match border get updated; transition target is preserved).
  cards.forEach(card => {
    const pid = card.dataset.playerId;
    const p = state.room.players.find(pp => pp.id === pid);
    if (!p) return;
    const inner = card.querySelector('.stage-card-inner');
    if (inner) inner.innerHTML = stageCardInnerHTML(p, true, consensus);
  });
  // 2. Apply per-card stagger then add .flip on the next frame so the transition fires.
  requestAnimationFrame(() => {
    cards.forEach((card, i) => {
      const inner = card.querySelector('.stage-card-inner');
      if (!inner) return;
      inner.style.transitionDelay = delays[i] + 'ms';
      inner.classList.add('flip');
    });
  });
  // 3. Clear the transition-delay after the cascade completes so it doesn't leak into later transitions.
  setTimeout(() => {
    cards.forEach(card => {
      const inner = card.querySelector('.stage-card-inner');
      if (inner) inner.style.transitionDelay = '';
    });
  }, FLIP_MS + CASCADE_MS + 50);
  continue;
}
```

- [ ] **Step 4: Manual verification at multiple player counts**

Run the server, join with 12 tabs (or repeatedly join + vote with the same name pattern via incognito). After every player votes:

```bash
cd ~/development/pointer && PORT=4173 node server.js &
```

- Host clicks Reveal. Confirm cards flip starting from the center two and rippling out to the edges. Total time feels snappy (≤700ms).
- Repeat with 6 players. Should also feel ≤700ms but the cascade is denser per card.
- Repeat with 2 players. Both flip nearly together.

Stop the server:

```bash
kill %1
```

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat: center-out reveal cascade capped at 700ms"
```

---

## Task 7: New round (unreveal) — C4 wiggle on all cards in sync

**Files:**
- Modify: `public/index.html` (unreveal branch in `applyStageOps`)

- [ ] **Step 1: Identify the suppression need**

Background for step 2: a `revealed: true → false` transition produces an `unreveal` op AND a per-player `update/clear` op for each player whose vote was just cleared (server clears all votes on new round). Both would fire `playCardAnimation(node, 'clear')` on the same card — the second call restarts the in-flight wiggle.

We avoid the restart-stutter by having the unreveal branch set a `suppressNextAnim` flag on each card, and the update branch checks that flag and skips animation when present.

- [ ] **Step 2: Add the suppression flag**

Update the unreveal branch to set a per-card flag, and update the update branch to skip animation if the flag is present.

Replace the unreveal branch with:

```js
if (op.type === 'unreveal') {
  container.style.setProperty('--flip-duration', '0.45s');
  const cards = [...container.querySelectorAll('.stage-card')];
  cards.forEach(card => {
    const pid = card.dataset.playerId;
    const p = state.room.players.find(pp => pp.id === pid);
    if (!p) return;
    const inner = card.querySelector('.stage-card-inner');
    if (!inner) return;
    // Update content with revealed=false so back goes to '—' and match class clears.
    inner.innerHTML = stageCardInnerHTML(p, false, consensus);
    inner.style.transitionDelay = '';
    // Remove .flip on the next frame so the existing inner transitions back to rotateY(0).
    requestAnimationFrame(() => inner.classList.remove('flip'));
    playCardAnimation(card, 'clear');
    card.dataset.suppressNextAnim = '1';
  });
  continue;
}
```

Update the update branch to check the flag:

```js
if (op.type === 'update') {
  const node = container.querySelector(`.stage-card[data-player-id="${CSS.escape(op.player.id)}"]`);
  if (node) {
    node.innerHTML = stageCardHTML(op.player, revealed, consensus);
    if ((op.subtype === 'place' || op.subtype === 'clear') && node.dataset.suppressNextAnim !== '1') {
      playCardAnimation(node, op.subtype);
    }
    delete node.dataset.suppressNextAnim;
  }
  continue;
}
```

- [ ] **Step 3: Manual verification**

Run the server, join 3 clients (Alex, Pat, Sam):

```bash
cd ~/development/pointer && PORT=4173 node server.js &
```

- All vote. Host reveals (center-out cascade plays).
- Host clicks "Start New Round". Confirm: all 3 cards wiggle simultaneously (C4) AND flip back to face-down at the same time. No card double-wiggles.

Stop the server:

```bash
kill %1
```

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat: synchronized C4 wiggle on round reset"
```

---

## Task 8: Final integration smoke test

**Files:**
- None modified.

- [ ] **Step 1: Run full test suite**

```bash
cd ~/development/pointer && npm test
```

Expected: all tests pass (room.test.js + render.test.js + server.test.js).

- [ ] **Step 2: End-to-end manual smoke**

Run the server:

```bash
PORT=4173 node server.js &
```

Open the app in 12 browser tabs. Join all to the same room with names spanning short and long ("Jaedyn", "Alex", "Pat", "Sam", "Joey", "Drew", "Riley", "Casey", "Morgan", "Avery", "Quinn", "Hayden").

Verify:

1. **Wrap:** Cards wrap to multiple rows. Top status and bottom action button never overlap cards.
2. **Order:** Card order is identical in every tab and matches the sidebar.
3. **Waiting:** Each unvoted card shows the player's initial at low contrast (no "?").
4. **Place:** Vote in one tab. ONLY that player's card animates (P1 tilt-and-snap) in every tab. Other cards stay still.
5. **Change:** Same player picks a different value. ONLY that player's card animates (P1).
6. **Clear:** Same player clicks the picked card to deselect. ONLY that player's card animates (C4 wiggle).
7. **Reveal:** All vote. Host reveals. Cascade is center-out, total duration feels ≤700ms. Match cards (consensus value) show green ring.
8. **New round:** Host clicks "Start New Round". All 12 cards wiggle in sync (C4) AND flip back to face-down at the same time. No double-wiggle.
9. **Join during waiting:** A 13th client joins mid-vote. New card appears smoothly without disturbing the others. Other clients see the new card in the same position.
10. **Leave during waiting:** A client closes their tab. Their card disappears smoothly.

Stop the server:

```bash
kill %1
```

- [ ] **Step 3: Final commit (only if cleanup needed)**

If smoke testing surfaced any small CSS or JS tweaks, commit them separately:

```bash
git add public/index.html
git commit -m "fix: <specific tweak>"
```

If no tweaks needed, skip this step.

---

## Self-Review Notes

- **Spec coverage:**
  - §1 Wrapping → Task 1
  - §2 Waiting card → Task 2
  - §3 Incremental rendering → Tasks 3 + 4
  - §4 Animations → Task 5
  - §5 Reveal cascade → Task 6
  - §6 Round reset → Task 7
  - Testing (diff helper, reveal cap, manual smoke) → Tasks 3 + 8
- **Placeholders:** None. Every step contains the exact code or command needed.
- **Type consistency:** `computeStageDiff` returns ops with `{ type, subtype, player, playerId }` consistently; `applyStageOps` reads the same fields. `computeRevealDelays(n, windowMs)` signature is consistent between definition and call site. `renderUtils.computeStageDiff` / `renderUtils.computeRevealDelays` namespace matches the UMD guard in `render.js`.

---

## Plan complete and saved.

**Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints.

Which approach?
