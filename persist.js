// ─── Room persistence ────────────────────────────────────────────────────────
// Rooms live in memory. To survive a deploy or restart, the server writes a
// snapshot on SIGTERM (and shortly after each change) and reads it at boot.
// Restored players come back "away" and keep their seat, vote, host role and
// reconnect token, so a client that reconnects with its sessionStorage
// credentials lands in the same seat.

const fs = require('fs');
const path = require('path');
const room = require('./room');

const SNAPSHOT_VERSION = 1;

function snapshotRooms(rooms, now = Date.now()) {
  return {
    version: SNAPSHOT_VERSION,
    savedAt: now,
    rooms: [...rooms.values()].map(r => ({
      id: r.id,
      name: r.name,
      votingSystemKey: r.votingSystemKey,
      revealed: r.revealed,
      roundNumber: r.roundNumber,
      consensusCount: r.consensusCount,
      topic: r.topic || '',
      history: r.history || [],
      lastActivity: r.lastActivity,
      countdownEndsAt: r.countdownEndsAt || null,
      players: [...r.players.entries()].map(([id, p]) => ({
        id,
        name: p.name,
        token: p.token,
        vote: p.vote,
        voteSeq: p.voteSeq || 0,
        isHost: !!p.isHost,
        color: p.color,
        observer: !!p.observer,
      })),
    })),
  };
}

const isStr = v => typeof v === 'string';
const isInt = v => Number.isInteger(v) && v >= 0;

// Bounds for a snapshot. Far above real use (a room rarely has 20 people), low
// enough that a damaged or planted file cannot exhaust memory at boot.
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const MAX_ROOMS = 10000;
const MAX_PLAYERS = 200;
const MAX_ID_LEN = 64;
const HISTORY_STATES = new Set(['none', 'split', 'consensus', 'unanimous']);

const cleanTopic = t => isStr(t) ? Array.from(t).slice(0, room.MAX_TOPIC_LEN).join('') : '';

// The client renders history fields directly, so every record must have the
// shape that applyReveal writes. Values outside the deck are dropped.
function cleanHistoryEntry(h, deck) {
  if (!h || typeof h !== 'object' || !isInt(h.round) || !HISTORY_STATES.has(h.state)) return null;
  const inDeck = v => isStr(v) && deck.includes(v);
  const values = Array.isArray(h.values) ? h.values.slice(0, deck.length).filter(inDeck) : [];
  const counts = Array.isArray(h.counts)
    ? h.counts.slice(0, deck.length).filter(c => c && inDeck(c.value) && isInt(c.n)).map(c => ({ value: c.value, n: c.n }))
    : [];
  return {
    round: h.round,
    topic: cleanTopic(h.topic),
    state: h.state,
    values,
    counts,
    average: Number.isFinite(h.average) ? h.average : null,
    voters: isInt(h.voters) ? h.voters : 0,
  };
}

function restorePlayer(p, deck) {
  if (!p || !isStr(p.id) || !isStr(p.token) || p.id.length > MAX_ID_LEN || p.token.length > MAX_ID_LEN) return null;
  return {
    name: room.sanitizeName(isStr(p.name) ? p.name : '', 'Player'),
    token: p.token,
    vote: isStr(p.vote) && deck.includes(p.vote) ? p.vote : null,
    voteSeq: isInt(p.voteSeq) ? p.voteSeq : 0,
    isHost: p.isHost === true,
    color: Number.isInteger(p.color) && p.color >= 0 && p.color < room.NUM_COLORS ? p.color : 0,
    observer: p.observer === true,
    away: true,
    ws: null,
  };
}

