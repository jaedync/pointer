const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(htmlPath, (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end('Internal Server Error');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
});

const { WebSocketServer } = require('ws');

const wss = new WebSocketServer({ server });

// ─── Data ───
const rooms = new Map();
const VOTING_SYSTEMS = {
  tshirt: ['XS', 'S', 'M', 'L', 'XL', '?'],
  fib: ['0', '1', '2', '3', '5', '8', '13', '21', '?'],
  powers: ['1', '2', '4', '8', '16', '32', '?'],
  simple: ['1', '2', '3', '4', '5', '?'],
};
const NUM_COLORS = 12;
const ROOM_TIMEOUT_MS = 30 * 60 * 1000;
const RECONNECT_WINDOW_MS = 60 * 1000;

function generateId() {
  return Math.random().toString(36).substring(2, 7);
}

function createRoom(name, votingSystem) {
  const id = generateId();
  const room = {
    id,
    name: name || 'Planning Poker',
    votingSystem: VOTING_SYSTEMS[votingSystem] || VOTING_SYSTEMS.tshirt,
    votingSystemKey: votingSystem || 'tshirt',
    players: new Map(),
    revealed: false,
    roundNumber: 0,
    consensusCount: 0,
    disconnected: new Map(),
    lastActivity: Date.now(),
  };
  rooms.set(id, room);
  return room;
}

function getNextColor(room) {
  const usedColors = new Set([...room.players.values()].map(p => p.color));
  for (let i = 0; i < NUM_COLORS; i++) {
    if (!usedColors.has(i)) return i;
  }
  return room.players.size % NUM_COLORS;
}

function broadcastRoom(room) {
  const state = {
    type: 'room-state',
    room: {
      id: room.id,
      name: room.name,
      votingSystem: room.votingSystem,
      votingSystemKey: room.votingSystemKey,
      revealed: room.revealed,
      roundNumber: room.roundNumber,
      consensusCount: room.consensusCount,
      players: [...room.players.entries()].map(([sid, p]) => ({
        id: sid,
        name: p.name,
        vote: room.revealed ? p.vote : (p.vote ? 'voted' : null),
        isHost: p.isHost,
        color: p.color,
      })),
    },
  };
  const msg = JSON.stringify(state);
  for (const [sid, player] of room.players) {
    if (player.ws && player.ws.readyState === 1) {
      player.ws.send(msg);
    }
  }
}

function promoteHost(room) {
  const players = [...room.players.values()];
  if (players.length > 0 && !players.some(p => p.isHost)) {
    players[0].isHost = true;
  }
}

wss.on('connection', (ws) => {
  let currentRoom = null;
  let currentPlayerId = null;

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'create-room': {
        const room = createRoom(msg.name, msg.votingSystem);
        const playerId = generateId();
        const player = {
          name: msg.playerName || 'Player',
          vote: null,
          isHost: true,
          color: 0,
          ws,
        };
        room.players.set(playerId, player);
        currentRoom = room;
        currentPlayerId = playerId;
        ws.send(JSON.stringify({ type: 'room-created', roomId: room.id, playerId }));
        broadcastRoom(room);
        break;
      }

      case 'join-room': {
        const room = rooms.get(msg.roomId);
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
          return;
        }
        room.lastActivity = Date.now();

        const disconnectedEntry = room.disconnected.get(msg.playerName);
        if (disconnectedEntry) {
          clearTimeout(disconnectedEntry.timeout);
          room.disconnected.delete(msg.playerName);
          const player = disconnectedEntry.player;
          player.ws = ws;
          const playerId = generateId();
          room.players.set(playerId, player);
          currentRoom = room;
          currentPlayerId = playerId;
          ws.send(JSON.stringify({ type: 'joined', roomId: room.id, playerId }));
          broadcastRoom(room);
          return;
        }

        const playerId = generateId();
        const player = {
          name: msg.playerName || 'Player',
          vote: null,
          isHost: room.players.size === 0,
          color: getNextColor(room),
          ws,
        };
        room.players.set(playerId, player);
        currentRoom = room;
        currentPlayerId = playerId;
        ws.send(JSON.stringify({ type: 'joined', roomId: room.id, playerId }));
        broadcastRoom(room);
        break;
      }

      case 'vote': {
        if (!currentRoom || !currentPlayerId) return;
        const player = currentRoom.players.get(currentPlayerId);
        if (!player || currentRoom.revealed) return;
        currentRoom.lastActivity = Date.now();
        player.vote = msg.value;
        broadcastRoom(currentRoom);
        break;
      }

      case 'clear-vote': {
        if (!currentRoom || !currentPlayerId) return;
        const player = currentRoom.players.get(currentPlayerId);
        if (!player || currentRoom.revealed) return;
        currentRoom.lastActivity = Date.now();
        player.vote = null;
        broadcastRoom(currentRoom);
        break;
      }

      case 'reveal': {
        if (!currentRoom || !currentPlayerId) return;
        const player = currentRoom.players.get(currentPlayerId);
        if (!player || !player.isHost) return;
        if (currentRoom.revealed || currentRoom._countdownTimer) return;
        currentRoom.lastActivity = Date.now();

        // Broadcast countdown start to all players
        const countdownMsg = JSON.stringify({
          type: 'countdown',
          initiatedBy: player.name,
          seconds: 3,
        });
        for (const [, p] of currentRoom.players) {
          if (p.ws && p.ws.readyState === 1) p.ws.send(countdownMsg);
        }

        // Reveal after 3 seconds
        currentRoom._countdownTimer = setTimeout(() => {
          currentRoom._countdownTimer = null;
          currentRoom.revealed = true;

          const votes = [...currentRoom.players.values()]
            .map(p => p.vote)
            .filter(v => v && v !== '?');
          if (votes.length > 1 && votes.every(v => v === votes[0])) {
            currentRoom.consensusCount++;
          }
          currentRoom.roundNumber++;

          broadcastRoom(currentRoom);
        }, 3000);
        break;
      }

      case 'new-round': {
        if (!currentRoom || !currentPlayerId) return;
        const player = currentRoom.players.get(currentPlayerId);
        if (!player || !player.isHost) return;
        currentRoom.lastActivity = Date.now();
        currentRoom.revealed = false;
        for (const p of currentRoom.players.values()) {
          p.vote = null;
        }
        broadcastRoom(currentRoom);
        break;
      }

      case 'leave-room': {
        if (!currentRoom || !currentPlayerId) return;
        const player = currentRoom.players.get(currentPlayerId);
        if (!player) return;
        currentRoom.players.delete(currentPlayerId);
        promoteHost(currentRoom);
        broadcastRoom(currentRoom);
        currentRoom = null;
        currentPlayerId = null;
        break;
      }

      case 'change-color': {
        if (!currentRoom || !currentPlayerId) return;
        const player = currentRoom.players.get(currentPlayerId);
        if (!player) return;
        if (typeof msg.colorIndex !== 'number' || msg.colorIndex < 0 || msg.colorIndex >= NUM_COLORS) return;
        player.color = msg.colorIndex;
        broadcastRoom(currentRoom);
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

    promoteHost(currentRoom);
    broadcastRoom(currentRoom);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (now - room.lastActivity > ROOM_TIMEOUT_MS && room.players.size === 0) {
      rooms.delete(id);
    }
  }
}, 60_000);

server.listen(PORT, () => {
  console.log(`Pointer running at http://localhost:${PORT}`);
});
