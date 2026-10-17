import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../dist/app.js';

test('U01/U02: real MCP calls are accounted once and source work remains separate', async t => {
  const recorded = [], known = new Set();
  const usage = {
    registerTools(names) { for (const name of names) known.add(name); },
    async measure(scope, tool, operation) {
      try { const result = await operation(); recorded.push({ scope, tool, failed: result?.isError === true || result?.result?.isError === true }); return result; }
      catch (error) { recorded.push({ scope, tool, failed: true }); throw error; }
    },
    start(scope, tool) { let done = false; return success => { if (!done) { done = true; recorded.push({ scope, tool, failed: !success }); } }; },
    status: () => ({ enabled: true, healthy: true, failed_writes: 0 }),
  };
  const law = {
    releaseVersion: 'fixture', close: async () => {},
    listTools: async () => ({ tools: [{ name: 'search_law', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }] }),
    callTool: async (_tool, args) => {
      if (args.query === 'failure') throw Error('synthetic private failure');
      return { result: { content: [{ type: 'text', text: 'synthetic private body' }] } };
    },
  };
  const runtime = createApp({ law, usage, env: { TAXLAB_PUBLIC_ACCESS: '1', TAXLAB_PUBLIC_SESSION_SECRET: 'synthetic-usage-session-secret-0123456789' } });
  const server = createServer(runtime.app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = new Client({ name: 'usage-test', version: '1' });
  t.after(async () => { await client.close(); await runtime.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
  await client.listTools();
  await fetch(base + '/health');
  assert.equal(recorded.length, 0, 'Discovery/health must not inflate tool counts');
  for (const query of ['success', 'success', 'failure']) await client.callTool({ name: 'search_law', arguments: { query } });
  assert.deepEqual(recorded.filter(x => x.scope === 'mcp').map(x => x.failed), [false, false, true]);
  assert.deepEqual(recorded.filter(x => x.scope === 'source').map(x => x.failed), [false, false, true]);
  const invalid = await client.callTool({ name: 'validate_legal_draft', arguments: {} });
  assert.equal(invalid.isError, true);
  assert.equal(recorded.filter(x => x.scope === 'mcp').length, 4);
  assert.equal(recorded.filter(x => x.scope === 'source').length, 3);
  const response = await fetch(base + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'rest example', tool: 'search_law' }) });
  assert.equal(response.status, 200);
  await response.json();
  assert.equal(recorded.filter(x => x.scope === 'rest').length, 1);
  assert.equal(recorded.filter(x => x.scope === 'source').length, 4);
  assert.ok(known.has('search_law'));
  const health = await (await fetch(base + '/health')).json();
  assert.equal(health.usage_accounting.enabled, true);
  assert.equal((await fetch(base + '/api/usage')).status, 404, 'No unauthenticated statistics endpoint');
});
