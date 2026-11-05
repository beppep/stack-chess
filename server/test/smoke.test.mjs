import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, connect } from './runtime.mjs';

test('room: host and guest join, move is relayed', async () => {
  const srv = await startServer({ port: 0 });
  try {
    const host = await connect(srv.ws + '/room/ABC234');
    host.send({ type: 'hello', token: 't1', name: 'A', create: { clock: '10+5', color: 'w' } });
    assert.equal((await host.next('state')).role, 'host');
    const guest = await connect(srv.ws + '/room/ABC234');
    guest.send({ type: 'hello', token: 't2', name: 'B' });
    assert.equal((await guest.next('state')).role, 'guest');
    host.send({ type: 'act', round: 1, n: 0, a: { t: 'move', from: 52, to: 36 } });
    assert.equal((await guest.next('act')).n, 0);
    host.close(); guest.close();
  } finally { await srv.stop(); }
});
