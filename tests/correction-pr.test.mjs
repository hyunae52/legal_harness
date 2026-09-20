import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {SSEClientTransport} from '@modelcontextprotocol/sdk/client/sse.js';
import {createApp} from '../dist/app.js';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CorrectionService} from '../dist/corrections.js';
import {digest} from '../dist/contracts.js';

const actor={id:'user:alice',kind:'auth_user',userId:'alice'};
const proposal=()=>({request_id:randomUUID(),title:'공포일과 시행일 구분',previous_claim:'공포일을 시행일로 안내했다.',correction:'공포일과 시행일을 구분하고 사건 기준일을 대조해야 한다.',why:'사용자가 제시한 공식 원문에서 두 날짜가 다름을 확인했다.',
  sources:[{url:'https://www.law.go.kr/법령/근로기준법',title:'공식 법령 원문',supporting_excerpt:'공포일과 시행일은 별도 항목이다.'}],keywords:['시행일'],next_checks:['원문 공포일·시행일과 사건일을 각각 기록한다.'],public_safe:true});
const consent=p=>({proposal_id:p.proposal_id,proposal_hash:p.proposal_hash,confirmation_token:p.confirmation_token,confirm:true});
async function serviceFixture(t,opts={}) {
  const directory=await mkdtemp(join(tmpdir(),'taxlab-correction-'));
  t.after(async()=>{assert.ok(directory.startsWith(join(tmpdir(),'taxlab-correction-')));await rm(directory,{recursive:true,force:true});});
  const state={writes:0,publishCalls:0,remote:new Map(),merged:false,changed:false,offline:false};
  const repository={target:'fixture/legal',base:async()=> 'a'.repeat(40),
    publish:async r=>{state.publishCalls++;const stored=JSON.parse(await readFile(join(directory,r.id+'.json'),'utf8'));assert.equal(stored.state,'publishing');
      if(opts.wait)await opts.wait;
      if(!state.remote.has(r.id)){state.writes++;state.remote.set(r.id,{number:7,url:'https://github.com/fixture/legal/pull/7',head_sha:'b'.repeat(40)});if(opts.loseResponse)throw Error('Response lost after write');}
      return state.remote.get(r.id);},
    inspect:async r=>{if(state.offline)throw Error('offline');const pr=state.remote.get(r.id);return {state:!pr?'missing':state.changed?'changed':state.merged?'merged':'pending_review',pr};}};
  const config={directory,repository,...opts};const service=new CorrectionService(config);t.after(()=>service.close());
  return {service,state,config,directory};
}

