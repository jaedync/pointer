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
    voteSeq: 0,
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
    const prev = snapshot({ players: [player('a', { vote: null, voteSeq: 0 })] });
    const next = snapshot({ players: [player('a', { vote: 'voted', voteSeq: 1 })] });
    assert.deepEqual(computeStageDiff(prev, next), [
      { type: 'update', subtype: 'place', player: player('a', { vote: 'voted', voteSeq: 1 }) },
    ]);
  });

  it('emits update/clear when player goes from voted to waiting', () => {
    const prev = snapshot({ players: [player('a', { vote: 'voted', voteSeq: 1 })] });
    const next = snapshot({ players: [player('a', { vote: null, voteSeq: 2 })] });
    assert.deepEqual(computeStageDiff(prev, next), [
      { type: 'update', subtype: 'clear', player: player('a', { vote: null, voteSeq: 2 }) },
    ]);
  });

  it('emits update/place when player changes vote (voteSeq bumps, sentinel stays "voted")', () => {
    // Pre-reveal the wire carries 'voted' for both sides of a vote change.
    // voteSeq is what makes the change detectable.
    const prev = snapshot({ players: [player('a', { vote: 'voted', voteSeq: 1 })] });
    const next = snapshot({ players: [player('a', { vote: 'voted', voteSeq: 2 })] });
    assert.deepEqual(computeStageDiff(prev, next), [
      { type: 'update', subtype: 'place', player: player('a', { vote: 'voted', voteSeq: 2 }) },
    ]);
  });

  it('emits update/place for local player whose own vote value changes (per-client unmask)', () => {
    // The server's per-client serialization gives the LOCAL player their own
    // actual value rather than the 'voted' sentinel. voteSeq still drives the
    // change classification.
    const prev = snapshot({ players: [player('a', { vote: '3', voteSeq: 1 })] });
    const next = snapshot({ players: [player('a', { vote: '8', voteSeq: 2 })] });
    assert.deepEqual(computeStageDiff(prev, next), [
      { type: 'update', subtype: 'place', player: player('a', { vote: '8', voteSeq: 2 }) },
    ]);
  });

  it('does NOT emit update/place for the reveal sentinel→real transition (voteSeq unchanged)', () => {
    // At reveal time, prev.vote === 'voted' and next.vote === '5' for every
    // voter — but voteSeq is identical (no new vote action). Without this
    // distinction, every voter card would spuriously fire P1 on top of the
    // reveal cascade. The reveal op alone owns this moment.
    const prev = snapshot({ revealed: false, players: [player('a', { vote: 'voted', voteSeq: 1 })] });
    const next = snapshot({ revealed: true,  players: [player('a', { vote: '5',     voteSeq: 1 })] });
    assert.deepEqual(computeStageDiff(prev, next), [
      { type: 'reveal' },
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

  it('returns [] for zero players (empty room)', () => {
    assert.deepEqual(computeRevealDelays(0, 250), []);
  });

  it('returns [0, 0] for two players (no cascade with equidistant cards)', () => {
    // Both cards are equally close to the center; there's no actual spread to cascade.
    // Returning [0, 0] avoids adding dead delay before a near-simultaneous flip.
    assert.deepEqual(computeRevealDelays(2, 250), [0, 0]);
  });

  it('returns all zeros when cascadeWindowMs is 0 (instant reveal)', () => {
    assert.deepEqual(computeRevealDelays(5, 0), [0, 0, 0, 0, 0]);
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

// ─── computeRevealDelays: radial (center-out) ordering for wrapped layouts ────

describe('computeRevealDelays (2D positions)', () => {
  it('orders by distance from the centroid, not by flat index, when cards wrap', () => {
    // 3 cards on row 1, 2 on row 2. The geometric center sits nearest index 1,
    // whereas the old flat-index math would pick index 2 (middle of the array).
    const positions = [
      { x: 0,   y: 0 },   // 0
      { x: 100, y: 0 },   // 1  <- closest to centroid
      { x: 200, y: 0 },   // 2
      { x: 0,   y: 112 }, // 3
      { x: 100, y: 112 }, // 4
    ];
    const delays = computeRevealDelays(positions, 250);
    const min = Math.min(...delays);
    assert.equal(delays[1], min, 'card nearest the center reveals first');
    assert.equal(delays.indexOf(Math.max(...delays)), 2, 'farthest card reveals last');
    assert.ok(delays.every(d => d >= 0 && d <= 250));
  });

  it('still supports the numeric (single-row) form', () => {
    assert.deepEqual(computeRevealDelays(3, 250), [250, 0, 250]);
  });
});

describe('computeRoundStats', () => {
  const { computeRoundStats } = require('./public/render.js');
  const fib = ['0', '1', '2', '3', '5', '8', '13', '21', '?'];

  it('counts in deck order with names, average and nearest card', () => {
    const s = computeRoundStats([
      { name: 'A', vote: '5' }, { name: 'B', vote: '3' }, { name: 'C', vote: '5' },
      { name: 'D', vote: '?' }, { name: 'E', vote: null },
    ], fib);
    assert.equal(s.voted, 4);
    assert.deepEqual(s.counts.map(c => [c.value, c.n]), [['3', 1], ['5', 2], ['?', 1]]);
    assert.equal(s.average, 4.3);
    assert.equal(s.nearest, '5');
    assert.deepEqual(s.low, { value: '3', names: ['B'] });
    assert.deepEqual(s.high, { value: '5', names: ['A', 'C'] });
    assert.equal(s.spread, 1);
  });

  it('has no average for t-shirt sizes and no low/high for one value', () => {
    const s = computeRoundStats([{ name: 'A', vote: 'M' }, { name: 'B', vote: 'M' }], ['XS', 'S', 'M', 'L', 'XL', '?']);
    assert.equal(s.average, null);
    assert.equal(s.low, null);
    assert.equal(s.spread, 0);
  });

  it('handles no votes', () => {
    const s = computeRoundStats([], fib);
    assert.equal(s.voted, 0);
    assert.deepEqual(s.counts, []);
    assert.equal(s.average, null);
  });
});

describe('fanLayout', () => {
  const { fanLayout } = require('./public/render.js');
  for (const n of [1, 5, 6, 7, 9]) {
    it(`is symmetric for ${n} cards`, () => {
      const f = fanLayout(n);
      assert.equal(f.length, n);
      for (let i = 0; i < n; i++) {
        assert.equal(f[i].rot + f[n - 1 - i].rot, 0);
        assert.equal(f[i].lift, f[n - 1 - i].lift);
      }
      assert.ok(Math.abs(f[0].rot) <= 20);
    });
  }
});
