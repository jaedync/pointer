const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const room = require('./room');
const persist = require('./persist');

const PORT = process.env.PORT || 3000;
const ROOM_TIMEOUT_MS = 30 * 60 * 1000;
const RECONNECT_WINDOW_MS = 60 * 1000;
const COUNTDOWN_MS = parseInt(process.env.COUNTDOWN_MS || '3000', 10);
// After a restart, every restored player is away until their client
// reconnects. Give them longer than a normal blip: laptops sleep, deploys take
// a moment, and the client backs off between retries.
const RESTORE_GRACE_MS = parseInt(process.env.RESTORE_GRACE_MS || String(10 * 60 * 1000), 10);
// Empty string disables persistence (tests).
const STATE_FILE = process.env.POINTER_STATE_FILE !== undefined
  ? process.env.POINTER_STATE_FILE
  : path.join(__dirname, 'data', 'rooms.json');
const SAVE_DEBOUNCE_MS = 1000;

// ─── HTTP ────────────────────────────────────────────────────────────────────
const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

const PUBLIC_DIR = path.join(__dirname, 'public');

// Response headers applied to every served file. The CSP allows inline
// style/script because the app ships a single inline <style>/<script>; it still
// blocks framing, object embeds, and off-origin connects (other than the WS).
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

// Resolve a request path to a file inside PUBLIC_DIR. Returns null if the
// normalized path escapes PUBLIC_DIR (path-traversal attempt). Node does NOT
// strip '..' from a raw request target, so this containment check is required.
function resolveStaticPath(reqUrl) {
  const reqPath = reqUrl.split('?')[0];
  let decoded;
  // decodeURIComponent throws URIError on malformed escapes (e.g. '/%E0%A4%A').
  // Treat any malformed path as not-resolvable rather than letting the throw
  // escape the request handler and crash the process.
  try { decoded = decodeURIComponent(reqPath); } catch { return null; }
  // fs.readFile throws synchronously on a NUL byte, outside its callback.
  if (decoded.includes('\0')) return null;
  const full = path.normalize(path.join(PUBLIC_DIR, decoded));
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) return null;
  return full;
}

const server = http.createServer((req, res) => {
  // Ignore the query string: '/render.js?v=2' (cache-busting) is still a .js file.
  const ext = path.extname(req.url.split('?')[0]);
  const isStatic = ext && MIME_TYPES[ext];

  let filePath;
  if (isStatic) {
    filePath = resolveStaticPath(req.url);
    if (!filePath) {
      res.writeHead(403, SECURITY_HEADERS);
      res.end('Forbidden');
      return;
    }
  } else {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }
  const contentType = MIME_TYPES[ext] || 'text/html';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (isStatic) {
        res.writeHead(404, SECURITY_HEADERS);
        res.end('Not Found');
        return;
      }
      res.writeHead(500, SECURITY_HEADERS);
      res.end('Internal Server Error');
      return;
    }
    const isShell = !isStatic || path.basename(filePath) === 'index.html';
    // Shell: paint instantly from cache and revalidate in the BACKGROUND
    // (stale-while-revalidate) so a reload never blanks white waiting on the
    // network — yet the next load still picks up a deploy. Earlier `no-cache`
    // had no validator, forcing a full HTML re-download (white) on every load.
    // Other assets aren't fingerprinted, so cache them modestly (1h).
    const cacheControl = isShell
      ? 'max-age=0, stale-while-revalidate=86400'
      : 'public, max-age=3600';
    // Weak ETag from the content so conditional GETs revalidate cheaply (304).
    const etag = 'W/"' + crypto.createHash('sha1').update(data).digest('base64').replace(/=+$/, '').slice(0, 20) + '"';
    const baseHeaders = { ...SECURITY_HEADERS, 'Cache-Control': cacheControl, 'ETag': etag };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, baseHeaders);
      res.end();
      return;
    }
    res.writeHead(200, { ...baseHeaders, 'Content-Type': contentType });
    res.end(data);
  });
});

// ─── WebSocket ───────────────────────────────────────────────────────────────
// maxPayload bounds a single frame; these messages are tiny, so 64 KB is ample
// and stops a client from forcing a multi-MB buffer allocation.
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
const rooms = persist.loadSnapshot(STATE_FILE);

let saveTimer = null;
function scheduleSave() {
  if (!STATE_FILE || saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; persist.saveSnapshot(STATE_FILE, rooms); }, SAVE_DEBOUNCE_MS);
  saveTimer.unref();
}

function deleteRoom(r) {
  room.cancelCountdown(r);
  for (const entry of r.disconnected.values()) clearTimeout(entry.timeout);
  r.disconnected.clear();
  rooms.delete(r.id);
  scheduleSave();
}

