// The hard computer: the C engine (sc.wasm) in a background worker.
// Message in: { acts, maxDepth, minDepth, nodes, job } where acts is the game's action list from the start
// ({ t: 'move', from, to, p } or { t: 'resolve' }). Message out: { job, key, score, nodes } where key is the
// best action (-1 resolve, from*64+to a move, 4096+from*64+to resolve then move), or { job, error }.
const PROMO = { q: 5, r: 4, b: 3, n: 2 };
const ready = fetch('sc.wasm')
  .then(r => { if (!r.ok) throw new Error('sc.wasm ' + r.status); return r.arrayBuffer(); })
  .then(b => WebAssembly.instantiate(b, {}))
  .then(w => w.instance.exports);

onmessage = async e => {
  const { acts, maxDepth, minDepth, nodes, job } = e.data;
  try {
    const E = await ready;
    E.sc_w_new_game();
    for (const a of acts) {
      const ok = a.t === 'move' ? E.sc_w_move(a.from, a.to, PROMO[a.p] || 5) : a.t === 'resolve' ? E.sc_w_resolve() : 1;
      if (!ok) throw new Error('engine refused action ' + JSON.stringify(a));
    }
    const key = E.sc_w_think(maxDepth, minDepth, nodes);
    postMessage({ job, key, score: E.sc_w_last_score(), nodes: E.sc_w_last_nodes() });
  } catch (err) {
    postMessage({ job, error: String(err && err.message || err) });
  }
};
