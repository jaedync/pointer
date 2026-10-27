// ─── Room Logic ──────────────────────────────────────────────────────────────
// Pure room state management, extracted for testability.
// No WebSocket or HTTP concerns — just data structures and rules.

const crypto = require('crypto');
const { computeRoundStats } = require('./public/render.js');

const VOTING_SYSTEMS = {
  tshirt: ['XS', 'S', 'M', 'L', 'XL', '?'],
  fib: ['0', '1', '2', '3', '5', '8', '13', '21', '?'],
  powers: ['1', '2', '4', '8', '16', '32', '?'],
  simple: ['1', '2', '3', '4', '5', '?'],
};
const NUM_COLORS = 12;
const MAX_NAME_LEN = 40;
const MAX_TOPIC_LEN = 120;
const MAX_HISTORY = 25;
// Seats per room, away seats included. Far above a planning meeting; it bounds
// what one room costs in memory, in every broadcast and in the snapshot.
const MAX_PLAYERS = 50;

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
  // Cap by Unicode codepoint, not UTF-16 code unit, so truncation can't split an
  // astral character (emoji) and leave a dangling lone surrogate.
  const trimmed = Array.from(name.trim()).slice(0, MAX_NAME_LEN).join('');
  return trimmed || fallback;
}

function createRoom(name, votingSystem, id) {
  // OWN-property check only: a client-supplied key like 'toString' or
  // '__proto__' must not resolve to an inherited Object.prototype member, which
  // would make votingSystem a function and crash vote()'s .includes().
  // The string check comes first: hasOwnProperty converts its key, and an
  // object key like {toString: 1} would throw inside that conversion.
  const hasSystem = typeof votingSystem === 'string' &&
    Object.prototype.hasOwnProperty.call(VOTING_SYSTEMS, votingSystem);
  return {
    id: id || generateId(),
    name: sanitizeName(name, 'Planning Poker'),
    votingSystem: hasSystem ? VOTING_SYSTEMS[votingSystem] : VOTING_SYSTEMS.tshirt,
    votingSystemKey: hasSystem ? votingSystem : 'tshirt',
    players: new Map(),
    revealed: false,
    roundNumber: 0,
    consensusCount: 0,
    topic: '',
    history: [],
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

// Returns null when the room is full.
function addPlayer(room, name, ws) {
  if (room.players.size >= MAX_PLAYERS) return null;
  const playerId = generateId();
  const token = generateToken();
  const player = {
    name: sanitizeName(name, 'Player'),
    token,
    vote: null,
    voteSeq: 0,
    isHost: room.players.size === 0,
    color: getNextColor(room),
    observer: false,
    away: false,
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

// Guarantee exactly one host when anyone is seated. Prefer a present voter,
// then any present player, then (all away) the first seat, so an away host is
// never replaced here — that only happens when their reconnect window ends
// (removePlayer) or when a present player claims the role (claimHost).
function promoteHost(room) {
  const players = [...room.players.values()];
  if (players.length === 0 || players.some(p => p.isHost)) return;
  const pick = players.find(p => !p.away && !p.observer)
    || players.find(p => !p.away)
    || players[0];
  pick.isHost = true;
}

// A present player may take the host role only while the host is away (closed
// tab, sleeping laptop). Otherwise the room would stall until the host's
// reconnect window ends.
function claimHost(room, playerId) {
  const player = room.players.get(playerId);
  if (!player || player.away || player.isHost) return false;
  const host = [...room.players.values()].find(p => p.isHost);
  if (host && !host.away) return false;
  if (host) host.isHost = false;
  player.isHost = true;
  room.lastActivity = Date.now();
  return true;
}

// Disconnect keeps the seat (and its order, vote and host role) and marks it
// away. The server removes it when the reconnect window ends.
function markAway(room, playerId) {
  const player = room.players.get(playerId);
  if (!player) return null;
  player.away = true;
  player.ws = null;
  return player;
}

function markBack(room, playerId, ws) {
  const player = room.players.get(playerId);
  if (!player) return null;
  player.away = false;
  player.ws = ws;
  return player;
}

function setObserver(room, playerId, observer) {
  const player = room.players.get(playerId);
  if (!player || typeof observer !== 'boolean') return false;
  if (player.observer === observer) return false;
  player.observer = observer;
  // After the reveal the vote stays, so the shown result and the history entry
  // still agree. newRound clears it, and from then on the observer is out.
  if (observer && player.vote && !room.revealed) {
    player.vote = null;
    player.voteSeq = (player.voteSeq || 0) + 1;
  }
  room.lastActivity = Date.now();
  return true;
}

function setTopic(room, playerId, topic) {
  const player = room.players.get(playerId);
  if (!player || !player.isHost || typeof topic !== 'string') return false;
  const clean = Array.from(topic.replace(/\s+/g, ' ').trim()).slice(0, MAX_TOPIC_LEN).join('');
  if (clean === room.topic) return false;
  room.topic = clean;
  room.lastActivity = Date.now();
  return true;
}

// Seats that count toward voting: everyone except observers. Away players stay
// in: a vote cast before a dropped connection is still a vote. An observer who
// still holds a vote switched after the reveal, and that vote is in the result.
function voters(room) {
  return [...room.players.values()].filter(p => !p.observer || p.vote);
}

function vote(room, playerId, value) {
  const player = room.players.get(playerId);
  if (!player || player.observer || room.revealed) return false;
  // The value must be one of the room's own card faces. This is the single
  // server-side gate that stops arbitrary strings (XSS payloads, prototype
  // keys like '__proto__') from ever reaching another client's DOM.
  if (typeof value !== 'string' || !Array.isArray(room.votingSystem) || !room.votingSystem.includes(value)) return false;
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

  const votes = voters(room).map(p => p.vote).filter(v => v && v !== '?');
  // One definition of agreement everywhere: the tracker counts exactly the
  // rounds that the result pill labels 'unanimous'.
  const consensus = computeConsensus(room);
  const hasConsensus = consensus.state === 'unanimous';
  if (hasConsensus) {
    room.consensusCount++;
  }
  room.roundNumber++;

  const stats = computeRoundStats(voters(room), room.votingSystem);
  room.history.unshift({
    round: room.roundNumber,
    topic: room.topic,
    state: consensus.state,
    values: consensus.values,
    counts: stats.counts.map(c => ({ value: c.value, n: c.n })),
    average: stats.average,
    voters: stats.voted,
  });
  if (room.history.length > MAX_HISTORY) room.history.length = MAX_HISTORY;

  return { hasConsensus, votes };
}

// Classify a revealed round. Excludes '?' votes and non-votes from the tally.
// Returns { state, values, maxCount } where state is one of:
//   'none'      — no value is shared by 2+ players (or too few votes)
//   'unanimous' — one value, and every voter chose it
//   'consensus' — one value leads but not everyone agrees
//   'split'     — two or more values tie for the lead
function computeConsensus(room) {
  const voted = voters(room).filter(p => p.vote);         // voted anything, incl '?'
  const valueVotes = voted.map(p => p.vote).filter(v => v !== '?');

  const counts = {};
  for (const v of valueVotes) counts[v] = (counts[v] || 0) + 1;

  const values = Object.keys(counts);
  let maxCount = 0;
  for (const v of values) if (counts[v] > maxCount) maxCount = counts[v];

  if (maxCount < 2) return { state: 'none', values: [], maxCount };

  const topValues = values.filter(v => counts[v] === maxCount);
  if (topValues.length === 1 && maxCount === voted.length) {
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
  room.topic = '';
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
  const present = [...room.players.values()].some(p => !p.away);
  return (now - room.lastActivity > timeoutMs)
    && !present
    && room.disconnected.size === 0;
}

function changeColor(room, playerId, colorIndex) {
  const player = room.players.get(playerId);
  if (!player) return false;
  // Number.isInteger rejects NaN, Infinity, floats, and non-numbers in one shot.
  // (typeof NaN === 'number' and every NaN comparison is false, so the old guard
  // let NaN/2.5 through and broadcast an undefined color to all clients.)
  if (!Number.isInteger(colorIndex) || colorIndex < 0 || colorIndex >= NUM_COLORS) return false;
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
    topic: room.topic || '',
    history: room.history || [],
    players: [...room.players.entries()].map(([sid, p]) => ({
      id: sid,
      name: p.name,
      vote: room.revealed ? p.vote : (p.vote ? 'voted' : null),
      voteSeq: p.voteSeq || 0,
      isHost: p.isHost,
      color: p.color,
      observer: !!p.observer,
      away: !!p.away,
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
  MAX_TOPIC_LEN,
  MAX_HISTORY,
  MAX_PLAYERS,
  generateId,
  generateUniqueId,
  generateToken,
  sanitizeName,
  createRoom,
  getNextColor,
  addPlayer,
  removePlayer,
  promoteHost,
  claimHost,
  markAway,
  markBack,
  setObserver,
  setTopic,
  voters,
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
