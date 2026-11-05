// Stack Chess game server (Cloudflare Workers + Durable Objects).
//   /room/CODE   one Room per game code: seats, every action, clocks, chat, earlier games
//   /lobby/TC    one Lobby per clock setting: pairs two people who press "Search for game"
// Both are WebSocket endpoints. The page sends JSON messages and gets JSON messages back.
import { DurableObject } from 'cloudflare:workers';
import '../../beta/rules.js';
import { Accounts } from './accounts.js';

export { Accounts };

const R = globalThis.StackRules;
const CODE = /^[A-Z0-9]{6}$/;
const LOBBIES = Object.keys(R.TIME_CONTROLS).concat('off');
const LATENCY = 1500;                 // free time on top of each turn for the network
const STEP = 750;                     // the page's resolve animation step, which doesn't count on the clock

export default {
  async fetch(req, env) {
    const [, kind, raw] = new URL(req.url).pathname.split('/');
    const name = decodeURIComponent(raw || '');
    if (kind === 'api') return env.ACCOUNTS.get(env.ACCOUNTS.idFromName('main')).fetch(req);
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Stack Chess server\n');
    if (kind === 'room' && CODE.test(name)) return env.ROOM.get(env.ROOM.idFromName(name)).fetch(req);
    if (kind === 'lobby' && LOBBIES.includes(name)) return env.LOBBY.get(env.LOBBY.idFromName(name)).fetch(req);
    return new Response('Not found', { status: 404 });
  }
};

const send = (ws, msg) => { try { ws.send(JSON.stringify(msg)); } catch (_) {} };
const parse = data => {
  if (typeof data !== 'string' || data.length > 4000) return null;
  try { const m = JSON.parse(data); return m && typeof m === 'object' ? m : null; } catch (_) { return null; }
};
const cleanName = n => (typeof n === 'string' ? n.trim().slice(0, 20) : '');
const randomCode = () => {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
};
function accept(ctx, attachment) {
  const pair = new WebSocketPair();
  ctx.acceptWebSocket(pair[1]);
  pair[1].serializeAttachment(attachment);
  return new Response(null, { status: 101, webSocket: pair[0] });
}

function newRoom(code, clock, hostColor, host, guest, rated = false) {
  return {
    code, clock: R.TIME_CONTROLS[clock] ? clock : null, hostColor: hostColor === 'b' ? 'b' : 'w',
    host, guest, rated: !!rated, accounts: { host: null, guest: null }, reported: 0,
    joined: { host: false, guest: false }, names: {},
    round: 1, actions: [], chat: [], turnStart: 0, grace: 0, pastCount: 0
  };
}
const ready = s => s.joined.host && s.joined.guest;
const playing = G => G.phase === 'move' || G.phase === 'respond';

