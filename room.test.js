const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  VOTING_SYSTEMS,
  NUM_COLORS,
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
} = require('./room');

// ─── createRoom ──────────────────────────────────────────────────────────────

describe('createRoom', () => {
  it('generates a 5-char id', () => {
    const room = createRoom('Test', 'fib');
    assert.equal(typeof room.id, 'string');
    assert.equal(room.id.length, 5);
  });

  it('uses provided name', () => {
    const room = createRoom('Sprint 42', 'fib');
    assert.equal(room.name, 'Sprint 42');
  });

  it('defaults name to Planning Poker', () => {
    const room = createRoom('', 'fib');
    assert.equal(room.name, 'Planning Poker');
  });

  it('selects correct voting system', () => {
    assert.deepEqual(createRoom('', 'tshirt').votingSystem, VOTING_SYSTEMS.tshirt);
    assert.deepEqual(createRoom('', 'fib').votingSystem, VOTING_SYSTEMS.fib);
    assert.deepEqual(createRoom('', 'powers').votingSystem, VOTING_SYSTEMS.powers);
    assert.deepEqual(createRoom('', 'simple').votingSystem, VOTING_SYSTEMS.simple);
  });

  it('defaults to tshirt for unknown voting system', () => {
    const room = createRoom('', 'bogus');
    assert.deepEqual(room.votingSystem, VOTING_SYSTEMS.tshirt);
    assert.equal(room.votingSystemKey, 'tshirt');
  });

  it('initializes with empty state', () => {
    const room = createRoom('Test', 'fib');
    assert.equal(room.players.size, 0);
    assert.equal(room.revealed, false);
    assert.equal(room.roundNumber, 0);
    assert.equal(room.consensusCount, 0);
    assert.equal(room.disconnected.size, 0);
  });
});

// ─── addPlayer / removePlayer ────────────────────────────────────────────────

describe('addPlayer', () => {
  let room;
  beforeEach(() => { room = createRoom('Test', 'fib'); });

  it('first player becomes host with color 0', () => {
    const { playerId, player } = addPlayer(room, 'Alice', null);
    assert.equal(player.isHost, true);
    assert.equal(player.color, 0);
    assert.equal(player.name, 'Alice');
    assert.equal(player.vote, null);
    assert.equal(room.players.size, 1);
    assert.equal(room.players.get(playerId), player);
  });

  it('second player is not host and gets a different color', () => {
    addPlayer(room, 'Alice', null);
    const { player } = addPlayer(room, 'Bob', null);
    assert.equal(player.isHost, false);
    assert.notEqual(player.color, 0);
  });

  it('defaults name to Player', () => {
    const { player } = addPlayer(room, '', null);
    assert.equal(player.name, 'Player');
  });
});

describe('removePlayer', () => {
  let room;
  beforeEach(() => { room = createRoom('Test', 'fib'); });

  it('removes the player from the room', () => {
    const { playerId } = addPlayer(room, 'Alice', null);
    const removed = removePlayer(room, playerId);
    assert.equal(removed.name, 'Alice');
    assert.equal(room.players.size, 0);
  });

  it('returns null for unknown playerId', () => {
    assert.equal(removePlayer(room, 'nonexistent'), null);
  });

  it('promotes next player to host when host leaves', () => {
    const { playerId: hostId } = addPlayer(room, 'Alice', null);
    addPlayer(room, 'Bob', null);
    removePlayer(room, hostId);
    const remaining = [...room.players.values()][0];
    assert.equal(remaining.isHost, true);
    assert.equal(remaining.name, 'Bob');
  });
});

// ─── getNextColor ────────────────────────────────────────────────────────────

describe('getNextColor', () => {
  it('assigns colors sequentially', () => {
    const room = createRoom('Test', 'fib');
    addPlayer(room, 'A', null); // color 0
    assert.equal(getNextColor(room), 1);
    addPlayer(room, 'B', null); // color 1
    assert.equal(getNextColor(room), 2);
  });

  it('fills gaps when players leave', () => {
    const room = createRoom('Test', 'fib');
    const { playerId: id1 } = addPlayer(room, 'A', null); // color 0
    addPlayer(room, 'B', null); // color 1
    addPlayer(room, 'C', null); // color 2
    removePlayer(room, id1); // frees color 0
    assert.equal(getNextColor(room), 0);
  });

  it('wraps around after 12 colors', () => {
    const room = createRoom('Test', 'fib');
    for (let i = 0; i < NUM_COLORS; i++) {
      addPlayer(room, `P${i}`, null);
    }
    // All 12 used, should wrap
    const next = getNextColor(room);
    assert.ok(next >= 0 && next < NUM_COLORS);
  });
});