// Returns the room, or null when the record cannot be used.
function restoreRoom(s) {
  if (!s || !isStr(s.id) || !/^[a-z0-9]{1,16}$/.test(s.id) || !Array.isArray(s.players)) return null;
  const r = room.createRoom(isStr(s.name) ? s.name : '', s.votingSystemKey, s.id);
  r.revealed = s.revealed === true;
  r.roundNumber = isInt(s.roundNumber) ? s.roundNumber : 0;
  r.consensusCount = isInt(s.consensusCount) ? s.consensusCount : 0;
  r.topic = cleanTopic(s.topic);
  r.history = Array.isArray(s.history)
    ? s.history.slice(0, room.MAX_HISTORY).map(h => cleanHistoryEntry(h, r.votingSystem)).filter(Boolean)
    : [];
  r.lastActivity = Number.isFinite(s.lastActivity) ? s.lastActivity : Date.now();
  for (const p of s.players.slice(0, MAX_PLAYERS)) {
    const player = restorePlayer(p, r.votingSystem);
    if (player && !r.players.has(p.id)) r.players.set(p.id, player);
  }
  if (r.players.size === 0) return null;
  // Exactly one host, even if the file says otherwise.
  let seenHost = false;
  for (const p of r.players.values()) {
    if (p.isHost && !seenHost) seenHost = true;
    else p.isHost = false;
  }
  room.promoteHost(r);
  // A reveal countdown cannot resume without its timer: finish it now.
  if (!r.revealed && s.countdownEndsAt) room.applyReveal(r);
  return r;
}

// Rebuild rooms from a snapshot. Every field is re-validated: the file is ours,
// but a truncated or hand-edited file must not crash the server or smuggle in
// values that the live checks would refuse (votes outside the deck, bad colors).
// Each room is restored on its own, so one bad record costs only that room.
// report.rejected counts the records that were dropped.
function restoreRooms(data, report = {}) {
  const out = new Map();
  report.rejected = 0;
  if (!data || data.version !== SNAPSHOT_VERSION || !Array.isArray(data.rooms)) return out;
  report.rejected = Math.max(0, data.rooms.length - MAX_ROOMS);
  for (const s of data.rooms.slice(0, MAX_ROOMS)) {
    let r = null;
    try { r = restoreRoom(s); } catch (e) {
      console.error(`[persist] dropping a room that cannot be restored: ${e.message}`);
    }
    if (r && !out.has(r.id)) out.set(r.id, r);
    else report.rejected++;
  }
  return out;
}

// Keep the unusable file next to the live one. The next save overwrites the
// live file, and without this copy the rooms in it could not be recovered.
function keepRejected(file, why) {
  try {
    fs.copyFileSync(file, `${file}.rejected`);
    fs.chmodSync(`${file}.rejected`, 0o600);
    console.error(`[persist] ${why}; kept a copy at ${file}.rejected`);
  } catch (e) {
    console.error(`[persist] ${why}; cannot keep a copy: ${e.message}`);
  }
}

function loadSnapshot(file) {
  if (!file) return new Map();
  let text;
  try {
    if (fs.statSync(file).size > MAX_SNAPSHOT_BYTES) {
      keepRejected(file, `snapshot ${file} is larger than ${MAX_SNAPSHOT_BYTES} bytes`);
      return new Map();
    }
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[persist] cannot read ${file}: ${e.message}`);
    return new Map();
  }
  let data;
  try { data = JSON.parse(text); } catch (e) {
    keepRejected(file, `unreadable snapshot ${file}: ${e.message}`);
    return new Map();
  }
  const report = {};
  const rooms = restoreRooms(data, report);
  if (report.rejected > 0 || (data && data.version !== SNAPSHOT_VERSION)) {
    keepRejected(file, `${report.rejected} room(s) in ${file} could not be restored`);
  }
  return rooms;
}

// Atomic write: a crash mid-write leaves the previous snapshot intact. The file
// holds reconnect tokens, so it is readable by the owner only.
function saveSnapshot(file, rooms) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshotRooms(rooms)), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error(`[persist] cannot write ${file}: ${e.message}`);
  }
}

module.exports = { SNAPSHOT_VERSION, snapshotRooms, restoreRooms, loadSnapshot, saveSnapshot };
