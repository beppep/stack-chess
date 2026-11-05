import test from 'node:test';
import assert from 'node:assert/strict';
import { rate } from '../src/elo.js';
import { newSalt, hashPassword, checkPassword } from '../src/password.js';

test('rate: equal new players, win', () => {
  assert.deepEqual(rate({ rating: 1200, rated: 0 }, { rating: 1200, rated: 0 }, 1), { a: 1220, b: 1180 });
});
test('rate: equal veterans, draw', () => {
  assert.deepEqual(rate({ rating: 1200, rated: 30 }, { rating: 1200, rated: 30 }, 0.5), { a: 1200, b: 1200 });
});
test('rate: K depends on each player\'s own rated count', () => {
  assert.deepEqual(rate({ rating: 1400, rated: 30 }, { rating: 1200, rated: 5 }, 0), { a: 1385, b: 1230 });
});
test('password: right, wrong, salts differ', async () => {
  const s = newSalt();
  assert.match(s, /^[0-9a-f]{32}$/);
  const h = await hashPassword('secret1', s);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(await checkPassword('secret1', s, h), true);
  assert.equal(await checkPassword('secret2', s, h), false);
  assert.notEqual(newSalt(), newSalt());
});