// ─── promoteHost ─────────────────────────────────────────────────────────────

describe('promoteHost', () => {
  it('does nothing if a host exists', () => {
    const room = createRoom('Test', 'fib');
    addPlayer(room, 'Alice', null);
    addPlayer(room, 'Bob', null);
    promoteHost(room);
    const players = [...room.players.values()];
    assert.equal(players.filter(p => p.isHost).length, 1);
    assert.equal(players[0].isHost, true);
  });

  it('promotes first player if no host', () => {
    const room = createRoom('Test', 'fib');
    const { player: p1 } = addPlayer(room, 'Alice', null);
    addPlayer(room, 'Bob', null);
    p1.isHost = false; // manually unset
    promoteHost(room);
    assert.equal(p1.isHost, true);
  });

  it('does nothing for empty room', () => {
    const room = createRoom('Test', 'fib');
    promoteHost(room); // no crash
  });
});

// ─── vote / clearVote ────────────────────────────────────────────────────────

describe('vote', () => {
  let room, playerId;
  beforeEach(() => {
    room = createRoom('Test', 'fib');
    ({ playerId } = addPlayer(room, 'Alice', null));
  });

  it('sets player vote', () => {
    assert.equal(vote(room, playerId, '5'), true);
    assert.equal(room.players.get(playerId).vote, '5');
  });

  it('rejects vote when revealed', () => {
    room.revealed = true;
    assert.equal(vote(room, playerId, '5'), false);
  });

  it('rejects vote for unknown player', () => {
    assert.equal(vote(room, 'bogus', '5'), false);
  });

  it('allows changing vote', () => {
    vote(room, playerId, '5');
    vote(room, playerId, '8');
    assert.equal(room.players.get(playerId).vote, '8');
  });

  it('bumps voteSeq on every vote (including changes to the same value)', () => {
    assert.equal(room.players.get(playerId).voteSeq, 0);
    vote(room, playerId, '5');
    assert.equal(room.players.get(playerId).voteSeq, 1);
    vote(room, playerId, '8');
    assert.equal(room.players.get(playerId).voteSeq, 2);
    vote(room, playerId, '8'); // same value, but still a new action
    assert.equal(room.players.get(playerId).voteSeq, 3);
  });
});

describe('clearVote', () => {
  let room, playerId;
  beforeEach(() => {
    room = createRoom('Test', 'fib');
    ({ playerId } = addPlayer(room, 'Alice', null));
    vote(room, playerId, '5');
  });

  it('clears the vote', () => {
    assert.equal(clearVote(room, playerId), true);
    assert.equal(room.players.get(playerId).vote, null);
  });

  it('rejects when revealed', () => {
    room.revealed = true;
    assert.equal(clearVote(room, playerId), false);
  });

  it('bumps voteSeq on clear', () => {
    // After setup: voteSeq = 1 (from beforeEach vote)
    assert.equal(room.players.get(playerId).voteSeq, 1);
    clearVote(room, playerId);
    assert.equal(room.players.get(playerId).voteSeq, 2);
  });
});

// ─── reveal / applyReveal ────────────────────────────────────────────────────

describe('reveal', () => {
  let room, hostId;
  beforeEach(() => {
    room = createRoom('Test', 'fib');
    ({ playerId: hostId } = addPlayer(room, 'Alice', null));
  });

  it('succeeds for host', () => {
    const result = reveal(room, hostId);
    assert.equal(result.ok, true);
    assert.equal(result.initiatedBy, 'Alice');
  });

  it('rejects non-host', () => {
    const { playerId: otherId } = addPlayer(room, 'Bob', null);
    const result = reveal(room, otherId);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-host');
  });

  it('rejects if already revealed', () => {
    room.revealed = true;
    const result = reveal(room, hostId);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'already-revealed');
  });

  it('rejects if countdown is active', () => {
    room._countdownTimer = setTimeout(() => {}, 10000);
    const result = reveal(room, hostId);
    assert.equal(result.ok, false);
    clearTimeout(room._countdownTimer);
  });
});

