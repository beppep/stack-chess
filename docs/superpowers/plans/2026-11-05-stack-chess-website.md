# Stack Chess Website Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the beta page into a small game website: home page, optional accounts, Elo, one
"Play online" queue on 10 min + 5 s, leaderboard, profiles, How to play, and a Puzzles/Extras spot.

**Architecture:** The Cloudflare Worker (`server/`) gets a third Durable Object, `Accounts`
(one instance, key-value storage), behind a small JSON HTTP API (`/api/*`). Rooms learn which
account sits in each seat from a session token in `hello` and report every finished round to
`Accounts`, which applies Elo for rated rounds. The single `Lobby` (`/lobby/play`) both counts open
pages ("players online") and pairs searchers. The page (`beta/index.html`, one file as today)
gains hash routes for the new views around the existing game table.

**Tech Stack:** Cloudflare Workers + SQLite-backed Durable Objects (key-value API), WebCrypto
PBKDF2, vanilla JS/HTML/CSS, Node `node:test` with an in-repo stand-in for Durable Objects.

**Spec:** `docs/superpowers/specs/2026-11-05-stack-chess-website-design.md`

## Global Constraints

- Keep the current look: dark background, `--amber #f0b44a` (White), `--teal #5cc6d8` (Black), Cinzel display + Alegreya Sans body, existing `.panel` / `button.btn` / `.btn.primary` styles. No generic blue UI.
- `https://beppep.github.io/stack-chess/` (root `index.html`) is not touched. All page work is in `beta/`.
- Matched games use time control key `'10+5'`. Starting rating `1200`. K = `40` for a player's first `20` rated games, then `20`.
- A round is rated only if it is in a "Play online" room (`rated: true`) and both seats have an account when the round ends. Rematch rounds in such a room are rated too. Invite-link rooms are casual.
- Profiles count every online round played while logged in (rated and casual), each marked rated or casual.
- Usernames: 3–20 chars of `A–Z a–z 0–9 _ -`, unique ignoring case. Passwords: 6–200 chars. No email.
- Passwords stored only as PBKDF2-SHA-256, 100000 iterations, random 16-byte salt.
- Logged-in players' in-game name is their username and can't be edited; guests type any name and are always shown with a "guest" tag.
- Free plan: Durable Objects stay SQLite-backed (`new_sqlite_classes`); no new services.
- Phones: 16px gutters, no horizontal scroll.
- Hash routes for views start with `#/` (e.g. `#/leaderboard`) so they never look like a 6-character game code (`#K7QF2M`) or a replay (`#replay…`).

## Review Focus

1. Same username in different case ("Bror" then "bror") → second signup refused; login works with either case. (Task 3)
2. One account searching from two browsers → never paired with itself. (Task 5)
3. A finished round reaching Accounts twice (alarm + act, a resync, a rematch) → counted once. (Task 3, Task 4)
4. A saved session token the server no longer knows → page silently becomes logged out, nothing breaks. (Task 3, Task 7)
5. A guest typing an existing username as their name → still shown as a guest, no profile link, round not rated. (Task 4)

---

### Task 1: Durable Object stand-in and test runner in the repo

**Files:**
- Create: `server/test/runtime.mjs`, `server/test/cfworkers.mjs`, `server/test/serve.mjs`, `server/test/smoke.test.mjs`
- Modify: `server/package.json` (add `"test": "node --test test/"`)

**Interfaces:**
- Produces: `startServer({ port = 0 }) -> Promise<{ http: string, ws: string, env, stop(): Promise<void> }>` from `runtime.mjs`. It bundles `src/index.js` with `node_modules/@esbuild/win32-x64/esbuild.exe` (`--bundle --format=esm --external:cloudflare:workers`), rewrites the `cloudflare:workers` import to `./cfworkers.mjs` (exports `class DurableObject { constructor(ctx, env) }`), and serves:
  - WebSocket upgrades on `/room/CODE` and `/lobby/NAME` straight to the matching object (`webSocketMessage`, `webSocketClose`, `serializeAttachment`/`deserializeAttachment`, `getWebSockets`).
  - Any other request through `mod.default.fetch(new Request(...), env)`.
  - Namespaces `env.ROOM`, `env.LOBBY`, `env.ACCOUNTS` (only those whose class the module exports) with `idFromName(n)` and `get(id)` returning the instance itself, so RPC calls are plain method calls.
  - Storage `get/put/delete/list({prefix, reverse, limit})`, `setAlarm/deleteAlarm` via `setTimeout`. Before every message and alarm, clear the instance's in-memory caches (`inst.s = undefined; inst.G = null`), like hibernation.
  - Base it on the working stand-in at the old scratchpad (`…/fa1604c5-…/scratchpad/mockcf/run.mjs`), copied into the repo.
