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
    // voteSeq is the canonical signal for vote changes: the server hides the
    // actual value pre-reveal (sends 'voted' sentinel for non-self players),
    // so vote-A → vote-B is otherwise undetectable from the wire. voteSeq
    // stays constant across the reveal-time sentinel→real transition, so this
    // branch does NOT spuriously fire for the reveal.
    if (!wasWaiting && !isWaiting && (before.voteSeq || 0) !== (after.voteSeq || 0)) return 'place';
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
    if (playerCount <= 0) return [];
    if (playerCount === 1) return [0];

    const center = (playerCount - 1) / 2;
    const dists  = new Array(playerCount);
    let minDist = Infinity, maxDist = -Infinity;
    for (let i = 0; i < playerCount; i++) {
      const d = Math.abs(i - center);
      dists[i] = d;
      if (d < minDist) minDist = d;
      if (d > maxDist) maxDist = d;
    }
    const range = maxDist - minDist;
    // Range zero means all cards are equidistant from center (e.g., N=2).
    // No cascade to spread — reveal them all at 0.
    if (range === 0) return new Array(playerCount).fill(0);

    const out = new Array(playerCount);
    for (let i = 0; i < playerCount; i++) {
      out[i] = ((dists[i] - minDist) / range) * cascadeWindowMs;
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
