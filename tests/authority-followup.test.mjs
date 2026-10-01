import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { identityFromDocument } from '../dist/researchIdentity.js';
import { researchCoverage } from '../dist/researchCoverage.js';
import { observeSearch } from '../dist/researchSearch.js';
import { coverageFixture, coveragePlan, providerResponse } from './fixtures/authority-provider.mjs';

test('Pro F-5: independent issuer and court conflicts cannot become Supreme Court evidence', () => {
  const doc = { id: 'a', documentType: '판결', issuingAgency: '대법원', court: '서울고등법원' };
  assert.equal(identityFromDocument(doc, 'nts', 'tax_document').status, 'conflict');
  assert.equal(identityFromDocument({ ...doc, issuingAgency: undefined }, 'nts', 'tax_document').kind, 'lower_court');
  assert.equal(identityFromDocument({ ...doc, court: undefined }, 'nts', 'tax_document').kind, 'supreme_court');
});

test('Pro F-6: an expired in-flight call keeps its reservation until actual settlement', async () => {
  let now = 1, finish, calls = 0;
  const gate = new Promise(resolve => { finish = resolve; });
  const f = coverageFixture(async (name, args) => { if (++calls === 1) await gate; return providerResponse(name, args); },
    { now: () => now, limits: { ttlMs: 50, yieldMs: 1, transientBytes: 20000, maxTotalBytes: 35000 } });
  const first = await f.law(await f.start()); assert.equal(first.pending, true);
  now = 100;
  let second = await f.start();
  await assert.rejects(() => f.law(second), e => e.code === 'RESEARCH_CAPACITY');
  assert.equal(calls, 1, 'expired call is still consuming the global reservation');
  finish(); await new Promise(resolve => setTimeout(resolve, 10));
  second = await f.law(second); assert.equal(second.job.status, 'completed'); assert.equal(calls, 2);
  f.service.close();
});

test('Pro F-4: 32 stored units can be rebound after a fact revision without another source call or body copy', async () => {
  const f = coverageFixture(); let s = await f.start();
  for (let n = 0; n < 32; n++) s = await f.law(s);
  const originals = s.evidence.map(e => ({ id: e.evidence_id, at: e.observed_at, hash: e.response_hash }));
  const count = f.calls.length, plan = structuredClone(s.plan); plan.facts[0].value = '보완된 합성 사실';
  s = await f.api('update_legal_research', s, { plan });
  s = await f.api('reuse_legal_evidence', s, { issue_ids: ['case'], evidence_ids: originals.map(e => e.id) });
  assert.equal(f.calls.length, count); assert.equal(s.evidence.length, 32);
  assert.equal(s.coverage.preparation_gaps.length, 0);
  assert.equal(s.last_review, null);
  for (const e of s.evidence) { const original = originals.find(o => o.id === e.evidence_id);
    assert.equal(e.revision, s.revision); assert.equal(e.observed_at, original.at);
    assert.equal(e.response_hash, original.hash); assert.equal(e.cache_of, e.evidence_id); }
  assert.equal(s.coverage.obligations.some(o => o.status.startsWith('completed')), false, 'old searches are not fresh searches');
  f.service.close();
});

test('Pro F-2: a new law MST is an unread version candidate, not a completed empty amendment search', async () => {
  const f = coverageFixture(); let s = await f.law(await f.start());
  s = await f.api('research_legal_sources', s, { issue_ids: ['case'], purpose: 'timing', tool: 'search_law', arguments: { query: '소득세법', display: 50 } });
  assert.ok(s.coverage.candidates.some(c => c.identity.family === 'statute'));
  const amendment = s.coverage.obligations.find(o => o.purpose === 'amendment');
  assert.equal(amendment.status, 'completed_with_candidates'); assert.ok(amendment.candidate_ids.length);
  f.service.close();
});