// Start (or restart) the reconnect window of an away seat. When it ends the
// seat is removed; that is the only automatic host hand-off.
function parkPlayer(r, pid, ms) {
  const existing = r.disconnected.get(pid);
  if (existing) clearTimeout(existing.timeout);
  const player = r.players.get(pid);
  if (!player) return;
  const timeout = setTimeout(() => {
    r.disconnected.delete(pid);
    const p = r.players.get(pid);
    if (!p || !p.away) return;
    room.removePlayer(r, pid);
    if (r.players.size === 0) deleteRoom(r);
    else broadcastRoom(r);
  }, ms);
  r.disconnected.set(pid, { player, timeout });
}

for (const r of rooms.values()) {
  for (const pid of r.players.keys()) parkPlayer(r, pid, RESTORE_GRACE_MS);
}
if (rooms.size > 0) console.log(`[persist] restored ${rooms.size} room(s) from ${STATE_FILE}`);

function broadcastRoom(r) {
  // Per-recipient serialization: each player's payload reveals THEIR OWN vote
  // value pre-reveal (so the client can sync state.myVote across reloads or
  // out-of-order events). Other players' votes stay masked with 'voted'.
  // serverTime lets each client compute its clock offset and render the
  // countdown (a server-stamped absolute end time) immune to clock skew.
  scheduleSave();
  const serverTime = Date.now();
  for (const [pid, p] of r.players) {
    if (!p.ws || p.ws.readyState !== 1) continue;
    const payload = JSON.stringify({ type: 'room-state', room: room.serializeRoomFor(r, pid), serverTime });
    p.ws.send(payload);
  }
}

