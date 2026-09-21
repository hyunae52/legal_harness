import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { createApp } from '../dist/app.js';
import { CorrectionService } from '../dist/corrections.js';
import { PublicAccess } from '../dist/publicAccess.js';
import { ResourceBudgets } from '../dist/resourceBudgets.js';
import { safeToolDiagnostic } from '../dist/errorDiagnostics.js';

const secret = 'synthetic-public-session-secret-0123456789abcdef';
const plan = { query:'Synthetic public research', issues:[{id:'rule',question:'Which facts are missing?',required_fact_ids:['fact'],required_date_roles:[]}],
  facts:[{id:'fact',description:'Synthetic fact',status:'unknown',value:null,source:''}],event_dates:[] };
const proposal = { request_id:'d4b0f635-8f10-4d30-8a5e-156f15c3e470',title:'Synthetic correction',previous_claim:'A synthetic prior claim',
  correction:'Check the missing fact first',why:'The synthetic case omitted a condition',sources:[{url:'https://law.go.kr/법령/소득세법',title:'Synthetic test source',supporting_excerpt:'Synthetic excerpt for transport tests'}],
  keywords:['synthetic'],next_checks:['Check the synthetic condition'],public_safe:true };
async function fixture(t, extra={}) {
  const calls=[], publications=[];
  const directory=await mkdtemp(join(tmpdir(),'taxlab-public-'));
  const corrections=new CorrectionService({directory,repository:{target:'fixture/repo',base:async()=> 'a'.repeat(40),
    publish:async record=>{publications.push(record);return {number:1,url:'https://github.com/fixture/repo/pull/1',head_sha:'b'.repeat(40)};},inspect:async()=>({state:'pending_review'})}});
  const law={releaseVersion:'fixture',listTools:async()=>({tools:[{name:'search_law',inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query']}}]}),
    callTool:async(name,args)=>{calls.push({name,args});return {server:{name:'fixture',version:'1'},result:{content:[{type:'text',text:'Synthetic legal lookup'}]}};},close:async()=>{}};
  const runtime=createApp({law,corrections,env:{TAXLAB_PUBLIC_ACCESS:'1',TAXLAB_PUBLIC_SESSION_SECRET:secret,TAXLAB_API_KEY:'legacy-fixture'},...extra});
  const server=createServer(runtime.app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const clients=[];
  t.after(async()=>{await Promise.all(clients.map(c=>c.close()));await runtime.close();await corrections.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});});
  const request=async(path,body,headers={})=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...headers},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};};
  const mcp=async(kind='http')=>{const c=new Client({name:'public-test',version:'1'});clients.push(c);await c.connect(kind==='http'?new StreamableHTTPClientTransport(new URL(base+'/mcp')):new SSEClientTransport(new URL(base+'/sse')),{timeout:2000});return c;};
  return {base,request,mcp,calls,publications,runtime};
}

test('PA-01: header-free REST, HTTP MCP and SSE retrieve through the real public app',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/api/tools')).status,200);
  for(const kind of ['http','sse']) {
    const c=await f.mcp(kind);assert.ok((await c.listTools()).tools.some(t=>t.name==='search_law'));
    const r=await c.callTool({name:'search_law',arguments:{query:'synthetic'}});assert.notEqual(r.isError,true);assert.match(r.content[0].text,/Synthetic legal lookup/);
  }
  assert.equal(f.calls.length,2);
  assert.equal((await f.request('/api/tools',null,{authorization:'Bearer invalid'})).status,401);
  assert.equal((await f.request('/api/tools',null,{authorization:''})).status,401);
  assert.equal((await f.request('/api/tools',null,{'x-api-key':''})).status,401);
  assert.equal((await f.request('/api/tools?apiKey=anything')).status,401);
});

test('PA-02: research ownership travels across actual HTTP MCP, SSE and REST clients',async t=>{
  const f=await fixture(t), http=await f.mcp(), sse=await f.mcp('sse');
  const a=(await http.callTool({name:'start_legal_research',arguments:{plan}})).structuredContent;
  const b=(await sse.callTool({name:'start_legal_research',arguments:{plan}})).structuredContent;
  assert.ok(a.client_session);assert.ok(b.client_session);
  const denied=await sse.callTool({name:'get_legal_research',arguments:{research_id:a.research_id,client_session:b.client_session}});
  assert.equal(denied.isError,true);assert.match(denied.content[0].text,/RESEARCH_NOT_FOUND/);
  const allowed=await sse.callTool({name:'get_legal_research',arguments:{research_id:a.research_id,client_session:a.client_session}});
  assert.notEqual(allowed.isError,true);assert.equal(allowed.structuredContent.research_id,a.research_id);
  assert.equal((await f.request('/api/research/status',{research_id:a.research_id,client_session:a.client_session})).status,200);
  assert.equal((await http.listTools()).tools.some(t=>t.name==='submit_failure'),false);
  assert.equal((await f.request('/api/failures',{})).body.code,'USE_CORRECTION_PR');
});

