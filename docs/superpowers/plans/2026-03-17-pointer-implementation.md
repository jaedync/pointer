# Pointer Scrum Poker Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a free, lightweight scrum poker web app — single Node.js process, single HTML file, WebSocket real-time, no build step.

**Architecture:** Node.js `http` + `ws` library serving a single `public/index.html`. In-memory room state. Hash routing on the client. No frameworks, no bundler.

**Tech Stack:** Node.js, `ws` (WebSocket library), vanilla JS/CSS/HTML

**Reference mockup:** `../../../scrum-poker-themes-v4.html` (approved Dusk theme with all interactions)

---

## File Structure

```
pointer/
├── server.js                 # HTTP server + WebSocket server + room logic
├── public/
│   └── index.html            # Single-file SPA (CSS + JS inline)
├── package.json              # Just ws dependency
├── .gitignore
└── docs/                     # Specs and plans
```

`server.js` responsibilities:
- Serve `public/index.html` for all HTTP GET requests
- WebSocket connection handling (upgrade, message routing, disconnect)
- Room CRUD (create, join, leave, vote, reveal, new-round, change-color)
- Room garbage collection (30 min inactivity timeout)
- Host auto-promotion on disconnect
- Reconnection tracking (60s grace window)

`public/index.html` responsibilities:
- All CSS inline in `<style>` (Dusk theme from mockup)
- All JS inline in `<script>`
- Hash router: `#/` (lobby modal), `#/room/{id}` (game), `#/join/{id}` (join modal)
- WebSocket client with auto-reconnect
- State object → DOM render loop (no virtual DOM)
- Lobby modal (create game), join modal (enter name), game UI

---

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `server.js` (skeleton)
- Create: `public/index.html` (skeleton)

- [ ] **Step 1: Create package.json**

```json
{
  "name": "pointer",
  "version": "1.0.0",
  "private": true,
  "description": "Free, lightweight scrum poker for agile teams",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  }
}
```

- [ ] **Step 2: Create .gitignore**

```
node_modules/
.DS_Store
```

- [ ] **Step 3: Install ws dependency**

Run: `cd /Users/jaedy/development/pointer && npm install ws`
Expected: `node_modules/` created, `package-lock.json` generated

- [ ] **Step 4: Create skeleton server.js**

```js
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

server.listen(PORT, () => {
  console.log(`Pointer running at http://localhost:${PORT}`);
});
```

- [ ] **Step 5: Create skeleton public/index.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pointer – Scrum Poker</title>
</head>
<body>
  <h1>Pointer</h1>
</body>
</html>
```

- [ ] **Step 6: Verify server starts**

