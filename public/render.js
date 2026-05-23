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
    const center = (playerCount - 1) / 2;
    const dists = new Array(playerCount);
    let minDist = Infinity;
    let maxDist = -Infinity;
    for (let i = 0; i < playerCount; i++) {
      const d = Math.abs(i - center);
      dists[i] = d;
      if (d < minDist) minDist = d;
      if (d > maxDist) maxDist = d;
    }
    // Even N has no index sitting at center; normalize so the centermost pair
    // lands on 0 and the edges land on cascadeWindowMs.
    const range = maxDist - minDist;
    const out = new Array(playerCount);
    if (range === 0) {
      // n=2 (or any all-equal-distance case): both at the edge.
      for (let i = 0; i < playerCount; i++) out[i] = cascadeWindowMs;
      return out;
    }
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
