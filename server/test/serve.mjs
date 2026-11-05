// Manual testing: node server/test/serve.mjs, then point the page at ws://127.0.0.1:8787.
import { startServer } from './runtime.mjs';

if (!process.env.NODE_TEST_CONTEXT) { // `node --test test/` also loads this file
  const srv = await startServer({ port: 8787 });
  console.log('mock server ready on', srv.http);
}
