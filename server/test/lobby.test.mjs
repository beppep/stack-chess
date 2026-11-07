import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, connect } from './runtime.mjs';

const listed = async (c, n) => { for (;;) { const m = await c.next('rooms'); if (m.rooms.length === n) return m.rooms; } };

test('lobby: online count follows opens and closes', async t => {
  const srv = await startServer({ port: 0 });
  t.after(() => srv.stop());
  const a = await connect(srv.ws + '/lobby/play');
  const b = await connect(srv.ws + '/lobby/play');
  const c = await connect(srv.ws + '/lobby/play');
  assert.equal((await c.next('count')).n, 3);
  while ((await a.next('count')).n !== 3); // a saw 1, 2, 3
  b.close();
  assert.equal((await a.next('count')).n, 2);
  assert.equal((await c.next('count')).n, 2);
  a.close(); c.close();
});

test('lobby: a hosted room is listed for everyone until it is unhosted', async t => {
  const srv = await startServer({ port: 0 });
  t.after(() => srv.stop());
  const a = await connect(srv.ws + '/lobby/play');
  const b = await connect(srv.ws + '/lobby/play');
  a.send({ type: 'host', code: 'ABC234', clock: '10+5', color: 'b', name: 'Ann' });
  const [r] = await listed(b, 1);
  assert.equal(r.code, 'ABC234');
  assert.equal(r.clock, '10+5');
  assert.equal(r.color, 'b');
  assert.equal(r.name, 'Ann');
  assert.equal(r.account, false);
  a.send({ type: 'unhost' });
  await listed(b, 0);
  a.close(); b.close();
});

test('lobby: a room goes away when its host closes the page', async t => {
  const srv = await startServer({ port: 0 });
  t.after(() => srv.stop());
  const a = await connect(srv.ws + '/lobby/play');
  const b = await connect(srv.ws + '/lobby/play');
  a.send({ type: 'host', code: 'ABC234', clock: null, color: 'w', name: '' });
  await listed(b, 1);
  a.close();
  await listed(b, 0);
  b.close();
});

test('lobby: a logged-in host is listed by username, and bad rooms are ignored', async t => {
  const srv = await startServer({ port: 0 });
  t.after(() => srv.stop());
  const token = (await (await fetch(srv.http + '/api/signup', { method: 'POST', body: JSON.stringify({ name: 'Bror', password: 'secret1' }) })).json()).token;
  const a = await connect(srv.ws + '/lobby/play');
  const b = await connect(srv.ws + '/lobby/play');
  a.send({ type: 'host', code: 'nope', clock: '10+5', color: 'w', name: 'x' });
  a.send({ type: 'host', code: 'ABC234', clock: 'bad', color: 'w', name: 'Fake', session: token });
  const [r] = await listed(b, 1);
  assert.equal(r.name, 'Bror');
  assert.equal(r.account, true);
  assert.equal(r.rating, 1200);
  assert.equal(r.clock, null);
  a.close(); b.close();
});

test('rooms made from the list are rated with or without a clock', async t => {
  const srv = await startServer({ port: 0 });
  t.after(() => srv.stop());
  for (const [code, clock, rated] of [['ABC234', '10+5', true], ['ABC235', null, true]]) {
    const a = await connect(srv.ws + '/room/' + code);
    a.send({ type: 'hello', token: 't' + code, name: 'A', create: { clock, color: 'w', rated: true } });
    assert.equal((await a.next('state')).rated, rated);
    a.close();
  }
});

test('lobby: other lobby names are 404', async t => {
  const srv = await startServer({ port: 0 });
  t.after(() => srv.stop());
  const up = { Upgrade: 'websocket' };
  assert.equal((await srv.worker('/lobby/3+2', up)).status, 404);
  assert.equal((await srv.worker('/lobby/off', up)).status, 404);
});

async function sessions(srv, n) {
  const post = (path, body) => fetch(srv.http + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  const out = [];
  for (let i = 0; i < n; i++) out.push((await post('/api/signup', { name: 'Player' + i, password: 'secret1' })).token);
  return out;
}
