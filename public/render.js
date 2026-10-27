// Pure helpers for stage rendering. Loaded both in the browser (regular <script>)
// and in Node tests (require()). The UMD-style guard at the bottom binds the
// exports to either `module.exports` or `window.renderUtils`.

(function (root) {
  'use strict';

  function playersEqualForData(a, b) {
    return a.name === b.name && a.color === b.color && a.isHost === b.isHost
      && !!a.away === !!b.away && !!a.observer === !!b.observer;
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

  // Summary of a revealed round. `players` are the voting seats ({name, vote});
  // `deck` is the room's card order. Counts follow deck order so the result
  // reads like the hand. The average (and the deck card nearest to it) exists
  // only for all-numeric decks; '?' never counts toward it.
  function computeRoundStats(players, deck) {
    const order = Array.isArray(deck) ? deck : [];
    const voted = (players || []).filter(p => p && p.vote);
    const byValue = new Map();
    for (const p of voted) {
      if (!byValue.has(p.vote)) byValue.set(p.vote, []);
      byValue.get(p.vote).push(p.name);
    }
    const rank = v => { const i = order.indexOf(v); return i === -1 ? order.length : i; };
    const counts = [...byValue.entries()]
      .map(([value, names]) => ({ value, n: names.length, names }))
      .sort((a, b) => rank(a.value) - rank(b.value));

    const faces = order.filter(v => v !== '?');
    const numericDeck = faces.length > 0 && faces.every(v => v !== '' && Number.isFinite(Number(v)));
    const sized = counts.filter(c => c.value !== '?');
    let average = null, nearest = null;
    if (numericDeck && sized.length > 0) {
      const total = sized.reduce((s, c) => s + Number(c.value) * c.n, 0);
      const n = sized.reduce((s, c) => s + c.n, 0);
      average = Math.round((total / n) * 10) / 10;
      nearest = faces.reduce((best, v) =>
        Math.abs(Number(v) - average) < Math.abs(Number(best) - average) ? v : best, faces[0]);
    }
    let low = null, high = null, spread = 0;
    if (sized.length >= 2) {
      low = { value: sized[0].value, names: sized[0].names };
      high = { value: sized[sized.length - 1].value, names: sized[sized.length - 1].names };
      spread = rank(high.value) - rank(low.value);
    }
    return { voted: voted.length, counts, average, nearest, low, high, spread };
  }

  // Hand fan geometry for `n` cards: a symmetric arc whatever the deck size.
  // The total sweep is capped so a 9-card deck does not lean or splay.
  function fanLayout(n) {
    if (!(n > 0)) return [];
    if (n === 1) return [{ rot: 0, lift: 0 }];
    const mid = (n - 1) / 2;
    const step = Math.min(6, 40 / (n - 1));
    const out = [];
    for (let i = 0; i < n; i++) {
      const off = i - mid;
      out.push({
        rot: (Math.round(off * step * 100) / 100) || 0,  // no -0
        lift: Math.round(Math.pow(Math.abs(off) / mid, 2) * 10 * 100) / 100,
      });
    }
    return out;
  }

  root.computeStageDiff    = computeStageDiff;
  root.computeRevealDelays = computeRevealDelays;
  root.computeRoundStats   = computeRoundStats;
  root.fanLayout           = fanLayout;
})(
  typeof module !== 'undefined' && module.exports
    ? module.exports
    : (typeof window !== 'undefined'
        ? (window.renderUtils = window.renderUtils || {})
        : {})
);