- Produces: `serve.mjs` starts it on port 8787 for manual browser testing (`node server/test/serve.mjs`).
- Produces: test helper `connect(url) -> Promise<{ send(obj), next(type?, timeoutMs=2000) -> Promise<msg>, close() }>` exported from `runtime.mjs`, using `ws` from `server/node_modules`.

- [ ] **Step 1: Write `smoke.test.mjs`**: create room `ABC234` with hello `{type:'hello', token:'t1', name:'A', create:{clock:'10+5', color:'w'}}`; expect a `state` with `role: 'host'`; second socket hello `token:'t2'` gets `role: 'guest'`; host sends `{type:'act', round:1, n:0, a:{t:'move', from:52, to:36}}` (e2–e4) and the guest receives `{type:'act', n:0}`.
- [ ] **Step 2: Run `npm test` in `server/`** — expected FAIL (runtime missing).
- [ ] **Step 3: Implement `runtime.mjs`, `cfworkers.mjs`, `serve.mjs`.**
- [ ] **Step 4: Run `npm test`** — expected PASS.
- [ ] **Step 5: Commit** `test: in-repo Durable Object stand-in and smoke test`.

### Task 2: Elo and password helpers

**Files:**
- Create: `server/src/elo.js`, `server/src/password.js`, `server/test/helpers.test.mjs`

**Interfaces:**
- Produces: `rate(a: {rating, rated}, b: {rating, rated}, scoreA: 1|0.5|0) -> { a: number, b: number }` (new rounded ratings; `rated` = rated games played before this one, picks K).
- Produces: `newSalt() -> string` (hex, 16 random bytes), `hashPassword(password: string, salt: string) -> Promise<string>` (hex, PBKDF2-SHA-256, 100000 iterations, 32 bytes), `checkPassword(password, salt, hash) -> Promise<boolean>` (constant-time compare).

- [ ] **Step 1: Write tests:**
  - `rate({rating:1200,rated:0},{rating:1200,rated:0},1)` → `{a:1220,b:1180}`.
  - `rate({rating:1200,rated:30},{rating:1200,rated:30},0.5)` → `{a:1200,b:1200}`.
  - `rate({rating:1400,rated:30},{rating:1200,rated:5},0)` → `a` is `1400 - round(20*0.7597)` = `1385`, `b` is `1200 + round(40*0.7597)` = `1230`.
  - `checkPassword('secret1', s, await hashPassword('secret1', s))` true; wrong password false; two `newSalt()` differ.
- [ ] **Step 2: Run `npm test`** — FAIL.
- [ ] **Step 3: Implement both files** (WebCrypto `crypto.subtle`, available in Workers and Node 20).
- [ ] **Step 4: Run `npm test`** — PASS.
- [ ] **Step 5: Commit** `feat(server): Elo and password hashing helpers`.

### Task 3: Accounts object and HTTP API

**Files:**
- Create: `server/src/accounts.js`, `server/test/accounts.test.mjs`
- Modify: `server/src/index.js` (export `Accounts`, route `/api/*`), `server/wrangler.toml` (binding `ACCOUNTS` → `Accounts`; migration `tag = "v2"`, `new_sqlite_classes = ["Accounts"]`)

**Interfaces:**
- Produces: `class Accounts extends DurableObject`, one instance `env.ACCOUNTS.get(env.ACCOUNTS.idFromName('main'))`. Storage keys:
  - `user:<lowercase name>` → `{ name, salt, hash, rating, rated, w, l, d, created }`
  - `session:<token>` → `<lowercase name>` (token: 32 random bytes hex)
  - `fail:<lowercase name>` → `{ n, until }` (5 wrong passwords → refused for 15 minutes)
  - `done:<code>:<round>` → `true`
  - `game:<lowercase name>:<9999999999999 - endedAt, zero-padded 13>` → round record (newest first by `list({prefix})`)
