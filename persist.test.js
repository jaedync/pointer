const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const room = require('./room');
const { snapshotRooms, restoreRooms, saveSnapshot, loadSnapshot } = require('./persist');

// Test files stay in the project's git-ignored .tmp folder, not the shared system /tmp.
const TMP_ROOT = path.join(__dirname, '.tmp');
const tempDirs = [];
function tempDir() {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'persist-'));
  tempDirs.push(dir);
  return dir;
}
// Also runs after a failed test, which never reaches its own rmSync.
afterEach(() => { for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function sampleRooms() {
  const r = room.createRoom('Sprint', 'fib', 'abcde');
  const a = room.addPlayer(r, 'Alice', null);
  const b = room.addPlayer(r, 'Bob', null);
  room.vote(r, a.playerId, '5');
  room.setTopic(r, a.playerId, 'Login');
  room.setObserver(r, b.playerId, true);
  return { rooms: new Map([[r.id, r]]), r, a, b };
}

describe('snapshot round trip', () => {
  it('restores seats as away with token, vote, host, order and topic', () => {
    const { rooms, a, b } = sampleRooms();
    const back = restoreRooms(JSON.parse(JSON.stringify(snapshotRooms(rooms))));
    const r = back.get('abcde');
    assert.deepEqual([...r.players.keys()], [a.playerId, b.playerId]);
    const alice = r.players.get(a.playerId);
    assert.equal(alice.token, a.token);
    assert.equal(alice.vote, '5');
    assert.equal(alice.isHost, true);
    assert.equal(alice.away, true);
    assert.equal(r.players.get(b.playerId).observer, true);
    assert.equal(r.topic, 'Login');
  });

  it('drops invalid votes and colors, and forces one host', () => {
    const { rooms } = sampleRooms();
    const snap = snapshotRooms(rooms);
    snap.rooms[0].players.forEach(p => { p.isHost = true; p.vote = '<img>'; p.color = 99; });
    const r = restoreRooms(snap).get('abcde');
    const ps = [...r.players.values()];
    assert.equal(ps.filter(p => p.isHost).length, 1);
    assert.ok(ps.every(p => p.vote === null && p.color === 0));
  });

  it('finishes a countdown that was running at shutdown', () => {
    const { rooms } = sampleRooms();
    const snap = snapshotRooms(rooms);
    snap.rooms[0].countdownEndsAt = Date.now() + 1000;
    const r = restoreRooms(snap).get('abcde');
    assert.equal(r.revealed, true);
    assert.equal(r.history.length, 1);
  });

  it('ignores garbage and other versions', () => {
    assert.equal(restoreRooms(null).size, 0);
    assert.equal(restoreRooms({ version: 99, rooms: [] }).size, 0);
    assert.equal(restoreRooms({ version: 1, rooms: [{ id: '../x', players: [] }, 7] }).size, 0);
  });

  it('drops invalid history records and keeps valid ones', () => {
    const { rooms, r } = sampleRooms();
    room.applyReveal(r);
    const snap = JSON.parse(JSON.stringify(snapshotRooms(rooms)));
    const good = snap.rooms[0].history[0];
    snap.rooms[0].history = [null, 7, { ...good, values: 'x' }, { ...good, state: '<b>' }, good,
      { ...good, counts: [null, { value: '999', n: 1 }, { value: '5', n: 1 }] }];
    const back = restoreRooms(snap).get('abcde');
    assert.equal(back.history.length, 3);
    assert.deepEqual(back.history[0], good);
    assert.deepEqual(back.history[1].values, []);
    assert.deepEqual(back.history[2].counts, [{ value: '5', n: 1 }]);
  });

  it('one bad room does not discard the other rooms', () => {
    const { rooms } = sampleRooms();
    const snap = JSON.parse(JSON.stringify(snapshotRooms(rooms)));
    const bad = { ...snap.rooms[0], id: 'zzzzz', votingSystemKey: { toString: 1 } };
    const worse = { ...snap.rooms[0], id: 'yyyyy', players: [{ id: 'p', token: 'x'.repeat(5000) }] };
    snap.rooms = [bad, worse, snap.rooms[0]];
    const report = {};
    const back = restoreRooms(snap, report);
    assert.ok(back.has('abcde'));
    assert.equal(back.get('zzzzz').votingSystemKey, 'tshirt');
    assert.ok(!back.has('yyyyy'), 'a room whose only player has an oversized token is dropped');
    // zzzzz falls back to the tshirt deck, so its fib vote '5' is dropped (1);
    // yyyyy loses its only player (1) and then the empty room (1).
    assert.equal(report.rejected, 3);
  });

  it('keeps a copy of a rejected or oversized snapshot instead of overwriting it', () => {
    const dir = tempDir();
    const file = path.join(dir, 'rooms.json');
    fs.writeFileSync(file, '{not json');
    assert.equal(loadSnapshot(file).size, 0);
    assert.equal(fs.readFileSync(`${file}.rejected`, 'utf8'), '{not json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, rooms: [], pad: 'x'.repeat(4096) }));
    assert.equal(loadSnapshot(file, 1024).size, 0);
    assert.ok(fs.statSync(`${file}.rejected`).size > 4096);
    fs.rmSync(dir, { recursive: true });
  });

  it('any dropped data inside a kept room also keeps a copy; a clean file does not', () => {
    const dir = tempDir();
    const file = path.join(dir, 'rooms.json');
    const { rooms, r } = sampleRooms();
    room.applyReveal(r);
    const clean = JSON.parse(JSON.stringify(snapshotRooms(rooms)));
    const cases = {
      'bad history record': s => { s.rooms[0].history.push(null); },
      'bad value in a history record': s => { s.rooms[0].history[0].values.push('999'); },
      'one bad player': s => { s.rooms[0].players.push({ id: 'p9', token: 7 }); },
      'vote outside the deck': s => { s.rooms[0].players[0].vote = 'XL'; },
      'rooms is not a list': s => { s.rooms = 'broken'; },
    };
    for (const [name, damage] of Object.entries(cases)) {
      fs.rmSync(`${file}.rejected`, { force: true });
      const snap = JSON.parse(JSON.stringify(clean));
      damage(snap);
      fs.writeFileSync(file, JSON.stringify(snap));
      loadSnapshot(file);
      assert.ok(fs.existsSync(`${file}.rejected`), name);
    }
    for (const ok of [clean, { version: 1, rooms: [] }, { version: 1, rooms: [{ id: 'empty', players: [] }] }]) {
      fs.rmSync(`${file}.rejected`, { force: true });
      fs.writeFileSync(file, JSON.stringify(ok));
      loadSnapshot(file);
      assert.ok(!fs.existsSync(`${file}.rejected`), 'a clean file makes no copy');
    }
    fs.rmSync(dir, { recursive: true });
  });

  it('a full room round-trips without loss', () => {
    const r = room.createRoom('Big', 'fib', 'bigrm');
    for (let i = 0; i < room.MAX_PLAYERS; i++) room.addPlayer(r, `P${i}`, null);
    assert.equal(room.addPlayer(r, 'One too many', null), null);
    const report = {};
    const back = restoreRooms(JSON.parse(JSON.stringify(snapshotRooms(new Map([[r.id, r]])))), report);
    assert.equal(back.get('bigrm').players.size, room.MAX_PLAYERS);
    assert.equal(report.rejected, 0);
  });

  it('does not write a snapshot over the load limit; the previous file stays', () => {
    const dir = tempDir();
    const file = path.join(dir, 'rooms.json');
    saveSnapshot(file, sampleRooms().rooms);
    const before = fs.readFileSync(file, 'utf8');
    saveSnapshot(file, sampleRooms().rooms, 10);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    fs.rmSync(dir, { recursive: true });
  });

  it('save + load through a file, owner-only permissions', () => {
    const dir = tempDir();
    const file = path.join(dir, 'sub', 'rooms.json');
    saveSnapshot(file, sampleRooms().rooms);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(loadSnapshot(file).size, 1);
    fs.writeFileSync(file, '{not json');
    assert.equal(loadSnapshot(file).size, 0);
    assert.equal(loadSnapshot(path.join(dir, 'missing.json')).size, 0);
    fs.rmSync(dir, { recursive: true });
  });
});

// End to end: a real server process is stopped with SIGTERM (as Docker does on
// redeploy) and started again; the client reclaims its seat with its token.
describe('restart keeps rooms', () => {
  function startProc(port, file) {
    const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      env: { ...process.env, PORT: String(port), POINTER_STATE_FILE: file, COUNTDOWN_MS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return new Promise((resolve, reject) => {
      proc.stdout.on('data', d => { if (String(d).includes('running')) resolve(proc); });
      proc.on('error', reject);
    });
  }
  function client(port) {
    return new Promise(resolve => {
      const ws = new WebSocket(`ws://localhost:${port}`);
      const msgs = [];
      ws.on('message', d => msgs.push(JSON.parse(d)));
      ws.wait = (pred) => new Promise((res, rej) => {
        const t0 = Date.now();
        (function poll() {
          const m = msgs.find(pred);
          if (m) return res(m);
          if (Date.now() - t0 > 4000) return rej(new Error('timeout'));
          setTimeout(poll, 10);
        })();
      });
      ws.on('open', () => resolve(ws));
    });
  }

  it('survives SIGTERM + restart with seat, vote and host intact', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'rooms.json');
    const port = 40000 + Math.floor(Math.random() * 20000);
    let proc = await startProc(port, file);
    const ws = await client(port);
    ws.send(JSON.stringify({ type: 'create-room', name: 'Keep', playerName: 'Alice', votingSystem: 'fib' }));
    const created = await ws.wait(m => m.type === 'room-created');
    ws.send(JSON.stringify({ type: 'vote', value: '8' }));
    await ws.wait(m => m.type === 'room-state' && m.room.players[0].vote === '8');

    const exited = new Promise(r => proc.on('exit', r));
    proc.kill('SIGTERM');
    assert.equal(await exited, 0);
    ws.terminate();

    proc = await startProc(port, file);
    const ws2 = await client(port);
    ws2.send(JSON.stringify({ type: 'join-room', roomId: created.roomId, playerName: 'Alice', playerId: created.playerId, token: created.token }));
    const joined = await ws2.wait(m => m.type === 'joined');
    assert.equal(joined.playerId, created.playerId);
    const st = await ws2.wait(m => m.type === 'room-state');
    assert.equal(st.room.players.length, 1);
    assert.equal(st.room.players[0].vote, '8');
    assert.equal(st.room.players[0].isHost, true);
    assert.equal(st.room.players[0].away, false);
    ws2.terminate();
    proc.kill('SIGTERM');
    await new Promise(r => proc.on('exit', r));
    fs.rmSync(dir, { recursive: true });
  });
});
