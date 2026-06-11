// ─── Room Logic ──────────────────────────────────────────────────────────────
// Pure room state management, extracted for testability.
// No WebSocket or HTTP concerns — just data structures and rules.

const crypto = require('crypto');

const VOTING_SYSTEMS = {
  tshirt: ['XS', 'S', 'M', 'L', 'XL', '?'],
  fib: ['0', '1', '2', '3', '5', '8', '13', '21', '?'],
  powers: ['1', '2', '4', '8', '16', '32', '?'],
  simple: ['1', '2', '3', '4', '5', '?'],
};
const NUM_COLORS = 12;
const MAX_NAME_LEN = 40;

// Room-code alphabet with visually ambiguous characters removed (no 0/o, 1/l/i).
// Lowercase + digits only so server-side lowercasing and case-insensitive joins
// stay lossless. 31^5 ≈ 28.6M codes, sampled with a CSPRNG.
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const ID_LEN = 5;

// Cryptographically-random room id. Rejection-sampled so each character is an
// unbiased draw from ID_ALPHABET (modulo bias would slightly favor early chars).
function generateId() {
  let out = '';
  while (out.length < ID_LEN) {
    const b = crypto.randomBytes(1)[0];
    if (b >= 256 - (256 % ID_ALPHABET.length)) continue; // drop the biased tail
    out += ID_ALPHABET[b % ID_ALPHABET.length];
  }
  return out;
}

// Draw a room id that isn't already in use. `isTaken(id) => bool` lets the caller
// (which owns the rooms map) reject collisions without this module knowing about it.
function generateUniqueId(isTaken) {
  let id;
  do { id = generateId(); } while (isTaken && isTaken(id));
  return id;
}

// A secret per-player handle used to prove identity on reconnect. Without it,
// reconnection was keyed by display name alone — letting any same-named joiner
// adopt a disconnected player's host role and vote.
function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

function sanitizeName(name, fallback) {
  if (typeof name !== 'string') return fallback;
  const trimmed = name.trim().slice(0, MAX_NAME_LEN);
  return trimmed || fallback;
}

function createRoom(name, votingSystem, id) {
  return {
    id: id || generateId(),
    name: sanitizeName(name, 'Planning Poker'),
    votingSystem: VOTING_SYSTEMS[votingSystem] || VOTING_SYSTEMS.tshirt,
    votingSystemKey: VOTING_SYSTEMS[votingSystem] ? votingSystem : 'tshirt',
    players: new Map(),
    revealed: false,
    roundNumber: 0,
    consensusCount: 0,
    disconnected: new Map(),
    lastActivity: Date.now(),
    _countdownTimer: null,
    countdownEndsAt: null,
    countdownBy: null,
  };
}

function getNextColor(room) {
  // Reserve colors held by players who are mid-reconnect too, so a fresh joiner
  // doesn't collide with someone who is about to come back with that color.
  const usedColors = new Set([
    ...[...room.players.values()].map(p => p.color),
    ...[...room.disconnected.values()].map(d => d.player.color),
  ]);
  for (let i = 0; i < NUM_COLORS; i++) {
    if (!usedColors.has(i)) return i;
  }
  return room.players.size % NUM_COLORS;
}

function addPlayer(room, name, ws) {
  const playerId = generateId();
  const token = generateToken();
  const player = {
    name: sanitizeName(name, 'Player'),
    token,
    vote: null,
    voteSeq: 0,
    isHost: room.players.size === 0,
    color: getNextColor(room),
    ws,
  };
  room.players.set(playerId, player);
  return { playerId, player, token };
}

function removePlayer(room, playerId) {
  const player = room.players.get(playerId);
  if (!player) return null;
  room.players.delete(playerId);
  promoteHost(room);
  return player;
}

function promoteHost(room) {
  const players = [...room.players.values()];
  if (players.length > 0 && !players.some(p => p.isHost)) {
    players[0].isHost = true;
  }
}

function vote(room, playerId, value) {
  const player = room.players.get(playerId);
  if (!player || room.revealed) return false;
  // The value must be one of the room's own card faces. This is the single
  // server-side gate that stops arbitrary strings (XSS payloads, prototype
  // keys like '__proto__') from ever reaching another client's DOM.
  if (typeof value !== 'string' || !room.votingSystem.includes(value)) return false;
  room.lastActivity = Date.now();
  player.vote = value;
  player.voteSeq = (player.voteSeq || 0) + 1;
  return true;
}

function clearVote(room, playerId) {
  const player = room.players.get(playerId);
  if (!player || room.revealed) return false;
  room.lastActivity = Date.now();
  player.vote = null;
  player.voteSeq = (player.voteSeq || 0) + 1;
  return true;
}