- Produces RPC methods (used by Room/Lobby):
  - `whoami(token) -> { key, name, rating } | null`
  - `report(r: { code, round, clock, hostColor, actions, endedAt, rated: boolean, winner: 'w'|'b'|null, seats: { w: { key|null, name }, b: { key|null, name } } }) -> { applied: boolean, ratings?: { w, b } }` — returns `{applied:false}` if `done:<code>:<round>` exists. Rated rounds (`r.rated && seats.w.key && seats.b.key`) update `rating`/`rated` via `rate()`. Every seat with a key gets `w/l/d` and a `game:` record `{ code, round, clock, hostColor, actions, endedAt, color, opponent: { name, account: boolean }, result: 'win'|'loss'|'draw', rated, rating, delta }`.
- Produces HTTP API (JSON; every response has `Access-Control-Allow-Origin: *`, `OPTIONS` answers the preflight with `Allow-Methods: GET, POST` and `Allow-Headers: Content-Type, Authorization`):
  - `POST /api/signup {name, password}` → `200 {token, name, rating}` | `400 {error}` (bad name/password) | `409 {error:'That name is taken.'}`
  - `POST /api/login {name, password}` → `200 {token, name, rating}` | `401 {error:'Wrong name or password.'}` | `429 {error}`
  - `POST /api/logout` (header `Authorization: Bearer <token>`) → `200 {}`
  - `GET /api/me` (Bearer) → `200 {name, rating}` | `401 {}`
  - `GET /api/leaderboard` → `200 [{name, rating, w, l, d}]`, every account, sorted by rating desc, then name; at most 100.
  - `GET /api/profile/<name>` → `200 {name, rating, w, l, d, games: [record…up to 50]}` | `404 {}`

- [ ] **Step 1: Write `accounts.test.mjs`:**
  - signup `Bror`/`secret1` → 200 with token; signup `bror` → 409; signup `ab` → 400; signup `Bror!`→ 400; password `12345` → 400.
  - login `BROR`/`secret1` → 200, `name: 'Bror'`; wrong password ×5 then right password → 429.
  - `/api/me` with the token → `{name:'Bror', rating:1200}`; with `deadbeef` → 401; after logout → 401.
  - `report` (called on `env.ACCOUNTS.get(...)` directly) for a rated round, Bror (w) beats Ann (b): Bror 1220, Ann 1180, `w:1`/`l:1`; same `code`/`round` again → `{applied:false}`, ratings unchanged.
  - casual round (Bror vs guest `{key:null,name:'Kim'}`) → Bror's rating unchanged, `d` or `w` counted, profile game has `rated:false`, `opponent.account:false`.
  - `/api/leaderboard` lists Bror before Ann; `/api/profile/BROR` returns games newest first; `/api/profile/nobody` → 404.
  - `OPTIONS /api/login` → 204 with the CORS headers above.
- [ ] **Step 2: Run `npm test`** — FAIL.
- [ ] **Step 3: Implement `accounts.js` and the `/api/*` routing in `index.js`.**
- [ ] **Step 4: Run `npm test`** — PASS (Task 1 smoke test still passes).
- [ ] **Step 5: Commit** `feat(server): accounts, sessions, Elo results and HTTP API`.

### Task 4: Rooms know accounts and report results

**Files:**
- Modify: `server/src/index.js` (`newRoom`, `Room.init`, `Room.hello`, `Room.record`, `Room.stateFor`, `name` handler)
- Create: `server/test/room-accounts.test.mjs`

**Interfaces:**
- Consumes: `Accounts.whoami(token)`, `Accounts.report(r)` (Task 3).
- Produces: `newRoom(code, clock, hostColor, host, guest, rated = false)`; room state gains `rated: boolean`, `accounts: { host: {key, name}|null, guest: {key, name}|null }`, `reported: number` (last round reported).
- Produces: `hello` accepts optional `session`. For a player seat, `accounts[role] = await whoami(session)` on every hello; when set, `names[role]` is the account name and later `name` messages for that seat are ignored.
- Produces: `state` messages gain `rated: boolean` and `accounts: { host: string|null, guest: string|null }` (account names, null for guests).
- Produces: after any recorded action that ends the round (`G.phase === 'over'`, including flags from the alarm), if `s.reported < s.round`: call `report` with `seats` built from `hostColor`, `accounts`, `names`, then set `s.reported = s.round` and save.

