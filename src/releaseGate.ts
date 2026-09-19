import {z} from 'zod';
import {digest,ServiceError} from './contracts.js';
const sha=z.string().regex(/^[a-f0-9]{40}$/),hash=z.string().regex(/^[a-f0-9]{64}$/);
export const BatchManifestSchema=z.object({
  schema_version:z.literal(1),repository:z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  base:sha,head:sha,tree:sha,pr_number:z.number().int().positive(),
  workflow_id:z.number().int().positive(),run_id:z.number().int().positive(),run_attempt:z.number().int().positive(),
  artifact_sha256:hash,execution_hash:hash,upstream_candidate_sha256:hash.nullable(),
  components:z.array(z.object({pr:z.number().int().positive(),head:sha}).strict()).min(1).max(30),
  migrations:z.array(z.object({path:z.string().regex(/^supabase\/migrations\/[0-9a-z_]+\.sql$/),sha256:hash}).strict()).max(30),
}).strict();
export type BatchManifest=z.infer<typeof BatchManifestSchema>;
/** Evidence is fetched by a trusted read-only GitHub adapter, never accepted
 * from the proposed patch. This gate verifies release identity, not legal truth. */
export function verifyRelease(input:unknown,evidence:{
  approval:{author:string;body:string},operator:string,
  pr:{merged:boolean;head:string;base:string;merge:string},
  merge:{sha:string;parents:string[];tree:string},main:string,artifact_sha256:string,
  run:{id:number;attempt:number;workflow_id:number;head:string;path:string;status:string;conclusion:string},
  jobs:Array<{name:string;status:string;conclusion:string;steps:Array<{name:string;status:string;conclusion:string}>}>,
  components:Array<{pr:number;head:string}>,
}) {
  const m=BatchManifestSchema.parse(input),manifestHash=digest(m),reject=(code:string):never=>{throw new ServiceError(409,code);};
  if(evidence.approval.author!==evidence.operator||evidence.approval.body.trim()!==`APPROVE DEPLOY ${manifestHash}`)reject('HUMAN_APPROVAL_MISMATCH');
  if(!evidence.pr.merged||evidence.pr.head!==m.head||evidence.pr.base!==m.base||evidence.pr.merge!==evidence.merge.sha||evidence.main!==evidence.merge.sha)reject('PR_MERGE_MISMATCH');
  if(evidence.merge.parents.length!==2||evidence.merge.parents[0]!==m.base||evidence.merge.parents[1]!==m.head||evidence.merge.tree!==m.tree)reject('MERGE_TREE_MISMATCH');
  if(evidence.artifact_sha256!==m.artifact_sha256)reject('ARTIFACT_MISMATCH');
  const run=evidence.run;
  if(run.id!==m.run_id||run.attempt!==m.run_attempt||run.workflow_id!==m.workflow_id||run.head!==m.head||run.path!=='.github/workflows/review.yml'||run.status!=='completed'||run.conclusion!=='success')reject('CI_RUN_MISMATCH');
  const jobs=evidence.jobs.filter(j=>j.name==='review / Node 22');
  if(jobs.length!==1||jobs[0].status!=='completed'||jobs[0].conclusion!=='success')reject('CI_JOB_NOT_SUCCESS');
  for(const name of ['npm ci --ignore-scripts --omit=optional --no-audit --no-fund','npm run review','npm run review:package']) {
    const steps=jobs[0].steps.filter(s=>s.name===name);
    if(steps.length!==1||steps[0].status!=='completed'||steps[0].conclusion!=='success')reject('CI_STEP_NOT_EXECUTED');
  }
  if(new Set(m.components.map(c=>c.pr)).size!==m.components.length||digest(m.components)!==digest(evidence.components))reject('COMPONENT_HEAD_MISMATCH');
  return {status:'identity_verified',manifest_hash:manifestHash,merge_sha:evidence.merge.sha,tree:m.tree,artifact_sha256:m.artifact_sha256,
    deployment_authorized:false,remaining:['runtime_config','database_restore_drill','isolated_maintenance_adapter','staging_and_rollback']};
}
