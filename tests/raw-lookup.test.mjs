import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../dist/app.js';

const body = '법령명: 합성 참조법\n시행일: 20990101\n제1조(합성)\n① 등록 없이 적용한다.';
async function fixture(t, result = { content: [{ type: 'text', text: body }] }) {
  const calls = [];
  const law = { close: async () => {}, listTools: async () => ({ tools: [] }),
    callTool: async (name, args) => { calls.push({ name, args }); return { server: { name: 'fixture', version: '1' }, result }; } };
  const runtime = createApp({ law, env: { TAXLAB_PUBLIC_ACCESS: '1', TAXLAB_PUBLIC_SESSION_SECRET: 'synthetic-link-test-secret-0123456789abcdef' } });
  const server = createServer(runtime.app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = new Client({ name: 'raw-lookup-contract', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
  t.after(async () => { await client.close(); await runtime.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const rest = async args => {
    const r = await fetch(base + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '합성 원문 조회', tool: 'get_law_text', arguments: args }) });
    return { status: r.status, body: await r.json() };
  };
  return { client, calls, rest };
}

test('CF-12 raw lookup: official navigation accompanies unchanged source text without research or an extra fetch', async t => {
  const original = { content: [{ type: 'text', text: body }], _meta: { fixture: 'provider' } };
  const f = await fixture(t, original);
  const args = { mst: '123456', jo: '제1조', apiKey: 'synthetic-provider-key' };
  const mcp = await f.client.callTool({ name: 'get_law_text', arguments: args });
  assert.notEqual(mcp.isError, true);
  assert.match(mcp.content[0].text, /^\{"retrieval_reference":/, 'a separate official-navigation record precedes the unchanged body');
  const reference = JSON.parse(mcp.content[0].text).retrieval_reference;
  assert.equal(reference?.url, 'https://www.law.go.kr/LSW/lsInfoP.do?lsiSeq=123456');
  assert.equal(reference.purpose, 'navigation_only');
  assert.equal(reference.link_basis, 'requested_mst');
  assert.equal(reference.observed_effective_date, '20990101');
  assert.deepEqual(mcp.content.slice(1), original.content);
  assert.equal(mcp._meta.fixture, 'provider');
  assert.equal(mcp._meta['legal-harness/evidence'].applicability, 'unverified');
  assert.equal(mcp.structuredContent, undefined);
  assert.equal(JSON.stringify(reference).includes('synthetic-provider-key'), false);
  const rest = await f.rest(args);
  assert.equal(rest.status, 200);
  assert.deepEqual(rest.body.data.result, original);
  assert.deepEqual(rest.body.data.retrieval_reference, reference);
  assert.equal(rest.body.data.research_id, undefined);
  assert.deepEqual(f.calls.map(c => c.name), ['get_law_text', 'get_law_text']);
  assert.deepEqual(original.content, [{ type: 'text', text: body }]);
});

test('CF-12 raw lookup: law ID, date correction, malformed locators and errors never become pinned version links', async t => {
  const f = await fixture(t);
  for (const args of [{ lawId: '123456' }, { mst: '123456', efYd: '20990301' },
    { mst: '123456&OC=secret' }, { mst: '' }, { mst: 'pilot-version' }]) {
    const r = await f.client.callTool({ name: 'get_law_text', arguments: args });
    assert.deepEqual(r.content, [{ type: 'text', text: body }]);
    assert.equal(r.structuredContent, undefined);
  }
  const failed = await fixture(t, { isError: true, content: [{ type: 'text', text: body }] });
  const r = await failed.client.callTool({ name: 'get_law_text', arguments: { mst: '123456' } });
  assert.equal(r.isError, true);
  assert.deepEqual(r.content, [{ type: 'text', text: body }]);
  assert.equal(f.calls.length, 5);
  assert.equal(failed.calls.length, 1);
});
