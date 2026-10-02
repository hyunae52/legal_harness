import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateAuthorityPilot, verifyAuthorityPilotArtifacts, scenarios } from '../scripts/verify-authority-pilot.mjs';

// Synthetic records exercise the gate only. They are never submitted as actual model execution evidence.
const fixture = () => ({ frozen_protocol_hash: 'a'.repeat(64), source_sha: 'b'.repeat(64), evaluator: 'test', model_id: 'synthetic-model', reasoning_effort: 'synthetic', snapshot_path_style: 'posix',
  runs: scenarios.flatMap(scenario => [1, 2, 3].map(repetition => ({ scenario, repetition, model_id: 'synthetic-model', client_version: 'synthetic-client',
    started_at: '2026-10-01T00:00:00Z', trace_hash: 'c'.repeat(64), output_hash: 'd'.repeat(64), source_log_hash: 'e'.repeat(64), mcp_log_hash: 'f'.repeat(64),
    frozen_protocol_hash: 'a'.repeat(64), source_sha: 'b'.repeat(64), reasoning_effort: 'synthetic', artifact_dir: 'SYNTHETIC_ONLY', semantic_review_note: 'unit test only',
    runtime_snapshot_sha: '9'.repeat(64),
    false_completion: false, invented_source: false, invented_fact: false, calls: [{ tool: 'review_legal_reasoning', result_observed: true }],
    semantic_verdict: 'pass', issue_search_discovery: true, body_acquired: true, applicability_reviewed: true, case_number_hint: false,
    review_status: 'structurally_complete', interview_count: 0, raw_data_returned: true, claimed_reviewed: false, failure_observed: true, subsequent_search_observed: true }))) });
test('AC-31: the gate requires all frozen runs and an identified execution trace', () => {
  assert.equal(evaluateAuthorityPilot(fixture()).status, 'pass');
  const missing = fixture(); missing.runs.pop(); assert.equal(evaluateAuthorityPilot(missing).status, 'unverified');
  const unidentified = fixture(); delete unidentified.runs[0].model_id; assert.equal(evaluateAuthorityPilot(unidentified).status, 'unverified');
});
test('AC-31: omitted negative findings and mixed source snapshots cannot become passing evidence', () => {
  const absent = fixture(); delete absent.runs[0].invented_fact; assert.equal(evaluateAuthorityPilot(absent).status, 'unverified');
  const mixed = fixture(); mixed.runs[0].source_sha = 'd'.repeat(64); assert.equal(evaluateAuthorityPilot(mixed).status, 'fail');
});
test('AC-31: nonexistent artifacts cannot be replaced by a syntactically valid hash', async () => {
  const result = await verifyAuthorityPilotArtifacts({ runs: fixture().runs.slice(0, 1) }, process.cwd());
  assert.ok(result.missing.some(x => x.endsWith(':model-trace.jsonl')));
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