function reveal(room, playerId) {
  const player = room.players.get(playerId);
  if (!player || !player.isHost) return { ok: false, reason: 'not-host' };
  if (room.revealed || room._countdownTimer) return { ok: false, reason: 'already-revealed' };
  room.lastActivity = Date.now();
  return { ok: true, initiatedBy: player.name };
}

// Mark a reveal countdown as running. The actual timer handle lives on the
// server (it owns setTimeout); this records the shared, serializable state so
// every client — including ones that join or reconnect mid-countdown — can
// render the same countdown derived from a wall-clock end time.
function beginCountdown(room, ms, initiatedBy) {
  room.countdownEndsAt = Date.now() + ms;
  room.countdownBy = initiatedBy || null;
  return room.countdownEndsAt;
}

// Tear down any pending countdown: clear the server's timer handle and wipe the
// serializable state so a stale timer can never fire applyReveal on a room that
// has since moved on (new round, everyone left, etc.).
function cancelCountdown(room) {
  if (room._countdownTimer) {
    clearTimeout(room._countdownTimer);
    room._countdownTimer = null;
  }
  room.countdownEndsAt = null;
  room.countdownBy = null;
}

function applyReveal(room) {
  room.revealed = true;
  room._countdownTimer = null;
  room.countdownEndsAt = null;
  room.countdownBy = null;

  const votes = [...room.players.values()]
    .map(p => p.vote)
    .filter(v => v && v !== '?');
  const hasConsensus = votes.length > 1 && votes.every(v => v === votes[0]);
  if (hasConsensus) {
    room.consensusCount++;
  }
  room.roundNumber++;

  return { hasConsensus, votes };
}

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

function newRound(room, playerId) {
  const player = room.players.get(playerId);
  if (!player || !player.isHost) return false;
  room.lastActivity = Date.now();
  // A reveal countdown may still be in flight (host hit reveal, then started a
  // new round before it elapsed). Cancel it so it can't clobber the fresh round
  // with a spurious blank reveal.
  cancelCountdown(room);
  room.revealed = false;
  for (const p of room.players.values()) {
    p.vote = null;
  }
  return true;
}

// GC predicate. A room is collectable only when it has been idle past the
// timeout AND has nobody connected AND nobody parked in the reconnect window —
// otherwise a long-idle discussion where everyone briefly drops would be
// destroyed out from under players still inside their 60s reconnect grace.
function isRoomExpired(room, now, timeoutMs) {
  return (now - room.lastActivity > timeoutMs)
    && room.players.size === 0
    && room.disconnected.size === 0;
}

function changeColor(room, playerId, colorIndex) {
  const player = room.players.get(playerId);
  if (!player) return false;
  if (typeof colorIndex !== 'number' || colorIndex < 0 || colorIndex >= NUM_COLORS) return false;
  player.color = colorIndex;
  return true;
}

function serializeRoom(room) {
  return {
    id: room.id,
    name: room.name,
    votingSystem: room.votingSystem,
    votingSystemKey: room.votingSystemKey,
    revealed: room.revealed,
    roundNumber: room.roundNumber,
    consensusCount: room.consensusCount,
    consensus: room.revealed ? computeConsensus(room) : null,
    // Countdown is carried in the room state (not a one-shot message) so any
    // client can derive the remaining time from the shared end timestamp,
    // including ones that join or reconnect while it is already running.
    countdownEndsAt: room.countdownEndsAt || null,
    countdownBy: room.countdownBy || null,
    players: [...room.players.entries()].map(([sid, p]) => ({
      id: sid,
      name: p.name,
      vote: room.revealed ? p.vote : (p.vote ? 'voted' : null),
      voteSeq: p.voteSeq || 0,
      isHost: p.isHost,
      color: p.color,
    })),
  };
}

// Per-viewer serialization: identical to serializeRoom EXCEPT the viewer's own
// vote value is shown in plaintext pre-reveal (so the viewer can sync their
// own state, e.g. re-render their hand-card picked highlight after a page
// reload). Other players' votes remain masked with the 'voted' sentinel.
function serializeRoomFor(room, viewerPlayerId) {
  const payload = serializeRoom(room);
  if (room.revealed) return payload;
  const me = payload.players.find(p => p.id === viewerPlayerId);
  const myActualPlayer = room.players.get(viewerPlayerId);
  if (me && myActualPlayer) {
    me.vote = myActualPlayer.vote;
  }
  return payload;
}

module.exports = {
  VOTING_SYSTEMS,
  NUM_COLORS,
  MAX_NAME_LEN,
  generateId,
  generateUniqueId,
  generateToken,
  sanitizeName,
  createRoom,
  getNextColor,
  addPlayer,
  removePlayer,
  promoteHost,
  vote,
  clearVote,
  reveal,
  applyReveal,
  beginCountdown,
  cancelCountdown,
  computeConsensus,
  isRoomExpired,
  newRound,
  changeColor,
  serializeRoom,
  serializeRoomFor,
};
