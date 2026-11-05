import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, connect } from './runtime.mjs';

const quiet = (c, ms = 300) => c.next('matched', ms).then(() => false, () => true);

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

test('lobby: two searchers get a rated 10+5 room', async t => {
  const srv = await startServer({ port: 0 });
  t.after(() => srv.stop());
  const a = await connect(srv.ws + '/lobby/play');
  const b = await connect(srv.ws + '/lobby/play');
  a.send({ type: 'search', token: 'tokA' });
  b.send({ type: 'search', token: 'tokB' });
  const [ma, mb] = [await a.next('matched'), await b.next('matched')];
  assert.match(ma.code, /^[A-Z0-9]{6}$/);
  assert.equal(ma.code, mb.code);
  const room = srv.env.ROOM.get(ma.code);
  await room.load();
  assert.equal(room.s.clock, '10+5');
  assert.equal(room.s.rated, true);
  assert.deepEqual([room.s.host, room.s.guest].sort(), ['tokA', 'tokB']);
  a.close(); b.close();
});

test('lobby: same account is not paired with itself; a third searcher pairs with the first', async t => {
  const srv = await startServer({ port: 0 });
  t.after(() => srv.stop());
  const post = (path, body) => fetch(srv.http + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  const s1 = (await post('/api/signup', { name: 'Bror', password: 'secret1' })).token;
  const s2 = (await post('/api/login', { name: 'Bror', password: 'secret1' })).token;
  assert.notEqual(s1, s2);
  const a = await connect(srv.ws + '/lobby/play');
  const b = await connect(srv.ws + '/lobby/play');
  const c = await connect(srv.ws + '/lobby/play');
  a.send({ type: 'search', token: 'tokA', session: s1 });
  await new Promise(r => setTimeout(r, 100)); // let the first search settle
  b.send({ type: 'search', token: 'tokB', session: s2 });
  assert.ok(await quiet(a) && await quiet(b));
  c.send({ type: 'search', token: 'tokC' });
  const [ma, mc] = [await a.next('matched'), await c.next('matched')];
  assert.equal(ma.code, mc.code);
  assert.ok(await quiet(b));
  a.close(); b.close(); c.close();
});

test('lobby: a searcher who cancels is not paired', async t => {
  const srv = await startServer({ port: 0 });
  t.after(() => srv.stop());
  const a = await connect(srv.ws + '/lobby/play');
  const b = await connect(srv.ws + '/lobby/play');
  a.send({ type: 'search', token: 'tokA' });
  a.send({ type: 'cancel' });
  b.send({ type: 'search', token: 'tokB' });
  assert.ok(await quiet(a) && await quiet(b));
  a.close(); b.close();
});

test('lobby: other lobby names are 404', async t => {
  const srv = await startServer({ port: 0 });
  t.after(() => srv.stop());
  const up = { Upgrade: 'websocket' };
  assert.equal((await srv.worker('/lobby/3+2', up)).status, 404);
  assert.equal((await srv.worker('/lobby/off', up)).status, 404);
});
