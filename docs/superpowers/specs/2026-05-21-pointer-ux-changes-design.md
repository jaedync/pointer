# Pointer — UX Changes Design

**Date:** 2026-05-21
**Status:** Approved (design), pending implementation plan

## Overview

Eight changes to Pointer, the real-time scrum poker app. Seven are direct UX
fixes; one (disagreement highlighting) is a new feature that grew out of the
consensus-layout discussion. All changes touch `public/index.html`; one also
touches `room.js`. The server (`server.js`) needs no changes.

---

## 1. Clean URLs — unified `/CODE` route

**Current:** hash routing — `#/` (landing), `#/join/CODE` (pre-join),
`#/room/CODE` (in room). Routing logic in `handleRoute()`, driven by the
`hashchange` event and `location.hash` assignments.

**Target:** History API path routing.

- `/` — landing page.
- `/CODE` — the room. One URL for both the invite link and the in-room
  address; the `join` / `room` split is collapsed.

**Behavior:**

- Visiting `/CODE` cold (not yet in the room) triggers the existing join flow
  (name prompt, with the localStorage-remembered name pre-filled). Once joined,
  the URL stays `/CODE`.
- Creating or joining a room: `history.pushState(null, '', '/' + roomId)`.
- Leaving a room: `history.pushState(null, '', '/')`.
- Browser back/forward handled via a `popstate` listener (replaces
  `hashchange`).
- Invalid code (`/BADCODE` where no room exists): the join attempt returns the
  server's existing "Room not found" error; the client then redirects to `/`.
- Invite link becomes `location.origin + '/' + roomId` (was
  `origin + pathname + '#/join/' + id`).
- Room codes remain case-insensitive — lowercase the path segment before use,
  consistent with the existing case-insensitive join.

**Why no server change:** `server.js` already serves `public/index.html` for
any request whose path has no static-asset extension. A bare `/CODE` segment
has no extension, so it already resolves to the SPA. Static assets
(`/favicon.svg`, fonts, etc.) keep their extensions and are unaffected.

---

## 2. Vote during the countdown

**Current:** when a reveal is initiated, a 3-second countdown runs. During it,
the client locks the hand — `pickCard()` early-returns on `state.countdown`,
and `renderHand()` adds the `hand-locked` class on `state.countdown`.

**Target:** the hand stays interactive during the countdown so a player can
make a last-second change. Whatever each player has selected when the timer
fires is what gets revealed.

**Implementation:** client-only change. Remove `state.countdown` from the
`pickCard()` guard and from the `renderHand()` lock check. Keep the
`state.room.revealed` lock in both — the hand still locks once cards are
actually revealed.

**Why no server change:** `room.vote()` / `room.clearVote()` already reject
votes only when `room.revealed` is true — they do not block during the
countdown. `applyReveal()` reads each player's current vote when the timer
fires, so a vote changed mid-countdown is captured correctly.

**Notes:** the countdown overlay is `position: absolute` inside `.stage`; the
hand is a separate grid cell, so the overlay never covered the hand. The
server-timed countdown is unaffected by vote messages — changing a vote does
not reset or cancel it.

---

## 3. Bigger revealed-card text

Option C from the card-sizing mockups. On the revealed card back
(`.stage-card-back`):

| Element            | Current | New  |
|--------------------|---------|------|
| Score (`.sc-value`)| 30px    | 42px |
| Name (`.sc-name`)  | 9px     | 14px |
| Name bar (`.sc-name-bar`) height | 26px | 36px |

The name-bar text also upgrades from `font-weight: 600` / `rgba(255,255,255,
0.7)` to `font-weight: 700` / `rgba(255,255,255,0.95)` for legibility. The card
footprint stays 80×112 (60×84 on mobile — verify the larger text still fits the
mobile card, scale down proportionally if needed).

---

## 4. Consensus moves above the cards

**Current stage column order:** status → cards → big-average → action. The
whole column is centered with `justify-content: center`.

**Target:** the consensus headline sits **above** the card row.

- The card row is pinned to the vertical center of the stage so it does not
  shift between the voting and revealed states, and does not move relative to
  where it sits today.
- Consensus headline occupies a reserved zone above the cards; the action
  button sits below. Both zones reserve their space in all states so the card
  row never jumps.
- The **"Results" status line is removed** in the revealed state — the cards
  and the consensus pill already communicate it. The voting-state status
  ("X of Y voted") is kept; it occupies the same top zone.

---

## 5. Consensus pill

