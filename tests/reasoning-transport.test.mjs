import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../dist/app.js';
import { coveragePlan, providerResponse } from './fixtures/authority-provider.mjs';
import { reasoningInput } from './fixtures/reasoning-v2.mjs';

async function fixture(t, enabled = true, responseBytes = 4194304) {
  let calls = 0;
  const runtime = createApp({ law: { releaseVersion: 'fixture', listTools: async () => ({ tools: [] }), close: async () => {},
    callTool: async (name, args) => { calls++; return providerResponse(name, args); } },
    env: { TAXLAB_PUBLIC_ACCESS: '1', TAXLAB_PUBLIC_SESSION_SECRET: 'synthetic-reasoning-transport-0123456789abcdef', REASONING_REVIEW_V2_ENABLED: String(enabled) },
    resourceOptions: { limits: { responseBytes } } });
  const server = createServer(runtime.app); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`, client = new Client({ name: 'reasoning-contract', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
  t.after(async () => { await client.close(); await runtime.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const rest = async (route, input) => {
    const r = await fetch(base + '/api/research/' + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    return { status: r.status, body: await r.json() };
  };
  return { base, client, rest, calls: () => calls };
}
async function research(f) {
  let s = (await f.rest('start', { plan: coveragePlan() })).body, session = s.client_session;
  s = (await f.rest('retrieve', { research_id: s.research_id, expected_revision: s.revision, client_session: session,
    issue_ids: ['case'], purpose: 'timing', tool: 'get_law_text', arguments: { lawId: '100', jo: '제1조' } })).body;
  for (let n = 0; n < 12; n++) {
    const full = (await f.rest('status', { research_id: s.research_id, client_session: session, view: 'full' })).body;
    if (full.coverage.obligations.every(o => o.status.startsWith('completed')) && !full.retrieval_progress.next_step) return full;
    s = (await f.rest('run', { research_id: s.research_id, expected_revision: s.revision, client_session: session, request_id: randomUUID(), max_steps: 4 })).body;
  }
  throw Error('Research did not complete');
}

test('IR-13/15/19/23/26: actual public REST/MCP roundtrip preserves complete material and cannot forge independence', async t => {
  const f = await fixture(t), tools = await f.client.listTools();
  for (const name of ['prepare_reasoning_review', 'submit_reasoning_review']) assert.ok(tools.tools.some(t => t.name === name));
  assert.equal((await (await fetch(f.base + '/health')).json()).research_harness.reasoning_review.enabled, true);
  const s = await research(f), session = s.client_session;
  const reviewed = await f.client.callTool({ name: 'review_legal_reasoning', arguments: { ...reasoningInput(s), client_session: session } });
  assert.equal(reviewed.isError, undefined); const r = reviewed.structuredContent; assert.equal(r.status, 'structurally_complete');
  const prepared = await f.rest('prepare-review', { research_id: s.research_id, expected_revision: s.revision,
    expected_state_version: r.state_version, request_id: randomUUID(), client_session: session, ...r.reasoning_artifact });
  assert.equal(prepared.status, 200); const p = prepared.body;
  const submitInput = { research_id: s.research_id, expected_revision: s.revision, expected_state_version: p.state_version,
    request_id: randomUUID(), client_session: session, packet_id: p.packet.packet_id, content_hash: p.packet.content_hash,
    manifest_hash: p.packet.manifest_hash, result: 'no_detected_issue', reviewer: { kind: 'client_reported_review', model: 'Pro' },
    findings: [], prior_findings: [], qualifications: [] };
  assert.equal((await f.rest('submit-review', submitInput)).body.code, 'REVIEW_MATERIAL_INCOMPLETE');
  let cursor, units = [];
  do {
    const result = await f.client.callTool({ name: 'get_legal_research', arguments: { research_id: s.research_id, client_session: session,
      view: 'review_packet', packet_id: p.packet.packet_id, packet_manifest_hash: p.packet.manifest_hash, packet_cursor: cursor, limit: 1 } });
    assert.equal(result.isError, undefined); units.push(...result.structuredContent.items); cursor = result.structuredContent.page.next_cursor;
  } while (cursor);
  assert.ok(units.some(u => u.id === 'artifact')); assert.ok(units.some(u => u.id.startsWith('evidence:')));
  const after = (await f.rest('submit-review', submitInput)).body;
  assert.equal(after.ready_for_answer, true); assert.equal(after.independent_review, 'not_performed'); assert.equal(after.stages.independent_semantic_review, 'not_configured');
  const replay = (await f.rest('submit-review', submitInput)).body;
  assert.equal(replay.replayed, true); assert.equal(replay.model_review.accepted_count, 1);
  const foreign = (await f.rest('start', { plan: coveragePlan() })).body;
  assert.equal((await f.rest('submit-review', { ...submitInput, client_session: foreign.client_session })).status, 404);
});

test('IR-26: a rejected transport envelope does not mark packet units as provided', async t => {
  const f = await fixture(t, true, 12000), s = await research(f), session = s.client_session;
  const r = (await f.rest('review', { ...reasoningInput(s), client_session: session })).body;
  const p = (await f.rest('prepare-review', { research_id: s.research_id, expected_revision: s.revision, expected_state_version: r.state_version,
    request_id: randomUUID(), client_session: session, ...r.reasoning_artifact })).body;
  const large = await f.client.callTool({ name: 'get_legal_research', arguments: { research_id: s.research_id, client_session: session,
    view: 'review_packet', packet_id: p.packet.packet_id, packet_manifest_hash: p.packet.manifest_hash, limit: 20 } });
  assert.equal(large.isError, true); assert.match(large.content[0].text, /RESPONSE_TOO_LARGE/);
  const page = (await f.rest('status', { research_id: s.research_id, client_session: session, view: 'review_packet',
    packet_id: p.packet.packet_id, packet_manifest_hash: p.packet.manifest_hash, limit: 1 })).body;
  assert.deepEqual(page.packet.provided_units, ['plan']); assert.ok(page.packet.missing_units.includes('artifact'));
});

test('IR-19/23: disabled feature hides new MCP tools, direct calls fail, and plain lookup stays available', async t => {
  const f = await fixture(t, false);
  const tools = await f.client.listTools(); assert.equal(tools.tools.some(t => t.name === 'prepare_reasoning_review'), false);
  const direct = await f.client.callTool({ name: 'prepare_reasoning_review', arguments: {} });
  assert.equal(direct.isError, true);
  const lookup = await f.client.callTool({ name: 'get_law_text', arguments: { lawId: '100', jo: '제1조' } });
  assert.equal(lookup.isError, undefined); assert.equal(f.calls(), 1);
});
