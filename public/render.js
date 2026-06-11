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

  // Cascade delays for the reveal flip. `arg` is either a player COUNT (number,
  // single-row 1D fallback) or an array of {x,y} card centers. With positions
  // the cascade radiates from the geometric centroid, so it stays center-out
  // even when cards wrap onto multiple rows (the count form only spreads along
  // one axis and looks wrong once wrapped).
  function computeRevealDelays(arg, cascadeWindowMs) {
    let dists;
    if (typeof arg === 'number') {
      if (arg <= 0) return [];
      if (arg === 1) return [0];
      const center = (arg - 1) / 2;
      dists = [];
      for (let i = 0; i < arg; i++) dists.push(Math.abs(i - center));
    } else {
      const pts = arg || [];
      if (pts.length <= 0) return [];
      if (pts.length === 1) return [0];
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      dists = pts.map(p => Math.hypot(p.x - cx, p.y - cy));
    }

    let minDist = Infinity, maxDist = -Infinity;
    for (const d of dists) {
      if (d < minDist) minDist = d;
      if (d > maxDist) maxDist = d;
    }
    const range = maxDist - minDist;
    // Range zero means all cards are equidistant from center (e.g., N=2).
    // No cascade to spread — reveal them all at 0.
    if (range === 0) return new Array(dists.length).fill(0);

    return dists.map(d => ((d - minDist) / range) * cascadeWindowMs);
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