Option B from the consensus mockups. Replace the floaty `big-average` text
with a **filled peach pill**:

- Solid accent (`#d4856a`) background, fully rounded.
- Label (uppercase, small) and value side by side.
- Value sits in its own inset disc (`rgba(255,255,255,0.16)` background).
- Drop shadow for lift.

Pill color and label vary by consensus state — see §6.

---

## 6. Disagreement highlighting (new feature)

After a reveal, mark the cards that landed on the most-common value with a
**green ring** (2.5px solid `#6aad8c` + soft drop glow). Differing cards stay
plain — no orange, no legend. Positive framing: green spotlights agreement; its
absence reads as off-consensus on its own.

### Consensus rule

Computed from the revealed votes. `?` votes and non-votes are excluded from the
tally and never receive a ring.

1. Tally a count per distinct voted value.
2. `maxCount` = the highest tally.
3. **`maxCount < 2`** (everyone voted a different value, or ≤1 vote total) →
   **No consensus**. No rings. Pill is neutral grey, label "No consensus", an
   em-dash in place of the value.
4. Otherwise, `topValues` = every value whose count equals `maxCount`.
   - **One value, and `maxCount` equals the total number of players who voted
     at all (including `?` votes)** → **Unanimous**. All cards ringed. Pill
     turns green (`#6aad8c`), label "Unanimous", value shown. (A single `?`
     vote in the round therefore prevents Unanimous — it falls to Consensus.)
   - **One value, not covering everyone** → **Consensus**. That value's cards
     ringed. Peach pill, label "Consensus", value shown.
   - **Two or more tied values** → **Split**. All tied camps' cards ringed
     green. Peach pill, label "Split", lists the tied values (each in its own
     disc).

### Behavior change to flag

Numeric decks (Fibonacci, Powers, Simple) currently show **"Average N.N"** (the
arithmetic mean). The mean is not a real card value, so it cannot drive the
green rings. The pill therefore switches to the **mode-based consensus** above
for **all** decks; the average is dropped. (Confirmed acceptable by the user
during design.)

### Where the logic lives

Add a pure `computeConsensus(votes)` function to `room.js`, exported and
unit-tested. `serializeRoom()` calls it when `room.revealed` is true and
includes the result on the serialized room (e.g. `room.consensus = { state,
values, maxCount }`). The client renders rings and the pill purely from this
field — single source of truth, server-computed, testable. The existing
client-side "Average / Consensus" computation in `renderStage()` is removed.

---

## 7. Room title contrast

`.room-name` in the header is `color: #8a7a6e` on the dark coffee header —
contrast is too low. Raise it to a lighter tone (target ≈ `#c9bcae`), verified
to read clearly against the header background. Adjust the value during
implementation if it looks heavy or still weak.

---

## 8. Page title

`document.title` is the static `"Pointer – Scrum Poker"`. Make it lead with the
room name:

- In a room: `"<RoomName> · Pointer"`.
- On the landing page: `"Pointer · Scrum Poker"`.

Update it on route changes and when the room state (name) changes.

---

## 9. Scroll sliver

There is a slight vertical overflow — a thin strip of extra space at the bottom
of the page that makes it marginally scrollable. Root cause unknown; debug live
in the browser. Candidates to check:

- `body { min-height: 100vh }` combined with the `#app` flex column —
  header + `.game-main` may exceed the viewport by a few pixels.
- A stray `}` in the CSS near line 628 (after `.stage-card-back .sc-name`).
- Header or grid heights not accounting for borders (`box-sizing`).

Fix the root cause rather than masking with `overflow: hidden`.

---

## Files touched

- `public/index.html` — routing (§1), countdown unlock (§2), card text (§3),
  stage layout (§4), consensus pill (§5), ring rendering + pill from
  `room.consensus` (§6), room-name color (§7), `document.title` (§8), scroll
  fix (§9).
- `room.js` — `computeConsensus()` pure function + `serializeRoom()` wiring
  (§6).
- `server.js` — no changes.

## Testing

- `room.js`: unit tests for `computeConsensus()` covering every branch of the
  rule — no consensus (all distinct, ≤1 vote), unanimous, single-value
  consensus, 2-way tie, 3-way tie, `?`-vote exclusion.
- `server.js` integration: a vote sent during the countdown window is reflected
  in the revealed result.
- Manual / browser: clean-URL navigation and back/forward, invalid-code
  redirect, countdown voting, revealed-card sizing, consensus placement and
  pill states, room-title contrast, page title, no scroll.