test('Pro F-3: only the same observed document/version/role can satisfy an alternative failed body request', () => {
  const identity = identityFromDocument({ id: 'doc', documentNumber: '번호-1', productionDate: '2026-01-01', issuingAgency: '국세청', documentType: '질의회신' }, 'nts', 'tax_document');
  const evidence = { evidence_id: randomUUID(), revision: 1, issue_ids: ['case'], purpose: 'context', body_scope: 'body_returned', identity,
    document_version: '2026-01-01', units: [{ role: 'document', date: null, body_scope: 'body_returned', source_access: 'available' }], passages: [] };
  const failed = { attempt_id: randomUUID(), revision: 1, issue_ids: ['case'], purpose: 'context', tool: 'get_tax_document', arguments_hash: 'one', status: 'failed',
    requirement: { document_key: 'nts:tax_document:doc', document_number: '번호-1', document_version: '2026-01-01', role: 'document', date: null } };
  const success = { attempt_id: randomUUID(), revision: 1, issue_ids: ['case'], purpose: 'context', tool: 'lookup_tax_document', arguments_hash: 'two', status: 'completed', evidence_ids: [evidence.evidence_id] };
  const inspect = e => researchCoverage(coveragePlan(), 1, [e], [failed, success]);
  assert.equal(inspect(evidence).incomplete_attempts.length, 0);
  assert.equal(inspect(evidence).resolved_attempts[0].resolved_by_attempt_id, success.attempt_id);
  for (const bad of [{ ...evidence, identity: { ...identity, document_id: 'other' } }, { ...evidence, document_version: '2025-01-01' },
    { ...evidence, body_scope: 'partial' }, { ...evidence, units: [{ ...evidence.units[0], role: 'current' }] }])
    assert.equal(inspect(bad).incomplete_attempts.length, 1);
});

test('Pro F-2: court zero cannot close a tribunal subsequent-treatment obligation', async () => {
  const row = { ntstDcmId: 'appeal', documentNumber: '조심-2025-서-0001', productionDate: '2025-01-01', issuingAgency: '조세심판원', documentType: '심판청구' };
  const f = coverageFixture((name, args) => name === 'get_tax_document'
    ? { result: { structuredContent: { document: { ...row, answer: '합성 심판 원문' } } } } : providerResponse(name, args));
  let s = await f.law(await f.start());
  s = await f.api('research_legal_sources', s, { issue_ids: ['case'], purpose: 'support', tool: 'get_tax_document', arguments: { ntst_dcm_id: 'appeal' } });
  const steps = s.coverage.obligations.filter(o => o.purpose === 'subsequent');
  assert.deepEqual(steps.map(o => o.family).sort(), ['adjudication', 'court']);
  for (let n = 0; n < 2; n++) {
    const step = s.coverage.obligations.find(o => o.purpose === 'subsequent' && o.family === 'court').next_step;
    s = await f.api('research_legal_sources', s, { tool: step.tool, arguments: step.arguments, purpose: step.purpose, issue_ids: ['case'] });
  }
  assert.ok(s.coverage.obligations.find(o => o.purpose === 'subsequent' && o.family === 'court').status.startsWith('completed'));
  assert.equal(s.coverage.obligations.find(o => o.purpose === 'subsequent' && o.family === 'adjudication').status, 'not_attempted');
  f.service.close();
});

test('Pro F-1: supplementary broad discovery stays visible and cannot downgrade a required failed query', async () => {
  const f = coverageFixture((name, args) => name.startsWith('search_tax_') && args.query === '넓은 보조 탐색'
    ? providerResponse(name, args, { total: 100, items: [] }) : providerResponse(name, args));
  let s = await f.law(await f.start());
  s = await f.api('research_legal_sources', s, { issue_ids: ['case'], purpose: 'context', tool: 'search_tax_decisions', arguments: { type: 'court', query: '넓은 보조 탐색', page: 1, limit: 20 } });
  assert.equal(s.attempts.at(-1).search_scope, 'exploratory'); assert.equal(s.coverage.exploratory_gaps.length, 1);
  assert.equal(s.coverage.obligations.every(o => o.status === 'not_attempted'), true);
  const step = s.coverage.obligations[0].next_step;
  s = await f.api('research_legal_sources', s, { issue_ids: ['case'], purpose: step.purpose, tool: step.tool, arguments: step.arguments });
  assert.equal(s.attempts.at(-1).search_scope, 'required');
  f.service.close();
});

test('Rate-limited provider searches preserve a retry hint and are never zero results', () => {
  const r = observeSearch('search_tax_decisions', { type: 'court', query: '쟁점', page: 1, limit: 20 },
    { result: { isError: true, structuredContent: { ok: false, error: { code: 'RATE_LIMITED', detail: { retryAfterSec: 2 } } } } });
  assert.equal(r.status, 'failed'); assert.equal(r.total, null); assert.equal(r.retry_after_ms, 2000);
});
