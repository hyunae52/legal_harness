import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../dist/app.js';
import { providerResponse } from './fixtures/authority-provider.mjs';

async function run(t, brokenCounter = false) {
  const calls = [];
  const runtime = createApp({ law: { releaseVersion: 'fixture', close: async () => {},
    listTools: async () => ({ tools: [{ name: 'search_law', description: 'fixture', inputSchema: { type: 'object' } }] }),
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (brokenCounter && name === 'search_decisions') throw Error('synthetic upstream failure');
      return providerResponse(name, args);
    } }, env: { TAXLAB_PUBLIC_ACCESS: '1', TAXLAB_PUBLIC_SESSION_SECRET: 'synthetic-live-smoke-0123456789abcdef', REASONING_REVIEW_V2_ENABLED: 'true' } });
  const server = createServer(runtime.app); await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { await runtime.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/interpretation-live-smoke.mjs', import.meta.url)), `http://127.0.0.1:${server.address().port}`],
    { env: { ...process.env, TAXLAB_SMOKE_LOCAL_FIXTURE: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  return { code, output, calls };
}

test('release smoke anchors a body and follows the real counter obligation through MCP/REST', async t => {
  const r = await run(t); assert.equal(r.code, 0, r.output);
  assert.match(r.output, /"mcp_rest_roundtrip":true/); assert.match(r.output, /"review_policy_seen":true/);
  assert.equal(r.calls[0].name, 'get_law_text'); assert.equal(r.calls[1].name, 'search_decisions');
  assert.match(r.calls[1].args.query, /적용 제외/);
});

test('release smoke refuses a failed required upstream search', async t => {
  const r = await run(t, true); assert.notEqual(r.code, 0);
  assert.match(r.output, /actual required counter search must complete/);
});
