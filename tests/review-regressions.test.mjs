import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { createApp } from '../dist/app.js';
import { createAuthenticator } from '../dist/auth.js';
import { GateEngine } from '../dist/gates.js';
import { LawMcpError } from '../dist/koreanLawClient.js';
import { ServiceError } from '../dist/contracts.js';

async function fixture(t, opts = {}) {
  const calls = [];
  const law = { releaseVersion: '4.13.0', listTools: async () => ({tools: [{name:'search_law',inputSchema:{type:'object'}}]}), close: async () => {},
    callTool: async (name,args) => { calls.push({name,args}); if(opts.operation) await opts.operation(); if(opts.error) throw opts.error;
      return {kind:'retrieval',tool:name,result:{content:[{type:'text',text:'Fixture source'}], structuredContent:{law:'fixture'}, _meta:{upstream:'preserved'}}}; } };
  const authenticate = opts.realAuth ? createAuthenticator({TAXLAB_API_KEY: 'fixture-key'}) : async req => {
    if (req.query.apiKey !== undefined || !['Bearer alice','Bearer bob'].includes(req.get('authorization'))) throw new ServiceError(401,'UNAUTHORIZED');
    return {id:req.get('authorization').slice(7),kind:'auth_user',userId:req.get('authorization').slice(7)};
  };
  const runtime = createApp({law,authenticate,...opts});
  const server = createServer(runtime.app);
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  const base = 'http://127.0.0.1:' + server.address().port;
  t.after(async()=>{await runtime.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
  async function request(path,body,auth='Bearer alice',extra={}) {
    const res=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'content-type':'application/json'}),...(auth?{authorization:auth}:{}),...extra},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(4000)});
    return {status:res.status,body:await res.json()};
  }
  return {base,calls,request,runtime};
}

