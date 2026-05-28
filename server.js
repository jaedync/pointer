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

const server = http.createServer((req, res) => {
  const ext = path.extname(req.url);
  const isStatic = ext && MIME_TYPES[ext];
  const filePath = isStatic
    ? path.join(__dirname, 'public', req.url.split('?')[0])
    : path.join(__dirname, 'public', 'index.html');
  const contentType = MIME_TYPES[ext] || 'text/html';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Fall back to index.html for unknown routes
      if (isStatic) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      res.writeHead(500);
      res.end('Internal Server Error');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

// ─── WebSocket ───────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });
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

function broadcastCountdown(r, initiatedBy) {
  const msg = JSON.stringify({ type: 'countdown', initiatedBy, seconds: 3 });
  for (const [, p] of r.players) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(msg);
  }
}

wss.on('connection', (ws) => {
  let currentRoom = null;
  let currentPlayerId = null;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    switch (msg.type) {
      case 'create-room': {
        const r = room.createRoom(msg.name, msg.votingSystem);
        rooms.set(r.id, r);
        const { playerId } = room.addPlayer(r, msg.playerName, ws);
        currentRoom = r;
        currentPlayerId = playerId;
        ws.send(JSON.stringify({ type: 'room-created', roomId: r.id, playerId }));
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

        // Reconnection
        const disconnectedEntry = r.disconnected.get(msg.playerName);
        if (disconnectedEntry) {
          clearTimeout(disconnectedEntry.timeout);
          r.disconnected.delete(msg.playerName);
          const player = disconnectedEntry.player;
          player.ws = ws;
          const playerId = room.generateId();
          r.players.set(playerId, player);
          currentRoom = r;
          currentPlayerId = playerId;
          ws.send(JSON.stringify({ type: 'joined', roomId: r.id, playerId }));
          broadcastRoom(r);
          return;
        }

        const { playerId } = room.addPlayer(r, msg.playerName, ws);
        currentRoom = r;
        currentPlayerId = playerId;
        ws.send(JSON.stringify({ type: 'joined', roomId: r.id, playerId }));
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

        broadcastCountdown(currentRoom, result.initiatedBy);
        currentRoom._countdownTimer = setTimeout(() => {
          room.applyReveal(currentRoom);
          broadcastRoom(currentRoom);
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
        broadcastRoom(currentRoom);
        if (currentRoom.players.size === 0) {
          rooms.delete(currentRoom.id);
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
    const player = currentRoom.players.get(currentPlayerId);
    if (!player) return;

    currentRoom.players.delete(currentPlayerId);

    const timeout = setTimeout(() => {
      currentRoom.disconnected.delete(player.name);
      if (currentRoom.players.size === 0 && currentRoom.disconnected.size === 0) {
        rooms.delete(currentRoom.id);
      }
    }, RECONNECT_WINDOW_MS);
    currentRoom.disconnected.set(player.name, { player, timeout });

    room.promoteHost(currentRoom);
    broadcastRoom(currentRoom);
  });
});

// ─── Room GC ─────────────────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [id, r] of rooms) {
    if (now - r.lastActivity > ROOM_TIMEOUT_MS && r.players.size === 0) {
      rooms.delete(id);
    }
  }
}, 60_000);

server.listen(PORT, () => {
  console.log(`Pointer running at http://localhost:${PORT}`);
});

module.exports = server;
