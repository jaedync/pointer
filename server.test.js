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
        process.env.POINTER_STATE_FILE = ''; // no snapshot file from the shared server
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
  return { client: c, roomId: created.roomId, playerId: created.playerId, token: created.token };
}

// Helper: join a room and return { client, playerId, token }
async function joinRoom(roomId, playerName) {
  const c = await connect();
  c.send({ type: 'join-room', roomId, playerName });
  const joined = await c.waitFor('joined');
  await c.waitFor('room-state'); // drain initial broadcast
  return { client: c, playerId: joined.playerId, token: joined.token };
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
      // Per-client serialization: the broadcast Alice receives includes her
      // own actual vote value (not the 'voted' sentinel). Other clients in
      // the room would still see Alice's slot masked as 'voted' pre-reveal.
      assert.equal(state.room.players[0].vote, '5');
      assert.equal(state.room.players[0].voteSeq, 1);

      await client.close();
    });
  });

  // ─── Join Room ─────────────────────────────────────────────────────────

  describe('join-room', () => {
    it('refuses a join when the room is full, with a clear error', async () => {
      const { MAX_PLAYERS } = require('./room');
      const { client: host, roomId } = await createRoom('Full', 'Host', 'fib');
      const guests = [];
      for (let i = 1; i < MAX_PLAYERS; i++) guests.push((await joinRoom(roomId, `G${i}`)).client);
      const late = await connect();
      late.send({ type: 'join-room', roomId, playerName: 'Late' });
      const err = await late.waitFor('error');
      assert.match(err.message, /full/);
      for (const c of [host, late, ...guests]) await c.close();
    });

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

  describe('check-room', () => {
    it('reports exists:false for an unknown room id', async () => {
      const c = await connect();
      c.send({ type: 'check-room', roomId: 'zzzzz' });
      const res = await c.waitFor('room-check-result');
      assert.equal(res.roomId, 'zzzzz');
      assert.equal(res.exists, false);
      await c.close();
    });

    it('reports exists:true for a live room', async () => {
      const { client: alice, roomId } = await createRoom('Probe', 'Alice', 'tshirt');
      const probe = await connect();
      probe.send({ type: 'check-room', roomId });
      const res = await probe.waitFor('room-check-result');
      assert.equal(res.roomId, roomId);
      assert.equal(res.exists, true);
      await alice.close();
      await probe.close();
    });

    it('accepts uppercase room codes (mirrors join-room casing)', async () => {
      const { client: alice, roomId } = await createRoom('ProbeCase', 'Alice', 'tshirt');
      const probe = await connect();
      probe.send({ type: 'check-room', roomId: roomId.toUpperCase() });
      const res = await probe.waitFor('room-check-result');
      assert.equal(res.roomId, roomId); // server normalizes to lowercase
      assert.equal(res.exists, true);
      await alice.close();
      await probe.close();
    });

    it('does not create a room as a side effect of the probe', async () => {
      const c = await connect();
      c.send({ type: 'check-room', roomId: 'nope1' });
      await c.waitFor('room-check-result');
      // A second probe must still see exists:false. If the first probe
      // accidentally instantiated the room, this would flip to true.
      c.send({ type: 'check-room', roomId: 'nope1' });
      const res2 = await c.waitFor('room-check-result');
      assert.equal(res2.exists, false);
      await c.close();
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
      await bob.waitFor('room-state', m => m.room.revealed === true); // revealed state

      // Try voting after reveal — should be ignored
      bob.send({ type: 'vote', value: 'XL' });
      // New round to get a clean state
      alice.send({ type: 'new-round' });
      const state = await bob.waitFor('room-state', m => m.room.revealed === false && m.room.roundNumber === 1);
      const b = state.room.players.find(p => p.name === 'Bob');
      assert.equal(b.vote, null);

      await alice.close();
      await bob.close();
    });
  });

  // ─── Reveal + Countdown ────────────────────────────────────────────────

  describe('reveal', () => {
    it('announces a countdown via room-state, then reveals', async () => {
      const { client: alice, roomId } = await createRoom('Reveal', 'Alice', 'tshirt');
      const { client: bob } = await joinRoom(roomId, 'Bob');
      await alice.waitFor('room-state');

      alice.send({ type: 'vote', value: 'M' });
      await bob.waitFor('room-state');
      bob.send({ type: 'vote', value: 'L' });
      await alice.waitFor('room-state');

      alice.send({ type: 'reveal' });

      const counting = await bob.waitFor('room-state', m => m.room.countdownEndsAt != null);
      assert.equal(counting.room.countdownBy, 'Alice');
      assert.equal(counting.room.revealed, false);

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
      await bob.waitFor('room-state', m => m.room.revealed === true); // revealed

      alice.send({ type: 'new-round' });
      const state = await bob.waitFor('room-state', m => m.room.revealed === false && m.room.roundNumber === 1);
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
      await bob.waitFor('room-state', m => m.room.revealed === true); // revealed

      // Bob tries new round — should be ignored
      bob.send({ type: 'new-round' });
      // Do a valid new-round from Alice
      alice.send({ type: 'new-round' });
      const state = await bob.waitFor('room-state', m => m.room.revealed === false);
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
    it('keeps the seat of a disconnected player and marks it away', async () => {
      const { client: alice, roomId } = await createRoom('DC', 'Alice', 'tshirt');
      const { client: bob } = await joinRoom(roomId, 'Bob');
      await alice.waitFor('room-state');

      await bob.close();
      const state = await alice.waitFor('room-state');
      assert.equal(state.room.players.length, 2);
      assert.deepEqual(state.room.players.map(p => [p.name, p.away]), [['Alice', false], ['Bob', true]]);

      await alice.close();
    });

    it('the host keeps the role (and seat order) across a reload', async () => {
      const { client: alice, roomId, playerId: aliceId, token: aliceToken } = await createRoom('Reload', 'Alice', 'tshirt');
      const { client: bob } = await joinRoom(roomId, 'Bob');
      await alice.waitFor('room-state');

      await alice.close();
      const away = await bob.waitFor('room-state', m => m.room.players.some(p => p.away));
      assert.equal(away.room.players.find(p => p.isHost).name, 'Alice', 'no hand-off while the host is away');

      const alice2 = await connect();
      alice2.send({ type: 'join-room', roomId, playerName: 'Alice', playerId: aliceId, token: aliceToken });
      await alice2.waitFor('joined');
      const back = await bob.waitFor('room-state', m => m.room.players.every(p => !p.away));
      assert.deepEqual(back.room.players.map(p => [p.name, p.isHost]), [['Alice', true], ['Bob', false]]);
      await alice2.close();
      await bob.close();
    });

    it('a present player can claim host only while the host is away', async () => {
      const { client: alice, roomId } = await createRoom('Claim', 'Alice', 'tshirt');
      const { client: bob } = await joinRoom(roomId, 'Bob');
      await alice.waitFor('room-state');

      bob.send({ type: 'claim-host' });
      bob.send({ type: 'set-topic', topic: 'probe' }); // non-host: ignored, but flushes ordering
      await new Promise(r => setTimeout(r, 50));
      await alice.close();
      await bob.waitFor('room-state', m => m.room.players.some(p => p.away));
      bob.send({ type: 'claim-host' });
      const state = await bob.waitFor('room-state', m => m.room.players.find(p => p.name === 'Bob').isHost);
      assert.equal(state.room.players.filter(p => p.isHost).length, 1);
      await bob.close();
    });
  });

  describe('observer, topic, history', () => {
    it('an observer cannot vote and is excluded from consensus', async () => {
      const { client: alice, roomId } = await createRoom('Obs', 'Alice', 'fib');
      const c = await connect();
      c.send({ type: 'join-room', roomId, playerName: 'Olu', observer: true });
      await c.waitFor('joined');
      const st = await alice.waitFor('room-state', m => m.room.players.length === 2);
      assert.equal(st.room.players.find(p => p.name === 'Olu').observer, true);

      c.send({ type: 'vote', value: '8' });
      alice.send({ type: 'vote', value: '5' });
      await alice.waitFor('room-state', m => m.room.players.find(p => p.name === 'Alice').vote === '5');
      alice.send({ type: 'reveal' });
      const rev = await alice.waitFor('room-state', m => m.room.revealed);
      assert.equal(rev.room.players.find(p => p.name === 'Olu').vote, null);
      assert.equal(rev.room.history[0].voters, 1);
      await alice.close();
      await c.close();
    });

    it('host sets the topic; it is stored in history and cleared by a new round', async () => {
      const { client: alice } = await createRoom('Topic', 'Alice', 'fib');
      alice.send({ type: 'set-topic', topic: '  Login   page  ' });
      const t = await alice.waitFor('room-state', m => m.room.topic);
      assert.equal(t.room.topic, 'Login page');
      alice.send({ type: 'vote', value: '3' });
      alice.send({ type: 'reveal' });
      const rev = await alice.waitFor('room-state', m => m.room.revealed);
      assert.equal(rev.room.history[0].topic, 'Login page');
      assert.deepEqual(rev.room.history[0].counts, [{ value: '3', n: 1 }]);
      alice.send({ type: 'new-round' });
      const nr = await alice.waitFor('room-state', m => !m.room.revealed && m.room.history.length === 1);
      assert.equal(nr.room.topic, '');
      assert.equal(nr.room.history.length, 1);
      await alice.close();
    });

    it('reconnecting player (with token) restores vote, seen as "voted" by others', async () => {
      const { client: alice, roomId } = await createRoom('Reconn', 'Alice', 'tshirt');
      const { client: bob, playerId: bobId, token: bobToken } = await joinRoom(roomId, 'Bob');
      await alice.waitFor('room-state');

      bob.send({ type: 'vote', value: 'L' });
      await alice.waitFor('room-state');

      await bob.close();
      await alice.waitFor('room-state'); // Bob parked

      // Reconnect with the stable id + secret token.
      const bob2 = await connect();
      bob2.send({ type: 'join-room', roomId, playerName: 'Bob', playerId: bobId, token: bobToken });
      await bob2.waitFor('joined');
      const state = await alice.waitFor('room-state', m => m.room.players.some(p => p.id === bobId));
      const bobState = state.room.players.find(p => p.id === bobId);
      assert.equal(bobState.vote, 'voted'); // preserved from before, masked to Alice

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

    it('survives a frame that parses to a non-object (null / number / string)', async () => {
      const c = await connect();
      // JSON.parse('null') succeeds and returns null; the old code then read
      // msg.type off null and crashed the whole process.
      c.ws.send('null');
      c.ws.send('42');
      c.ws.send('"hello"');
      c.ws.send('[1,2,3]');
      c.ws.send(JSON.stringify({ noTypeField: true }));
      // Server must still be alive and serving.
      c.send({ type: 'create-room', name: 'T', playerName: 'A', votingSystem: 'tshirt' });
      const msg = await c.waitFor('room-created');
      assert.ok(msg.roomId);
      await c.close();
    });
  });

  // ─── Security / robustness hardening (pre-push audit) ──────────────────────

  describe('static file serving', () => {
    it('serves a cache-busted asset (?v=) with its real type', async () => {
      const res = await fetch(`${baseUrl}/render.js?v=2`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /javascript/);
      assert.match(await res.text(), /computeRoundStats/);
    });

    it('serves the Open Graph image', async () => {
      const res = await fetch(`${baseUrl}/og.png`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/png');
    });

    it('does not serve files outside public/ via path traversal', async () => {
      // Raw socket so the literal "/../server.js" target reaches the server
      // un-normalized (fetch/browsers would collapse the .. client-side).
      const net = require('net');
      const body = await new Promise((resolve, reject) => {
        const sock = net.connect(port, 'localhost', () => {
          sock.write('GET /../server.js HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
        });
        let buf = '';
        sock.on('data', d => { buf += d.toString(); });
        sock.on('end', () => resolve(buf));
        sock.on('error', reject);
      });
      const statusLine = body.split('\r\n')[0];
      assert.ok(!statusLine.includes('200'), `expected non-200, got: ${statusLine}`);
      assert.ok(!body.includes('WebSocketServer'), 'server source must not leak');
    });

    it('rejects a NUL byte in the path (fs would throw synchronously)', async () => {
      const { resolveStaticPath } = require('./server');
      assert.equal(resolveStaticPath('/%00.js'), null);
      const res = await fetch(`${baseUrl}/%00.js`);
      assert.equal(res.status, 403);
      assert.equal((await fetch(`${baseUrl}/render.js`)).status, 200, 'server still up');
    });

    it('resolveStaticPath returns null on malformed percent-encoding (no throw → no crash)', () => {
      const { resolveStaticPath } = require('./server');
      assert.equal(typeof resolveStaticPath, 'function');
      // decodeURIComponent throws URIError on these; the handler must not crash.
      for (const bad of ['/%E0%A4%A.js', '/%.css', '/%ZZ.woff2', '/%c0%af.png']) {
        let val;
        assert.doesNotThrow(() => { val = resolveStaticPath(bad); }, `threw on ${bad}`);
        // Either contained-null (escape/garbage) — never an uncaught throw.
        assert.ok(val === null || typeof val === 'string');
      }
    });

    it('survives a live request with a malformed-percent static path', async () => {
      const net = require('net');
      const status = await new Promise((resolve, reject) => {
        const sock = net.connect(port, 'localhost', () => {
          sock.write('GET /%E0%A4%A.js HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
        });
        let buf = '';
        sock.on('data', d => { buf += d.toString(); });
        sock.on('end', () => resolve(buf.split('\r\n')[0]));
        sock.on('error', reject);
      });
      assert.ok(/40[34]/.test(status), `expected 403/404, got: ${status}`);
      // Server still alive afterwards.
      const res = await fetch(`${baseUrl}/`);
      assert.equal(res.status, 200);
    });

    it('sets hardening + cache headers on a static asset', async () => {
      const res = await fetch(`${baseUrl}/render.js`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.ok(res.headers.get('content-security-policy'), 'CSP header present');
      assert.ok(/max-age=\d+/.test(res.headers.get('cache-control') || ''), 'cache-control present');
    });

    it('serves the HTML shell with an ETag and a paint-from-cache policy (no white-flash re-download)', async () => {
      const res = await fetch(baseUrl);
      assert.equal(res.status, 200);
      const cc = res.headers.get('cache-control') || '';
      // Must allow instant paint from cache + background revalidation, not a
      // blocking full re-download on every load.
      assert.match(cc, /stale-while-revalidate/, `shell cache-control was: ${cc}`);
      assert.ok(res.headers.get('etag'), 'shell must send an ETag validator');
    });

    it('returns 304 (tiny) for a conditional GET with a matching If-None-Match', async () => {
      const first = await fetch(`${baseUrl}/render.js`);
      const etag = first.headers.get('etag');
      assert.ok(etag, 'asset must send an ETag');
      const second = await fetch(`${baseUrl}/render.js`, { headers: { 'If-None-Match': etag } });
      assert.equal(second.status, 304, 'matching ETag should revalidate to 304');
      assert.equal((await second.text()).length, 0, '304 must have an empty body');
    });

    it('enforces the 64KB frame cap by closing the offending socket, server survives', async () => {
      const c = await connect();
      const closed = new Promise(res => c.ws.on('close', (code) => res(code)));
      const huge = 'x'.repeat(300 * 1024); // > maxPayload (64KB)
      try { c.ws.send(JSON.stringify({ type: 'create-room', name: huge, playerName: 'A' })); } catch {}
      // ws closes an over-limit connection with 1009 (message too big).
      const code = await Promise.race([closed, new Promise(r => setTimeout(() => r('timeout'), 2000))]);
      assert.equal(code, 1009, `expected close code 1009, got ${code}`);
      // A second client must still be able to use the server.
      const c2 = await connect();
      c2.send({ type: 'create-room', name: 'T', playerName: 'A', votingSystem: 'tshirt' });
      const msg = await c2.waitFor('room-created');
      assert.ok(msg.roomId);
      await c2.close();
    });
  });

  describe('reveal countdown (room-state carried)', () => {
    it('broadcasts countdownEndsAt before the reveal lands', async () => {
      const { client: alice, roomId } = await createRoom('CD', 'Alice', 'tshirt');
      alice.send({ type: 'vote', value: 'M' });
      await alice.waitFor('room-state');
      alice.send({ type: 'reveal' });
      const counting = await alice.waitFor('room-state', m => m.room.countdownEndsAt != null);
      assert.equal(counting.room.revealed, false);
      assert.equal(typeof counting.room.countdownEndsAt, 'number');
      assert.equal(counting.room.countdownBy, 'Alice');
      const revealed = await alice.waitFor('room-state', m => m.room.revealed === true);
      assert.equal(revealed.room.countdownEndsAt, null);
      await alice.close();
    });
  });

  describe('reconnection identity (token-based)', () => {
    it('create-room and join-room hand back a reconnect token', async () => {
      const { client: alice, roomId, token: aliceToken } = await createRoom('Tok', 'Alice', 'tshirt');
      assert.equal(typeof aliceToken, 'string');
      const { client: bob, token: bobToken } = await joinRoom(roomId, 'Bob');
      assert.equal(typeof bobToken, 'string');
      assert.notEqual(aliceToken, bobToken);
      await alice.close();
      await bob.close();
    });

    it('a same-named joiner WITHOUT the token does not adopt the disconnected player', async () => {
      const { client: alice, roomId } = await createRoom('Hijack', 'Alice', 'tshirt');
      const { client: bob, playerId: bobId } = await joinRoom(roomId, 'Bob');
      await alice.waitFor('room-state');
      alice.send({ type: 'vote', value: 'L' });
      await bob.waitFor('room-state');

      await alice.close(); // Alice (host) drops; her seat stays, away
      await bob.waitFor('room-state');

      // A stranger shows up claiming the name "Alice" but with no token.
      const stranger = await connect();
      stranger.send({ type: 'join-room', roomId, playerName: 'Alice' });
      const joined = await stranger.waitFor('joined');
      const state = await stranger.waitFor('room-state');
      const me = state.room.players.find(p => p.id === joined.playerId);
      assert.equal(me.isHost, false, 'stranger must NOT inherit host');
      assert.equal(me.vote, null, 'stranger must NOT inherit the vote');
      const hosts = state.room.players.filter(p => p.isHost);
      assert.equal(hosts.length, 1, 'exactly one host');
      assert.equal(hosts[0].id === joined.playerId, false, 'stranger is not the host');
      await bob.close();
      await stranger.close();
    });

    it('reconnecting with the correct playerId+token restores identity and vote', async () => {
      const { client: alice, roomId } = await createRoom('Reconn', 'Alice', 'tshirt');
      const { client: bob, playerId: bobId, token: bobToken } = await joinRoom(roomId, 'Bob');
      await alice.waitFor('room-state');
      bob.send({ type: 'vote', value: 'L' });
      await alice.waitFor('room-state');

      await bob.close();
      await alice.waitFor('room-state'); // Bob parked

      const bob2 = await connect();
      bob2.send({ type: 'join-room', roomId, playerName: 'Bob', playerId: bobId, token: bobToken });
      const joined = await bob2.waitFor('joined');
      assert.equal(joined.playerId, bobId, 'same stable id on reconnect');
      const state = await bob2.waitFor('room-state', m => m.room.players.some(p => p.id === bobId));
      const bobP = state.room.players.find(p => p.id === bobId);
      assert.equal(bobP.vote, 'L'); // own vote restored to self
      await alice.close();
      await bob2.close();
    });

    it('the original host reconnecting after a claim does not create a second host', async () => {
      const { client: alice, roomId, playerId: aliceId, token: aliceToken } = await createRoom('TwoHost', 'Alice', 'tshirt');
      const { client: bob } = await joinRoom(roomId, 'Bob');
      await alice.waitFor('room-state');

      await alice.close(); // host drops → away; Bob claims the role
      await bob.waitFor('room-state', m => m.room.players.some(p => p.away));
      bob.send({ type: 'claim-host' });
      await bob.waitFor('room-state', m => m.room.players.find(p => p.name === 'Bob').isHost);

      const alice2 = await connect();
      alice2.send({ type: 'join-room', roomId, playerName: 'Alice', playerId: aliceId, token: aliceToken });
      await alice2.waitFor('joined');
      const state = await alice2.waitFor('room-state', m => m.room.players.every(p => !p.away));
      const hosts = state.room.players.filter(p => p.isHost);
      assert.equal(hosts.length, 1, 'exactly one host after host reconnect');
      assert.equal(hosts[0].name, 'Bob', 'claimed host keeps the role');
      await bob.close();
      await alice2.close();
    });

    it('fast reconnect (old socket still open) reclaims the seat, no duplicate', async () => {
      // Reload race: the new socket's join-room can arrive BEFORE the old
      // socket's close event parks the player. The reconnect must take over the
      // existing seat instead of adding a second one.
      const { client: alice, roomId } = await createRoom('Fast', 'Alice', 'tshirt');
      const { client: bob, playerId: bobId, token: bobToken } = await joinRoom(roomId, 'Bob');
      await alice.waitFor('room-state');

      // bob is still connected; bob2 reconnects with the same id+token.
      const bob2 = await connect();
      bob2.send({ type: 'join-room', roomId, playerName: 'Bob', playerId: bobId, token: bobToken });
      const joined = await bob2.waitFor('joined');
      assert.equal(joined.playerId, bobId, 'same stable id (took over the seat)');

      const state = await alice.waitFor('room-state', m => m.room.players.filter(p => p.name === 'Bob').length >= 1);
      assert.equal(state.room.players.length, 2, 'no duplicate seat — still Alice + Bob');
      assert.equal(state.room.players.filter(p => p.id === bobId).length, 1);

      // The superseded old socket closing must NOT tear down the live seat.
      await bob.close();
      await new Promise(r => setTimeout(r, 50));
      bob2.send({ type: 'vote', value: 'M' });
      const after = await alice.waitFor('room-state', m => m.room.players.some(p => p.id === bobId && p.vote === 'voted'));
      assert.equal(after.room.players.length, 2, 'seat survives the old socket closing');

      await alice.close();
      await bob2.close();
    });

    it('a superseded socket cannot mutate the live seat (leave-room from old socket is ignored)', async () => {
      const { client: alice, roomId } = await createRoom('Supersede', 'Alice', 'tshirt');
      const { client: bob, playerId: bobId, token: bobToken } = await joinRoom(roomId, 'Bob');
      await alice.waitFor('room-state');

      // bob2 takes over bob's seat; the OLD bob socket then flushes a leave-room
      // in the takeover window. That message must NOT delete the reconnected seat.
      const bob2 = await connect();
      bob2.send({ type: 'join-room', roomId, playerName: 'Bob', playerId: bobId, token: bobToken });
      bob.send({ type: 'leave-room' });
      await bob2.waitFor('joined');
      await new Promise(r => setTimeout(r, 100));

      // bob2's seat must still be live: its vote registers and others see it.
      bob2.send({ type: 'vote', value: 'M' });
      const state = await alice.waitFor('room-state', m => m.room.players.some(p => p.id === bobId && p.vote === 'voted'));
      assert.ok(state.room.players.some(p => p.id === bobId), 'reconnected seat survives a superseded leave-room');
      assert.equal(state.room.players.length, 2);

      await alice.close();
      await bob2.close();
    });
  });
});
