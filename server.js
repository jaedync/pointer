const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const room = require('./room');

const PORT = process.env.PORT || 3000;
const ROOM_TIMEOUT_MS = 30 * 60 * 1000;
const RECONNECT_WINDOW_MS = 60 * 1000;
const COUNTDOWN_MS = parseInt(process.env.COUNTDOWN_MS || '3000', 10);

// ─── HTTP ────────────────────────────────────────────────────────────────────
const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
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
  const full = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(reqPath)));
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) return null;
  return full;
}

const server = http.createServer((req, res) => {
  const ext = path.extname(req.url);
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
    // index.html is the app shell — must always re-validate so updates ship.
    // Other assets aren't fingerprinted, so cache them modestly (1h).
    const cacheControl = (!isStatic || path.basename(filePath) === 'index.html')
      ? 'no-cache'
      : 'public, max-age=3600';
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': contentType, 'Cache-Control': cacheControl });
    res.end(data);
  });
});

// ─── WebSocket ───────────────────────────────────────────────────────────────
// maxPayload bounds a single frame; these messages are tiny, so 64 KB is ample
// and stops a client from forcing a multi-MB buffer allocation.
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
const rooms = new Map();

function broadcastRoom(r) {
  // Per-recipient serialization: each player's payload reveals THEIR OWN vote
  // value pre-reveal (so the client can sync state.myVote across reloads or
  // out-of-order events). Other players' votes stay masked with 'voted'.
  for (const [pid, p] of r.players) {
    if (!p.ws || p.ws.readyState !== 1) continue;
    const payload = JSON.stringify({ type: 'room-state', room: room.serializeRoomFor(r, pid) });
    p.ws.send(payload);
  }
}

wss.on('connection', (ws) => {
  let currentRoom = null;
  let currentPlayerId = null;

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
        // adopt a disconnected player's host role and vote.
        const entry = msg.playerId ? r.disconnected.get(msg.playerId) : null;
        if (entry && entry.player.token && msg.token === entry.player.token) {
          clearTimeout(entry.timeout);
          r.disconnected.delete(msg.playerId);
          const player = entry.player;
          player.ws = ws;
          player.isHost = false;        // a host may have been promoted while we were gone
          r.players.set(msg.playerId, player);
          room.promoteHost(r);          // guarantee exactly one host
          currentRoom = r;
          currentPlayerId = msg.playerId;
          ws.send(JSON.stringify({ type: 'joined', roomId: r.id, playerId: msg.playerId, token: player.token }));
          broadcastRoom(r);
          return;
        }

        const { playerId, token } = room.addPlayer(r, msg.playerName, ws);
        currentRoom = r;
        currentPlayerId = playerId;
        ws.send(JSON.stringify({ type: 'joined', roomId: r.id, playerId, token }));
        broadcastRoom(r);
        break;
      }

      case 'vote': {
        if (!currentRoom || !currentPlayerId) return;
        if (room.vote(currentRoom, currentPlayerId, msg.value)) {
          broadcastRoom(currentRoom);
        }
        break;
      }

      case 'clear-vote': {
        if (!currentRoom || !currentPlayerId) return;
        if (room.clearVote(currentRoom, currentPlayerId)) {
          broadcastRoom(currentRoom);
        }
        break;
      }

      case 'reveal': {
        if (!currentRoom || !currentPlayerId) return;
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
        if (!currentRoom || !currentPlayerId) return;
        if (room.newRound(currentRoom, currentPlayerId)) {
          broadcastRoom(currentRoom);
        }
        break;
      }

      case 'leave-room': {
        if (!currentRoom || !currentPlayerId) return;
        room.removePlayer(currentRoom, currentPlayerId);
        if (currentRoom.players.size === 0 && currentRoom.disconnected.size === 0) {
          // Tearing the room down — cancel any pending countdown so its timer
          // can't fire applyReveal on a deleted room.
          room.cancelCountdown(currentRoom);
          rooms.delete(currentRoom.id);
        } else {
          broadcastRoom(currentRoom);
        }
        currentRoom = null;
        currentPlayerId = null;
        break;
      }

      case 'change-color': {
        if (!currentRoom || !currentPlayerId) return;
        if (room.changeColor(currentRoom, currentPlayerId, msg.colorIndex)) {
          broadcastRoom(currentRoom);
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!currentRoom || !currentPlayerId) return;
    const r = currentRoom;
    const pid = currentPlayerId;
    const player = r.players.get(pid);
    if (!player) return;

    r.players.delete(pid);
    player.ws = null;

    // Park by stable playerId (not name) so two same-named players never clash.
    // Defensively clear any prior parked timer for this id before re-parking.
    const existing = r.disconnected.get(pid);
    if (existing) clearTimeout(existing.timeout);
    const timeout = setTimeout(() => {
      r.disconnected.delete(pid);
      if (r.players.size === 0 && r.disconnected.size === 0) {
        room.cancelCountdown(r);
        rooms.delete(r.id);
      }
    }, RECONNECT_WINDOW_MS);
    r.disconnected.set(pid, { player, timeout });

    room.promoteHost(r);
    broadcastRoom(r);
  });
});

// ─── Room GC ─────────────────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [id, r] of rooms) {
    if (room.isRoomExpired(r, now, ROOM_TIMEOUT_MS)) {
      room.cancelCountdown(r);
      rooms.delete(id);
    }
  }
}, 60_000);

server.listen(PORT, () => {
  console.log(`Pointer running at http://localhost:${PORT}`);
});

module.exports = server;
