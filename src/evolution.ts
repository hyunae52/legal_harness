import { z } from 'zod';
import { digest, ServiceError } from './contracts.js';
import { reviewPatch, type ModelTransport } from './supremeJudge.js';
import { FailureSchema } from './failures.js';

export const PatchSchema=z.object({files:z.array(z.object({path:z.string().max(200),content:z.string().max(40000)}).strict()).min(1).max(10)}).strict();
export type Patch=z.infer<typeof PatchSchema>;
const allowed=/^(?:src\/(?:gates|sourceVerifier|evidence)\.ts|rules\/QG-[A-Z]+-\d+\.json|tests\/cases\/[a-z0-9_-]+\.test\.mjs)$/;
export function validatePublicPatch(input:unknown):Patch {
  const patch=PatchSchema.parse(input);
  if(new Set(patch.files.map(f=>f.path)).size!==patch.files.length) throw new ServiceError(422,'DUPLICATE_PATCH_PATH');
  for(const file of patch.files) {
    if(!allowed.test(file.path)||/\.\.|\\|\x00/.test(file.path)) throw new ServiceError(422,'PATCH_OUTSIDE_AUTOMATION_SCOPE');
    // Defense in addition to allowing only public synthetic input. Never rely on
    // a regexp to anonymize arbitrary private case documents.
    if(/(?:-----BEGIN .*PRIVATE KEY-----|(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}|\b\d{6}-[1-4]\d{6}\b|PRIVATE_CASE_CANARY)/.test(file.content)) throw new ServiceError(422,'PUBLICATION_BLOCKED');
  }
  if(Buffer.byteLength(JSON.stringify(patch),'utf8')>100_000) throw new ServiceError(413,'PATCH_TOO_LARGE');
  return patch;
}
export const RunEvidenceSchema=z.object({
  producer:z.literal('trusted_runner'),run_id:z.string().min(1),
  base_sha:z.string().regex(/^[a-f0-9]{40}$/),head_sha:z.string().regex(/^[a-f0-9]{40}$/),
  execution_hash:z.string().regex(/^[a-f0-9]{64}$/),fixture_hash:z.string().regex(/^[a-f0-9]{64}$/),
  patch_hash:z.string().regex(/^[a-f0-9]{64}$/),
  expected_assertion:z.string().min(1),base_failure:z.string().min(1),patch_result:z.literal('pass'),
  checks:z.array(z.object({name:z.string(),conclusion:z.literal('success'),executed:z.literal(true)}).strict()),
}).strict();
export interface EvolutionJob {id:string;attempt_id:string;base_sha:string;execution_hash:string;fixture_hash:string;attempt:number;payload:unknown}
export interface EvolutionPorts {
  assertLease():Promise<void>;
  writer(job:EvolutionJob,feedback?:string):Promise<unknown>;
  // This is an unprivileged executor. It must not accept writer-provided logs.
  test(job:EvolutionJob,patch:Patch):Promise<unknown>;
  reviewer?:ModelTransport;
  record(event:string,evidence:unknown):Promise<void>;
  publish(job:EvolutionJob,patch:Patch,proof:unknown):Promise<{status:'published'|'unknown';url?:string}>;
}
/** Single bounded attempt. Durable claiming, retry counters and CAS are owned
 * by the coordinator. These ports are not exposed through any MCP tool. */
export async function runEvolutionAttempt(job:EvolutionJob,ports:EvolutionPorts,feedback?:string) {
  z.object({id:z.string().uuid(),attempt_id:z.string().uuid(),base_sha:z.string().regex(/^[a-f0-9]{40}$/),execution_hash:z.string().regex(/^[a-f0-9]{64}$/),fixture_hash:z.string().regex(/^[a-f0-9]{64}$/),attempt:z.number().int(),payload:FailureSchema.omit({request_id:true})}).strict().parse(job);
  if(job.attempt<1||job.attempt>3) throw new ServiceError(409,'ATTEMPT_LIMIT');
  await ports.assertLease();
  if(!ports.reviewer) {await ports.record('waiting_dependency',{reason:'reviewer_unavailable'});return {state:'waiting_dependency'};}
  const patch=validatePublicPatch(await ports.writer(job,feedback));
  await ports.assertLease();
  const run=RunEvidenceSchema.parse(await ports.test(job,patch));
  const required=['build','regressions','fixed_fixture'];
  if(run.patch_hash!==digest(patch)||run.head_sha===job.base_sha||run.base_sha!==job.base_sha||run.execution_hash!==job.execution_hash||run.fixture_hash!==job.fixture_hash||run.base_failure!==run.expected_assertion||new Set(run.checks.map(c=>c.name)).size!==run.checks.length||!required.every(n=>run.checks.some(c=>c.name===n))) {
    throw new ServiceError(422,'INVALID_REPRODUCTION_EVIDENCE');
  }
  await ports.assertLease();
  const review=await reviewPatch({job_id:job.id,attempt_id:job.attempt_id,base_sha:job.base_sha,head_sha:run.head_sha,
    execution_hash:job.execution_hash,fixture_hash:job.fixture_hash,diff:JSON.stringify(patch),test_evidence:JSON.stringify(run),
    source_evidence:JSON.stringify(job.payload)},ports.reviewer);
  await ports.assertLease();
  await ports.record('ai_review',{run,review,patch_hash:digest(patch)});
  if(review.verdict!=='approved') {
    const state=review.verdict==='unavailable'?'waiting_dependency':review.verdict==='needs_evidence'?'needs_evidence':'revision_required';
    await ports.record(state,{review});return {state,feedback:review.required_changes.join('\n')};
  }
  const published=await ports.publish(job,patch,{run,review,patch_hash:digest(patch)});
  await ports.assertLease();
  if(published.status!=='published'||!published.url) {await ports.record('waiting_dependency',{external_state:'unknown'});return {state:'waiting_dependency'};}
  await ports.record('ready_for_human',{head_sha:run.head_sha,execution_hash:job.execution_hash,pr_url:published.url});
  return {state:'ready_for_human',pr_url:published.url};
}