test('PA-03: capabilities accidentally included in sources or proposals never leave the server',async t=>{
  const f=await fixture(t), a=(await f.request('/api/research/start',{plan})).body;
  assert.equal((await f.request('/api/analyze',{query:a.client_session,tool:'search_law'})).body.code,'PRIVATE_SESSION_IN_CONTENT');
  assert.equal((await f.request('/api/research/retrieve',{research_id:a.research_id,expected_revision:a.revision,client_session:a.client_session,
    issue_ids:['rule'],purpose:'support',tool:'search_law',arguments:{query:a.client_session}})).body.code,'PRIVATE_SESSION_IN_CONTENT');
  assert.equal((await f.request('/api/corrections/prepare',{...proposal,why:a.client_session,client_session:a.client_session})).body.code,'PRIVATE_SESSION_IN_CONTENT');
  assert.equal(f.calls.length,0);assert.equal(f.publications.length,0);
  const diagnostic=safeToolDiagnostic({isError:true,content:[{type:'text',text:'Bad value '+a.client_session}],structuredContent:{client_session:a.client_session,message:a.client_session}},{});
  assert.equal(JSON.stringify(diagnostic).includes(a.client_session),false);assert.equal(diagnostic.structuredContent.client_session,undefined);
});

const publicEnv={TAXLAB_PUBLIC_ACCESS:'1',TAXLAB_PUBLIC_SESSION_SECRET:secret};
const peer=(address,headers={})=>({socket:{remoteAddress:address},get:name=>headers[name]});

test('PA-04/05: untrusted forwarding cannot change rate identity; session churn keeps peer and global quotas',()=>{
  const access=new PublicAccess(publicEnv), original=access.anonymous(peer('127.0.0.1'));
  const spoofed=access.anonymous(peer('127.0.0.1',{'x-forwarded-for':'203.0.113.2','cf-connecting-ip':'203.0.113.3'}));
  assert.equal(spoofed.id,original.id);
  const trusted=new PublicAccess({...publicEnv,TAXLAB_TRUST_CLOUDFLARE:'1'});
  assert.notEqual(trusted.anonymous(peer('127.0.0.1',{'cf-connecting-ip':'203.0.113.2'})).id,original.id);
  assert.equal(trusted.anonymous(peer('192.0.2.1',{'cf-connecting-ip':'203.0.113.2'})).id,access.anonymous(peer('192.0.2.1')).id);
  assert.throws(()=>trusted.anonymous(peer('127.0.0.1',{'cf-connecting-ip':'arbitrary'})),e=>e.code==='INVALID_CLIENT_ADDRESS');
  const a=access.scope(original,{},true), b=access.scope(spoofed,{},true);
  assert.notEqual(a.actor.id,b.actor.id);
  const budgets=new ResourceBudgets({}, {now:()=>1000,limits:{actorLookupRpm:1,lookupRpm:2}});
  budgets.consume(a.actor,'lookup');
  assert.throws(()=>budgets.consume(b.actor,'lookup'),e=>e.code==='LOOKUP_RATE_LIMIT');
  budgets.consume(access.anonymous(peer('192.0.2.2')),'lookup');
  assert.throws(()=>budgets.consume(access.anonymous(peer('192.0.2.3')),'lookup'),e=>e.code==='LOOKUP_RATE_LIMIT');
});

