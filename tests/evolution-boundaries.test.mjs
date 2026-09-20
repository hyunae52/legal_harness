// Contract tests with injected ports. These are NOT evidence of a live AI review.
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {reviewPatch} from '../dist/supremeJudge.js';
import {runEvolutionAttempt,validatePublicPatch} from '../dist/evolution.js';
import {publishReviewedPatch} from '../dist/gitOps.js';
import {digest} from '../dist/contracts.js';
const base='a'.repeat(40),head='b'.repeat(40),hash='c'.repeat(64);
const payload={case_id:'INPUT-BOOLEAN-01',category:'validation',expected:'reject_invalid_input',actual:'accepted_invalid_input'};
const job=()=>({id:randomUUID(),attempt_id:randomUUID(),base_sha:base,execution_hash:hash,fixture_hash:hash,attempt:1,payload});
const context={job_id:randomUUID(),attempt_id:randomUUID(),base_sha:base,head_sha:head,execution_hash:hash,fixture_hash:hash,diff:'public synthetic diff',test_evidence:'fixed fixture',source_evidence:'synthetic input contract'};
const model=text=>({model:'fixture-review-model',request:async()=>({text:typeof text==='string'?text:JSON.stringify(text),model:'fixture-review-model',requestId:'fixture'})});
const approval={verdict:'approved',reason:'Fixture only',required_changes:[]};
test('reviewer absence, malformed output, spoofed identity, contradictions and actual timeout never approve',async()=>{
  assert.equal((await reviewPatch(context)).verdict,'unavailable');
  for(const output of ['', 'false',{}, {...approval,verdict:'false'}, {...approval,required_changes:['fix']}, {...approval,extra:true}]) assert.equal((await reviewPatch(context,model(output))).verdict,'unavailable');
  assert.equal((await reviewPatch(context,{model:'expected',request:async()=>({text:JSON.stringify(approval),model:'other'})})).verdict,'unavailable');
  assert.equal((await reviewPatch(context,{model:'hung',request:()=>new Promise(()=>{})},10)).verdict,'unavailable');
  const a=await reviewPatch(context,model(approval)),b=await reviewPatch({...context,head_sha:'d'.repeat(40)},model(approval));
  assert.equal(a.verdict,'approved');assert.notEqual(a.request_hash,b.request_hash);assert.match(a.response_hash,/^[a-f0-9]{64}$/);
});
test('automation cannot edit coordinator, CI, authentication, existing baseline tests or publish case canaries',()=>{
  for(const path of ['src/index.ts','src/auth.ts','src/evolution.ts','.github/workflows/review.yml','tests/review-regressions.test.mjs','../src/gates.ts','src\\gates.ts']) assert.throws(()=>validatePublicPatch({files:[{path,content:'x'}]}));
  assert.throws(()=>validatePublicPatch({files:[{path:'src/gates.ts',content:'PRIVATE_CASE_CANARY'}]}));
  assert.throws(()=>validatePublicPatch({files:[{path:'src/gates.ts',content:'x'},{path:'src/gates.ts',content:'y'}]}));
});
const patch={files:[{path:'src/gates.ts',content:'// fixture synthetic patch'}]};
function fixture() {
  const current=job(),events=[];let writes=0;
  const run={producer:'trusted_runner',run_id:'fixture-run',base_sha:base,head_sha:head,execution_hash:hash,fixture_hash:hash,patch_hash:digest(patch),expected_assertion:'BOOLEAN_REJECTION',base_failure:'BOOLEAN_REJECTION',patch_result:'pass',checks:['build','regressions','fixed_fixture'].map(name=>({name,conclusion:'success',executed:true}))};
  const ports={assertLease:async()=>{},writer:async()=>patch,test:async()=>run,reviewer:model(approval),record:async(event,evidence)=>events.push({event,evidence}),publish:async()=>{writes++;return {status:'published',url:'https://github.com/example/fixture/pull/1'};}};
  return {current,events,run,ports,writes:()=>writes};
}
test('absent dependencies, unrelated base failure, skipped checks or changed fingerprint stop publication',async()=>{
  let f=fixture();delete f.ports.reviewer;assert.equal((await runEvolutionAttempt(f.current,f.ports)).state,'waiting_dependency');assert.equal(f.writes(),0);
  for(const change of [{base_failure:'IMPORT_FAILURE'},{execution_hash:'d'.repeat(64)},{patch_hash:'e'.repeat(64)},{checks:[]},{checks:[{name:'build',conclusion:'neutral',executed:false}]}]) {
    f=fixture();Object.assign(f.run,change);await assert.rejects(runEvolutionAttempt(f.current,f.ports));assert.equal(f.writes(),0);
  }
  f=fixture();f.current.payload={...payload,private_case:'PRIVATE_CASE_CANARY'};await assert.rejects(runEvolutionAttempt(f.current,f.ports));assert.equal(f.writes(),0);
});
test('revision feedback is retained; stale lease or ambiguous external effect cannot become ready',async()=>{
  let f=fixture();f.ports.reviewer=model({verdict:'changes_requested',reason:'Fix fixture',required_changes:['repair the boundary']});
  assert.equal((await runEvolutionAttempt(f.current,f.ports)).state,'revision_required');assert.equal(f.writes(),0);
  f=fixture();let leases=0;f.ports.assertLease=async()=>{if(++leases===4)throw Error('stale lease');};await assert.rejects(runEvolutionAttempt(f.current,f.ports),/stale lease/);assert.equal(f.writes(),0);
  f=fixture();f.ports.publish=async()=>({status:'unknown'});assert.equal((await runEvolutionAttempt(f.current,f.ports)).state,'waiting_dependency');assert.ok(!f.events.some(e=>e.event==='ready_for_human'));
});
test('trusted-port contract binds approval and publication to exact tested head; no live AI claimed',async()=>{
  const f=fixture();const result=await runEvolutionAttempt(f.current,f.ports);assert.equal(result.state,'ready_for_human');
  assert.equal(f.events.find(e=>e.event==='ai_review').evidence.review.context.head_sha,head);assert.equal(f.writes(),1);
});
test('PR publication reconciles only a matching open PR and does not invent URLs after write uncertainty',async()=>{
  const current=job(),options={token:'fixture',owner:'fixture',repo:'fixture',baseBranch:'main'};
  let prior=[],creates=0,blob=patch.files[0].content;
  const client={rest:{pulls:{list:async()=>({data:prior}),create:async()=>{creates++;throw Error('lost response');}},git:{getRef:async()=>({data:{object:{sha:head}}})},repos:{compareCommits:async()=>({data:{total_commits:1,files:[{filename:'src/gates.ts',status:'modified'}]}}),getContent:async()=>({data:{content:Buffer.from(blob).toString('base64')}})}}};
  await assert.rejects(publishReviewedPatch({...options,token:''},current,patch,head,client));assert.equal(creates,0);
  assert.equal((await publishReviewedPatch(options,current,patch,head,client)).status,'unknown');assert.equal(creates,1);
  prior=[{head:{sha:head},base:{ref:'main'},state:'open',html_url:'https://github.com/fixture/fixture/pull/1'}];
  assert.equal((await publishReviewedPatch(options,current,patch,head,client)).status,'published');assert.equal(creates,1);
  blob='unreviewed';await assert.rejects(publishReviewedPatch(options,current,patch,head,client),/PATCH_CONTENT_MISMATCH/);
  prior[0].state='closed';await assert.rejects(publishReviewedPatch(options,current,patch,head,client),/PR_HEAD_OR_STATE_CHANGED/);
});
