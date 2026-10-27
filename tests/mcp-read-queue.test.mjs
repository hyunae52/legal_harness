import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { createApp } from '../dist/app.js';

const eventually = async predicate => {
  const until = performance.now() + 2500;
  while (!await predicate()) {
    assert.ok(performance.now() < until, 'condition did not settle');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
async function fixture(t, options = {}) {
  const held = Promise.withResolvers(), calls = [], records = []; let active = 0, peak = 0;
  const law = {
    releaseVersion: 'fixture', close: async () => {},
    listTools: async () => ({ tools: ['get_law_text', 'search_decisions', 'search_law'].map(name => ({ name, inputSchema: { type: 'object' } })) }),
    callTool: async (name, args) => {
      calls.push({ name, tag: args.tag }); active++; peak = Math.max(peak, active);
      try { await held.promise; return { result: { content: [{ type: 'text', text: 'synthetic source' }] } }; }
      finally { active--; }
    },
  };
  const usage = {
    registerTools() {}, status: () => ({ enabled: true, healthy: true, failed_writes: 0 }), start: () => () => {},
    async measure(scope, tool, operation) {
      try { const result = await operation(); records.push({ scope, tool, success: !result?.isError }); return result; }
      catch (error) { records.push({ scope, tool, success: false }); throw error; }
    },
  };
  const runtime = createApp({ env: {}, law, usage,
    authenticate: async req => ({ kind: 'auth_user', id: req.get('x-test-actor') ?? 'fixture' }), ...options });
  const server = createServer(runtime.app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = async () => (await fetch(base + '/health')).json();
  const call = async (name = 'get_law_text', tag = 'read', signal, actor = 'fixture') => {
    const response = await fetch(base + '/mcp', { method: 'POST', signal,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-test-actor': actor },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { tag } } }) });
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => { held.resolve(); await runtime.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { base, runtime, held, calls, records, call, health, peak: () => peak };
}

test('a five-call read burst completes once per call while only three providers run', async t => {
  const f = await fixture(t);
  const initial = [1, 2, 3].map(tag => f.call('get_law_text', tag));
  await eventually(() => f.calls.length === 3);
  const waiting = [4, 5].map(tag => f.call(tag === 4 ? 'search_decisions' : 'get_law_text', tag));
  await eventually(async () => (await f.health()).queued_requests === 2);
  assert.equal(f.calls.length, 3);
  f.held.resolve();
  for (const response of await Promise.all([...initial, ...waiting])) {
    assert.equal(response.status, 200); assert.equal(response.body.result.isError, undefined);
  }
  assert.equal(f.peak(), 3); assert.equal(f.calls.length, 5);
  assert.deepEqual(f.calls.slice(3).map(c => c.tag), [4, 5]);
  assert.equal(f.records.filter(r => r.scope === 'mcp' && r.success).length, 5);
  assert.equal(f.records.filter(r => r.scope === 'source').length, 5);
  assert.equal((await f.health()).queued_requests, 0);
});

test('queue overflow and timeout expose retry guidance; custom work is not deferred', async t => {
  const f = await fixture(t, { maxActive: 1, workQueue: { maxQueued: 1, waitMs: 120 } });
  const first = f.call(); await eventually(() => f.calls.length === 1);
  const pending = f.call(); await eventually(async () => (await f.health()).queued_requests === 1);
  const overflow = await f.call('get_law_text', 'overflow');
  assert.deepEqual(JSON.parse(overflow.body.result.content[0].text), { code: 'AT_CAPACITY', retryable: true, retry_after_ms: 5000 });
  const custom = await f.call('create_correction_pr', 'must-not-run');
  assert.equal(JSON.parse(custom.body.result.content[0].text).code, 'AT_CAPACITY');
  const expired = await pending;
  assert.equal(JSON.parse(expired.body.result.content[0].text).code, 'AT_CAPACITY');
  assert.equal((await f.health()).queued_requests, 0);
  f.held.resolve(); await first; assert.equal(f.calls.length, 1);
});

test('HTTP disconnect and response timeout remove queued reads before provider execution', async t => {
  for (const timedOut of [false, true]) {
    const f = await fixture(t, { maxActive: 1, resourceOptions: { limits: { responseMs: timedOut ? 150 : 3000 } } });
    const first = f.call().catch(() => null); await eventually(() => f.calls.length === 1);
    const abort = new AbortController();
    const pending = f.call('get_law_text', 'cancelled', abort.signal).catch(() => null);
    await eventually(async () => (await f.health()).queued_requests === 1);
    if (!timedOut) abort.abort();
    await pending; await eventually(async () => (await f.health()).queued_requests === 0);
    assert.equal((await f.health()).active_requests, 1, 'running work keeps its slot');
    f.held.resolve(); await first;
    await eventually(async () => (await f.health()).active_requests === 0);
    assert.equal(f.calls.length, 1);
  }
});

test('SSE disconnect cancels queued reads through the SDK abort signal', async t => {
  const f = await fixture(t, { maxActive: 1 });
  const client = new Client({ name: 'read-queue-test', version: '1' });
  t.after(() => client.close());
  await client.connect(new SSEClientTransport(new URL(f.base + '/sse')));
  const first = f.call(); await eventually(() => f.calls.length === 1);
  const pending = client.callTool({ name: 'search_decisions', arguments: {} }).catch(() => null);
  await eventually(async () => (await f.health()).queued_requests === 1);
  await client.close(); await pending;
  await eventually(async () => (await f.health()).queued_requests === 0);
  f.held.resolve(); await first; assert.equal(f.calls.length, 1);
});

test('drain rejects queued reads, waits for running work, and performs no replay', async t => {
  const f = await fixture(t, { maxActive: 1 });
  const first = f.call(); await eventually(() => f.calls.length === 1);
  const pending = f.call(); await eventually(async () => (await f.health()).queued_requests === 1);
  let drained = false;
  const drain = f.runtime.drain(2000).then(() => { drained = true; });
  assert.equal(JSON.parse((await pending).body.result.content[0].text).code, 'SHUTTING_DOWN');
  assert.equal(drained, false); assert.equal(f.calls.length, 1);
  f.held.resolve(); await first; await drain;
  assert.equal((await f.health()).queued_requests, 0);
});
