import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const scenarios = ['remaining_two_homes', 'ordinary_two_homes', 'amended_rule', 'administrative_only',
  'provider_failure', 'subsequent_change', 'statute_only', 'raw_lookup_only'];

/** Release evidence validator. Semantic verdicts must come from a separately recorded source review. */
export function evaluateAuthorityPilot(report) {
  const failures = [], missing = [];
  if (!report?.frozen_protocol_hash || !report?.source_sha || !report?.evaluator) missing.push('protocol_source_evaluator');
  const runs = report?.runs ?? [];
  if (runs.length !== 24) missing.push('24_runs_required');
  for (const scenario of scenarios) for (const repetition of [1, 2, 3]) {
    const matching = runs.filter(r => r.scenario === scenario && r.repetition === repetition);
    if (matching.length !== 1) { missing.push(`${scenario}:${repetition}`); continue; }
    const r = matching[0], label = `${scenario}:${repetition}`;
    if (!r.model_id || !r.client_version || !r.started_at || !r.trace_hash || !r.output_hash || !Array.isArray(r.calls) || !r.calls.length)
      missing.push(`${label}:execution_evidence`);
    if (r.semantic_verdict !== 'pass') failures.push(`${label}:semantic_verdict`);
    if (r.false_completion || r.invented_source || r.invented_fact) failures.push(`${label}:false_claim`);
    if (['remaining_two_homes', 'ordinary_two_homes'].includes(scenario) && (!r.issue_search_discovery || !r.body_acquired || !r.applicability_reviewed || r.case_number_hint))
      failures.push(`${label}:discovery_and_applicability`);
    if (scenario === 'ordinary_two_homes' && r.review_status !== 'structurally_complete') failures.push(`${label}:normal_control_blocked`);
    if (['statute_only', 'raw_lookup_only'].includes(scenario)) {
      if (r.interview_count || !r.raw_data_returned || r.claimed_reviewed) failures.push(`${label}:lookup_regression`);
    } else if (!r.calls.some(c => c.tool === 'review_legal_reasoning' && c.result_observed === true)) failures.push(`${label}:review_not_observed`);
    if (scenario === 'provider_failure' && !r.failure_observed) failures.push(`${label}:failure_not_injected`);
    if (scenario === 'subsequent_change' && !r.subsequent_search_observed) failures.push(`${label}:subsequent_search_missing`);
  }
  return { status: missing.length ? 'unverified' : failures.length ? 'fail' : 'pass', failures, missing,
    scope: 'identified client/model pilot; not a statistical guarantee or original-incident root cause' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const result = evaluateAuthorityPilot(report); console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'pass') process.exitCode = 1;
}