Run: `cd /Users/jaedy/development/pointer && node server.js &`
Then: `curl -s http://localhost:3000 | head -5`
Expected: HTML returned with `<title>Pointer`
Cleanup: Kill the background process

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .gitignore server.js public/index.html
git commit -m "feat: project scaffold with http server and skeleton html"
```

---

### Task 2: WebSocket Server + Room Logic

**Files:**
- Modify: `server.js`

This is the core backend. All room state management, player handling, vote logic.

- [ ] **Step 1: Add WebSocket server and room data structures**

Add to `server.js` after the http server creation but before `server.listen`:

```js
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
    disconnected: new Map(), // name -> { player, timeout }
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
```

- [ ] **Step 2: Add WebSocket connection handler**

```js
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

        // Check for reconnection
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
        currentRoom.lastActivity = Date.now();
        currentRoom.revealed = true;

        // Check consensus
        const votes = [...currentRoom.players.values()]
          .map(p => p.vote)
          .filter(v => v && v !== '?');
        if (votes.length > 1 && votes.every(v => v === votes[0])) {
          currentRoom.consensusCount++;
        }
        currentRoom.roundNumber++;

        broadcastRoom(currentRoom);
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

    // Reconnection window
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
```

- [ ] **Step 3: Add room garbage collection**

```js
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (now - room.lastActivity > ROOM_TIMEOUT_MS && room.players.size === 0) {
      rooms.delete(id);
    }
  }
}, 60_000);
```

- [ ] **Step 4: Verify WebSocket server starts without errors**

Run: `cd /Users/jaedy/development/pointer && node -e "require('./server.js')" &`
Expected: `Pointer running at http://localhost:3000` printed, no errors
Cleanup: Kill the process

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: websocket server with room logic, voting, reveal, reconnection"
```

---

### Task 3: Client HTML — CSS Theme (Dusk)

**Files:**
- Modify: `public/index.html`

Port the approved Dusk theme CSS from `scrum-poker-themes-v4.html`. This task is CSS only — no JS, no interactivity yet.

- [ ] **Step 1: Write the full HTML structure with inline CSS**

Replace `public/index.html` with the complete HTML structure containing:
- All CSS from the approved v4 mockup (CSS variables, header, sidebar, stage, hand, lobby modal, consensus tracker, color picker, player rows, card animations)
- HTML skeleton for all three views: lobby modal overlay, join modal overlay, game layout (header + sidebar + stage + hand)
- No JavaScript yet — just the DOM structure and styles

**Key CSS to port from mockup:**
- `:root` variables (Dusk palette + 12 player colors)
- `.header`, `.sidebar`, `.stage`, `.hand` layout (grid: 280px sidebar | 1fr stage, auto hand row)
- `.lobby-overlay` / `.join-overlay` — fixed overlay with backdrop blur
- `.lobby-card` — centered modal card
- `.hand-card` — fan rotation with nth-child transforms
- `.stage-card` — 3D flip with `transform-style: preserve-3d`, `-webkit-backface-visibility`
- `.consensus-tracker` — SVG ring styles
- `.player-row`, `.player-avatar`, `.player-vote-indicator`
- `.color-picker-popover`
- All animations: `@keyframes cardIn`, `@keyframes revealPulse`
- Font imports: Karla, Recursive, Instrument Sans

**HTML structure:**
```
body
├── div.lobby-overlay#lobby-overlay
│   └── div.lobby-card (game name, player name, voting system, create button)
├── div.join-overlay#join-overlay (hidden by default)
│   └── div.lobby-card (player name only, join button)
├── div#app
│   ├── header.header
│   ├── div.game-main
│   │   ├── aside.sidebar
│   │   │   ├── div.sidebar-label
│   │   │   ├── div#players-list
│   │   │   ├── div.players-divider
│   │   │   └── div.consensus-tracker
│   │   ├── div.stage
│   │   │   ├── div.stage-status
│   │   │   ├── div.stage-cards#stage-cards
│   │   │   ├── div.big-average#big-average
│   │   │   └── div.stage-action#stage-action
│   │   └── div.hand
│   │       ├── span.hand-label
│   │       └── div.hand-cards#hand-cards
```

- [ ] **Step 2: Verify the page loads with styles**

Run: `cd /Users/jaedy/development/pointer && node server.js &`
Then: Open `http://localhost:3000` in a browser
Expected: See the styled layout with lobby modal overlay visible
Cleanup: Kill the process

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "feat: dusk theme CSS and HTML structure"
```

---

### Task 4: Client JS — WebSocket Client + State Management

**Files:**
- Modify: `public/index.html` (add `<script>` block)

This is the core client logic: WebSocket connection, state management, and the render loop.

- [ ] **Step 1: Add state object and WebSocket connection**

Inside `<script>` at end of body:

```js
// ─── State ───
const state = {
  connected: false,
  playerId: null,
  room: null,     // { id, name, votingSystem, votingSystemKey, revealed, roundNumber, consensusCount, players[] }
  myVote: null,
};

// ─── WebSocket ───
let ws = null;
let reconnectTimer = null;

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    state.connected = true;
    // If we have a room hash, try to rejoin
    const hash = location.hash;
    if (hash.startsWith('#/room/') && state.room) {
      send({ type: 'join-room', roomId: state.room.id, playerName: getMyName() });
    }
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleMessage(msg);
  };

  ws.onclose = () => {
    state.connected = false;
    reconnectTimer = setTimeout(connect, 2000);
  };
}

function send(msg) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  }
}

function getMyName() {
  if (!state.room || !state.playerId) return '';
  const me = state.room.players.find(p => p.id === state.playerId);
  return me ? me.name : '';
}
```

- [ ] **Step 2: Add message handler**

```js
function handleMessage(msg) {
  switch (msg.type) {
    case 'room-created':
      state.playerId = msg.playerId;
      location.hash = `#/room/${msg.roomId}`;
      break;

    case 'joined':
      state.playerId = msg.playerId;
      location.hash = `#/room/${msg.roomId}`;
      hideModals();
      break;

    case 'room-state':
      // Track if reveal just happened (was not revealed, now is)
      const wasRevealed = state.room?.revealed;
      state.room = msg.room;
      // Reset myVote when new round starts
      if (wasRevealed && !msg.room.revealed) {
        state.myVote = null;
      }
      render();
      break;

    case 'error':
      alert(msg.message);
      break;
  }
}
```

- [ ] **Step 3: Add render function**

```js
function render() {
  if (!state.room) return;
  renderHeader();
  renderSidebar();
  renderStage();
  renderHand();
}
```

Each `render*` function reads from `state.room` and updates the DOM. These will be implemented in the next tasks.

- [ ] **Step 4: Add hash router and initialization**

```js
function handleRoute() {
  const hash = location.hash || '#/';

  if (hash === '#/' || hash === '') {
    showLobbyModal();
  } else if (hash.startsWith('#/join/')) {
    const roomId = hash.split('/')[2];
    showJoinModal(roomId);
  } else if (hash.startsWith('#/room/')) {
    // Room view — handled by room-state messages
    hideModals();
  }
}

