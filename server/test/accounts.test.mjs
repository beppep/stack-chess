import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './runtime.mjs';

test('accounts: signup, login, sessions, results, leaderboard, profile, CORS', async () => {
  const srv = await startServer({ port: 0 });
  const acc = srv.env.ACCOUNTS.get(srv.env.ACCOUNTS.idFromName('main'));
  const post = (path, body, headers = {}) => fetch(srv.http + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const get = (path, token) => fetch(srv.http + path, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  try {
    // signup
    const su = await post('/api/signup', { name: 'Bror', password: 'secret1' });
    assert.equal(su.status, 200);
    assert.equal(su.headers.get('access-control-allow-origin'), '*');
    const { token, name, rating } = await su.json();
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.deepEqual([name, rating], ['Bror', 1200]);
    assert.equal((await post('/api/signup', { name: 'bror', password: 'secret1' })).status, 409);
    assert.equal((await post('/api/signup', { name: 'ab', password: 'secret1' })).status, 400);
    assert.equal((await post('/api/signup', { name: 'Bror!', password: 'secret1' })).status, 400);
    assert.equal((await post('/api/signup', { name: 'Carl', password: '12345' })).status, 400);
    assert.equal((await post('/api/signup', { name: 'Ann', password: 'hunter22' })).status, 200);

    // login and rate limit
    const li = await post('/api/login', { name: 'BROR', password: 'secret1' });
    assert.equal(li.status, 200);
    assert.equal((await li.json()).name, 'Bror');
    for (let i = 0; i < 2; i++) assert.equal((await post('/api/login', { name: 'bror', password: 'nope' + i })).status, 401);
    assert.equal((await post('/api/login', { name: 'bror', password: 'secret1' })).status, 200); // success resets the counter
    for (let i = 0; i < 5; i++) assert.equal((await post('/api/login', { name: 'Ann', password: 'wrong' + i })).status, 401);
    assert.equal((await post('/api/login', { name: 'Ann', password: 'hunter22' })).status, 429);

    // me / logout
    assert.deepEqual(await (await get('/api/me', token)).json(), { name: 'Bror', rating: 1200 });
    assert.equal((await get('/api/me', 'deadbeef')).status, 401);
    assert.equal((await get('/api/me')).status, 401);
    const other = (await (await post('/api/login', { name: 'bror', password: 'secret1' })).json()).token;
    assert.equal((await post('/api/logout', {}, { Authorization: 'Bearer ' + other })).status, 200);
    assert.equal((await get('/api/me', other)).status, 401);
    assert.equal((await get('/api/me', token)).status, 200);
    assert.deepEqual(await acc.whoami(token), { key: 'bror', name: 'Bror', rating: 1200 });
    assert.equal(await acc.whoami('nope'), null);

    // rated result: Bror (w) beats Ann (b)
    const seats = { w: { key: 'bror', name: 'Bror' }, b: { key: 'ann', name: 'Ann' } };
    const round = { code: 'ABC234', round: 1, clock: '10+5', hostColor: 'w', actions: [{ t: 'move' }], endedAt: 1000, rated: true, winner: 'w', seats };
    assert.deepEqual(await acc.report(round), { applied: true, ratings: { w: 1220, b: 1180 } });
    assert.deepEqual(await acc.report(round), { applied: false });
    const lb = await (await get('/api/leaderboard')).json();
    assert.deepEqual(lb, [{ name: 'Bror', rating: 1220, w: 1, l: 0, d: 0 }, { name: 'Ann', rating: 1180, w: 0, l: 1, d: 0 }]);

    // casual result against a guest: rating unchanged
    await acc.report({ ...round, code: 'CASUAL', endedAt: 2000, rated: false, seats: { w: seats.w, b: { key: null, name: 'Kim' } } });
    const p = await (await get('/api/profile/BROR')).json();
    assert.deepEqual([p.name, p.rating, p.w, p.l, p.d], ['Bror', 1220, 2, 0, 0]);
    assert.deepEqual(p.games.map(g => g.code), ['CASUAL', 'ABC234']);
    assert.equal(p.games[0].rated, false);
    assert.deepEqual(p.games[0].opponent, { name: 'Kim', account: false });
    assert.equal(p.games[0].result, 'win');
    assert.deepEqual([p.games[1].rated, p.games[1].delta, p.games[1].rating, p.games[1].color], [true, 20, 1220, 'w']);
    assert.equal((await get('/api/profile/nobody')).status, 404);

    // CORS preflight
    const pre = await fetch(srv.http + '/api/login', { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    assert.equal(pre.headers.get('access-control-allow-methods'), 'GET, POST');
    assert.equal(pre.headers.get('access-control-allow-headers'), 'Content-Type, Authorization');
    assert.equal(await (await fetch(srv.http + '/')).text(), 'Stack Chess server\n');
  } finally { await srv.stop(); }
});