// One game code. The room keeps the action list and checks every action with the shared rules,
// so a page can't cheat. It also runs the clocks: a player whose time runs out loses even if
// their page is closed. The clock starts once both players have joined, and then always runs.
export class Room extends DurableObject {
  async load() {
    if (this.s === undefined) this.s = (await this.ctx.storage.get('room')) || null;
    return this.s;
  }
  async save() { await this.ctx.storage.put('room', this.s); }
  game() {
    const s = this.s;
    if (!this.G) this.G = R.replay(s.actions, { [s.hostColor]: 'host', [R.other(s.hostColor)]: 'guest' }, R.timeControl(s.clock));
    return this.G;
  }
  colorOf(role) { return role === 'host' ? this.s.hostColor : role === 'guest' ? R.other(this.s.hostColor) : 's'; }
  timeLeft(G) { return G.clock[G.cur] - Math.max(0, Date.now() - this.s.turnStart - this.s.grace); }
  async armClock() {
    const s = this.s, G = this.game();
    if (G.clock && ready(s) && playing(G)) await this.ctx.storage.setAlarm(s.turnStart + s.grace + G.clock[G.cur] + 50);
    else await this.ctx.storage.deleteAlarm();
  }
  sockets() { return this.ctx.getWebSockets().map(ws => ({ ws, me: ws.deserializeAttachment() || {} })); }
  broadcast(msg, except) { for (const { ws, me } of this.sockets()) if (ws !== except && me.role) send(ws, msg); }
  presence(closing) {
    const online = { host: false, guest: false };
    let watchers = 0;
    for (const { ws, me } of this.sockets()) {
      if (ws === closing) continue;
      if (me.role === 'watch') watchers++;
      else if (me.role) online[me.role] = true;
    }
    return { online, watchers, ready: ready(this.s) };
  }
  async stateFor(me) {
    const s = this.s, G = this.game();
    const past = [...(await this.ctx.storage.list({ prefix: 'past:' })).values()];
    return {
      type: 'state', role: me.role, round: s.round, hostColor: s.hostColor, clock: s.clock, actions: s.actions, past,
      names: s.names, rated: !!s.rated, accounts: { host: s.accounts?.host?.name || null, guest: s.accounts?.guest?.name || null },
      chat: s.chat.map(c => ({ c: c.c, r: c.r, text: c.text, n: c.n, mine: c.from === me.token })),
      left: G.clock && ready(s) && playing(G) ? Math.max(0, Math.round(this.timeLeft(G))) : undefined,
      ...this.presence()
    };
  }
  // Saves an action that already went through the rules, restarts the clock and tells everyone else.
  async record(a, animation, except) {
    const s = this.s;
    s.actions.push(a);
    s.turnStart = Date.now();
    s.grace = animation + LATENCY;
    await this.save();
    await this.armClock();
    this.broadcast({ type: 'act', round: s.round, n: s.actions.length - 1, a }, except);
    await this.reportRound();
  }
  // Tells the accounts server how a finished round ended, once per round.
  async reportRound() {
    const s = this.s, G = this.game();
    if (G.phase !== 'over' || (s.reported || 0) >= s.round) return;
    const seat = role => ({ key: s.accounts?.[role]?.key || null, name: s.names[role] || '' });
    const seats = { [s.hostColor]: seat('host'), [R.other(s.hostColor)]: seat('guest') };
    s.reported = s.round;
    await this.save();
    await this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName('main')).report({
      code: s.code, round: s.round, clock: s.clock, hostColor: s.hostColor, actions: s.actions, endedAt: Date.now(),
      rated: !!s.rated, winner: G.result?.winner || null, seats
    });
  }
  async flag(G) {
    const a = { t: 'flag', c: G.cur, by: G.cur === this.s.hostColor ? 'host' : 'guest' };
    if (!R.startAction(G, a)) return;
    await this.record(a, 0, null);
  }

  // Called by the Lobby when two searchers are paired. Returns false if the code is already used.
  async init({ code, clock, hostColor, host, guest, rated }) {
    if (await this.load()) return false;
    this.s = newRoom(code, clock, hostColor, host, guest, rated);
    await this.save();
    return true;
  }

  async fetch(req) {
    const code = new URL(req.url).pathname.split('/')[2];
    return accept(this.ctx, { code });
  }

  async webSocketMessage(ws, data) {
    const m = parse(data);
    if (!m) return;
    const s = await this.load();
    const me = ws.deserializeAttachment() || {};
    if (m.type === 'hello') return this.hello(ws, me, m);
    if (!s || !me.role) return;
    const resync = async () => send(ws, await this.stateFor(me));
    const player = me.role === 'host' || me.role === 'guest';
    switch (m.type) {
      case 'act': {
        const G = this.game(), color = this.colorOf(me.role), a0 = m.a || {};
        if (!player || m.round !== s.round || m.n !== s.actions.length || !ready(s) || G.cur !== color ||
            !['move', 'resolve', 'flag'].includes(a0.t)) return resync();
        const a = { t: a0.t, c: color, by: me.role };
        if (a.t === 'move') { a.from = a0.from; a.to = a0.to; if (a0.p) a.p = String(a0.p); }
        if (G.clock && a.t !== 'flag') {
          // The page says how much time it has left. Trust it only between what the server measured and the time at turn start.
          const min = this.timeLeft(G), max = G.clock[G.cur];
          if (min <= 0) { await this.flag(G); return; }
          a.left = Math.round(Math.min(max, Math.max(min, typeof a0.left === 'number' ? a0.left : min)));
        }
        const stacked = G.stack.length;
        const gen = R.startAction(G, a);
        if (!gen) return resync();
        R.drain(gen);
        // Players watch the stack resolve before their clock starts again.
        await this.record(a, a.t === 'resolve' ? STEP * 0.55 + stacked * STEP * 1.55 : 0, ws);
        return;
      }
      case 'chat': {
        const text = typeof m.text === 'string' ? m.text.trim().slice(0, 300) : '';
        if (!text) return;
        const c = this.colorOf(me.role), r = player ? me.role : 's';
        const n = cleanName(m.n) || (player ? s.names[me.role] || '' : '');
        s.chat = s.chat.concat({ c, r, text, n, from: me.token, t: Date.now() }).slice(-100);
        await this.save();
        this.broadcast({ type: 'chat', c, r, text, n }, ws);
        return;
      }
      case 'name':
        if (!player || s.accounts?.[me.role]) return;
        s.names[me.role] = cleanName(m.name);
        await this.save();
        this.broadcast({ type: 'names', names: s.names }, ws);
        return;
      case 'rematch': {
        // Only with the opponent here, since the new game's clock starts right away.
        if (!player || this.game().phase !== 'over' || !this.presence().online[me.role === 'host' ? 'guest' : 'host']) return resync();
        await this.ctx.storage.put('past:' + String(s.pastCount).padStart(4, '0'), { hostColor: s.hostColor, actions: s.actions });
        s.pastCount++;
        s.round++;
        s.hostColor = R.other(s.hostColor);
        s.actions = [];
        s.turnStart = Date.now();
        s.grace = LATENCY;
        this.G = null;
        await this.save();
        await this.armClock();
        for (const o of this.sockets()) if (o.me.role) send(o.ws, await this.stateFor(o.me));
        return;
      }
      case 'sync':
        return resync();
    }
  }

  async hello(ws, me, m) {
    const token = typeof m.token === 'string' ? m.token.slice(0, 64) : '';
    if (!token) return;
    let s = this.s;
    if (m.create && typeof m.create === 'object') {
      if (!s) s = this.s = newRoom(me.code, m.create.clock, m.create.color, token, null);
      else if (s.host !== token) return send(ws, { type: 'taken' });
    }
    if (!s) return send(ws, { type: 'missing' });
    let role = s.host === token ? 'host' : s.guest === token ? 'guest' : null;
    if (!role && !s.guest) { s.guest = token; role = 'guest'; }
    role = role || 'watch';
    if (role !== 'watch') {
      const who = typeof m.session === 'string' && m.session
        ? await this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName('main')).whoami(m.session.slice(0, 64)) : null;
      s.accounts = s.accounts || { host: null, guest: null };
      s.accounts[role] = who ? { key: who.key, name: who.name } : null;
      s.names[role] = who ? who.name : cleanName(m.name);
      if (!s.joined[role]) {
        s.joined[role] = true;
        if (ready(s)) { s.turnStart = Date.now(); s.grace = LATENCY; } // both are here: White's clock starts
      }
    }
    me.token = token;
    me.role = role;
    ws.serializeAttachment(me);
    await this.save();
    await this.armClock();
    send(ws, await this.stateFor(me));
    this.broadcast({ type: 'names', names: s.names }, ws);
    this.broadcast({ type: 'presence', ...this.presence() }, ws);
  }

  async alarm() {
    if (!(await this.load())) return;
    const G = this.game();
    if (!G.clock || !ready(this.s) || !playing(G)) return;
    if (this.timeLeft(G) > 0) return this.armClock();
    await this.flag(G);
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code); } catch (_) {}
    if (await this.load()) this.broadcast({ type: 'presence', ...this.presence(ws) }, ws);
  }
  async webSocketError(ws) { return this.webSocketClose(ws, 1011); }
}