window.addEventListener('hashchange', handleRoute);

// Init
connect();
handleRoute();
```

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat: websocket client, state management, hash router"
```

---

### Task 5: Client JS — Lobby & Join Modals

**Files:**
- Modify: `public/index.html`

Wire up the lobby (create game) and join modals to send WebSocket messages.

- [ ] **Step 1: Implement lobby modal logic**

```js
function showLobbyModal() {
  document.getElementById('lobby-overlay').classList.remove('hidden');
  document.getElementById('join-overlay').classList.add('hidden');
}

function showJoinModal(roomId) {
  document.getElementById('join-overlay').classList.remove('hidden');
  document.getElementById('lobby-overlay').classList.add('hidden');
  document.getElementById('join-overlay').dataset.roomId = roomId;
}

function hideModals() {
  document.getElementById('lobby-overlay').classList.add('hidden');
  document.getElementById('join-overlay').classList.add('hidden');
}

function createGame() {
  const name = document.getElementById('lobby-game-name').value.trim();
  const playerName = document.getElementById('lobby-player-name').value.trim();
  const votingSystem = document.getElementById('lobby-voting-system').value;

  if (!playerName) {
    document.getElementById('lobby-player-name').focus();
    return;
  }

  send({
    type: 'create-room',
    name: name || 'Planning Poker',
    playerName,
    votingSystem,
  });
}

function joinGame() {
  const playerName = document.getElementById('join-player-name').value.trim();
  const roomId = document.getElementById('join-overlay').dataset.roomId;

  if (!playerName) {
    document.getElementById('join-player-name').focus();
    return;
  }

  send({
    type: 'join-room',
    roomId,
    playerName,
  });
}
```

- [ ] **Step 2: Add voting system preview updater**

```js
const VOTING_SYSTEMS = {
  tshirt: ['XS', 'S', 'M', 'L', 'XL', '?'],
  fib: ['0', '1', '2', '3', '5', '8', '13', '21', '?'],
  powers: ['1', '2', '4', '8', '16', '32', '?'],
  simple: ['1', '2', '3', '4', '5', '?'],
};

function updateVotingPreview() {
  const sel = document.getElementById('lobby-voting-system');
  const preview = document.getElementById('system-preview');
  const values = VOTING_SYSTEMS[sel.value];
  preview.innerHTML = values.map(v => `<span class="system-chip">${v}</span>`).join('');
}
```

- [ ] **Step 3: Wire up HTML onclick/onchange attributes**

Update the lobby modal HTML:
- Create button: `onclick="createGame()"`
- Voting select: `onchange="updateVotingPreview()"`
- Join button: `onclick="joinGame()"`
- Lobby close X: `onclick="hideModals()"`

- [ ] **Step 4: Verify create game flow works end-to-end**

Run: Start server, open browser, fill in lobby, click Create Game
Expected: Modal closes, URL changes to `#/room/{id}`, room state received

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat: lobby and join modal logic with create/join flows"
```

---

### Task 6: Client JS — Render Functions (Sidebar, Stage, Hand)

**Files:**
- Modify: `public/index.html`

The main rendering logic. Each function takes `state.room` and updates DOM.

- [ ] **Step 1: Implement renderHeader**

```js
function renderHeader() {
  document.getElementById('room-name-display').textContent = state.room.name;
  const me = state.room.players.find(p => p.id === state.playerId);
  if (me) {
    document.getElementById('user-av').style.background = COLORS[me.color];
    document.getElementById('user-av').textContent = me.name[0].toUpperCase();
    document.getElementById('user-name-display').textContent = me.name;
  }
}

