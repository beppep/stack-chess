import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, connect } from './runtime.mjs';

const DAY = 24 * 60 * 60 * 1000;
const settle = () => new Promise(r => setTimeout(r, 150));
const E2E4 = { t: 'move', from: 52, to: 36 }, E7E5 = { t: 'move', from: 12, to: 28 };

async function setup() {
  const srv = await startServer({ port: 0 });
  const post = (path, body) => fetch(srv.http + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  const tok = {};
  for (const n of ['Ann', 'Ben']) tok[n] = (await post('/api/signup', { name: n, password: 'secret1' })).token;
  const get = async (path, n) => (await fetch(srv.http + path, n ? { headers: { Authorization: 'Bearer ' + tok[n] } } : {})).json();
  const join = async (code, token, extra = {}) => {
    const c = await connect(srv.ws + '/room/' + code);
    c.send({ type: 'hello', token, ...extra });
    return { c, st: await c.next('state') };
  };
  const game = async () => {
    const a = await join('LONG01', 't1', { session: tok.Ann, create: { clock: 'off', color: 'w', rated: true } });
    const b = await join('LONG01', 't2', { session: tok.Ben });
    return { a, b };
  };
  const play = async (w, b) => {
    w.c.send({ type: 'act', round: 1, n: 0, a: E2E4 });
    await b.c.next('act');
    b.c.send({ type: 'act', round: 1, n: 1, a: E7E5 });
    await w.c.next('act');
  };
  // Makes the current turn this many days old.
  const age = async days => {
    const r = srv.env.ROOM.get(srv.env.ROOM.idFromName('LONG01'));
    const s = await r.ctx.storage.get('room');
    s.since -= days * DAY;
    await r.ctx.storage.put('room', s);
  };
  return { srv, tok, get, join, game, play, age };
}

test('a game with no clock is rated and shows on both players\' lists', async t => {
  const { srv, get, game, play } = await setup();
  t.after(() => srv.stop());
  const { a, b } = await game();
  assert.equal(b.st.rated, true);
  await settle();
  assert.deepEqual((await get('/api/games', 'Ann')).map(g => [g.code, g.myTurn, g.color, g.opponent.name]), [['LONG01', true, 'w', 'Ben']]);
  assert.deepEqual((await get('/api/games', 'Ben')).map(g => [g.myTurn, g.color]), [[false, 'b']]);
  await play(a, b);
  a.c.send({ type: 'act', round: 1, n: 2, a: E2E4 }); // a bad move changes nothing
  await a.c.next('state');
  await settle();
  assert.equal((await get('/api/games', 'Ann'))[0].myTurn, true);
  a.c.close(); b.c.close();
});

test('your games needs a login', async t => {
  const { srv } = await setup();
  t.after(() => srv.stop());
  assert.equal((await fetch(srv.http + '/api/games')).status, 401);
});

test('resigning loses on either player\'s turn, moves ratings and clears the lists', async t => {
  const { srv, get, game, play } = await setup();
  t.after(() => srv.stop());
  const { a, b } = await game();
  await play(a, b);
  b.c.send({ type: 'act', round: 1, n: 2, a: { t: 'resign' } }); // not Black's turn
  const m = await a.c.next('act');
  assert.equal(m.a.t, 'resign');
  assert.equal(m.a.c, 'b');
  await settle();
  assert.equal((await get('/api/me', 'Ann')).rating, 1220);
  assert.equal((await get('/api/me', 'Ben')).rating, 1180);
  assert.deepEqual(await get('/api/games', 'Ann'), []);
  assert.deepEqual(await get('/api/games', 'Ben'), []);
  a.c.close(); b.c.close();
});

test('leaving before both players have moved does not count', async t => {
  const { srv, get, game } = await setup();
  t.after(() => srv.stop());
  const { a, b } = await game();
  a.c.send({ type: 'act', round: 1, n: 0, a: E2E4 });
  await b.c.next('act');
  b.c.send({ type: 'act', round: 1, n: 1, a: { t: 'resign' } }); // a resign this early is an abort
  assert.equal((await a.c.next('act')).a.t, 'abort');
  await settle();
  assert.equal((await get('/api/me', 'Ann')).rating, 1200);
  assert.equal((await get('/api/me', 'Ben')).rating, 1200);
  const p = await get('/api/profile/ann');
  assert.deepEqual([p.w, p.l, p.d, p.games.length], [0, 0, 0, 0]);
  assert.deepEqual(await get('/api/games', 'Ann'), []);
  a.c.close(); b.c.close();
});

test('running out of time before your first move only aborts', async t => {
  const { srv, tok, get, join } = await setup();
  t.after(() => srv.stop());
  const a = await join('TIMED1', 't1', { session: tok.Ann, create: { clock: '10+5', color: 'w', rated: true } });
  const b = await join('TIMED1', 't2', { session: tok.Ben });
  a.c.send({ type: 'act', round: 1, n: 0, a: { t: 'flag' } });
  assert.equal((await b.c.next('act')).a.t, 'abort');
  await settle();
  assert.equal((await get('/api/me', 'Ann')).rating, 1200);
  a.c.close(); b.c.close();
});

test('abort is refused once both players have moved', async t => {
  const { srv, game, play } = await setup();
  t.after(() => srv.stop());
  const { a, b } = await game();
  await play(a, b);
  a.c.send({ type: 'act', round: 1, n: 2, a: { t: 'abort' } });
  const st = await a.c.next('state');
  assert.equal(st.actions.length, 2);
  a.c.close(); b.c.close();
});

test('the win can be claimed only after 7 days of silence', async t => {
  const { srv, get, game, play, age } = await setup();
  t.after(() => srv.stop());
  const { a, b } = await game();
  await play(a, b); // White (Ann) is to act, so Ben is the one who may claim
  b.c.send({ type: 'act', round: 1, n: 2, a: { t: 'claim' } });
  assert.equal((await b.c.next('state')).actions.length, 2); // too soon
  await age(6.9);
  b.c.send({ type: 'act', round: 1, n: 2, a: { t: 'claim' } });
  assert.equal((await b.c.next('state')).actions.length, 2);
  await age(0.2);
  a.c.send({ type: 'act', round: 1, n: 2, a: { t: 'claim' } }); // the silent player can't claim
  assert.equal((await a.c.next('state')).actions.length, 2);
  b.c.send({ type: 'act', round: 1, n: 2, a: { t: 'claim' } });
  const m = await a.c.next('act');
  assert.equal(m.a.t, 'claim');
  await settle();
  assert.equal((await get('/api/me', 'Ben')).rating, 1220);
  a.c.close(); b.c.close();
});

test('a resolve and a move are one turn: resolving does not reset the claim', async t => {
  const { srv, tok, get, join } = await setup();
  t.after(() => srv.stop());
  const { c: a } = await join('LONG02', 't1', { session: tok.Ann, create: { clock: 'off', color: 'w', rated: true } });
  const { c: b } = await join('LONG02', 't2', { session: tok.Ben });
  a.send({ type: 'act', round: 1, n: 0, a: E2E4 });
  await b.next('act');
  const before = (await (b.send({ type: 'sync' }), b.next('state'))).since;
  await settle();
  b.send({ type: 'act', round: 1, n: 1, a: { t: 'resolve' } }); // Black's move is still to come
  await a.next('act');
  assert.equal((await (b.send({ type: 'sync' }), b.next('state'))).since, before);
  a.close(); b.close();
});

test('with no clock a rematch does not need the opponent online', async t => {
  const { srv, get, game, play } = await setup();
  t.after(() => srv.stop());
  const { a, b } = await game();
  await play(a, b);
  a.c.send({ type: 'act', round: 1, n: 2, a: { t: 'resign' } });
  await b.c.next('act');
  b.c.close();
  await settle();
  a.c.send({ type: 'rematch' });
  await a.c.next('state'); // the state from the rematch or the next one
  await settle();
  a.c.send({ type: 'sync' });
  for (;;) { const st = await a.c.next('state'); if (st.round === 2) break; }
  const [g] = await get('/api/games', 'Ben');
  assert.equal(g.color, 'w'); // colors swapped
  assert.equal(g.myTurn, true);
  a.c.close();
});

test('your account gets your seat on another device', async t => {
  const { srv, tok, join, game, play } = await setup();
  t.after(() => srv.stop());
  const { a, b } = await game();
  await play(a, b);
  a.c.close();
  const phone = await join('LONG01', 'phone', { session: tok.Ann });
  assert.equal(phone.st.role, 'host');
  phone.c.send({ type: 'act', round: 1, n: 2, a: { t: 'resolve' } });
  await b.c.next('act');
  const other = await join('LONG01', 'stranger', {});
  assert.equal(other.st.role, 'watch'); // anyone else can watch
  phone.c.close(); b.c.close(); other.c.close();
});

test('a waiting game stays listed after the host leaves, until someone joins', async t => {
  const { srv, tok, get, join } = await setup();
  t.after(() => srv.stop());
  const lobby = await connect(srv.ws + '/lobby/play');
  const listed = async n => { for (;;) { const m = await lobby.next('rooms'); if (m.rooms.length === n) return m.rooms; } };
  const a = await join('WAIT01', 't1', { session: tok.Ann, create: { clock: 'off', color: 'b', rated: true } });
  const [r] = await listed(1);
  assert.deepEqual([r.code, r.name, r.account, r.rating, r.clock, r.color], ['WAIT01', 'Ann', true, 1200, null, 'b']);
  await settle();
  assert.equal((await get('/api/games', 'Ann'))[0].waiting, true);
  a.c.close();
  await settle();
  const late = await connect(srv.ws + '/lobby/play');
  assert.equal((await late.next('rooms')).rooms.length, 1);
  const b = await join('WAIT01', 't2', { session: tok.Ben });
  await listed(0);
  assert.equal((await get('/api/games', 'Ann'))[0].waiting, false);
  lobby.close(); late.close(); b.c.close();
});

test('a timed or guest game is not saved in the list', async t => {
  const { srv, tok, join } = await setup();
  t.after(() => srv.stop());
  const a = await join('WAIT02', 't1', { session: tok.Ann, create: { clock: '10+5', color: 'w', rated: true } });
  const g = await join('WAIT03', 't2', { name: 'Guest', create: { clock: 'off', color: 'w', rated: true } });
  await settle();
  const lobby = await connect(srv.ws + '/lobby/play');
  assert.equal((await lobby.next('rooms')).rooms.length, 0);
  lobby.close(); a.c.close(); g.c.close();
});

test('the host can cancel a game nobody joined, and only then', async t => {
  const { srv, tok, get, join, game } = await setup();
  t.after(() => srv.stop());
  const lobby = await connect(srv.ws + '/lobby/play');
  const listed = async n => { for (;;) { const m = await lobby.next('rooms'); if (m.rooms.length === n) return m.rooms; } };
  const a = await join('WAIT04', 't1', { session: tok.Ann, create: { clock: 'off', color: 'w', rated: true } });
  await listed(1);
  a.c.send({ type: 'cancel' });
  await a.c.next('missing');
  await listed(0);
  assert.deepEqual(await get('/api/games', 'Ann'), []);
  const c = await connect(srv.ws + '/room/WAIT04');
  c.send({ type: 'hello', token: 'x' });
  await c.next('missing');
  c.close();
  const { a: a2, b } = await game();
  a2.c.send({ type: 'cancel' });
  assert.equal((await a2.c.next('state')).code, undefined); // refused: it sends the state back
  lobby.close(); a2.c.close(); b.c.close();
});
