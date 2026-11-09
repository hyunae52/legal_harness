import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { classifyRetrieval, OUTCOME_META, preserveOutcomeMetadata } from '../dist/retrievalOutcome.js';
import { LawMcpError } from '../dist/koreanLawClient.js';
import { TaxLawClient, LegalRetrievalClient } from '../dist/taxLawClient.js';
import { observeSearch } from '../dist/researchSearch.js';

const pin = JSON.parse(await readFile(new URL('../upstreams/korean-taxlaw-mcp.json', import.meta.url), 'utf8'));
const provider = { name: 'nts', version: pin.version, commit: pin.commit };
const args = { query: '공개 합성 검색', type: 'written', page: 1, limit: 20 };
const proof = (changes = {}) => ({ contract: 'nts-document-list-v1', schema: 'ASIPDI002PR01/sparse-facets-v1',
  operation: 'list_search', page: 1, limit: 20, total: 0, returned: 0, scope_verified: true, status: 'empty_confirmed', ...changes });
const failure = (p = null, code = 'NOT_FOUND') => ({ isError: true,
  content: [{ type: 'text', text: 'legacy failure wording' }],
  structuredContent: { ok: false, error: { code, message: 'source result', detail: { searchProof: p } } } });
const classify = (p, input = args, identity = provider) => {
  const result = failure(p);
  return classifyRetrieval('search_tax_interpretations', input, identity, result, new LawMcpError(404, 'MCP_TOOL_ERROR', 'retrieval failed', result));
};

test('O01/O06: verified zero and overflow have distinct normalized results', () => {
  const empty = classify(proof());
  assert.equal(empty.event.outcome, 'empty_confirmed'); assert.equal(empty.recovered, true);
  assert.equal(empty.result.isError, false); assert.equal(empty.result.structuredContent.total, 0);
  assert.doesNotMatch(JSON.stringify(empty.result), /legacy failure wording|"error"/);
  const overflow = classify(proof({ page: 4, limit: 5, total: 12, status: 'page_out_of_range' }), { ...args, page: 4, limit: 5 });
  assert.equal(overflow.event.outcome, 'page_out_of_range'); assert.equal(overflow.result.structuredContent.total, 12);
  assert.equal(observeSearch('search_tax_interpretations', { ...args, page: 4, limit: 5 }, { result: overflow.result }).status, 'partial');
  assert.equal(classify(proof({ page: 2 }), { ...args, page: 2 }).recovered, false);
});

test('H-01: omitted limit uses the pinned public tool default, without changing arguments', () => {
  for (const [name, type] of [['search_tax_interpretations', 'written'], ['search_tax_decisions', 'court']]) {
    const input = { query: 'public synthetic default', type };
    const empty = classifyRetrieval(name, input, provider, failure(proof({ limit: 10 })));
    assert.equal(empty.event.outcome, 'empty_confirmed'); assert.equal(empty.result.structuredContent.limit, 10);
    const data = { total: 1, page: 1, limit: 10, items: [{ ntstDcmId: '200000000000000001' }],
      searchProof: proof({ limit: 10, total: 1, returned: 1, status: 'found' }) };
    const found = classifyRetrieval(name, input, provider, { content: [], structuredContent: data });
    assert.equal(found.event.outcome, 'found'); assert.strictEqual(found.result.structuredContent, data);
    for (const result of [empty.result, found.result]) {
      const observed = observeSearch(name, input, { result });
      assert.equal(observed.status, 'complete'); assert.equal(observed.page_size, 10);
      assert.deepEqual(observed, observeSearch(name, { ...input, limit: 10 }, { result }));
    }
    const legacy = observeSearch(name, input, { result: { structuredContent: { total: 0, page: 1, limit: 20, items: [] } } });
    assert.equal(legacy.status, 'complete'); assert.equal(legacy.page_size, 20);
    assert.deepEqual(input, { query: 'public synthetic default', type });
  }
});

test('H-02: excluded local and special positive lists preserve their existing research observation', () => {
  for (const [tool, type] of [['search_local_tax_interpretations', 'all'], ['search_tax_interpretations', 'curated_issue']]) {
    const input = { query: 'public synthetic local', type, page: 1, limit: 10 };
    const result = { content: [], structuredContent: { total: 1, page: 1, limit: 10,
      items: [{ id: 'public-local-1', title: 'Public synthetic document' }] } };
    const baseline = observeSearch(tool, input, { result });
    assert.equal(baseline.status, 'complete');
    const classified = classifyRetrieval(tool, input, provider, result);
    assert.equal(classified.event.outcome, 'unclassified');
    assert.deepEqual(observeSearch(tool, input, { result: classified.result }), baseline);
    const missed = classifyRetrieval(tool, input, provider, failure());
    assert.equal(missed.recovered, false);
    assert.equal(observeSearch(tool, input, { result: missed.result }).status, 'failed');
  }
});