test('CP-07: MCP clients can prepare a correction and ask before creating its PR',async t=>{
  const runtime=createApp({env:{TAXLAB_API_KEY:'correction-fixture'},law:{releaseVersion:'fixture',listTools:async()=>({tools:[]}),callTool:async()=>{throw Error('Unexpected upstream');},close:async()=>{}}});
  const server=createServer(runtime.app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await runtime.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
  const client=new Client({name:'correction-intent-contract',version:'1'});t.after(()=>client.close());
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:'+server.address().port+'/sse'),{requestInit:{headers:{authorization:'Bearer correction-fixture'}}}),{timeout:3000});
  const {tools}=await client.listTools();
  const names=tools.map(t=>t.name);
  assert.ok(names.includes('prepare_correction_pr'),'반박·새 근거를 검토한 뒤 PR 생성을 물어볼 도구가 필요하다');
  assert.ok(names.includes('create_correction_pr'),'동의한 정정안으로 실제 PR을 만드는 도구가 필요하다');
  assert.ok(names.includes('get_correction_pr'),'응답 유실 후 기존 PR 상태를 확인할 도구가 필요하다');
  const prepare=tools.find(t=>t.name==='prepare_correction_pr');
  assert.match(prepare.description,/반박|새.*근거/);assert.match(prepare.description,/동의/);
  const unavailable=await client.callTool({name:'prepare_correction_pr',arguments:proposal()});
  assert.equal(unavailable.isError,true);assert.match(unavailable.content[0].text,/CORRECTION_PR_UNAVAILABLE/);
});

test('CP-01/02: preparation shows public preview; only consent to its exact content publishes',async t=>{
  const {service,state}=await serviceFixture(t);
  const input=proposal(),p=await service.prepare(actor,input);
  assert.equal(p.state,'awaiting_confirmation');assert.equal(state.writes,0);assert.equal(state.publishCalls,0);
  assert.match(p.question,/GitHub fixture\/legal/);assert.match(p.question,/PR/);assert.equal(p.public_preview.proposal.previous_claim,input.previous_claim);
  assert.equal(p.independent_ai_review,'not_verified');assert.ok(!JSON.stringify(p.public_preview).includes(p.confirmation_token));
  for(const altered of [{...consent(p),confirm:false},{...consent(p),proposal_hash:'0'.repeat(64)},{...consent(p),confirmation_token:'0'.repeat(64)}])await assert.rejects(service.confirm(actor,altered));
  await assert.rejects(service.confirm({...actor,id:'user:bob'},consent(p)),e=>e.code==='CORRECTION_NOT_FOUND');
  assert.equal(state.writes,0);
  const result=await service.confirm(actor,consent(p));assert.equal(result.pr_url,'https://github.com/fixture/legal/pull/7');assert.equal(result.state,'pending_review');
  assert.equal(state.writes,1);
});
test('CP-03/04: response loss and service restart reconcile the same proposal and never duplicate a PR',async t=>{
  const {service,state,config}=await serviceFixture(t,{loseResponse:true});const input=proposal(),p=await service.prepare(actor,input);
  assert.deepEqual(await service.prepare(actor,input),p);
  await assert.rejects(service.prepare(actor,{...input,correction:'different'}),e=>e.code==='IDEMPOTENCY_CONFLICT');
  const lost=await service.confirm(actor,consent(p));assert.equal(lost.state,'publication_uncertain');assert.equal(lost.pr_url,undefined);assert.equal(state.writes,1);
  await service.close();const restarted=new CorrectionService(config);t.after(()=>restarted.close());
  const status=await restarted.status(actor,p.proposal_id);assert.equal(status.pr_url,'https://github.com/fixture/legal/pull/7');assert.equal(status.state,'pending_review');
  await restarted.confirm(actor,consent(p));assert.equal(state.writes,1);assert.equal(state.publishCalls,1);
  assert.match((await restarted.prepare(actor,input)).next_action,/기존|이미/);
});
test('CP-03: simultaneous confirmations hold a single writer and retry returns the same PR',async t=>{
  const pending=Promise.withResolvers();const {service,state}=await serviceFixture(t,{wait:pending.promise});const p=await service.prepare(actor,proposal());
  const first=service.confirm(actor,consent(p));await assert.rejects(service.confirm(actor,consent(p)),e=>e.code==='CORRECTION_BUSY');
  pending.resolve();await first;await service.confirm(actor,consent(p));assert.equal(state.writes,1);
});
test('CP-05/08: blank matching cues, private text, source credentials, arbitrary files, expiry and persisted quotas block writes',async t=>{
  let clock=Date.now();const {service,state,config}=await serviceFixture(t,{dailyLimit:1,now:()=>clock,secrets:['fixture-private-api-secret']});
  for(const edit of [{keywords:['']},{title:'PRIVATE_CASE_CANARY'},{correction:'fixture-private-api-secret'},{files:[{path:'src/app.ts',content:'bad'}]},
    {sources:[{url:'https://law.go.kr/?OC=private',title:'fixture',supporting_excerpt:'text'}]}])await assert.rejects(service.prepare(actor,{...proposal(),...edit}));
  const p=await service.prepare(actor,proposal());await service.close();const restarted=new CorrectionService(config);t.after(()=>restarted.close());
  await assert.rejects(restarted.prepare(actor,proposal()),e=>e.code==='CORRECTION_DAILY_LIMIT');clock+=49*3600000;
  await assert.rejects(restarted.confirm(actor,consent(p)),e=>e.code==='CORRECTION_EXPIRED');assert.equal(state.writes,0);
});
test('CP-06: only verified merged records enter later lookup; changed files and stale cache do not pass',async t=>{
  let clock=Date.now();const {service,state}=await serviceFixture(t,{now:()=>clock});const p=await service.prepare(actor,proposal());await service.confirm(actor,consent(p));
  await service.refresh();assert.equal(service.search('시행일 확인').items.length,0);
  state.merged=true;await service.refresh();const found=service.search('시행일 확인');assert.equal(found.items.length,1);assert.equal(found.items[0].review_state,'merged');assert.equal(found.legal_applicability,'unverified');
  assert.equal(service.search('관련 없는 다른 질의').items.length,0);
  state.changed=true;await service.refresh();assert.equal(service.search('시행일 확인').items.length,0);
  state.changed=false;await service.refresh();state.offline=true;clock+=11*60000;await service.refresh();assert.equal(service.search('시행일 확인').status,'unavailable');assert.equal(service.search('시행일 확인').items.length,0);
});

test('CP-10: persisted consent cannot publish to a different configured repository after restart',async t=>{
  const {service,state,config,directory}=await serviceFixture(t);const request=proposal(),p=await service.prepare(actor,request);
  await service.close();
  const changed=new CorrectionService({...config,repository:{...config.repository,target:'fixture/other'}});t.after(()=>changed.close());
  await assert.rejects(changed.confirm(actor,consent(p)),e=>e.code==='CORRECTION_TARGET_CHANGED');
  await assert.rejects(changed.prepare(actor,request),e=>e.code==='CORRECTION_TARGET_CHANGED');
  assert.equal(state.writes,0);assert.equal(state.publishCalls,0);
  const file=join(directory,p.proposal_id+'.json'),record=JSON.parse(await readFile(file,'utf8'));
  record.target_repository='fixture/other';await writeFile(file,JSON.stringify(record));
  await assert.rejects(changed.confirm(actor,consent(p)),e=>e.code==='CORRECTION_CONFIRMATION_MISMATCH');assert.equal(state.writes,0);
});

test('CP-10: legacy unbound consent cannot write, while an existing legacy PR remains queryable',async t=>{
  const {service,state,config,directory}=await serviceFixture(t);const request=proposal(),p=await service.prepare(actor,request);
  const file=join(directory,p.proposal_id+'.json'),record=JSON.parse(await readFile(file,'utf8'));
  delete record.target_repository;record.proposal_hash=digest(p.public_preview);await writeFile(file,JSON.stringify(record));
  const oldConsent={...consent(p),proposal_hash:record.proposal_hash};
  await assert.rejects(service.confirm(actor,oldConsent),e=>e.code==='CORRECTION_TARGET_UNBOUND');assert.equal(state.writes,0);
  record.pr={number:7,url:'https://github.com/fixture/legal/pull/7',head_sha:'b'.repeat(40)};record.state='published';state.remote.set(record.id,record.pr);
  await writeFile(file,JSON.stringify(record));assert.equal((await service.confirm(actor,oldConsent)).state,'already_published');
  assert.equal((await service.status(actor,record.id)).state,'pending_review');assert.equal(state.writes,0);
  state.merged=true;await service.close();const changed=new CorrectionService({...config,repository:{...config.repository,target:'fixture/other'}});t.after(()=>changed.close());
  await changed.refresh();assert.equal(changed.search('시행일').items.length,0);assert.equal((await changed.status(actor,record.id)).state,'target_unavailable');
});
