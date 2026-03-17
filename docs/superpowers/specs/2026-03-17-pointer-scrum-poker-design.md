# Pointer — Scrum Poker Design Spec

## Overview

Pointer is a free, lightweight scrum poker web app for agile estimation. No auth, no database, no build step on the frontend. A single Node.js process serves a single HTML file and handles real-time communication via WebSockets.

**Target audience:** Teams that want a polished, no-friction estimation tool they can share with colleagues and clients. Not a full SaaS — no billing, no accounts, no persistence.

## Core Flow

1. **Create game:** User opens the app, sees a modal overlay with game name, their display name, and voting system selector. Submits to create a room.
2. **Share link:** A unique room URL is generated (e.g. `/room/x7k2m`). User copies and shares with teammates.
3. **Join:** Teammates open the URL, enter their display name in a join modal, and enter the room.
4. **Vote:** Everyone picks a card from their hand. Cards appear face-down on the stage with player initials. Sidebar shows who has voted.
5. **Reveal:** Host clicks "Reveal Cards" — all cards flip with staggered animation. Consensus/average shown.
6. **New Round:** Host resets for the next estimation. Consensus tracker updates.

## Data Model

```
Room {
  id: string             // short random code, e.g. "x7k2m"
  name: string           // optional game name
  players: Map<socketId, Player>
  revealed: boolean
  votingSystem: string[] // e.g. ["XS","S","M","L","XL","?"]
  roundNumber: number
  consensusCount: number // rounds where all votes matched
}

Player {
  name: string
  vote: string | null
  isHost: boolean
  color: number          // index into 12-color palette
}
```

## Architecture

**Single Node.js process:**
- `server.js` (~200 lines): HTTP server (Node built-in `http`) + WebSocket server (`ws` library)
  - Serves `index.html` for all HTTP requests
  - WebSocket message types: `create-room`, `join-room`, `vote`, `clear-vote`, `reveal`, `new-round`, `change-color`, `disconnect`
  - In-memory room storage, garbage-collected after 30 min inactivity
  - Host auto-promotion on disconnect
  - Reconnection window: 60 seconds to rejoin with same name

- `public/index.html` (~800-1000 lines): Single-file SPA with inline CSS + JS
  - Hash routing: `#/` (create), `#/room/{id}` (game room), `#/join/{id}` (join modal)
  - No framework, no build step, no external dependencies
  - State: simple JS object, re-render on WebSocket messages

## UI Layout (Dusk Theme)

**Visual identity:** Warm rose/terracotta accent (`#d4856a`) + dark header (`#2e2320`) + cream body (`#faf5f2`). Karla for UI text, Recursive (variable, casual axis) for card values, Instrument Sans for body.

**Layout:** Asymmetric grid — sidebar (280px, players + consensus tracker) | center stage (cards + reveal) | bottom hand (card fan).

**Key elements:**
- **Lobby modal:** Floating overlay with backdrop blur. Fields: game name, player name, voting system. Not a separate page.
- **Join modal:** Same floating overlay, but only player name field. Shown when visiting a room URL.
- **Player sidebar:** Avatar with deterministic color, name, vote indicator (colored mini-card when voted, dashed outline when waiting).
- **Stage:** Cards in a row with player initials on face, staggered flip animation on reveal. Big consensus/average display below.
- **Hand:** Cards fan in an arc (CSS rotation), hover lifts card out, click to select/deselect.
- **Consensus tracker:** Circular SVG progress ring in sidebar footer showing X of Y rounds with agreement.

**12-color deterministic palette:**
Terracotta, sage, periwinkle, gold, lavender, rose, sky, olive, amber, slate blue, magenta, teal. Assigned by join order (mod 12). Players can change via color picker.

**Voting systems:**
- T-Shirt Sizes (default): XS, S, M, L, XL, ?
- Fibonacci: 0, 1, 2, 3, 5, 8, 13, 21, ?
- Powers of 2: 1, 2, 4, 8, 16, 32, ?
- Simple: 1, 2, 3, 4, 5, ?

## Deployment

- Single process on a VPS (same infra as other projects)
- `node server.js` with a process manager (pm2 or systemd)
- No database, no Redis, no external services
- Reverse proxy (nginx) for SSL termination

## Out of Scope

- User accounts / authentication
- Persistent game history
- Issue/story tracking sidebar
- Jira/Linear integrations
- Spectator mode (can add later)
- Dark mode (can add later)