test('PA-04: public request and transport limits apply before provider work',async t=>{
  const f=await fixture(t,{resourceOptions:{now:()=>1000,limits:{actorRequestRpm:2}}});
  assert.equal((await f.request('/api/research/start',{plan})).status,200);
  assert.equal((await f.request('/api/research/start',{plan})).status,200);
  assert.equal((await f.request('/api/tools')).body.code,'REQUEST_RATE_LIMIT');assert.equal(f.calls.length,0);
  const g=await fixture(t,{env:{...publicEnv,TAXLAB_MAX_TRANSPORTS_PER_ACTOR:'1'}});
  const c=await g.mcp('sse');
  const res=await fetch(g.base+'/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
  assert.equal(res.status,429);assert.equal((await res.json()).code,'SESSION_CAPACITY');assert.equal(g.calls.length,0);
  await c.close();
});

test('PA-07: signing config, expiration, renewal and restart preserve the correct owner',async t=>{
  for(const env of [{TAXLAB_PUBLIC_ACCESS:'maybe'},{TAXLAB_PUBLIC_ACCESS:'1'},{...publicEnv,TAXLAB_PUBLIC_SESSION_SECRET:' '.repeat(64)}])assert.throws(()=>new PublicAccess(env));
  let now=1800000000000;const access=new PublicAccess(publicEnv,()=>now), actor=access.anonymous(peer('192.0.2.1'));
  const a=access.scope(actor,{},true);assert.match(a.token,/^v1\./);
  now+=24*3600_000;
  const renewed=access.scope(actor,{client_session:a.token},true);assert.equal(renewed.actor.id,a.actor.id);assert.notEqual(renewed.token,a.token);
  const restarted=new PublicAccess(publicEnv,()=>now);
  assert.equal(restarted.scope(actor,{client_session:a.token}).actor.id,a.actor.id);
  assert.throws(()=>new PublicAccess({...publicEnv,TAXLAB_PUBLIC_SESSION_SECRET:'different-signing-secret-0123456789abcdef'},()=>now).scope(actor,{client_session:a.token}),e=>e.code==='PUBLIC_SESSION_INVALID');
  const directory=await mkdtemp(join(tmpdir(),'taxlab-public-restart-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const repository={target:'fixture/repo',base:async()=> 'a'.repeat(40),publish:async()=>assert.fail('preview must not publish'),inspect:async()=>({state:'pending_review'})};
  const before=new CorrectionService({directory,repository,now:()=>now});
  const prepared=await before.prepare(renewed.actor,proposal);await before.close();
  const after=new CorrectionService({directory,repository,now:()=>now});t.after(()=>after.close());
  const restored=restarted.scope(actor,{client_session:renewed.token}).actor;
  assert.equal((await after.status(restored,prepared.proposal_id)).state,'awaiting_confirmation');
  now+=24*3600_000;
  assert.throws(()=>restarted.scope(actor,{client_session:a.token}),e=>e.code==='PUBLIC_SESSION_INVALID');
  assert.equal(restarted.scope(actor,{client_session:renewed.token}).actor.id,a.actor.id);
  now+=24*3600_000;
  assert.throws(()=>restarted.scope(actor,{client_session:renewed.token}),e=>e.code==='PUBLIC_SESSION_INVALID');
});

test('PA-02/03: public research requires its automatic session and strips it from source arguments',async t=>{
  const f=await fixture(t);
  const a=await f.request('/api/research/start',{plan});assert.equal(a.status,200);assert.ok(a.body.client_session);
  const b=await f.request('/api/research/start',{plan});assert.equal(b.status,200);assert.notEqual(a.body.client_session,b.body.client_session);
  for(const token of [undefined,b.body.client_session,a.body.client_session+'x']) {
    const r=await f.request('/api/research/status',{research_id:a.body.research_id,...(token?{client_session:token}:{})});
    assert.ok([401,404].includes(r.status));assert.equal(r.body.plan,undefined);
  }
  const ref={research_id:a.body.research_id,expected_revision:a.body.revision,client_session:a.body.client_session};
  const got=await f.request('/api/research/status',ref);assert.equal(got.status,400); // strict schemas retain their existing contract
  const current=await f.request('/api/research/status',{research_id:ref.research_id,client_session:ref.client_session});assert.equal(current.status,200);
  const r=await f.request('/api/research/retrieve',{...ref,issue_ids:['rule'],purpose:'support',tool:'search_law',arguments:{query:'synthetic'}});
  assert.equal(r.status,200);assert.deepEqual(f.calls,[{name:'search_law',args:{query:'synthetic'}}]);
  const cross=await f.request('/api/research/status',{research_id:ref.research_id,client_session:ref.client_session},{'x-api-key':'legacy-fixture'});
  assert.ok([400,404].includes(cross.status));
});

test('PA-06: anonymous correction preview still needs exact confirmation and another session cannot publish',async t=>{
  const f=await fixture(t);
  const a=await f.request('/api/corrections/prepare',proposal);assert.equal(a.status,200);assert.ok(a.body.client_session);assert.equal(f.publications.length,0);
  const b=await f.request('/api/research/start',{plan});
  const input={proposal_id:a.body.proposal_id,proposal_hash:a.body.proposal_hash,confirmation_token:a.body.confirmation_token,confirm:true};
  assert.equal((await f.request('/api/corrections/create',{...input,client_session:b.body.client_session})).status,404);
  assert.equal(f.publications.length,0);
  const invalid=await f.request('/api/corrections/create',{...input,proposal_hash:'0'.repeat(64),client_session:a.body.client_session});assert.equal(invalid.status,409);
  assert.equal(f.publications.length,0);
  const confirmed=await f.request('/api/corrections/create',{...input,client_session:a.body.client_session});assert.equal(confirmed.status,200);assert.equal(confirmed.body.state,'pending_review');assert.equal(f.publications.length,1);
  assert.equal(JSON.stringify(f.publications[0].proposal).includes(a.body.client_session),false);
  const duplicate=await f.request('/api/corrections/create',{...input,client_session:a.body.client_session});assert.equal(duplicate.body.state,'already_published');assert.equal(f.publications.length,1);
});

test('PA-04: new anonymous identities cannot bypass peer research admission',async t=>{
  const f=await fixture(t,{researchOptions:{limits:{maxSessionsPerActor:2}}});
  assert.equal((await f.request('/api/research/start',{plan})).status,200);
  assert.equal((await f.request('/api/research/start',{plan})).status,200);
  const limited=await f.request('/api/research/start',{plan});assert.equal(limited.status,429);assert.equal(limited.body.code,'RESEARCH_CAPACITY');
});