test('O03/O04/O05/O10: malformed or mismatched proof cannot turn a failure into zero', () => {
  for (const bad of [undefined, {}, proof({ total: -1 }), proof({ total: '0' }), proof({ total: 1 }), proof({ returned: 1 }),
    proof({ page: 2 }), proof({ limit: 10 }), proof({ schema: 'unknown' }), proof({ contract: 'future' }),
    proof({ scope_verified: 'true' }), proof({ operation: 'exact_lookup' })]) {
    assert.equal(classify(bad).recovered, false, JSON.stringify(bad));
  }
  for (const identity of [{ ...provider, commit: 'unknown' }, { ...provider, version: 'future' }, { ...provider, name: 'law' }])
    assert.equal(classify(proof(), args, identity).recovered, false);
  assert.equal(classify(undefined, { ...args, searchProof: proof() }).recovered, false);
  assert.equal(classify(proof(), { ...args, ignoredFilter: 'anything' }).recovered, false);
  const diagnostic = { isError: true, content: [] };
  assert.strictEqual(preserveOutcomeMetadata(diagnostic, { _meta: { [OUTCOME_META]: { status: 'empty_confirmed' }, secret: 'never copy' } }), diagnostic);
});

test('O07/O08/O09/O11: exact, special, unknown scope and actual failures remain distinct', () => {
  assert.equal(classify(proof(), { ...args, document_number: '서면-2026-9999' }).event.outcome, 'document_unresolved');
  assert.equal(classify(proof(), { ...args, type: 'curated_issue' }).recovered, false);
  assert.equal(classify(proof({ scope_verified: false, status: 'partial' })).event.outcome, 'partial');
  for (const code of ['TIMEOUT', 'RATE_LIMITED', 'MCP_AT_CAPACITY', 'INVALID_INPUT', 'PARSE_ERROR']) {
    const result = failure(proof(), code);
    const error = new LawMcpError(429, 'MCP_TOOL_ERROR', 'retry', result);
    const out = classifyRetrieval('search_tax_interpretations', args, provider, result, error);
    assert.equal(out.event.outcome, 'failed'); assert.equal(out.recovered, false);
    assert.deepEqual(out.result.structuredContent, result.structuredContent);
  }
  const missingBody = failure(undefined, 'DETAIL_NOT_AVAILABLE');
  assert.equal(classifyRetrieval('get_decision_text', { domain: 'nts' }, provider, missingBody,
    new LawMcpError(502, 'MCP_TOOL_ERROR', 'body missing', missingBody)).event.outcome, 'body_unavailable');
  assert.equal(classifyRetrieval('prepare_reasoning_review', {}, provider, failure()).event, undefined);
});

test('O02: verified candidates remain unchanged and do not become a body read', () => {
  const data = { total: 1, page: 1, limit: 20, items: [{ ntstDcmId: '200000000000000001', title: '공개 합성 문서' }],
    searchProof: proof({ total: 1, returned: 1, status: 'found' }) };
  const result = { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
  const out = classifyRetrieval('search_tax_interpretations', args, provider, result);
  assert.equal(out.event.outcome, 'found'); assert.equal(out.event.operation, 'list_search');
  assert.deepEqual(out.result.content, result.content); assert.strictEqual(out.result.structuredContent, data);
  data.searchProof.status = 'partial';
  const partial = classifyRetrieval('search_tax_interpretations', args, provider, result);
  const observation = observeSearch('search_tax_interpretations', args, { result: partial.result });
  assert.equal(observation.status, 'partial'); assert.equal(observation.hits.length, 1);
});

test('O13/O14: research rejects bare NOT_FOUND only in the opt-in mode', () => {
  const legacy = failure({});
  assert.equal(observeSearch('search_tax_interpretations', args, { result: legacy }).status, 'complete');
  const classified = classify({});
  assert.equal(classified.event.outcome, 'unclassified');
  assert.equal(observeSearch('search_tax_interpretations', args, { result: classified.result }).status, 'failed');
  const empty = classify(proof());
  assert.equal(observeSearch('search_tax_interpretations', args, { result: empty.result }).status, 'complete');
  assert.equal(observeSearch('search_tax_interpretations', args, { result: empty.result }).hits.length, 0);
});

test('O10/O14/O15: one provider call, disabled compatibility, throwing transport, collector failure', async () => {
  let calls = 0;
  const data = failure(proof()).structuredContent;
  const raw = { isError: true, content: [{ type: 'text', text: '[NOT_FOUND]\n' + JSON.stringify(data) }],
    structuredContent: { result: '[NOT_FOUND]\n' + JSON.stringify(data) } };
  const managed = { releaseVersion: pin.version, listTools: async () => ({ tools: [] }), close: async () => {},
    callTool: async () => { calls++; throw new LawMcpError(502, 'MCP_TOOL_ERROR', 'transport failure', raw); } };
  const tax = new TaxLawClient(managed, true);
  const enabled = new LegalRetrievalClient(managed, tax, undefined, { enabled: true, record() { throw Error('collector unavailable'); } });
  const answer = await enabled.callTool('search_tax_interpretations', args);
  assert.equal(answer.result._meta[OUTCOME_META].status, 'empty_confirmed'); assert.equal(calls, 1);
  const disabled = new LegalRetrievalClient(managed, new TaxLawClient(managed));
  await assert.rejects(disabled.callTool('search_tax_interpretations', args), error => error.result === raw);
  assert.equal(calls, 2);
});