wss.on('connection', (ws) => {
  let currentRoom = null;
  let currentPlayerId = null;

  // This socket still owns its seat only if the seat's ws is still us. After a
  // fast-reconnect takeover the seat's ws points at the NEW socket, so any
  // seat-mutating message from this (superseded) socket must be ignored —
  // otherwise a late leave-room/vote from the old socket clobbers the live seat.
  function ownsSeat() {
    if (!currentRoom || !currentPlayerId) return false;
    // The room may have been deleted and restored (or GC'd) since this socket
    // joined; a stale room object must not accept changes.
    if (rooms.get(currentRoom.id) !== currentRoom) return false;
    const p = currentRoom.players.get(currentPlayerId);
    return !!p && p.ws === ws;
  }

  // A socket-level error (oversized frame past maxPayload, abrupt reset) emits
  // 'error'; without a handler ws rethrows it as an uncaughtException that would
  // take down the whole process. Swallow it — the 'close' handler cleans up.
  ws.on('error', () => {});

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    // JSON.parse('null'), '42', '"x"', '[...]' all succeed but aren't messages.
    // Guard before touching msg.type, which previously crashed the process.
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'create-room': {
        const id = room.generateUniqueId(x => rooms.has(x));
        const r = room.createRoom(msg.name, msg.votingSystem, id);
        rooms.set(r.id, r);
        const { playerId, token } = room.addPlayer(r, msg.playerName, ws);
        if (msg.observer === true) room.setObserver(r, playerId, true);
        currentRoom = r;
        currentPlayerId = playerId;
        ws.send(JSON.stringify({ type: 'room-created', roomId: r.id, playerId, token }));
        broadcastRoom(r);
        break;
      }

      case 'check-room': {
        // Existence probe used by the client before showing the name-entry
        // modal. Lets a stale URL surface the "room expired" modal immediately
        // instead of after the user types a name and submits.
        const roomId = typeof msg.roomId === 'string' ? msg.roomId.toLowerCase() : msg.roomId;
        ws.send(JSON.stringify({
          type: 'room-check-result',
          roomId,
          exists: rooms.has(roomId),
        }));
        break;
      }

      case 'join-room': {
        // Room ids are stored lowercase (base36 from Math.random); the UI renders
        // them uppercase via CSS, so accept either casing from clients.
        const roomId = typeof msg.roomId === 'string' ? msg.roomId.toLowerCase() : msg.roomId;
        const r = rooms.get(roomId);
        if (!r) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
          return;
        }
        r.lastActivity = Date.now();

        // Reconnection requires BOTH the stable playerId and the matching secret
        // token. Name alone is not enough — otherwise any same-named joiner could
        // adopt a disconnected player's host role and vote. The seat may be away
        // (normal reconnect) or still live (fast reconnect: the new socket beat
        // the old socket's 'close'); either way, take it over. The seat keeps
        // its place, vote and host role, unless someone claimed host meanwhile.
        const seat = msg.playerId ? r.players.get(msg.playerId) : null;
        if (seat && seat.token && msg.token === seat.token) {
          const parked = r.disconnected.get(msg.playerId);
          if (parked) { clearTimeout(parked.timeout); r.disconnected.delete(msg.playerId); }
          const oldWs = seat.ws;
          room.markBack(r, msg.playerId, ws);
          if (oldWs && oldWs !== ws) { try { oldWs.close(); } catch {} }
          room.promoteHost(r);
          currentRoom = r;
          currentPlayerId = msg.playerId;
          ws.send(JSON.stringify({ type: 'joined', roomId: r.id, playerId: msg.playerId, token: seat.token }));
          broadcastRoom(r);
          return;
        }

        const { playerId, token } = room.addPlayer(r, msg.playerName, ws);
        if (msg.observer === true) room.setObserver(r, playerId, true);
        currentRoom = r;
        currentPlayerId = playerId;
        ws.send(JSON.stringify({ type: 'joined', roomId: r.id, playerId, token }));
        broadcastRoom(r);
        break;
      }

      case 'vote': {
        if (!ownsSeat()) return;
        if (room.vote(currentRoom, currentPlayerId, msg.value)) {
          broadcastRoom(currentRoom);
        }
        break;
      }

      case 'clear-vote': {
        if (!ownsSeat()) return;
        if (room.clearVote(currentRoom, currentPlayerId)) {
          broadcastRoom(currentRoom);
        }
        break;
      }

      case 'reveal': {
        if (!ownsSeat()) return;
        const result = room.reveal(currentRoom, currentPlayerId);
        if (!result.ok) return;

        // Countdown state lives in the room and is broadcast, so clients that
        // join/reconnect mid-countdown render the same timer. The server only
        // owns the timer handle that fires the actual reveal.
        room.beginCountdown(currentRoom, COUNTDOWN_MS, result.initiatedBy);
        broadcastRoom(currentRoom);
        const revealingRoom = currentRoom;
        revealingRoom._countdownTimer = setTimeout(() => {
          room.applyReveal(revealingRoom);
          broadcastRoom(revealingRoom);
        }, COUNTDOWN_MS);
        break;
      }

      case 'new-round': {
        if (!ownsSeat()) return;
        if (room.newRound(currentRoom, currentPlayerId)) {
          broadcastRoom(currentRoom);
        }
        break;
      }

      case 'leave-room': {
        if (!ownsSeat()) return;
        room.removePlayer(currentRoom, currentPlayerId);
        if (currentRoom.players.size === 0) {
          // Tearing the room down — cancel any pending countdown so its timer
          // can't fire applyReveal on a deleted room.
          deleteRoom(currentRoom);
        } else {
          broadcastRoom(currentRoom);
        }
        currentRoom = null;
        currentPlayerId = null;
        break;
      }

      case 'claim-host': {
        if (!ownsSeat()) return;
        if (room.claimHost(currentRoom, currentPlayerId)) broadcastRoom(currentRoom);
        break;
      }

      case 'set-observer': {
        if (!ownsSeat()) return;
        if (room.setObserver(currentRoom, currentPlayerId, msg.observer)) broadcastRoom(currentRoom);
        break;
      }

      case 'set-topic': {
        if (!ownsSeat()) return;
        if (room.setTopic(currentRoom, currentPlayerId, msg.topic)) broadcastRoom(currentRoom);
        break;
      }

      case 'change-color': {
        if (!ownsSeat()) return;
        if (room.changeColor(currentRoom, currentPlayerId, msg.colorIndex)) {
          broadcastRoom(currentRoom);
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!ownsSeat()) return;
    const r = currentRoom;
    const pid = currentPlayerId;
    const player = r.players.get(pid);
    // If a newer socket already took over this seat (fast reconnect), player.ws
    // points at that socket, not us — this close is for a superseded connection
    // and must NOT tear the live seat down.
    if (!player || player.ws !== ws) return;

    // Keep the seat (place, vote, host role) and mark it away. Parked by
    // stable playerId (not name) so two same-named players never clash.
    room.markAway(r, pid);
    parkPlayer(r, pid, RECONNECT_WINDOW_MS);
    broadcastRoom(r);
  });
});

// ─── Room GC ─────────────────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [id, r] of rooms) {
    if (room.isRoomExpired(r, now, ROOM_TIMEOUT_MS)) deleteRoom(r);
  }
}, 60_000).unref();

// Docker sends SIGTERM on stop/redeploy. Write the snapshot synchronously and
// exit, so the next process can restore every room and seat.
function shutdown(signal) {
  console.log(`[persist] ${signal}: saving ${rooms.size} room(s)`);
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  persist.saveSnapshot(STATE_FILE, rooms);
  process.exit(0);
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, () => {
  console.log(`Pointer running at http://localhost:${PORT}`);
});

module.exports = server;
module.exports.resolveStaticPath = resolveStaticPath;