const COLORS = ['#d4856a','#6aad8c','#7b8fc7','#c9a84c','#b07cc7','#c76a6a','#6ab5c7','#8aad5c','#c78a5c','#6a7ec7','#c76a9a','#5cad9a'];
```

- [ ] **Step 2: Implement renderSidebar**

```js
function renderSidebar() {
  const container = document.getElementById('players-list');
  const me = state.room.players.find(p => p.id === state.playerId);

  container.innerHTML = state.room.players.map(p => {
    const isMe = p.id === state.playerId;
    const color = COLORS[p.color];
    let indicator = '';

    if (state.room.revealed && p.vote) {
      indicator = `<div class="player-vote-indicator revealed-vote"><span class="vi-val">${p.vote}</span></div>`;
    } else if (p.vote === 'voted' || (state.room.revealed && p.vote)) {
      indicator = `<div class="player-vote-indicator voted" style="background:${color}"><span class="vi-check">✓</span></div>`;
    } else {
      indicator = `<div class="player-vote-indicator waiting"></div>`;
    }

    return `
      <div class="player-row ${isMe ? 'is-you' : ''}">
        <div class="player-avatar" style="background:${color}">${p.name[0].toUpperCase()}</div>
        <div class="player-info">
          <div class="player-name-text">${escapeHtml(p.name)}</div>
          ${isMe ? '<div class="player-role">Host · You</div>'.replace('Host · ', p.isHost ? 'Host · ' : '') : ''}
        </div>
        ${indicator}
      </div>
    `;
  }).join('');

  // Update player count
  document.getElementById('players-count').textContent = `Players · ${state.room.players.length}`;

  // Update consensus tracker
  renderConsensus();
}

