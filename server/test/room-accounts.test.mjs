import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, connect } from './runtime.mjs';

async function setup() {
  const srv = await startServer({ port: 0 });
  const post = (path, body) => fetch(srv.http + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  const tok = {};
  for (const n of ['Ann', 'Ben']) tok[n] = (await post('/api/signup', { name: n, password: 'secret1' })).token;
  const me = async n => (await fetch(srv.http + '/api/me', { headers: { Authorization: 'Bearer ' + tok[n] } })).json();
  const profile = async n => (await fetch(srv.http + '/api/profile/' + n)).json();
  const room = code => srv.env.ROOM.get(srv.env.ROOM.idFromName(code));
  // joins a seat and returns {c, st}
  const join = async (code, token, extra = {}) => {
    const c = await connect(srv.ws + '/room/' + code);
    c.send({ type: 'hello', token, ...extra });
    return { c, st: await c.next('state') };
  };
  return { srv, tok, me, profile, room, join };
}
const flag = (c, round) => c.send({ type: 'act', round, n: 0, a: { t: 'flag' } });
const settle = () => new Promise(r => setTimeout(r, 150));

test('rated room: results move ratings, rematch reports again, no double report', async t => {
  const { srv, tok, me, profile, room, join } = await setup();
  t.after(() => srv.stop());
  assert.equal(await room('RATED1').init({ code: 'RATED1', clock: '10+5', hostColor: 'w', host: 't1', guest: 't2', rated: true }), true);
  const a = await join('RATED1', 't1', { session: tok.Ann, name: 'x' });
  const b = await join('RATED1', 't2', { session: tok.Ben });
  assert.equal(b.st.rated, true);
  assert.deepEqual(b.st.accounts, { host: 'Ann', guest: 'Ben' });
  assert.deepEqual(b.st.names, { host: 'Ann', guest: 'Ben' });
  flag(a.c, 1); // White (Ann) runs out of time
  await b.c.next('act');
  await settle();
  assert.equal((await me('Ann')).rating, 1180);
  assert.equal((await me('Ben')).rating, 1220);
  // extra traffic after the end does not report again
  a.c.send({ type: 'sync' });
  flag(a.c, 1);
  await settle();
  assert.equal((await profile('Ann')).games.length, 1);
  assert.equal((await me('Ann')).rating, 1180);
  // rematch: colors swap, Ben is White and runs out of time
  a.c.send({ type: 'rematch' });
  const s2 = await b.c.next('state');
  assert.equal(s2.round, 2);
  assert.equal(s2.hostColor, 'b');
  flag(b.c, 2);
  await a.c.next('act');
  await settle();
  const [ann, ben] = [await me('Ann'), await me('Ben')];
  assert.ok(ann.rating > 1180 && ben.rating < 1220);
  const p = await profile('Ann');
  assert.equal(p.games.length, 2);
  assert.ok(p.games.every(g => g.rated));
  a.c.close(); b.c.close();
});

test('invite room is counted but not rated', async t => {
  const { srv, tok, me, profile, join } = await setup();
  t.after(() => srv.stop());
  const a = await join('INVIT1', 't1', { session: tok.Ann, create: { clock: '10+5', color: 'w' } });
  const b = await join('INVIT1', 't2', { session: tok.Ben });
  assert.equal(b.st.rated, false);
  assert.deepEqual(b.st.accounts, { host: 'Ann', guest: 'Ben' });
  flag(a.c, 1);
  await b.c.next('act');
  await settle();
  const p = await profile('Ann');
  assert.equal(p.games.length, 1);
  assert.equal(p.games[0].rated, false);
  assert.equal(p.games[0].result, 'loss');
  assert.equal((await me('Ann')).rating, 1200);
  assert.equal((await me('Ben')).rating, 1200);
  a.c.close(); b.c.close();
});

test('a guest using an account name is not that account; the round is not rated', async t => {
  const { srv, tok, me, room, join } = await setup();
  t.after(() => srv.stop());
  await room('GUEST1').init({ code: 'GUEST1', clock: '10+5', hostColor: 'b', host: 't1', guest: 't2', rated: true });
  const b = await join('GUEST1', 't1', { session: tok.Ben });
  const g = await join('GUEST1', 't2', { name: 'Ann' });
  assert.equal(g.st.accounts.guest, null);
  assert.equal(g.st.accounts.host, 'Ben');
  g.c.send({ type: 'act', round: 1, n: 0, a: { t: 'flag' } }); // guest is White
  await b.c.next('act');
  await settle();
  assert.equal((await me('Ben')).rating, 1200);
  assert.equal((await me('Ann')).rating, 1200);
  b.c.close(); g.c.close();
});

test('logged-in players cannot rename themselves', async t => {
  const { srv, tok, join } = await setup();
  t.after(() => srv.stop());
  const a = await join('NAMES1', 't1', { session: tok.Ann, create: { clock: '10+5', color: 'w' } });
  const b = await join('NAMES1', 't2', { session: tok.Ben });
  a.c.send({ type: 'name', name: 'Zed' });
  a.c.send({ type: 'sync' });
  const st = await a.c.next('state');
  assert.deepEqual(st.names, { host: 'Ann', guest: 'Ben' });
  a.c.close(); b.c.close();
});
