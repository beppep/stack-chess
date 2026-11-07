// Optional accounts: one Durable Object ('main') holds every account, login session and finished game.
// The page calls it over HTTP (/api/*); Room and Lobby call whoami() and report() directly.
import { DurableObject } from 'cloudflare:workers';
import { rate } from './elo.js';
import { newSalt, hashPassword, checkPassword } from './password.js';

const NAME = /^[A-Za-z0-9_-]{3,20}$/;
const TRIES = 5;                      // wrong passwords before a name is locked
const LOCK = 15 * 60 * 1000;          // for this long
const CORS = {
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const newToken = () => [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2, '0')).join('');
const gameKey = (key, endedAt) => 'game:' + key + ':' + String(9999999999999 - endedAt).padStart(13, '0');

export class Accounts extends DurableObject {
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
    let body = {};
    if (req.method === 'POST') { try { body = (await req.json()) || {}; } catch (_) {} }
    if (req.method === 'POST' && path === '/api/signup') return this.signup(body.name, body.password);
    if (req.method === 'POST' && path === '/api/login') return this.login(body.name, body.password);
    if (req.method === 'POST' && path === '/api/logout') { await this.ctx.storage.delete('session:' + bearer); return json({}); }
    if (req.method === 'GET' && path === '/api/me') {
      const me = await this.whoami(bearer);
      return me ? json({ name: me.name, rating: me.rating }) : json({}, 401);
    }
    if (req.method === 'GET' && path === '/api/leaderboard') return this.leaderboard();
    if (req.method === 'GET' && path === '/api/games') {
      const me = await this.whoami(bearer);
      return me ? this.games(me.key) : json({}, 401);
    }
    if (req.method === 'GET' && path.startsWith('/api/profile/')) {
      let who;
      try { who = decodeURIComponent(path.slice(13)).toLowerCase(); } catch (_) { return json({}, 404); }
      return this.profile(who);
    }
    return json({}, 404);
  }

  async startSession(key, name, rating) {
    const token = newToken();
    await this.ctx.storage.put('session:' + token, key);
    return json({ token, name, rating });
  }

  async signup(name, password) {
    if (typeof name !== 'string' || !NAME.test(name)) return json({ error: 'Names are 3-20 letters, digits, _ or -.' }, 400);
    if (typeof password !== 'string' || password.length < 6 || password.length > 200) return json({ error: 'Passwords are 6-200 characters.' }, 400);
    const key = name.toLowerCase(), salt = newSalt(), hash = await hashPassword(password, salt);
    if (await this.ctx.storage.get('user:' + key)) return json({ error: 'That name is taken.' }, 409);
    const user = { name, salt, hash, rating: 1200, rated: 0, w: 0, l: 0, d: 0, created: Date.now() };
    await this.ctx.storage.put('user:' + key, user);
    return this.startSession(key, name, user.rating);
  }

  async login(name, password) {
    const bad = () => json({ error: 'Wrong name or password.' }, 401);
    if (typeof name !== 'string' || !NAME.test(name) || typeof password !== 'string' || password.length > 200) return bad();
    const key = name.toLowerCase(), st = this.ctx.storage;
    const user = await st.get('user:' + key);
    if (!user) return bad(); // unknown names get no fail record
    // Count the attempt before the slow hash so parallel guesses all count; a success clears it.
    let fail = (await st.get('fail:' + key)) || { n: 0, until: 0 };
    if (fail.until && fail.until <= Date.now()) fail = { n: 0, until: 0 };
    if (fail.until > Date.now()) return json({ error: 'Too many wrong passwords. Try again in 15 minutes.' }, 429);
    fail.n++;
    if (fail.n >= TRIES) fail.until = Date.now() + LOCK;
    await st.put('fail:' + key, fail);
    if (!(await checkPassword(password, user.salt, user.hash))) return bad();
    await st.delete('fail:' + key);
    return this.startSession(key, user.name, user.rating);
  }

  async whoami(token) {
    if (typeof token !== 'string' || !token) return null;
    const key = await this.ctx.storage.get('session:' + token);
    const user = key && (await this.ctx.storage.get('user:' + key));
    return user ? { key, name: user.name, rating: user.rating } : null;
  }

  async leaderboard() {
    const users = [...(await this.ctx.storage.list({ prefix: 'user:' })).values()];
    users.sort((a, b) => b.rating - a.rating || (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));
    return json(users.slice(0, 100).map(({ name, rating, w, l, d }) => ({ name, rating, w, l, d })));
  }

  async profile(key) {
    const user = await this.ctx.storage.get('user:' + key);
    if (!user) return json({}, 404);
    const games = [...(await this.ctx.storage.list({ prefix: 'game:' + key + ':', limit: 50 })).values()];
    return json({ name: user.name, rating: user.rating, w: user.w, l: user.l, d: user.d, games });
  }

  // A player's unfinished games, the ones waiting for them first.
  async games(key) {
    const games = [...(await this.ctx.storage.list({ prefix: 'active:' + key + ':' })).values()];
    games.sort((a, b) => b.myTurn - a.myTurn || a.since - b.since);
    return json(games);
  }

  // A room tells us how its game stands, so each player's list stays current.
  async touch(g) {
    const st = this.ctx.storage;
    if (await st.get('done:' + g.code + ':' + g.round)) return; // a late message about a finished round
    for (const c of ['w', 'b']) {
      const me = g.seats[c], opp = g.seats[c === 'w' ? 'b' : 'w'];
      if (!me.key) continue;
      await st.put('active:' + me.key + ':' + g.code, {
        code: g.code, color: c, clock: g.clock, since: g.since, waiting: g.waiting, myTurn: !g.waiting && g.cur === c,
        rated: !!(g.rated && opp.key), opponent: { name: opp.name, account: !!opp.key }
      });
    }
  }
  async forget(code, seats) {
    for (const c of ['w', 'b']) if (seats[c].key) await this.ctx.storage.delete('active:' + seats[c].key + ':' + code);
  }

  // A finished round. Counted once per code and round; rated only when both players have accounts.
  // An aborted round leaves no trace: no game on the profile, no change to anyone's record.
  async report(r) {
    const st = this.ctx.storage, done = 'done:' + r.code + ':' + r.round;
    if (await st.get(done)) return { applied: false };
    await st.put(done, true);
    await this.forget(r.code, r.seats);
    if (r.aborted) return { applied: true };
    const users = {};
    for (const c of ['w', 'b']) users[c] = r.seats[c].key && (await st.get('user:' + r.seats[c].key));
    const score = r.winner === 'w' ? 1 : r.winner === 'b' ? 0 : 0.5;
    const rated = !!(r.rated && users.w && users.b && r.seats.w.key !== r.seats.b.key);
    const now = rated ? rate(users.w, users.b, score) : null;
    const ratings = rated ? { w: now.a, b: now.b } : undefined;
    for (const c of ['w', 'b']) {
      const u = users[c];
      if (!u) continue;
      const key = r.seats[c].key, o = c === 'w' ? 'b' : 'w';
      const result = r.winner === c ? 'win' : r.winner ? 'loss' : 'draw';
      const before = u.rating;
      u[result === 'win' ? 'w' : result === 'loss' ? 'l' : 'd']++;
      if (rated) { u.rating = ratings[c]; u.rated++; }
      await st.put('user:' + key, u);
      await st.put(gameKey(key, r.endedAt), {
        code: r.code, round: r.round, clock: r.clock, hostColor: r.hostColor, actions: r.actions, endedAt: r.endedAt,
        color: c, opponent: { name: r.seats[o].name, account: !!r.seats[o].key }, result, rated, rating: u.rating, delta: u.rating - before
      });
    }
    return rated ? { applied: true, ratings } : { applied: true };
  }
}