describe('applyReveal', () => {
  let room, hostId;
  beforeEach(() => {
    room = createRoom('Test', 'fib');
    ({ playerId: hostId } = addPlayer(room, 'Alice', null));
  });

  it('sets revealed and increments round', () => {
    applyReveal(room);
    assert.equal(room.revealed, true);
    assert.equal(room.roundNumber, 1);
  });

  it('detects consensus when all votes match', () => {
    const { playerId: bobId } = addPlayer(room, 'Bob', null);
    vote(room, hostId, '5');
    vote(room, bobId, '5');
    const result = applyReveal(room);
    assert.equal(result.hasConsensus, true);
    assert.equal(room.consensusCount, 1);
  });

  it('no consensus when votes differ', () => {
    const { playerId: bobId } = addPlayer(room, 'Bob', null);
    vote(room, hostId, '5');
    vote(room, bobId, '8');
    const result = applyReveal(room);
    assert.equal(result.hasConsensus, false);
    assert.equal(room.consensusCount, 0);
  });

  it('ignores ? votes for consensus', () => {
    const { playerId: bobId } = addPlayer(room, 'Bob', null);
    vote(room, hostId, '5');
    vote(room, bobId, '?');
    const result = applyReveal(room);
    // Only one non-? vote, need >1 for consensus
    assert.equal(result.hasConsensus, false);
  });

  it('tracks consensus across multiple rounds', () => {
    const { playerId: bobId } = addPlayer(room, 'Bob', null);

    // Round 1: consensus
    vote(room, hostId, '5');
    vote(room, bobId, '5');
    applyReveal(room);
    assert.equal(room.consensusCount, 1);
    assert.equal(room.roundNumber, 1);

    // Round 2: no consensus
    newRound(room, hostId);
    vote(room, hostId, '3');
    vote(room, bobId, '8');
    applyReveal(room);
    assert.equal(room.consensusCount, 1);
    assert.equal(room.roundNumber, 2);

    // Round 3: consensus again
    newRound(room, hostId);
    vote(room, hostId, 'M');
    vote(room, bobId, 'M');
    applyReveal(room);
    assert.equal(room.consensusCount, 2);
    assert.equal(room.roundNumber, 3);
  });
});

// ─── newRound ────────────────────────────────────────────────────────────────

describe('newRound', () => {
  let room, hostId, bobId;
  beforeEach(() => {
    room = createRoom('Test', 'fib');
    ({ playerId: hostId } = addPlayer(room, 'Alice', null));
    ({ playerId: bobId } = addPlayer(room, 'Bob', null));
    vote(room, hostId, '5');
    vote(room, bobId, '8');
    room.revealed = true;
  });

  it('clears revealed and all votes', () => {
    assert.equal(newRound(room, hostId), true);
    assert.equal(room.revealed, false);
    for (const p of room.players.values()) {
      assert.equal(p.vote, null);
    }
  });

  it('rejects non-host', () => {
    assert.equal(newRound(room, bobId), false);
    assert.equal(room.revealed, true); // unchanged
  });
});

// ─── changeColor ─────────────────────────────────────────────────────────────

describe('changeColor', () => {
  let room, playerId;
  beforeEach(() => {
    room = createRoom('Test', 'fib');
    ({ playerId } = addPlayer(room, 'Alice', null));
  });

  it('changes player color', () => {
    assert.equal(changeColor(room, playerId, 5), true);
    assert.equal(room.players.get(playerId).color, 5);
  });

  it('rejects out-of-range color', () => {
    assert.equal(changeColor(room, playerId, -1), false);
    assert.equal(changeColor(room, playerId, 12), false);
    assert.equal(changeColor(room, playerId, 99), false);
  });

  it('rejects non-number color', () => {
    assert.equal(changeColor(room, playerId, 'red'), false);
    assert.equal(changeColor(room, playerId, null), false);
  });

  it('rejects unknown player', () => {
    assert.equal(changeColor(room, 'bogus', 5), false);
  });
});

