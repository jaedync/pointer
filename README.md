# pointer

> Scrum poker for your team. Free, fast, no signup.

![pointer](og.png)

Real-time planning poker for agile estimation. Create a room, share the link, vote privately, reveal together. A single Node.js process with one dependency ([`ws`](https://github.com/websockets/ws)), no database, no accounts.

## Features

- **Instant rooms**: create and share a link (or the share sheet on phones), no signup
- **Private voting**: estimates stay hidden until the host reveals
- **3-second countdown**: reveal with anticipation
- **4 voting systems**: T-shirt (XS–XL), Fibonacci, Powers of 2, Simple (1–5)
- **Results that start the conversation**: count per card, average for numeric decks, lowest and highest voters
- **Story title and round history**: the host names what is being estimated; the sidebar lists past rounds
- **Observers**: a scrum master or product owner can watch without holding cards
- **Seats survive drops**: a disconnected player stays at the table as "away" (vote, place and host role kept) for 60s; a present player can take over from an away host
- **Rooms survive restarts**: the server writes a snapshot on SIGTERM and restores it at boot, so a deploy does not end a meeting
- **Phone, tablet and desktop**: one layout per size, players drawer on phones
- **Keyboard and screen reader friendly**: type a card's value to vote, `R`/`N` for the host, focus rings, labelled controls, reduced motion respected
- **12-color player palette**: deterministic, no duplicates, change your own
- **Persistent names**: remembered across sessions via localStorage

## Self-Hosting

```bash
docker build -t pointer .
docker run -p 3000:3000 -v pointer-data:/app/data pointer
```

Or run directly:

```bash
npm install
node server.js
```

| Env | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP + WebSocket port |
| `POINTER_STATE_FILE` | `./data/rooms.json` | Room snapshot; empty string disables persistence |
| `RESTORE_GRACE_MS` | `600000` | How long restored players may take to reconnect after a restart |
| `COUNTDOWN_MS` | `3000` | Reveal countdown |

The snapshot holds reconnect tokens and is written with mode `0600`.

## Testing

```bash
npm test                    # unit + integration + restart persistence, Node's built-in runner
npm run test:e2e            # browser end-to-end + viewport matrix with axe (requires playwright)
npm run test:e2e:viewports  # only the viewport matrix (375, 390, 768, 1280, 1440 px)
```

`npm test` needs no runtime dependencies beyond `ws`. The browser tests need the dev
dependencies (`playwright`, `@axe-core/playwright`) and Chromium
(`npx playwright install chromium`, or set `PW_CHROMIUM` to a Chromium binary).
`e2e/viewports.cjs` saves a screenshot set for each size in `$SHOTS`.

## License

MIT