// One clock setting. Whoever searches waits here; the next person with the same clock is paired
// with them into a new room with a random color, and both are sent its code.
export class Lobby extends DurableObject {
  async fetch(req) {
    const tc = decodeURIComponent(new URL(req.url).pathname.split('/')[2] || '');
    return accept(this.ctx, { tc });
  }
  async webSocketMessage(ws, data) {
    const m = parse(data);
    if (!m || m.type !== 'search' || typeof m.token !== 'string') return;
    const me = ws.deserializeAttachment() || {};
    const token = m.token.slice(0, 64);
    const waiting = this.ctx.getWebSockets().find(o => o !== ws && (o.deserializeAttachment() || {}).token && o.deserializeAttachment().token !== token);
    if (!waiting) { ws.serializeAttachment({ ...me, token }); return; }
    const them = waiting.deserializeAttachment();
    waiting.serializeAttachment({ tc: them.tc }); // taken, so nobody else pairs with them meanwhile
    for (let i = 0; i < 5; i++) {
      const code = randomCode();
      const hostColor = Math.random() < 0.5 ? 'w' : 'b';
      const ok = await this.env.ROOM.get(this.env.ROOM.idFromName(code)).init({ code, clock: me.tc, hostColor, host: them.token, guest: token });
      if (ok) {
        for (const o of [waiting, ws]) { send(o, { type: 'matched', code }); try { o.close(1000); } catch (_) {} }
        return;
      }
    }
  }
  async webSocketClose(ws, code) { try { ws.close(code === 1005 ? 1000 : code); } catch (_) {} }
}