- [ ] **Step 1: Write `room-accounts.test.mjs`** (sign up `Ann` and `Ben` through the API first):
  - rated room created with `env.ROOM.get(...).init({code, clock:'10+5', hostColor:'w', host:'t1', guest:'t2', rated:true})`; both hello with their sessions; White sends `{t:'flag'}` (resigns on time); Ann (w) 1180, Ben 1220 via `/api/me`; `state.accounts` is `{host:'Ann', guest:'Ben'}`.
  - rematch in that room (colors swap, so Ben is White), White flags → rated again: Ben loses, both ratings move a second time.
  - invite room (`create` via hello, no `rated`) with both logged in → round counted on profiles with `rated:false`, ratings unchanged.
  - guest hello with `name:'Ann'` and no session in a rated room vs Ben → `state.accounts.guest === null`, round not rated, Ben's rating unchanged.
  - logged-in player sends `{type:'name', name:'Zed'}` → names unchanged.
  - after the round ends, a `sync` and an extra `act` don't report again (Ann's profile has one game for that round).
- [ ] **Step 2: Run `npm test`** — FAIL.
- [ ] **Step 3: Implement the Room changes.**
- [ ] **Step 4: Run `npm test`** — PASS.
- [ ] **Step 5: Commit** `feat(server): rooms bind accounts and report every round`.

### Task 5: One "Play online" lobby with a players-online count

**Files:**
- Modify: `server/src/index.js` (`fetch` routing: only `/lobby/play`; rewrite `Lobby`)
- Create: `server/test/lobby.test.mjs`

**Interfaces:**
- Consumes: `Accounts.whoami`, `Room.init({…, rated:true})`.
- Produces: `/lobby/play` WebSocket. Every open page connects and stays connected.
  - Server → page: `{type:'count', n}` to everyone whenever a socket opens or closes (`n` = open sockets).
  - Page → server: `{type:'search', token, session?}`; `{type:'cancel'}`.
  - Server → page: `{type:'matched', code}` to both searchers (sockets stay open; both stop searching).
  - Pairs the earliest other searcher whose `token` differs and whose account key (from `whoami(session)`) differs or is null. Room: random code (retry 5 times), random `hostColor`, clock `'10+5'`, `rated: true`.
- Removes the per-clock lobbies (`/lobby/1+1` etc. → 404).

- [ ] **Step 1: Write `lobby.test.mjs`:**
  - three sockets connect → the third receives `{type:'count', n:3}`; one closes → others get `n:2`.
  - A and B search → both get the same `matched` code; that room's state has `clock:'10+5'` and `rated:true`.
  - one account (two sessions from two logins, two tokens) searching twice is not paired; a third searcher then pairs with the first.
  - a searcher who sends `cancel` is not paired.
- [ ] **Step 2: Run `npm test`** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`** — PASS.
- [ ] **Step 5: Commit** `feat(server): single Play online lobby with online count`.

### Task 6: Site shell: header, routes, home, How to play, Extras

**Files:**
- Modify: `beta/index.html`
- Modify (outside the repo, for testing): workspace `.claude/launch.json` → `stack-chess-server` runs `node stack-chess-site/server/test/serve.mjs`

**Interfaces:**
- Produces: views `home | game | leaderboard | profile | how | extras | login | signup`, one visible at a time; `route()` reads `location.hash`:
  - `''`, `#`, `#/` → home
  - `#/local`, `#/computer`, `#/online` → game view + `setMode('local'|'cpu'|'online')`
  - `#XXXXXX` (6 chars) and `#replay…` → game view, existing behavior
  - `#/leaderboard`, `#/u/<encoded name>`, `#/how`, `#/extras`, `#/login`, `#/signup`
  - Mode tabs inside the game view set `location.hash` to the matching `#/…` route; `openGame` keeps `#CODE`.
- Produces: site header on every view: logo "Stack **Chess**" (link to `#/`), links Leaderboard, How to play, Extras; right side Log in / Sign up (filled in by Task 7).
- Produces: home view per the approved mockup (layout A): headline "Chess where every move can be answered before it happens", stack explanation line, "What is this? How to play →" (`#/how`), buttons Play online (`.btn.primary`) with `<span id="onlineCount">` under it, Vs computer, Local versus; decorative board with one amber and one teal arrow. Stacks to one column under 820px.
- Produces: How to play view = the current rules list moved out of the `<details id="rules">` box; the box next to the board is replaced by a "How to play" link.
- Produces: Extras view: "Puzzles — coming soon."