// ─── serializeRoom ───────────────────────────────────────────────────────────

describe('serializeRoom', () => {
  it('hides votes when not revealed', () => {
    const room = createRoom('Test', 'fib');
    const { playerId } = addPlayer(room, 'Alice', null);
    vote(room, playerId, '5');
    const serialized = serializeRoom(room);
    assert.equal(serialized.players[0].vote, 'voted');
  });

  it('shows votes when revealed', () => {
    const room = createRoom('Test', 'fib');
    const { playerId } = addPlayer(room, 'Alice', null);
    vote(room, playerId, '5');
    room.revealed = true;
    const serialized = serializeRoom(room);
    assert.equal(serialized.players[0].vote, '5');
  });

  it('shows null for players who have not voted', () => {
    const room = createRoom('Test', 'fib');
    addPlayer(room, 'Alice', null);
    const serialized = serializeRoom(room);
    assert.equal(serialized.players[0].vote, null);
  });

  it('includes all room metadata', () => {
    const room = createRoom('Sprint 42', 'tshirt');
    const serialized = serializeRoom(room);
    assert.equal(serialized.name, 'Sprint 42');
    assert.equal(serialized.votingSystemKey, 'tshirt');
    assert.equal(serialized.revealed, false);
    assert.equal(serialized.roundNumber, 0);
    assert.equal(serialized.consensusCount, 0);
  });

  it('includes voteSeq on every player', () => {
    const room = createRoom('Test', 'fib');
    const { playerId } = addPlayer(room, 'Alice', null);
    assert.equal(serializeRoom(room).players[0].voteSeq, 0);
    vote(room, playerId, '5');
    assert.equal(serializeRoom(room).players[0].voteSeq, 1);
    vote(room, playerId, '8');
    assert.equal(serializeRoom(room).players[0].voteSeq, 2);
  });
});

describe('serializeRoomFor (per-recipient)', () => {
  const { serializeRoomFor } = require('./room');

  it('reveals viewer own vote value pre-reveal, hides other players', () => {
    const room = createRoom('Test', 'fib');
    const { playerId: alicePid } = addPlayer(room, 'Alice', null);
    const { playerId: bobPid } = addPlayer(room, 'Bob', null);
    vote(room, alicePid, '5');
    vote(room, bobPid, '8');

    const forAlice = serializeRoomFor(room, alicePid);
    assert.equal(forAlice.players.find(p => p.id === alicePid).vote, '5');
    assert.equal(forAlice.players.find(p => p.id === bobPid).vote, 'voted');

    const forBob = serializeRoomFor(room, bobPid);
    assert.equal(forBob.players.find(p => p.id === alicePid).vote, 'voted');
    assert.equal(forBob.players.find(p => p.id === bobPid).vote, '8');
  });

  it('post-reveal serializeRoomFor matches serializeRoom (all real values)', () => {
    const room = createRoom('Test', 'fib');
    const { playerId: alicePid } = addPlayer(room, 'Alice', null);
    const { playerId: bobPid } = addPlayer(room, 'Bob', null);
    vote(room, alicePid, '5');
    vote(room, bobPid, '8');
    room.revealed = true;

    const forAlice = serializeRoomFor(room, alicePid);
    assert.equal(forAlice.players.find(p => p.id === alicePid).vote, '5');
    assert.equal(forAlice.players.find(p => p.id === bobPid).vote, '8');
  });

  it('returns null for the viewer slot when they have not voted', () => {
    const room = createRoom('Test', 'fib');
    const { playerId } = addPlayer(room, 'Alice', null);
    const forAlice = serializeRoomFor(room, playerId);
    assert.equal(forAlice.players[0].vote, null);
  });
});

// ─── computeConsensus ────────────────────────────────────────────────────────

