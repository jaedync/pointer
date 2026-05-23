# Pointer — Stage Card Wrapping & Animation Polish

**Date:** 2026-05-23
**Owner:** Jaedyn Chilton
**Repo:** `~/development/pointer/`, deployed at https://pointer.jaedyn.me

## Background

The stage area renders one card per player. Today the layout is a single non-wrapping flex row of 80×112 cards that compresses horizontally when crowded, then clips. Separately, `renderStage()` re-builds the entire stage every WebSocket update via `cards.innerHTML = ...`, which restarts the `cardIn` keyframe on every card — every vote change causes all cards to re-animate in sequence. The reveal animation is a left-to-right cascade of Y-axis flips with a fixed 100ms per-card stagger.

## Goals

1. Gracefully handle more than ~9 players on the stage without compressing or clipping cards.
2. Replace the "?" waiting-card glyph with a lower-contrast version of the player's actual initial.
3. Stop re-animating every card on every WebSocket update. Animate only the card whose state changed.
4. Give each meaningful state change a small, playful animation that reads as a deliberate gesture, not a re-render.
5. Make the reveal cascade snappier and capped in total duration regardless of player count.

## Non-Goals

- No randomized animation pools (rejected during brainstorming — single canonical animation per event).
- No special-case animation for the local player (consistency with other players preferred).
- No card-by-card "fly from hand to stage" interaction (rejected — too elaborate for this round).
- No new colors, fonts, or theme tokens. Reuse existing CSS variables and the existing 12-color `COLORS` palette.

## Design

### 1 · Stage card wrapping

**Approach:** `flex-wrap: wrap` on `.stage-cards`, cards keep full 80×112 dimensions (`flex-shrink: 0`). The stage zone grows vertically as rows are added.

The absolutely-positioned `.stage-top` and `.stage-action` are currently pinned at `±80px` from the stage's vertical center. That assumes a single-row card block. They must be repositioned so they sit above/below the wrapped card block, never overlap it.

**Specifics:**

- `.stage-cards`: add `flex-wrap: wrap; row-gap: 24px;`. Add `flex-shrink: 0;` to `.stage-card`.
- `.stage-top`: pin to `top: 32px` (was `bottom: calc(50% + 80px)`).
- `.stage-action`: pin to `bottom: 32px` (was `top: calc(50% + 80px)`).
- `.stage`: keep `min-height: 360px` for the single-row case. Stage grows naturally when content wraps.
- Player ordering on every client matches the server's `serializeRoom` array (insertion order via `Map`). This is already universal and matches the sidebar — no change needed.

**Edge case:** When the stage zone grows past the viewport height, normal page scroll handles it. No internal scroll. The total page chrome (header + hand strip) is already accounted for in the existing `min-height: 100vh` flow.

### 2 · Waiting-card style

Drop the `?` glyph entirely. Show the player's actual first initial at low contrast on a faded tan card of the same 80×112 footprint.

**Specifics:**

- `.stage-card-front.sc-waiting`:
  - `background: rgba(212,196,184,0.5)` (was opaque `--waiting`)
  - `box-shadow: none` (was a subtle drop shadow)
- `.stage-card-front.sc-waiting::after`:
  - `border-color: rgba(255,255,255,0.1)` (softer inner frame)
- `.stage-card-front.sc-waiting .sc-init`:
  - `color: rgba(181,168,152,0.55)`
  - `font-size: 22px` (matches the voted state, was 24px on the question mark)
  - `font-weight: 700` (was 800)
- `renderStage()`: change `${isWaiting && !revealed ? '?' : p.name[0].toUpperCase()}` to always render `p.name[0].toUpperCase()`. The waiting/voted styling is purely a class toggle.

Footprint stays 80×112, so cards do not "pop" to a larger size when a player votes. The transition is purely a color/contrast swap.

### 3 · Incremental stage rendering

**Problem:** `renderStage()` writes a fresh `innerHTML` string on every websocket message. This re-creates every DOM node and re-triggers every keyframe.

**Approach:** Add a diff-by-player-id render path. On each tick:

1. Determine the canonical player list (already deterministic — `state.room.players`).
2. For each player ID in the list, find the existing `.stage-card[data-player-id="…"]` node:
   - If missing, create it with the entry animation.
   - If present, compare its current state (voted vs. waiting, color, initial, revealed value, match flag) to the new payload and update only what changed. Trigger the appropriate animation when the meaningful state changes (see §4).
3. Remove any nodes whose IDs are no longer in the list, with a quick exit animation (fade + shrink, 200ms).

**Implementation hint:** A small `renderStageDiff(prev, next)` helper that takes the previous and next serialized player snapshots and emits a list of operations: `add`, `remove`, `update-vote`, `update-clear`, `update-color`, `reveal`, `unreveal`. The existing `renderStage()` continues to be the entry point but delegates body work to this diff. Tests should cover each operation in isolation.

**State that triggers an animation:**

- `update-vote` (was waiting, now has a vote, OR had a vote and value changed): play P1 on that card.
- `update-clear` (had a vote, now waiting): play C4 on that card.
- `reveal`: handled separately by §5.
- `unreveal` (round reset, all cards transition revealed → waiting): play C4 on all cards in sync (no stagger).
- `add`: existing `cardIn` keyframe (entry).
- `remove`: 200ms fade + shrink, then DOM removal.

### 4 · State-change animations on individual cards

Two canonical animations on the player card's outer `.stage-card` element. JS adds an `is-animating-place` or `is-animating-clear` class for the duration of the animation, then removes it. Pure CSS keyframes — no animation library.

**P1 · Tilt-and-snap** — fires on `update-vote` (place or change).

