import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

export const scenarios = ['remaining_two_homes', 'ordinary_two_homes', 'amended_rule', 'administrative_only',
  'provider_failure', 'subsequent_change', 'statute_only', 'raw_lookup_only'];

/** Release evidence validator. Semantic verdicts must come from a separately recorded source review. */
export function evaluateAuthorityPilot(report) {
  const failures = [], missing = [];
  const sha = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
  if (!sha(report?.frozen_protocol_hash) || !sha(report?.source_sha) || !report?.evaluator || !report?.model_id || !report?.reasoning_effort)
    missing.push('protocol_source_evaluator');
  if (!['windows', 'posix'].includes(report?.snapshot_path_style)) missing.push('snapshot_path_style');
  const runs = report?.runs ?? [];
  if (runs.length !== 24) missing.push('24_runs_required');
  for (const scenario of scenarios) for (const repetition of [1, 2, 3]) {
    const matching = runs.filter(r => r.scenario === scenario && r.repetition === repetition);
    if (matching.length !== 1) { missing.push(`${scenario}:${repetition}`); continue; }
    const r = matching[0], label = `${scenario}:${repetition}`;
    if (!r.model_id || !r.client_version || !r.started_at || !sha(r.trace_hash) || !sha(r.output_hash)
      || !sha(r.source_log_hash) || !sha(r.mcp_log_hash) || !sha(r.runtime_snapshot_sha)
      || !r.artifact_dir || !r.semantic_review_note || !Array.isArray(r.calls) || !r.calls.length)
      missing.push(`${label}:execution_evidence`);
    if (r.source_sha !== report.source_sha || r.frozen_protocol_hash !== report.frozen_protocol_hash
      || r.model_id !== report.model_id || r.reasoning_effort !== report.reasoning_effort) failures.push(`${label}:identity_mismatch`);
    for (const key of ['false_completion', 'invented_source', 'invented_fact'])
      if (typeof r[key] !== 'boolean') missing.push(`${label}:${key}`);
    if (r.semantic_verdict !== 'pass') failures.push(`${label}:semantic_verdict`);
    if (r.false_completion || r.invented_source || r.invented_fact) failures.push(`${label}:false_claim`);
    if (['remaining_two_homes', 'ordinary_two_homes'].includes(scenario) && (r.issue_search_discovery !== true || r.body_acquired !== true || r.applicability_reviewed !== true || r.case_number_hint !== false))
      failures.push(`${label}:discovery_and_applicability`);
    if (['remaining_two_homes', 'ordinary_two_homes'].includes(scenario) && typeof r.case_number_hint !== 'boolean') missing.push(`${label}:case_number_hint`);
    if (scenario === 'ordinary_two_homes' && r.review_status !== 'structurally_complete') failures.push(`${label}:normal_control_blocked`);
    if (['statute_only', 'raw_lookup_only'].includes(scenario)) {
      if (!Number.isInteger(r.interview_count) || r.interview_count < 0 || typeof r.raw_data_returned !== 'boolean' || typeof r.claimed_reviewed !== 'boolean')
        missing.push(`${label}:lookup_observations`);
      if (r.interview_count !== 0 || r.raw_data_returned !== true || r.claimed_reviewed !== false) failures.push(`${label}:lookup_regression`);
    } else if (!r.calls.some(c => c.tool === 'review_legal_reasoning' && c.result_observed === true)) failures.push(`${label}:review_not_observed`);
    if (scenario === 'provider_failure' && r.failure_observed !== true) failures.push(`${label}:failure_not_injected`);
    if (scenario === 'subsequent_change' && r.subsequent_search_observed !== true) failures.push(`${label}:subsequent_search_missing`);
  }
  return { status: missing.length ? 'unverified' : failures.length ? 'fail' : 'pass', failures, missing,
    scope: 'identified client/model pilot; not a statistical guarantee or original-incident root cause' };
}
/** Bind the separately written semantic review to actual saved outputs; a typed hash alone is insufficient. */
export async function verifyAuthorityPilotArtifacts(report, root) {
  const missing = [], failures = [], base = resolve(root);
  for (const r of report.runs ?? []) {
    const label = `${r.scenario}:${r.repetition}`, dir = resolve(base, r.artifact_dir ?? '');
    const rel = relative(base, dir);
    if (!r.artifact_dir || rel.startsWith('..') || isAbsolute(rel)) { failures.push(`${label}:artifact_path`); continue; }
    let metadata, log;
    for (const [file, key] of [['model-trace.jsonl', 'trace_hash'], ['answer.txt', 'output_hash'], ['sources.jsonl', 'source_log_hash'], ['mcp.jsonl', 'mcp_log_hash']]) {
      try {
        const bytes = await readFile(resolve(dir, file));
        if (createHash('sha256').update(bytes).digest('hex') !== r[key]) failures.push(`${label}:${file}:digest_mismatch`);
        if (file === 'mcp.jsonl') log = bytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
      } catch { missing.push(`${label}:${file}`); }
    }
    try { metadata = JSON.parse(await readFile(resolve(dir, 'run.json'), 'utf8')); } catch { missing.push(`${label}:run.json`); }
    if (metadata && (metadata.exit_code !== 0 || metadata.source_sha !== r.source_sha || metadata.frozen_protocol_hash !== r.frozen_protocol_hash
      || metadata.scenario !== r.scenario || metadata.repetition !== r.repetition || metadata.model_id !== r.model_id
      || metadata.reasoning_effort !== r.reasoning_effort || metadata.client_version !== r.client_version)) failures.push(`${label}:run_identity`);
    try {
      const runtime = resolve(dir, 'runtime'), files = [];
      async function walk(path) {
        for (const entry of await readdir(path, { withFileTypes: true })) {
          if (entry.isDirectory()) await walk(resolve(path, entry.name));
          else if (entry.isFile()) files.push(resolve(path, entry.name));
          else throw Error('Snapshot contains a link or non-regular entry');
        }
      }
      await walk(runtime);
      const label = path => report.snapshot_path_style === 'windows' ? relative(runtime, path).replaceAll('/', '\\') : relative(runtime, path).replaceAll('\\', '/');
      const order = path => report.snapshot_path_style === 'windows' ? label(path).toLowerCase() : label(path);
      files.sort((a, b) => order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0);
      const full = createHash('sha256'), source = createHash('sha256');
      for (const file of files) {
        const bytes = await readFile(file), path = label(file);
        full.update(path).update('\0').update(bytes);
        if (/^src[\\/][^\\/]+\.ts$/.test(path)) source.update(path).update('\0').update(bytes);
      }
      if (!files.length || full.digest('hex') !== r.runtime_snapshot_sha || metadata?.runtime_snapshot_sha !== r.runtime_snapshot_sha
        || source.digest('hex') !== r.source_sha) failures.push(`${r.scenario}:${r.repetition}:runtime_snapshot`);
    } catch { missing.push(`${label}:runtime_snapshot`); }
    if (log && !['statute_only', 'raw_lookup_only'].includes(r.scenario)) {
      const reviews = log.filter(row => row.request?.params?.name === 'review_legal_reasoning'
        && !row.response?.result?.isError && row.response?.result?.structuredContent?.status);
      if (!reviews.length) failures.push(`${label}:no_successful_review_call`);
      else if (reviews.at(-1).response.result.structuredContent.status !== r.review_status) failures.push(`${label}:review_status_mismatch`);
    }
  }
  return { missing, failures };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const result = evaluateAuthorityPilot(report), artifacts = await verifyAuthorityPilotArtifacts(report, process.argv[3] ?? process.cwd());
  result.missing.push(...artifacts.missing); result.failures.push(...artifacts.failures);
  result.status = result.missing.length ? 'unverified' : result.failures.length ? 'fail' : 'pass';
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'pass') process.exitCode = 1;
}