function renderConsensus() {
  const total = state.room.roundNumber;
  const consensus = state.room.consensusCount;
  const circumference = 2 * Math.PI * 22; // r=22

  document.getElementById('consensus-num').textContent = consensus;
  document.getElementById('consensus-den').textContent = `of ${total}`;
  document.getElementById('consensus-desc').textContent =
    total === 0
      ? 'No rounds played yet'
      : `${consensus} of ${total} rounds reached agreement`;

  const pct = total === 0 ? 0 : consensus / total;
  const offset = circumference * (1 - pct);
  document.getElementById('consensus-ring-fill').setAttribute('stroke-dashoffset', offset);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
```

- [ ] **Step 3: Implement renderStage**

```js
function renderStage() {
  const cards = document.getElementById('stage-cards');
  const status = document.getElementById('stage-status');
  const action = document.getElementById('stage-action');
  const avg = document.getElementById('big-average');

  const votedCount = state.room.players.filter(p => p.vote).length;
  const totalCount = state.room.players.length;
  const me = state.room.players.find(p => p.id === state.playerId);
  const isHost = me?.isHost;

  // Status
  if (state.room.revealed) {
    status.innerHTML = 'Results';
  } else {
    status.innerHTML = `<span class="count">${votedCount}</span> of ${totalCount} voted`;
  }

  // Stage cards
  cards.innerHTML = state.room.players.map((p, i) => {
    const color = COLORS[p.color];
    const isWaiting = !p.vote || p.vote === null;
    const displayVote = state.room.revealed ? (p.vote || '—') : '';
    const flipClass = state.room.revealed ? 'flip' : '';
    const delay = state.room.revealed ? `transition-delay: ${i * 0.1}s` : '';

    return `
      <div class="stage-card" style="animation-delay:${i * 0.06}s">
        <div class="stage-card-inner ${flipClass}" style="${delay}">
          <div class="stage-card-front ${isWaiting && !state.room.revealed ? 'sc-waiting' : ''}" style="background:${isWaiting && !state.room.revealed ? '' : color}">
            <span class="sc-init">${isWaiting && !state.room.revealed ? '?' : p.name[0].toUpperCase()}</span>
          </div>
          <div class="stage-card-back">
            <div class="sc-color-bar" style="background:${color}"></div>
            <span class="sc-value">${displayVote}</span>
            <span class="sc-name">${escapeHtml(p.name)}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Action button
  if (state.room.revealed) {
    if (isHost) {
      action.innerHTML = '<button class="btn-new-round" onclick="newRound()">Start New Round</button>';
    } else {
      action.innerHTML = '<span style="color:var(--text-muted);font-size:13px;">Waiting for host to start new round...</span>';
    }
    // Show average/consensus
    const numericVotes = state.room.players.map(p => p.vote).filter(v => v && v !== '?' && v !== '—');
    avg.classList.add('show');
    // For T-shirt sizes, show mode; for numeric, show average
    if (numericVotes.length > 0 && !isNaN(Number(numericVotes[0]))) {
      const sum = numericVotes.reduce((a, b) => a + Number(b), 0);
      document.getElementById('avg-label').textContent = 'Average';
      document.getElementById('avg-value').textContent = (sum / numericVotes.length).toFixed(1);
    } else {
      // Mode for non-numeric
      const counts = {};
      numericVotes.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
      const mode = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      document.getElementById('avg-label').textContent = 'Consensus';
      document.getElementById('avg-value').textContent = mode ? mode[0] : '—';
    }
  } else {
    avg.classList.remove('show');
    if (isHost) {
      const allVoted = votedCount === totalCount && totalCount > 0;
      action.innerHTML = `<button class="btn-reveal ${allVoted ? 'all-in' : ''}" onclick="reveal()" ${votedCount === 0 ? 'disabled style="opacity:0.5;cursor:default;"' : ''}>Reveal Cards</button>`;
    } else {
      action.innerHTML = '<span style="color:var(--text-muted);font-size:13px;">Waiting for host to reveal...</span>';
    }
  }
}
```

- [ ] **Step 4: Implement renderHand**

```js
function renderHand() {
  const container = document.getElementById('hand-cards');
  const system = state.room.votingSystem;

  container.innerHTML = system.map(value => {
    const picked = state.myVote === value ? 'picked' : '';
    return `<div class="hand-card ${picked}" onclick="pickCard('${value}')">${value}</div>`;
  }).join('');
}
```

- [ ] **Step 5: Add action functions**

```js
function pickCard(value) {
  if (state.room.revealed) return;
  if (state.myVote === value) {
    state.myVote = null;
    send({ type: 'clear-vote' });
  } else {
    state.myVote = value;
    send({ type: 'vote', value });
  }
  renderHand();
}

function reveal() {
  send({ type: 'reveal' });
}

function newRound() {
  send({ type: 'new-round' });
}

function copyInviteLink() {
  const url = `${location.origin}${location.pathname}#/join/${state.room.id}`;
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById('btn-invite');
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  });
}

function changeColor(colorIndex) {
  send({ type: 'change-color', colorIndex });
}
```

- [ ] **Step 6: Verify the full game loop works**

Run: Start server, open two browser tabs
Tab 1: Create a game, get the invite link
Tab 2: Open the invite link, join with a different name
Both tabs: Pick cards, reveal, new round
Expected: Real-time updates in both tabs, card flips, consensus tracking

- [ ] **Step 7: Commit**

```bash
git add public/index.html
git commit -m "feat: complete render loop — sidebar, stage, hand, actions"
```

---

### Task 7: Polish & Edge Cases

**Files:**
- Modify: `public/index.html`
- Modify: `server.js`

- [ ] **Step 1: Add invite link copy button handler**

Wire the header "Copy invite link" button to `copyInviteLink()`.

- [ ] **Step 2: Add color picker UI**

Implement the color picker popover on the user's player row in the sidebar. Clicking a swatch calls `changeColor(index)`.

- [ ] **Step 3: Handle room-not-found gracefully**

When visiting `#/join/{id}` for a nonexistent room, show a friendly message in the join modal instead of a raw error alert.

- [ ] **Step 4: Add Enter key support on modals**

Pressing Enter in the lobby or join modal input fields should submit the form.

- [ ] **Step 5: Add responsive styles for mobile**

Add a `@media (max-width: 768px)` breakpoint:
- Stack sidebar below/above stage instead of side-by-side
- Hand cards scroll horizontally instead of fanning
- Reduce stage card size

- [ ] **Step 6: Verify all interactions end-to-end**

Test: Create game, join from another tab, vote, deselect, reveal, new round, color change, copy invite, mobile viewport
Expected: All flows work, no console errors

- [ ] **Step 7: Commit**

```bash
git add public/index.html server.js
git commit -m "feat: polish — color picker, mobile responsive, enter key, error handling"
```

---

### Task 8: Final Verification & Cleanup

**Files:**
- Modify: `server.js` (if needed)
- Modify: `public/index.html` (if needed)

- [ ] **Step 1: Copy approved mockup into project for reference**

```bash
cp /Users/jaedy/development/scrum-poker-themes-v4.html /Users/jaedy/development/pointer/docs/mockup-reference.html
```

- [ ] **Step 2: Clean up mockup files**

Remove temporary mockup files from the parent directory:
```bash
rm /Users/jaedy/development/scrum-poker-*.html
rm /Users/jaedy/development/planningpoker-*.png
```

- [ ] **Step 3: Test with 3+ players**

Open 3+ browser tabs, all joining the same room. Verify:
- Player colors are assigned distinctly
- All players see votes update in real-time
- Host promotion works when host disconnects
- Reconnection works within 60s window

- [ ] **Step 4: Test room garbage collection**

Create a room, disconnect all players, wait and verify the room is cleaned up (check server logs or add a temporary log).

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore: cleanup mockups, add reference, final polish"
```
