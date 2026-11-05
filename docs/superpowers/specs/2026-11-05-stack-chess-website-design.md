# Stack Chess website: design

Date: 2026-11-05. Owner: Bror (game designer). Status: draft for approval.

## Intent

Stack Chess is Bror's chess variant: moves go on a Magic-style stack, the opponent can respond
on top, and the stack resolves last-in-first-out. Today it is one game page
(https://beppep.github.io/stack-chess/) plus a beta (`/beta/`) whose online mode runs on a
Cloudflare Workers + Durable Objects server (`server/`, deployed at
`https://stack-chess.bror-beppe-persson.workers.dev`).

Bror wants it to become a proper game website, in the spirit of chess.com: a front page, accounts,
ratings, matchmaking, a leaderboard. It should look and feel like a full game, not a demo page.

Why now: online play already works on the server, so accounts and ratings are the next step to make
it a site people come back to. There are almost no players yet, so matchmaking must pair anyone who
is searching.

## Goals

- A home page that tells a newcomer what this is and gets them into a game in one click.
- Optional accounts that keep a player's rating, game history and name.
- An Elo rating, updated after rated online games.
- "Play online" pairs any two people who are searching, on one fixed clock.
- A leaderboard and a profile page per account.
- A How to play page.

## Non-goals (for now)

Puzzles: Bror wants Stack Chess puzzles with difficulty levels, but as a separate project with
its own design after this one (where puzzles come from and what makes one good is Bror's call).
This site should leave a place for it: a "Puzzles" (or "Extras") entry somewhere on the site,
which can say "coming soon" until then.

Friends lists, tournaments, private messages, rating graphs, email, password reset,
Google or other third-party sign-in, multiple ratings per time control.

## Anti-goals

- **No account features for their own sake.** Bror: accounts exist only for things that need an
  account to keep track of a person. Anything that works without an account stays available to guests.
- **Don't lose the current look.** The site keeps the game's existing visual style: dark "game table
  at night" background, amber (White) and teal (Black), Cinzel display font, Alegreya Sans body font,
  the existing panel and button styles (`--bg #14121b`, `--panel #1d1a27`, `--amber #f0b44a`,
  `--teal #5cc6d8`, etc. in `index.html`). No generic blue UI.
- **Don't break the live page.** `https://beppep.github.io/stack-chess/` stays as it is until Bror
  says to switch.

## Decided by Bror

### Home page (layout "A")

Approved mockup (in the game's own style):

- Top bar: "Stack **Chess**" logo on the left (Chess in amber), **Log in** and **Sign up** on the right.
- Left: headline "Chess where every move can be answered before it happens", one or two lines about
  the stack, and a "What is this? How to play →" link.
- Three mode buttons, stacked:
  - **Play online** (primary, amber), with "N players online" under it.
  - **Vs computer**.
  - **Local versus** (two players, one screen).
- Right: a board with an amber and a teal stack arrow, so the game is recognizable at a glance.

### Accounts

- Only for: rating, game history, keeping your name.
- Sign up with username and password. No email. (Accepted downside: a forgotten password can't be recovered.)
- Guests can play everything, online included, and can name themselves, as today.

### Online play and rating

- **Play online** pairs any two people who are searching. No clock choice on that button: every
  matched game uses **10 min + 5 s** (the existing `10+5` time control).
- A game counts for rating only if **both** players are logged in. A game with a guest is casual.
- Rematches in a rated "Play online" room count for rating too (every round, not just the first).
- Other clocks remain available through "New game" + invite link, as today.
- One rating per account.

### Other pages

- **Leaderboard**: accounts sorted by rating.
- **Profile**: name, rating, wins/losses/draws, past games; clicking a game opens its replay
  (the replay viewer already exists). Stats and the game list cover **every** online game played
  while logged in: rated, casual against guests, and invite-link games, each marked rated or casual.
  So every Room must know which account (if any) sits in each seat and report every finished round.
- **How to play**: for now, the current rules text on its own page. Bror wants to design this page
  carefully later, as a separate piece of work.

### Where it is built

At `/stack-chess/beta/` (and the existing server), like the current beta. The live main page is
untouched until Bror says to switch.

## Calls made by Claude (Bror can override)

- Standard Elo, everyone starts at 1200, ratings move faster for a player's first games
  (e.g. K=40 for the first 20 rated games, then K=20).
- The game screen itself (board, stack column, side panel, clocks, chat) stays as it is today; the
  new pages are around it.
- Everything runs on the existing free Cloudflare setup (Workers + SQLite-backed Durable Objects);
  no new paid services.
- Matchmaking and casual/rated rules apply to "Play online". Invite-link games are casual.
- The per-clock "Search for game" (1+1, 3+2, 5+3, 10+5 lobbies) goes away: "Play online" is the
  only search, so the few players there are all land in one pool.
- When logged in, your in-game name is your username (no separate display name). Guests can type
  any name, but they are always shown as guests (e.g. a "guest" tag, no profile link), so they
  can't pass for an account.

## Constraints

- Free Cloudflare plan. Durable Objects must stay SQLite-backed (`new_sqlite_classes`).
- The page is hosted on GitHub Pages (static files). Only the server can store accounts.
- Rules are shared between page and server through `beta/rules.js`; the server checks every move.
- Existing beta features must keep working: reconnect and keep your seat, spectators, chat,
  rematch, replays of earlier games in a room, the bot (vs computer), same-screen play, the flag
  alarm that ends a game when time runs out with the page closed.
- Must work on phones (16px gutters, no horizontal scroll), as the current page does.
- Passwords are never stored in plain text (hash with a slow salted hash, e.g. PBKDF2 via WebCrypto).

## Current code to build on

- `beta/index.html`: the whole game page (UI, bot, online client). Identity today is a random token
  per browser in `localStorage` (`stackchess2[-profile]:me`), sent in the room `hello` message.
- `beta/rules.js`: game rules, shared with the server.
- `server/src/index.js`: `Room` Durable Object per 6-letter game code (seats by token, actions,
  clocks, chat, rematch, past rounds), `Lobby` Durable Object per time control (pairs two searchers,
  creates a Room via RPC `init`). Deploy with `npx wrangler deploy` in `server/` (already logged in
  on Bror's PC).

## Left to the builder

- How pages are organized (one page with views vs several HTML files), as long as the look, links
  and back button behave like a normal website.
- Where accounts, sessions, ratings and game records live on the server (for example a single
  Accounts Durable Object with SQLite), and the message/HTTP format.
- How a logged-in browser proves who it is to the Room and Lobby (session token), and how a finished
  rated game reports its result exactly once.
- How "players online" is counted.
- Username rules (length, allowed characters, uniqueness ignoring case) and basic rate limiting on
  login attempts.
- What happens to an unfinished rated game where a player never comes back (the clock already flags
  them; a flag loss counts like any loss).