- [ ] **Step 1: Implement the router, header and the three static views.**
- [ ] **Step 2: Verify in the browser preview** (static server on the repo + `serve.mjs`): each route shows the right view; back/forward work; `#K7QF2M` still opens a game; a `#replay…` link still opens a replay; same-screen and vs-computer games still play; no console errors; 375px wide has no horizontal scroll.
- [ ] **Step 3: Commit** `feat(beta): site header, routes, home, how to play, extras`.

### Task 7: Accounts in the page

**Files:**
- Modify: `beta/index.html`

**Interfaces:**
- Consumes: `/api/signup`, `/api/login`, `/api/logout`, `/api/me` (Task 3); `state.accounts`, `state.rated` (Task 4).
- Produces: `API = SERVER.replace(/^ws/, 'http')`; `ACCT = { token, name, rating } | null` saved under store key `'session'`; `api(path, { method, body, auth }) -> Promise<{ ok, status, data }>` (network failure → `{ ok:false, status:0 }`).
- Produces: on boot, if a token is saved, `GET /api/me`; on `401` clear `ACCT`; on network failure keep it.
- Produces: login and signup views (username, password, submit, error text from the response, link to the other form); success saves `ACCT`, goes back to the previous view (or home). Header shows `name (rating)` linking to `#/u/<name>` and "Log out".
- Produces: room `hello` includes `session: ACCT && ACCT.token`; when logged in the name input becomes plain text with the username.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Verify in the browser** with `serve.mjs` running: sign up, reload (still logged in), log out, log in with different case, wrong password message, edit the saved token to garbage and reload → logged out with no errors; logged-in name shows in an invite game's seat list and can't be edited.
- [ ] **Step 3: Commit** `feat(beta): log in, sign up, sessions`.

### Task 8: Play online flow and the online panel

**Files:**
- Modify: `beta/index.html`

**Interfaces:**
- Consumes: `/lobby/play` messages (Task 5), `state.accounts` / `state.rated` (Task 4).
- Produces: one lobby socket opened at boot and kept open (reconnect after 3s); `#onlineCount` shows "N players online" (`1 player online` singular).
- Produces: Play online (home button and online panel) = switch to the game view in online mode and send `search`; panel shows "Searching… (10 min + 5 s)" with Cancel (`cancel`). `matched` → `openGame(code)`.
- Produces: online panel changes: per-clock search and its note removed; under the game title a "Rated" or "Casual" label (`Rated` only when `state.rated` and both `accounts` set); seats show account names as links to `#/u/<name>` and guests with a small "guest" tag. "New game" + invite link keep their clock choice.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Verify in the browser** with two profiles (`?profile=a`, `?profile=b`) on `serve.mjs`: home count goes 1 → 2; both press Play online → same game, 10:00 clocks, "Rated" when both logged in, "Casual" with one guest; guest tag and profile links show; Cancel stops the search.
- [ ] **Step 3: Commit** `feat(beta): Play online queue and rated/casual display`.

### Task 9: Leaderboard and profile views

**Files:**
- Modify: `beta/index.html`

**Interfaces:**
- Consumes: `/api/leaderboard`, `/api/profile/<name>` (Task 3); `openReplay({ acts, tc, names })` (existing).
- Produces: leaderboard view: rank, name (link to profile), rating, W/L/D; "No players yet" when empty; "Can't reach the server" on failure.
- Produces: profile view: name, rating, W/L/D, games newest first (opponent name or "guest", result, Rated/Casual, rating change for rated games, date); clicking a game opens its replay with `replay(actions, seats, timeControl(clock)).acts` and both names.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Verify in the browser** after playing one rated and one casual game in Task 8's setup: leaderboard order, profile counts and list, replay opens and steps.
- [ ] **Step 3: Commit** `feat(beta): leaderboard and profiles`.

### Task 10: Deploy and check live

**Files:** none new.

- [ ] **Step 1: `npm test` in `server/`** — all PASS.
- [ ] **Step 2: `npx wrangler deploy` in `server/`** — output lists `env.ACCOUNTS (Accounts)` and the workers.dev URL.
- [ ] **Step 3: Push the repo** (`git pull --rebase`, `git push`).
- [ ] **Step 4: Verify live** at `https://beppep.github.io/stack-chess/beta/?profile=a` and `?profile=b`: sign up two accounts, Play online pairs them, a resign/flag moves both ratings, leaderboard and profiles show it; root page unchanged.
- [ ] **Step 5: Update memory** (`stack-chess-check-rules-idea.md`) with the new site structure.