describe('computeConsensus', () => {
  // Build a room whose players carry the given votes. `null` = did not vote.
  function roomWithVotes(votes) {
    const room = createRoom('Test', 'fib');
    votes.forEach((v, i) => {
      const { playerId } = addPlayer(room, 'P' + i);
      if (v !== null) room.players.get(playerId).vote = v;
    });
    return room;
  }

  it('no consensus when every vote is different', () => {
    const r = computeConsensus(roomWithVotes(['1', '2', '3', '5']));
    assert.equal(r.state, 'none');
    assert.deepEqual(r.values, []);
  });

  it('no consensus with a single voter', () => {
    assert.equal(computeConsensus(roomWithVotes(['5'])).state, 'none');
  });

  it('no consensus when nobody voted', () => {
    assert.equal(computeConsensus(roomWithVotes([null, null])).state, 'none');
  });

  it('no consensus when every vote is "?"', () => {
    assert.equal(computeConsensus(roomWithVotes(['?', '?', '?'])).state, 'none');
  });

  it('unanimous when all players voted the same value', () => {
    const r = computeConsensus(roomWithVotes(['5', '5', '5']));
    assert.equal(r.state, 'unanimous');
    assert.deepEqual(r.values, ['5']);
  });

  it('consensus when one value leads but not everyone agrees', () => {
    const r = computeConsensus(roomWithVotes(['5', '5', '3']));
    assert.equal(r.state, 'consensus');
    assert.deepEqual(r.values, ['5']);
    assert.equal(r.maxCount, 2);
  });

  it('unanimous counts voters only — a non-voter does not block it', () => {
    // Two players voted 5, one player did not vote at all.
    const r = computeConsensus(roomWithVotes(['5', '5', null]));
    assert.equal(r.state, 'unanimous');
    assert.deepEqual(r.values, ['5']);
  });

  it('a "?" vote prevents unanimous, falls back to consensus', () => {
    const r = computeConsensus(roomWithVotes(['5', '5', '?']));
    assert.equal(r.state, 'consensus');
    assert.deepEqual(r.values, ['5']);
  });

  it('split on a two-way tie', () => {
    const r = computeConsensus(roomWithVotes(['3', '3', '5', '5']));
    assert.equal(r.state, 'split');
    assert.equal(r.values.length, 2);
    assert.ok(r.values.includes('3') && r.values.includes('5'));
  });

  it('split on a three-way tie', () => {
    const r = computeConsensus(roomWithVotes(['1', '1', '2', '2', '3', '3']));
    assert.equal(r.state, 'split');
    assert.equal(r.values.length, 3);
  });

  it('excludes "?" votes from the tally', () => {
    // 5,5 lead with count 2; the two "?" voters do not form a camp.
    const r = computeConsensus(roomWithVotes(['5', '5', '?', '?']));
    assert.equal(r.state, 'consensus');
    assert.deepEqual(r.values, ['5']);
  });
});

// ─── serializeRoom consensus field ───────────────────────────────────────────

describe('serializeRoom consensus', () => {
  it('is null before reveal', () => {
    const room = createRoom('Test', 'fib');
    addPlayer(room, 'Alice');
    assert.equal(serializeRoom(room).consensus, null);
  });

  it('is populated after reveal', () => {
    const room = createRoom('Test', 'fib');
    const { playerId: a } = addPlayer(room, 'Alice');
    const { playerId: b } = addPlayer(room, 'Bob');
    vote(room, a, '5');
    vote(room, b, '5');
    applyReveal(room);
    const consensus = serializeRoom(room).consensus;
    assert.equal(consensus.state, 'unanimous');
    assert.deepEqual(consensus.values, ['5']);
  });
});

// ─── voting during the reveal countdown ──────────────────────────────────────

describe('vote during countdown', () => {
  it('accepts a vote while a reveal countdown is pending', () => {
    const room = createRoom('Test', 'fib');
    const { playerId: host } = addPlayer(room, 'Host');
    const { playerId: bob } = addPlayer(room, 'Bob');
    vote(room, host, '3');
    vote(room, bob, '3');

    // Host initiates the reveal. The server then sets _countdownTimer and
    // calls applyReveal only when it fires — revealed is still false here.
    assert.equal(reveal(room, host).ok, true);
    room._countdownTimer = setTimeout(() => {}, 1000); // simulate pending countdown

    assert.equal(room.revealed, false); // countdown pending, not yet revealed

    // A player changes their mind during the countdown window.
    assert.equal(vote(room, bob, '8'), true);
    assert.equal(room.players.get(bob).vote, '8');

    clearTimeout(room._countdownTimer);
  });
});
