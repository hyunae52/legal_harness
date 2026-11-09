import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { KoreanLawClient } from '../../dist/koreanLawClient.js';
import { LegalRetrievalClient, TaxLawClient, taxLawOptionsFromEnv } from '../../dist/taxLawClient.js';
import { createApp } from '../../dist/app.js';
import { ResearchService } from '../../dist/research.js';
import { OUTCOME_META } from '../../dist/retrievalOutcome.js';
import { coverageActor, coveragePlan, coverageFixture, providerResponse } from '../fixtures/authority-provider.mjs';

const manifest = JSON.parse(await readFile(new URL('../../.runtime/taxlaw/active.json', import.meta.url), 'utf8'));
function makeClient(enabled, record) {
  const options = taxLawOptionsFromEnv({ TAXLAB_SEARCH_OUTCOME_V1: String(enabled) });
  options.server.args = ['-I', '-X', 'utf8', fileURLToPath(new URL('../fixtures/nts-proof-server.py', import.meta.url)), manifest.cwd];
  // Offline fixtures exercise many calls quickly; production limits remain unchanged.
  options.server.env.TAXLAW_RATE_BURST = '100'; options.server.env.TAXLAW_RATE_PER_MIN = '1000';
  const managed = new KoreanLawClient(options);
  const law = { releaseVersion: '4.15.23', listTools: async () => ({ tools: [] }), callTool: async () => { throw Error('Unexpected law call'); }, close: async () => {} };
  return new LegalRetrievalClient(law, new TaxLawClient(managed, enabled), undefined, { enabled, record });
}

test('O01–O05/O12/O14: raw HTTP → real NTS parser → MCP/REST/research; disabled rollback', async t => {
  const events = [], retrieval = makeClient(true, event => events.push(event));
  const runtime = createApp({ law: retrieval, env: { TAXLAB_API_KEY: 'outcome-fixture-key' } });
  const server = runtime.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: 'Bearer outcome-fixture-key', 'Content-Type': 'application/json' };
  const mcp = new Client({ name: 'outcome-contract', version: '1' });
  t.after(async () => { await mcp.close(); await runtime.close(); await new Promise(resolve => server.close(resolve)); });
  await mcp.connect(new SSEClientTransport(new URL(origin + '/sse'), { requestInit: { headers } }));
  const input = { query: '__zero__', type: 'written', page: 1, limit: 2 };
  const direct = await mcp.callTool({ name: 'search_tax_interpretations', arguments: input });
  assert.equal(direct.isError, false); assert.equal(direct._meta[OUTCOME_META].status, 'empty_confirmed');
  const response = await fetch(origin + '/api/analyze', { method: 'POST', headers,
    body: JSON.stringify({ tool: 'search_tax_interpretations', query: input.query, arguments: input }) });
  assert.equal(response.status, 200);
  const rest = await response.json(); assert.deepEqual(rest.data.result.structuredContent, direct.structuredContent);
  for (const query of ['__html__', '__missing__', '__contradiction__']) {
    const error = await mcp.callTool({ name: 'search_tax_interpretations', arguments: { ...input, query } });
    assert.equal(error.isError, true); assert.equal(error._meta?.[OUTCOME_META]?.status, 'failed');
    const badRest = await fetch(origin + '/api/analyze', { method: 'POST', headers,
      body: JSON.stringify({ tool: 'search_tax_interpretations', query, arguments: { ...input, query } }) });
    assert.equal(badRest.status, 502);
    assert.equal((await badRest.json()).result._meta[OUTCOME_META].status, 'failed');
  }
  const positive = await mcp.callTool({ name: 'search_tax_interpretations', arguments: { ...input, query: '__positive__' } });
  assert.equal(positive.isError, false); assert.equal(positive.structuredContent.items.length, 1);
  assert.equal(positive._meta[OUTCOME_META].status, 'found');
  const overflow = await mcp.callTool({ name: 'search_tax_interpretations', arguments: { ...input, query: '__overflow__', page: 4, limit: 5 } });
  assert.equal(overflow._meta[OUTCOME_META].status, 'page_out_of_range'); assert.equal(overflow.structuredContent.total, 12);
  const service = new ResearchService(retrieval);
  try {
    const initial = await service.run('start_legal_research', coverageActor, { plan: coveragePlan() });
    const state = await service.run('research_legal_sources', coverageActor, { research_id: initial.research_id, expected_revision: initial.revision,
      request_id: randomUUID(), issue_ids: ['case'], purpose: 'support', tool: 'search_tax_interpretations', arguments: input });
    assert.equal(state.attempts.at(-1).status, 'empty');
    assert.equal(state.legal_verification, 'unverified');
    assert.notEqual(state.retrieval_progress.state, 'ready_for_analysis');
  } finally { service.close(); }
  assert.equal(events.length, 11);
  assert.equal(events.filter(e => e.outcome === 'empty_confirmed').length, 3);
  for (const [name, type] of [['search_tax_interpretations', 'written'], ['search_tax_decisions', 'court']]) {
    for (const [query, status] of [['__zero__', 'empty_confirmed'], ['__positive__', 'found']]) {
      const result = await mcp.callTool({ name, arguments: { query, type } });
      assert.equal(result.isError, false);
      assert.equal(result._meta[OUTCOME_META].status, status);
      assert.equal(result.structuredContent.limit, 10);
    }
  }
  const facetConflict = await mcp.callTool({ name: 'search_tax_interpretations', arguments: { query: '__facet_conflict__', type: 'all', limit: 2 } });
  assert.equal(facetConflict.isError, true); assert.equal(facetConflict._meta[OUTCOME_META].status, 'failed');
  assert.equal(events.at(-1).code, 'PARSE_ERROR');
  assert.equal(events.length, 16);
  const legacy = makeClient(false);
  try { await assert.rejects(legacy.callTool('search_tax_interpretations', input), error => error.result.structuredContent.error.code === 'NOT_FOUND'); }
  finally { await legacy.close(); }
});

test('O13: normalized empty follows the existing empty-search recipe and budget', async () => {
  const real = makeClient(true), control = coverageFixture();
  const candidate = coverageFixture((name, args) => name.startsWith('search_tax_') ? real.callTool(name, args) : providerResponse(name, args));
  try {
    const reference = await control.finish(await control.law(await control.start()));
    const actual = await candidate.finish(await candidate.law(await candidate.start()));
    assert.deepEqual(candidate.calls, control.calls);
    assert.deepEqual(actual.coverage.obligations.map(o => o.status), reference.coverage.obligations.map(o => o.status));
    assert.equal(actual.legal_verification, 'unverified');
  } finally { candidate.service.close(); control.service.close(); await real.close(); }
});