test('native ESM app imports without starting a listener or loading environment credentials',()=>assert.equal(typeof createApp,'function'));
test('unauthenticated analyze/tools/messages do no upstream work',async t=>{
  const f=await fixture(t);
  for(const [p,b] of [['/api/analyze',{query:'law'}],['/api/tools',undefined],['/messages?sessionId=00000000-0000-4000-8000-000000000001',{}]]) assert.equal((await f.request(p,b,null)).status,401);
  assert.equal(f.calls.length,0);
});
test('production authentication rejects query keys and missing key configuration',async t=>{
  const f=await fixture(t,{realAuth:true});
  assert.equal((await f.request('/api/tools?apiKey=fixture-key',undefined,null)).status,401);
  assert.equal((await f.request('/api/tools',undefined,'Bearer fixture-key')).status,200);
  const noKey=createAuthenticator({});
  await assert.rejects(noKey({query:{},get:n=>n==='x-api-key'?'fixture-key':undefined}),e=>e.status===401);
});
test('JWT identity is verified through Supabase and never comes from submitted names',async()=>{
  let observed;
  const auth=createAuthenticator({SUPABASE_URL:'https://fixture.invalid',SUPABASE_PUBLISHABLE_KEY:'fixture-publishable'},async(input,init)=>{
    observed=new Request(input,init);return Response.json({id:'00000000-0000-4000-8000-000000000001'});
  });
  const actor=await auth({query:{},get:n=>n==='authorization'?'Bearer fixture-jwt':undefined});
  assert.equal(observed.headers.get('authorization'),'Bearer fixture-jwt');
  assert.equal(actor.id,'user:00000000-0000-4000-8000-000000000001');
});
test('global execution capacity counts work until completion including disconnected callers',async t=>{
  let entered=0;const wait=Promise.withResolvers();
  const f=await fixture(t,{operation:async()=>{entered++;await wait.promise;}});
  const controller=new AbortController();
  const disconnected=fetch(f.base+'/api/analyze',{method:'POST',headers:{authorization:'Bearer alice','content-type':'application/json'},body:JSON.stringify({query:'law'}),signal:controller.signal}).catch(()=>null);
  const requests=[1,2].map(()=>f.request('/api/analyze',{query:'law'}));
  while(entered<3) await new Promise(r=>setTimeout(r,5));
  controller.abort();await disconnected;
  assert.equal((await f.request('/api/analyze',{query:'law'})).status,429);
  wait.resolve();await Promise.all(requests);
  assert.equal((await f.request('/health')).body.active_requests,0);
});
test('retrieval retains structured content and provenance without pretending to validate a final answer',async t=>{
  const f=await fixture(t);const r=await f.request('/api/analyze',{query:'law'});
  assert.equal(r.status,200);assert.equal(f.calls[0].name,'legal_research');assert.equal(f.calls[0].args.query,'law');
  assert.equal(r.body.data.result.structuredContent.law,'fixture');assert.equal(r.body.quality_gate,null);
  assert.equal(r.body.data.evidence.applicability,'unverified');assert.equal(r.body.data.evidence.purpose,'retrieval_only');
});
test('explicit retrieval identifiers are not overwritten; invalid process settings/query rejected',async t=>{
  const f=await fixture(t);await f.request('/api/analyze',{query:'law',tool:'get_law_text',arguments:{mst:'123',jo:'88'}});
  assert.deepEqual(f.calls[0].args,{mst:'123',jo:'88'});
  assert.equal((await f.request('/api/analyze',{})).status,400);
  assert.equal((await f.request('/api/analyze',{query:'law',command:'bad'})).status,400);
});
test('upstream timeout/config/tool failures are failures and unexpected errors do not leak secrets',async t=>{
  for(const [status,code] of [[502,'MCP_TOOL_ERROR'],[503,'MCP_NOT_CONFIGURED'],[504,'MCP_TIMEOUT']]) {
    const f=await fixture(t,{error:new LawMcpError(status,code,'private-detail')});const r=await f.request('/api/analyze',{query:'law'});
    assert.equal(r.status,status);assert.equal(r.body.code,code);assert.ok(!JSON.stringify(r).includes('private-detail'));
  }
  const f=await fixture(t,{error:new Error('private-token')});assert.deepEqual((await f.request('/api/analyze',{query:'law'})).body,{code:'INTERNAL_ERROR'});
});
test('legacy automatic PR paths stay closed and unavailable durable intake never reports success',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/api/evolve',{issue_summary:'old'})).status,410);
  assert.equal((await f.request('/api/failures',{})).status,503);
});
test('durable service receives verified actor and DB error is not success',async t=>{
  let actor;const f=await fixture(t,{failures:{submit:async(a)=>{actor=a;throw new ServiceError(503,'DB_UNAVAILABLE');},status:async()=>({})}});
  assert.equal((await f.request('/api/failures',{proposer_name:'bob'})).status,503);assert.equal(actor.id,'alice');
});
test('real MCP SSE and messages require matching authenticated principal, preserve upstream result',async t=>{
  const f=await fixture(t);let session;
  const client=new Client({name:'review',version:'1'});
  const transport=new SSEClientTransport(new URL(f.base+'/sse'),{requestInit:{headers:{authorization:'Bearer alice'}},fetch:async(url,init)=>{
    if(String(url).includes('/messages?')) session=new URL(url).searchParams.get('sessionId');return fetch(url,init);
  }});
  t.after(()=>client.close());await client.connect(transport,{timeout:3000});
  const catalog=await client.listTools();assert.ok(catalog.tools.some(x=>x.name==='validate_legal_draft'));
  assert.equal((await f.request('/messages?sessionId='+session,{jsonrpc:'2.0',method:'ping',id:20},'Bearer bob')).status,404);
  const r=await client.callTool({name:'search_law',arguments:{query:'law'}});assert.equal(r.structuredContent.law,'fixture');assert.equal(r._meta.upstream,'preserved');
  const invalid=await client.callTool({name:'validate_tax_draft',arguments:{draft_answer:'law',force:'false'}});assert.equal(invalid.isError,true);
  const old=await client.callTool({name:'propose_tax_rule',arguments:{}});assert.equal(old.isError,true);
});
test('foreign browser Origin and oversized body are rejected',async t=>{
  const f=await fixture(t);assert.equal((await f.request('/api/tools',undefined,'Bearer alice',{origin:'https://evil.invalid'})).status,403);
  assert.equal((await f.request('/api/analyze',{query:'x'.repeat(300000)})).status,413);
});
test('all ten rules have executable missing-fact paths; FC08-10 are no longer silent passes',()=>{
  const engine=new GateEngine();assert.equal(engine.rules.length,10);
  for(const rule of engine.rules){const r=engine.validate({draft_answer:rule.cues[0]},'fixture');assert.equal(r.checks.find(x=>x.id===rule.id).status,'needs_info');assert.equal(r.passed,false);}
  const result=engine.validate({draft_answer:'종전 취득원가 권리가액 분담금 전액을 시가로 안분'},'fixture');
  assert.ok(['FC-08','FC-09','FC-10'].every(id=>result.checks.some(c=>c.case_id===id)));
});
test('empty checks/skips/unverified legal basis cannot become passed; force preserves completed failed arithmetic',()=>{
  const e=new GateEngine();assert.equal(e.validate({draft_answer:'hello'},'v').coverage,'no_coverage');
  assert.throws(()=>e.validate({draft_answer:''},'v'));assert.throws(()=>new GateEngine('missing-rules-directory'));
  const normal=e.validate({draft_answer:'arithmetic',facts:{allocation:{total:100,parts:[60,60]}}},'v');assert.equal(normal.blocked,true);assert.equal(normal.assessment_complete,true);
  const forced=e.validate({draft_answer:'arithmetic',facts:{allocation:{total:100,parts:[60,60]}},force:true,bypass_reason:'review exception'},'v');
  assert.equal(forced.blocked,false);assert.equal(forced.assessment_complete,true);assert.equal(forced.scoped_pass,false);assert.equal(forced.passed,false);
  const skipped=e.validate({draft_answer:'분담금',skip_gates:['QG-COST-03'],bypass_reason:'review exception'},'v');assert.equal(skipped.assessment_complete,false);
  const revised=e.validate({draft_answer:'different'},'v');assert.notEqual(normal.draft_hash,revised.draft_hash);
});
test('health records release and rule fingerprints',async t=>{const f=await fixture(t);const r=await f.request('/health');assert.equal(r.body.mcp_release,'4.13.0');assert.match(r.body.rules_version,/^[a-f0-9]{64}$/);});
