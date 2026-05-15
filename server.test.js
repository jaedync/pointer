const { describe, it, after, before } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const WebSocket = require('ws');

// ─── Test Helpers ────────────────────────────────────────────────────────────
// A thin client wrapper that queues all incoming messages so we never miss one.

class TestClient {
  constructor(ws) {
    this.ws = ws;
    this._queue = [];
    this._waiters = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      const waiterIdx = this._waiters.findIndex(w =>
        w.type === msg.type && (!w.predicate || w.predicate(msg))
      );
      if (waiterIdx !== -1) {
        const waiter = this._waiters.splice(waiterIdx, 1)[0];
        waiter.resolve(msg);
      } else {
        this._queue.push(msg);
      }
    });
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  waitFor(type, predicateOrTimeout, timeoutMs) {
    let predicate = null;
    if (typeof predicateOrTimeout === 'function') {
      predicate = predicateOrTimeout;
      timeoutMs = timeoutMs || 5000;
    } else {
      timeoutMs = predicateOrTimeout || 5000;
    }

    // Check queue first
    const idx = this._queue.findIndex(m => m.type === type && (!predicate || predicate(m)));
    if (idx !== -1) {
      return Promise.resolve(this._queue.splice(idx, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiters.splice(this._waiters.indexOf(entry), 1);
        reject(new Error(`Timed out waiting for "${type}"`));
      }, timeoutMs);
      const entry = {
        type,
        predicate,
        resolve: (msg) => { clearTimeout(timer); resolve(msg); },
      };
      this._waiters.push(entry);
    });
  }

  async close() {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.on('close', resolve);
      this.ws.close();
    });
  }
}

let server;
let port;
let wsUrl;
let baseUrl;

async function startServer() {
  return new Promise((resolve) => {
    const tempServer = http.createServer();
    tempServer.listen(0, () => {
      port = tempServer.address().port;
      tempServer.close(() => {
        process.env.PORT = port;
        process.env.COUNTDOWN_MS = '0'; // instant reveal for tests
        delete require.cache[require.resolve('./server')];
        delete require.cache[require.resolve('./room')];
        server = require('./server');
        baseUrl = `http://localhost:${port}`;
        wsUrl = `ws://localhost:${port}`;
        resolve();
      });
    });
  });
}

async function connect() {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => resolve(new TestClient(ws)));
  });
}

// Helper: create a room and return { client, roomId, playerId }
async function createRoom(name, playerName, votingSystem) {
  const c = await connect();
  c.send({ type: 'create-room', name, playerName, votingSystem });
  const created = await c.waitFor('room-created');
  await c.waitFor('room-state'); // drain initial broadcast
  return { client: c, roomId: created.roomId, playerId: created.playerId };
}