```css
@keyframes pt-place {
  0%   { transform: rotate(0) translateY(0); }
  25%  { transform: rotate(-8deg) translateY(-10px); }
  60%  { transform: rotate(3deg) translateY(2px); }
  100% { transform: rotate(0) translateY(0); }
}
.stage-card.is-animating-place {
  animation: pt-place 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
}
```

**C4 · Gentle wiggle** — fires on `update-clear` (also on `unreveal` for every card in sync).

```css
@keyframes pt-clear {
  0%   { transform: rotate(0); }
  25%  { transform: rotate(-3deg); }
  50%  { transform: rotate(2deg); }
  75%  { transform: rotate(-1deg); }
  100% { transform: rotate(0); }
}
.stage-card.is-animating-clear {
  animation: pt-clear 0.45s ease-out;
}
```

The same animations fire for the local player and for remote players. No special case.

The CSS color transition on `.pt-card-front` (background + box-shadow + initial color) uses the existing `transition: …` shorthand, ~0.35s ease, so the visual state swap dovetails with the motion.

### 5 · Reveal animation

**Order:** Center-out cascade. Cards closer to the array center start flipping first; edges last.

**Timing:** Snappy budget — total reveal duration ≤ 700ms regardless of player count.

- Flip duration: 450ms (per card).
- Cascade window: 250ms (delay range from center to edges).
- Per-card stagger: `cascadeWindow / maxDistanceFromCenter`. For N players, `maxDistanceFromCenter = (N - 1) / 2`, so the step shrinks as N grows. 12 players → ~45ms step. 24 players → ~22ms step. Total stays ≤ 700ms.

**Curve:** Keep the existing `cubic-bezier(0.34, 1.56, 0.64, 1)` so the card lands with a small overshoot.

**Implementation:**

- `.stage-card-inner` transition becomes `transform var(--flip-duration, 0.45s) cubic-bezier(0.34, 1.56, 0.64, 1)`.
- On reveal, JS sets `--flip-duration` on the stage container (or each card) and computes `transition-delay` per card based on distance from `(N-1)/2`.
- The `consensus.values.includes(String(p.vote))` match check stays as-is; the green `.match` ring lights up on flipped cards.

**Wrapping note:** Order is computed by array index, not by visual coordinates. With wrapped rows, the cascade still reads as "from the middle outward" because middle-of-array cards are in row 1 of 2 (or row 2 of 3). Acceptable; no special handling needed.

### 6 · Round reset (unreveal)

When the host starts a new round, the server clears all votes and `revealed` flips back to `false`. The diff produces one `unreveal` operation per card (or a single bulk `unreveal-all`).

Behavior: every card runs the C4 wiggle in sync (no stagger), while the inner card flips back from 180° to 0° using the same 450ms flip duration. The wiggle and flip can run concurrently.

## Testing

All in `room.test.js` / `server.test.js`. New diff helper gets its own unit tests in `render.test.js` or co-located if a `render.js` module is extracted.

- **Wrapping (manual):** Resize browser. Confirm cards wrap at expected breakpoints. Confirm `.stage-top` and `.stage-action` never overlap cards. Confirm 12 players, 18 players, and 24 players all render legibly.
- **Waiting card (manual):** Join a game with two players, confirm both show low-contrast initials. Vote on one client, confirm only that card transitions (color in, no glyph swap).
- **Render diff (unit):**
  - `add` operation: appends a new `.stage-card[data-player-id]` to the container.
  - `remove` operation: removes the matching node.
  - `update-vote` operation: applies `.is-animating-place` class to only the changed card.
  - `update-clear` operation: applies `.is-animating-clear` class to only the changed card.
  - `reveal` operation: sets `--flip-duration` and per-card `transition-delay` derived from `(i - center)`.
  - `unreveal` operation: removes `.flip` class on all cards and applies `.is-animating-clear` to all cards with no stagger.
  - Stable case (no state change): produces zero operations, no DOM mutations, no animation class flips.
- **Reveal cap (unit):** With N = 12, 18, 24, 50: `cascadeWindow / maxDistanceFromCenter` × `maxDistanceFromCenter` ≤ 250ms. Total ≤ 700ms.
- **Order universality (already tested):** Existing `serializeRoom` tests cover that the player array is insertion-ordered; no new test needed.

## Risks & Tradeoffs

- **Diff complexity.** Moving from `innerHTML = ...` to a diff render touches the most-used render path. Risk of bugs (stuck animations, missing classes, leaked nodes). Mitigation: keep diff in its own module with full unit coverage and a smoke E2E that joins → votes → changes → reveals → new-round.
- **Wrapped layout zone overlap.** The `.stage-top` / `.stage-action` zones currently rely on absolute positioning at fixed offsets from center. The new top/bottom pinning is simpler but means the consensus pill / Reveal button position changes slightly even in the single-row case — they'll sit a touch higher/lower than today. Acceptable.
- **Reveal cap at extreme N.** With N = 50, the per-card step drops below 11ms — the cascade becomes nearly imperceptible. Acceptable: very large games look like a near-simultaneous reveal, which still reads well. No additional clamping needed.
- **Animation fatigue at high vote-change frequency.** P1 has a small lift; if a player rapidly toggles votes, the same card animates repeatedly. CSS animations cancel and restart cleanly when the class is re-applied, but it may look busy. Acceptable for now; reconsider if user reports it.

## Open Questions

None. All design decisions finalized via brainstorming session 2026-05-23.

## Files Affected

- `public/index.html` — CSS for `.stage-cards`, `.stage-card`, `.stage-top`, `.stage-action`, `.sc-waiting`, `.stage-card-inner`. New keyframes `pt-place`, `pt-clear`. JS `renderStage()` refactor + new diff helper.
- `room.test.js` / new `render.test.js` — diff helper unit tests.
- No changes to `server.js` or `room.js` (this is purely client-side rendering).
