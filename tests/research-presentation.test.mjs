import assert from 'node:assert/strict';
import test from 'node:test';
import { presentResearch } from '../dist/researchPresentation.js';
import { coverageFixture, coverageActor, coverageReview, providerResponse } from './fixtures/authority-provider.mjs';

test('CF-06: paged worklists retain every mandatory candidate and review still examines the full ledger', async t => {
  const rows = Array.from({ length: 20 }, (_, n) => ({ ntstDcmId: String(n + 1), documentNumber: 'SYNTHETIC-' + n,
    title: '합성 후보 ' + n, documentType: '판례', issuingAgency: '대법원', productionDate: '2026-01-01' }));
  const f = coverageFixture((name, args) => name === 'search_tax_decisions' && args.type === 'court'
    ? providerResponse(name, args, { total: rows.length, items: rows }) : providerResponse(name, args));
  t.after(() => f.service.close());
  let s = await f.law(await f.start());
  const step = s.coverage.obligations.find(o => o.next_step?.tool === 'search_tax_decisions' && o.next_step.arguments.type === 'court').next_step;
  s = await f.api('research_legal_sources', s, { tool: step.tool, arguments: step.arguments, issue_ids: step.issue_ids, purpose: step.purpose });
  assert.equal(s.review_worklist.length, 20);
  const summary = presentResearch('research_legal_sources', {}, s);
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) <= 32768);
  assert.equal(summary.collections.worklist.total, 20); assert.equal(summary.previews.review_worklist.shown, 2);
  let cursor, pages = [];
  do {
    const page = presentResearch('get_legal_research', { research_id: s.research_id, view: 'worklist', limit: 7, cursor }, s);
    pages.push(...page.items); cursor = page.page.next_cursor;
  } while (cursor);
  assert.deepEqual(pages.map(p => p.document_number).sort(), rows.map(r => r.documentNumber).sort());
  assert.equal(new Set(pages.map(p => p.candidate_id)).size, 20);
  const review = await f.service.run('review_legal_reasoning', coverageActor, coverageReview(s));
  assert.equal(review.findings.filter(f => f.code === 'CANDIDATE_BODY_REQUIRED').length, 20);
  assert.equal(review.question_scope_complete, false);
});

test('CF-04: attempt exhaustion still allows a real conditional review using the reserved review slot', async t => {
  const f = coverageFixture(undefined, { limits: { maxAttempts: 1 } }); t.after(() => f.service.close());
  const s = await f.law(await f.start()), draft = coverageReview(s), a = draft.analysis[0];
  a.conclusion_mode = 'conditional'; a.unknowns = ['필수 검색 미완료']; a.next_queries = ['확보한 원문과 남은 조사 공백 안내'];
  draft.scope_assessments[0].status = 'conditional';
  const calls = f.calls.length;
  await assert.rejects(() => f.run(s), e => e.capacity_reason === 'attempts');
  const review = await f.service.run('review_legal_reasoning', coverageActor, draft);
  assert.equal(review.status, 'needs_info'); assert.equal(review.question_scope_complete, false);
  const after = await f.service.run('get_legal_research', coverageActor, { research_id: s.research_id });
  assert.equal(after.last_review.current, true); assert.equal(f.calls.length, calls);
  assert.deepEqual(after.evidence, s.evidence);
});
