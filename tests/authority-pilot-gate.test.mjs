import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateAuthorityPilot, scenarios } from '../scripts/verify-authority-pilot.mjs';

// Synthetic records exercise the gate only. They are never submitted as actual model execution evidence.
const fixture = () => ({ frozen_protocol_hash: 'synthetic-protocol', source_sha: 'synthetic-source', evaluator: 'test',
  runs: scenarios.flatMap(scenario => [1, 2, 3].map(repetition => ({ scenario, repetition, model_id: 'synthetic-model', client_version: 'synthetic-client',
    started_at: '2026-10-01T00:00:00Z', trace_hash: 'synthetic-trace', output_hash: 'synthetic-output', calls: [{ tool: 'review_legal_reasoning', result_observed: true }],
    semantic_verdict: 'pass', issue_search_discovery: true, body_acquired: true, applicability_reviewed: true, case_number_hint: false,
    review_status: 'structurally_complete', interview_count: 0, raw_data_returned: true, claimed_reviewed: false, failure_observed: true, subsequent_search_observed: true }))) });
test('AC-31: the gate requires all frozen runs and an identified execution trace', () => {
  assert.equal(evaluateAuthorityPilot(fixture()).status, 'pass');
  const missing = fixture(); missing.runs.pop(); assert.equal(evaluateAuthorityPilot(missing).status, 'unverified');
  const unidentified = fixture(); delete unidentified.runs[0].model_id; assert.equal(evaluateAuthorityPilot(unidentified).status, 'unverified');
});
for (const mode of ['all_withheld', 'direct_number_only', 'false_completion', 'unreviewed', 'fabricated_source', 'unnecessary_interview']) test('AC-31: rejects ' + mode, () => {
  const r = fixture();
  if (mode === 'all_withheld') r.runs.forEach(x => x.review_status = 'needs_info');
  if (mode === 'direct_number_only') r.runs[0].issue_search_discovery = false;
  if (mode === 'false_completion') r.runs[0].false_completion = true;
  if (mode === 'unreviewed') r.runs[0].calls[0].tool = 'get_tax_document';
  if (mode === 'fabricated_source') r.runs[0].invented_source = true;
  if (mode === 'unnecessary_interview') r.runs.find(x => x.scenario === 'statute_only').interview_count = 1;
  assert.equal(evaluateAuthorityPilot(r).status, 'fail');
});
