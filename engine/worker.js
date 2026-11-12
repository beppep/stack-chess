// The hard computer: the C engine (sc.wasm) in a background worker, scoring boards with a neural network
// (nn/hybrid3.net: threatMaterial plus a learned correction; see nn/README.md). If the network cannot be
// loaded, the engine plays with threatMaterial alone.
// Message in: { acts, maxDepth, minDepth, nodes, ms, job } where acts is the game's action list from the start
// ({ t: 'move', from, to, p } or { t: 'resolve' }) and ms is the time budget after minDepth (0: none).
// Message out: { job, key, score, nodes, net } where key is the best action (-1 resolve, from*64+to a move,
// 4096+from*64+to resolve then move) and net says whether the network was used, or { job, error }.
const PROMO = { q: 5, r: 4, b: 3, n: 2 };
const NET = 'nn/hybrid3.net', NET_BYTES = (768 * 128 + 128 + 128 + 1) * 4;
const load = url => fetch(url).then(r => { if (!r.ok) throw new Error(url + ' ' + r.status); return r.arrayBuffer(); });
const ready = load('sc.wasm')
  .then(b => WebAssembly.instantiate(b, { env: { now_ms: () => performance.now() } }))
  .then(async w => {
    const E = w.instance.exports;
    let net = false;
    try {
      const b = await load(NET);
      if (b.byteLength !== NET_BYTES) throw new Error(NET + ': ' + b.byteLength + ' bytes, expected ' + NET_BYTES);
      new Uint8Array(E.memory.buffer, E.sc_w_nn_buf(), NET_BYTES).set(new Uint8Array(b));
      E.sc_w_nn_use(1);
      net = true;
    } catch (err) {
      console.warn('engine: playing without the network:', String(err && err.message || err));
    }
    return { E, net };
  });

onmessage = async e => {
  const { acts, maxDepth, minDepth, nodes, ms, job } = e.data;
  try {
    const { E, net } = await ready;
    E.sc_w_new_game();
    for (const a of acts) {
      const ok = a.t === 'move' ? E.sc_w_move(a.from, a.to, PROMO[a.p] || 5) : a.t === 'resolve' ? E.sc_w_resolve() : 1;
      if (!ok) throw new Error('engine refused action ' + JSON.stringify(a));
    }
    const key = E.sc_w_think(maxDepth, minDepth, nodes, ms || 0);
    postMessage({ job, key, score: E.sc_w_last_score(), nodes: E.sc_w_last_nodes(), net });
  } catch (err) {
    postMessage({ job, error: String(err && err.message || err) });
  }
};
