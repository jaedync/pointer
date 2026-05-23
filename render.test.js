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
