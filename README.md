# pointer

> Scrum poker for your team. Free, fast, no signup.

![pointer](og.png)

Real-time planning poker for agile estimation. Create a room, share the link, vote privately, reveal together. A single Node.js process with one dependency ([`ws`](https://github.com/websockets/ws)), no database, no accounts.

## Features

- **Instant rooms** — create and share a link, no signup
- **Private voting** — estimates stay hidden until the host reveals
- **3-second countdown** — reveal with anticipation
- **4 voting systems** — T-shirt (XS–XL), Fibonacci, Powers of 2, Simple (1–5)
- **Host auto-promotion** — if the host disconnects, the next player takes over after 60s
- **Token-based reconnection** — 60s to rejoin your exact seat (id + secret token, not name)
- **12-color player palette** — deterministic, no duplicates
- **Persistent names** — remembered across sessions via localStorage

## Self-Hosting

```bash
docker build -t pointer .
docker run -p 3000:3000 pointer
```

Or run directly:

```bash
npm install
node server.js
```

## Testing

```bash
npm test          # 141 unit + integration tests, Node's built-in runner, no deps
npm run test:e2e  # browser end-to-end (requires playwright)
```

`npm test` (105 unit + 36 integration) needs zero runtime dependencies. The optional
browser E2E in `e2e/verify.cjs` drives two real clients through
create/join/vote/reveal/new-round/reconnect/back and needs the one dev
dependency (`playwright` + `npx playwright install chromium`).

## License

MIT
