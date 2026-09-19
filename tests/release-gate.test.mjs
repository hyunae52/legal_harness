import assert from 'node:assert/strict';
import test from 'node:test';
import {verifyRelease} from '../dist/releaseGate.js';
import {digest} from '../dist/contracts.js';
function fixture(){
  const base='a'.repeat(40),head='b'.repeat(40),tree='c'.repeat(40),merge='d'.repeat(40),hash='e'.repeat(64);
  const m={schema_version:1,repository:'fixture/fixture',base,head,tree,pr_number:1,workflow_id:2,run_id:3,run_attempt:1,artifact_sha256:hash,execution_hash:hash,upstream_candidate_sha256:null,components:[{pr:1,head}],migrations:[]};
  const e={operator:'fixture-owner',approval:{author:'fixture-owner',body:`APPROVE DEPLOY ${digest(m)}`},pr:{merged:true,head,base,merge},merge:{sha:merge,parents:[base,head],tree},main:merge,artifact_sha256:hash,
    run:{id:3,attempt:1,workflow_id:2,head,path:'.github/workflows/review.yml',status:'completed',conclusion:'success'},components:m.components,
    jobs:[{name:'review / Node 22',status:'completed',conclusion:'success',steps:['npm ci --ignore-scripts --omit=optional --no-audit --no-fund','npm run review','npm run review:package'].map(name=>({name,status:'completed',conclusion:'success'}))}]};return {m,e};
}
test('merge commit may differ from approved head only with the exact approved parents and tree',()=>{
  const {m,e}=fixture();assert.equal(verifyRelease(m,e).status,'identity_verified');assert.equal(verifyRelease(m,e).deployment_authorized,false);
  for(const mutate of [e=>e.merge.parents=[e.pr.head],e=>e.merge.tree='f'.repeat(40),e=>e.pr.head='f'.repeat(40),e=>e.main='f'.repeat(40),e=>e.artifact_sha256='f'.repeat(64),e=>e.approval.author='fixture-bot',e=>e.approval.body='approved']) {
    const changed=structuredClone(e);mutate(changed);assert.throws(()=>verifyRelease(m,changed));
  }
});
test('skipped, neutral, missing, wrong-run or changed component checks cannot pass the release gate',()=>{
  for(const mutate of [e=>e.jobs[0].steps[1].conclusion='skipped',e=>e.jobs[0].conclusion='neutral',e=>e.jobs=[],e=>e.run.head='f'.repeat(40),e=>e.run.workflow_id=9,e=>e.run.attempt=2,e=>e.components=[{pr:1,head:'f'.repeat(40)}]]) {
    const {m,e}=fixture();mutate(e);assert.throws(()=>verifyRelease(m,e));
  }
});
