// ─── Room Logic ──────────────────────────────────────────────────────────────
// Pure room state management, extracted for testability.
// No WebSocket or HTTP concerns — just data structures and rules.

const VOTING_SYSTEMS = {
  tshirt: ['XS', 'S', 'M', 'L', 'XL', '?'],
  fib: ['0', '1', '2', '3', '5', '8', '13', '21', '?'],
  powers: ['1', '2', '4', '8', '16', '32', '?'],
  simple: ['1', '2', '3', '4', '5', '?'],
};
const NUM_COLORS = 12;

function generateId() {
  return Math.random().toString(36).substring(2, 7);
}

function createRoom(name, votingSystem) {
  return {
    id: generateId(),
    name: name || 'Planning Poker',
    votingSystem: VOTING_SYSTEMS[votingSystem] || VOTING_SYSTEMS.tshirt,
    votingSystemKey: VOTING_SYSTEMS[votingSystem] ? votingSystem : 'tshirt',
    players: new Map(),
    revealed: false,
    roundNumber: 0,
    consensusCount: 0,
    disconnected: new Map(),
    lastActivity: Date.now(),
    _countdownTimer: null,
  };
}

function getNextColor(room) {
  const usedColors = new Set([...room.players.values()].map(p => p.color));
  for (let i = 0; i < NUM_COLORS; i++) {
    if (!usedColors.has(i)) return i;
  }
  return room.players.size % NUM_COLORS;
}

function addPlayer(room, name, ws) {
  const playerId = generateId();
  const player = {
    name: name || 'Player',
    vote: null,
    voteSeq: 0,
    isHost: room.players.size === 0,
    color: room.players.size === 0 ? 0 : getNextColor(room),
    ws,
  };
  room.players.set(playerId, player);
  return { playerId, player };
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

function applyReveal(room) {
  room.revealed = true;
  room._countdownTimer = null;

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
  room.revealed = false;
  for (const p of room.players.values()) {
    p.vote = null;
  }
  return true;
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
  generateId,
  createRoom,
  getNextColor,
  addPlayer,
  removePlayer,
  promoteHost,
  vote,
  clearVote,
  reveal,
  applyReveal,
  computeConsensus,
  newRound,
  changeColor,
  serializeRoom,
  serializeRoomFor,
};