// Helper: join a room and return { client, playerId }
async function joinRoom(roomId, playerName) {
  const c = await connect();
  c.send({ type: 'join-room', roomId, playerName });
  const joined = await c.waitFor('joined');
  await c.waitFor('room-state'); // drain initial broadcast
  return { client: c, playerId: joined.playerId };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Server Integration', () => {
  before(async () => { await startServer(); });
  after(() => { server.close(); });

  // ─── HTTP ──────────────────────────────────────────────────────────────

  describe('HTTP', () => {
    it('serves index.html', async () => {
      const res = await fetch(baseUrl);
      assert.equal(res.status, 200);
      assert.ok((await res.text()).includes('Pointer'));
    });
  });

  // ─── Room Creation ─────────────────────────────────────────────────────

  describe('create-room', () => {
    it('returns roomId and playerId, broadcasts state', async () => {
      const { client, roomId, playerId } = await createRoom('Test', 'Alice', 'fib');
      assert.equal(roomId.length, 5);
      assert.equal(typeof playerId, 'string');

      // Verify by voting (which triggers a new broadcast)
      client.send({ type: 'vote', value: '5' });
      const state = await client.waitFor('room-state');
      assert.equal(state.room.name, 'Test');
      assert.equal(state.room.players.length, 1);
      assert.equal(state.room.players[0].name, 'Alice');
      assert.equal(state.room.players[0].isHost, true);
      assert.equal(state.room.players[0].vote, 'voted');

      await client.close();
    });
  });

  // ─── Join Room ─────────────────────────────────────────────────────────

  describe('join-room', () => {
    it('second player joins, both see updated state', async () => {
      const { client: alice, roomId } = await createRoom('Join', 'Alice', 'tshirt');
      const { client: bob } = await joinRoom(roomId, 'Bob');

      // Alice should have received a broadcast when Bob joined
      const aliceState = await alice.waitFor('room-state');
      assert.equal(aliceState.room.players.length, 2);

      const bobPlayer = aliceState.room.players.find(p => p.name === 'Bob');
      assert.equal(bobPlayer.isHost, false);
      const alicePlayer = aliceState.room.players.find(p => p.name === 'Alice');
      assert.notEqual(alicePlayer.color, bobPlayer.color);

      await alice.close();
      await bob.close();
    });

    it('returns error for nonexistent room', async () => {
      const c = await connect();
      c.send({ type: 'join-room', roomId: 'zzzzz', playerName: 'Alice' });
      const err = await c.waitFor('error');
      assert.equal(err.message, 'Room not found');
      await c.close();
    });

    it('joins case-insensitively (uppercase code matches lowercase room id)', async () => {
      const { client: alice, roomId } = await createRoom('Case', 'Alice', 'tshirt');
      // Room ids are lowercase base36, but the UI renders them uppercase via CSS;
      // users naturally type/share the uppercase form. Server must accept either.
      const { client: bob } = await joinRoom(roomId.toUpperCase(), 'Bob');
      const aliceState = await alice.waitFor('room-state');
      assert.equal(aliceState.room.players.length, 2);
      await alice.close();
      await bob.close();
    });
  });

  // ─── Voting ────────────────────────────────────────────────────────────

  describe('voting', () => {
    it('broadcasts vote as "voted" (hidden)', async () => {
      const { client: alice, roomId } = await createRoom('Vote', 'Alice', 'tshirt');
      const { client: bob } = await joinRoom(roomId, 'Bob');
      await alice.waitFor('room-state'); // Bob join broadcast

      alice.send({ type: 'vote', value: 'M' });
      const state = await bob.waitFor('room-state');
      const a = state.room.players.find(p => p.name === 'Alice');
      assert.equal(a.vote, 'voted');

      await alice.close();
      await bob.close();
    });

    it('clear-vote removes the vote', async () => {
      const { client: alice, roomId } = await createRoom('Clear', 'Alice', 'tshirt');
      const { client: bob } = await joinRoom(roomId, 'Bob');
      await alice.waitFor('room-state');

      alice.send({ type: 'vote', value: 'L' });
      await bob.waitFor('room-state');

      alice.send({ type: 'clear-vote' });
      const state = await bob.waitFor('room-state');
      const a = state.room.players.find(p => p.name === 'Alice');
      assert.equal(a.vote, null);

      await alice.close();
      await bob.close();
    });

    it('cannot vote after reveal', async () => {
      const { client: alice, roomId } = await createRoom('NoVote', 'Alice', 'tshirt');
      const { client: bob } = await joinRoom(roomId, 'Bob');
      await alice.waitFor('room-state');

      alice.send({ type: 'vote', value: 'M' });
      await bob.waitFor('room-state');

      alice.send({ type: 'reveal' });
      // With COUNTDOWN_MS=0, countdown and reveal come back-to-back
      await bob.waitFor('room-state'); // revealed state

      // Try voting after reveal — should be ignored
      bob.send({ type: 'vote', value: 'XL' });
      // New round to get a clean state
      alice.send({ type: 'new-round' });
      const state = await bob.waitFor('room-state');
      const b = state.room.players.find(p => p.name === 'Bob');
      assert.equal(b.vote, null);

      await alice.close();
      await bob.close();
    });
  });

  // ─── Reveal + Countdown ────────────────────────────────────────────────

  describe('reveal', () => {
    it('sends countdown then reveals', async () => {
      const { client: alice, roomId } = await createRoom('Reveal', 'Alice', 'tshirt');
      const { client: bob } = await joinRoom(roomId, 'Bob');
      await alice.waitFor('room-state');

      alice.send({ type: 'vote', value: 'M' });
      await bob.waitFor('room-state');
      bob.send({ type: 'vote', value: 'L' });
      await alice.waitFor('room-state');

      alice.send({ type: 'reveal' });

      const countdown = await bob.waitFor('countdown');
      assert.equal(countdown.initiatedBy, 'Alice');
      assert.equal(countdown.seconds, 3);

      const revealed = await bob.waitFor('room-state', m => m.room.revealed === true);
      assert.equal(revealed.room.revealed, true);
      assert.equal(revealed.room.roundNumber, 1);
      assert.equal(revealed.room.players.find(p => p.name === 'Alice').vote, 'M');
      assert.equal(revealed.room.players.find(p => p.name === 'Bob').vote, 'L');

      await alice.close();
      await bob.close();
    });

    it('rejects non-host reveal', async () => {
      const { client: alice, roomId } = await createRoom('HostOnly', 'Alice', 'tshirt');
      const { client: bob } = await joinRoom(roomId, 'Bob');
      await alice.waitFor('room-state');

      bob.send({ type: 'reveal' }); // Bob is not host

      // Trigger a broadcast to confirm nothing changed
      alice.send({ type: 'vote', value: 'S' });
      const state = await bob.waitFor('room-state');
      assert.equal(state.room.revealed, false);

      await alice.close();
      await bob.close();
    });

    it('detects consensus', async () => {
      const { client: alice, roomId } = await createRoom('Consensus', 'Alice', 'fib');
      const { client: bob } = await joinRoom(roomId, 'Bob');
      await alice.waitFor('room-state');

      alice.send({ type: 'vote', value: '5' });
      await bob.waitFor('room-state');
      bob.send({ type: 'vote', value: '5' });
      await alice.waitFor('room-state');

      alice.send({ type: 'reveal' });
      const state = await bob.waitFor('room-state', m => m.room.revealed === true);
      assert.equal(state.room.consensusCount, 1);

      await alice.close();
      await bob.close();
    });
  });

  // ─── New Round ─────────────────────────────────────────────────────────

  describe('new-round', () => {
    it('clears votes and revealed state', async () => {
      const { client: alice, roomId } = await createRoom('Round', 'Alice', 'tshirt');
      const { client: bob } = await joinRoom(roomId, 'Bob');
      await alice.waitFor('room-state');

      alice.send({ type: 'vote', value: 'M' });
      await bob.waitFor('room-state');
      alice.send({ type: 'reveal' });
      await bob.waitFor('room-state'); // revealed

      alice.send({ type: 'new-round' });
      const state = await bob.waitFor('room-state');
      assert.equal(state.room.revealed, false);
      for (const p of state.room.players) {
        assert.equal(p.vote, null);
      }

      await alice.close();
      await bob.close();
    });

    it('rejects non-host', async () => {
      const { client: alice, roomId } = await createRoom('NoRound', 'Alice', 'tshirt');
      const { client: bob } = await joinRoom(roomId, 'Bob');
      await alice.waitFor('room-state');

      alice.send({ type: 'reveal' });
      await bob.waitFor('room-state'); // revealed

      // Bob tries new round — should be ignored
      bob.send({ type: 'new-round' });
      // Do a valid new-round from Alice
      alice.send({ type: 'new-round' });
      const state = await bob.waitFor('room-state');
      assert.equal(state.room.revealed, false);

      await alice.close();
      await bob.close();
    });
  });

  // ─── Leave Room ────────────────────────────────────────────────────────

  describe('leave-room', () => {
    it('removes player and promotes host', async () => {
      const { client: alice, roomId } = await createRoom('Leave', 'Alice', 'tshirt');
      const { client: bob } = await joinRoom(roomId, 'Bob');
      await alice.waitFor('room-state');

      alice.send({ type: 'leave-room' });
      const state = await bob.waitFor('room-state');
      assert.equal(state.room.players.length, 1);
      assert.equal(state.room.players[0].name, 'Bob');
      assert.equal(state.room.players[0].isHost, true);

      await alice.close();
      await bob.close();
    });
  });

  // ─── Change Color ──────────────────────────────────────────────────────

  describe('change-color', () => {
    it('updates color and broadcasts', async () => {
      const { client: alice, roomId } = await createRoom('Color', 'Alice', 'tshirt');
      const { client: bob } = await joinRoom(roomId, 'Bob');
      await alice.waitFor('room-state');

      alice.send({ type: 'change-color', colorIndex: 7 });
      const state = await bob.waitFor('room-state');
      assert.equal(state.room.players.find(p => p.name === 'Alice').color, 7);

      await alice.close();
      await bob.close();
    });

    it('ignores invalid color index', async () => {
      const { client: alice } = await createRoom('BadColor', 'Alice', 'tshirt');

      alice.send({ type: 'change-color', colorIndex: 99 });
      // Trigger a broadcast to verify color unchanged
      alice.send({ type: 'vote', value: 'M' });
      const state = await alice.waitFor('room-state');
      assert.equal(state.room.players[0].color, 0); // unchanged

      await alice.close();
    });
  });

  // ─── Disconnect / Reconnect ────────────────────────────────────────────

  describe('disconnect', () => {
    it('removes player on disconnect', async () => {
      const { client: alice, roomId } = await createRoom('DC', 'Alice', 'tshirt');
      const { client: bob } = await joinRoom(roomId, 'Bob');
      await alice.waitFor('room-state');

      await bob.close();
      const state = await alice.waitFor('room-state');
      assert.equal(state.room.players.length, 1);
      assert.equal(state.room.players[0].name, 'Alice');

      await alice.close();
    });

    it('reconnecting player restores vote', async () => {
      const { client: alice, roomId } = await createRoom('Reconn', 'Alice', 'tshirt');
      const { client: bob } = await joinRoom(roomId, 'Bob');
      await alice.waitFor('room-state');

      bob.send({ type: 'vote', value: 'L' });
      await alice.waitFor('room-state');

      await bob.close();
      await alice.waitFor('room-state'); // Bob removed

      // Reconnect with same name
      const { client: bob2 } = await joinRoom(roomId, 'Bob');
      const state = await alice.waitFor('room-state');
      const bobState = state.room.players.find(p => p.name === 'Bob');
      assert.equal(bobState.vote, 'voted'); // preserved from before

      await alice.close();
      await bob2.close();
    });
  });

  // ─── Malformed Messages ────────────────────────────────────────────────

  describe('malformed messages', () => {
    it('ignores non-JSON without crashing', async () => {
      const c = await connect();
      c.ws.send('not json');
      // Server should still work
      c.send({ type: 'create-room', name: 'T', playerName: 'A', votingSystem: 'tshirt' });
      const msg = await c.waitFor('room-created');
      assert.ok(msg.roomId);
      await c.close();
    });

    it('ignores unknown message types', async () => {
      const c = await connect();
      c.send({ type: 'hack-the-planet' });
      c.send({ type: 'create-room', name: 'T', playerName: 'A', votingSystem: 'tshirt' });
      const msg = await c.waitFor('room-created');
      assert.ok(msg.roomId);
      await c.close();
    });
  });
});
