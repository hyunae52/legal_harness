import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { createApp } from '../dist/app.js';
import { createAuthenticator } from '../dist/auth.js';
import { GateEngine } from '../dist/gates.js';
import { LawMcpError } from '../dist/koreanLawClient.js';
import { ServiceError, digest } from '../dist/contracts.js';
import { safeToolDiagnostic } from '../dist/errorDiagnostics.js';

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
test('public connection guide is readable without credentials and does not open authenticated tools',async t=>{
  const secret='guide-private-fixture-key';
  const f=await fixture(t,{env:{TAXLAB_API_KEY:secret,LAW_OC:'guide-private-oc'}});
  const res=await fetch(f.base+'/?key=untrusted-input',{headers:{'x-forwarded-host':'untrusted.invalid'}});
  assert.equal(res.status,200);assert.match(res.headers.get('content-type'),/text\/html.*utf-8/);
  const html=await res.text();assert.match(html,/<html lang="ko">/);assert.match(html,/https:\/\/law\.taxlab\.kr\/sse/);
  assert.doesNotMatch(html,/YOUR_API_KEY/);assert.match(html,/접속키 없이 바로 연결/);assert.match(html,/OAuth/);assert.doesNotMatch(html,/Node\.js/);
  assert.match(html,/https:\/\/law\.taxlab\.kr\/mcp/);assert.match(html,/사건 조건이 빠졌으면/);
  assert.doesNotMatch(html,/OAuth 로그인과 Streamable HTTP는 제공하지 않습니다/);
  for(const text of ['Claude 설치파일','ChatGPT 설정하기','Gemini 연결 안내','Antigravity 연결 안내','AI 설정 요청문 복사','PR로 제안할까요'])assert.ok(html.includes(text));
  for(const value of [secret,'guide-private-oc','untrusted-input','untrusted.invalid'])assert.ok(!html.includes(value));
  assert.match(res.headers.get('content-security-policy'),/default-src 'none'/);
  assert.ok(!res.headers.get('content-security-policy').includes('unsafe-inline'));
  const head=await fetch(f.base,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
  for(const path of ['/api/tools','/sse'])assert.equal((await f.request(path,undefined,null)).status,401);
  assert.equal(f.calls.length,0);
});
test('setup downloads expose only fixed public artifacts; private paths and tool access stay closed',async t=>{
  const f=await fixture(t,{env:{TAXLAB_API_KEY:'download-private-canary',LAW_OC:'law-private-canary'}});
  for(const path of ['/setup.md','/openapi.json','/downloads/gemini-settings.json','/downloads/antigravity-mcp.json','/downloads/chatgpt-desktop.toml','/downloads/chatgpt-actions.json','/downloads/chatgpt-instructions.txt']) {
    const res=await fetch(f.base+path+'?key=untrusted-download');assert.equal(res.status,200);
    const body=await res.text();assert.ok(!/download-private-canary|law-private-canary|untrusted-download/.test(body));
    assert.equal(res.headers.get('x-content-type-options'),'nosniff');
    if(path.startsWith('/downloads/'))assert.match(res.headers.get('content-disposition'),/^attachment;/);
    if(path.endsWith('.json')) {
      const config=JSON.parse(body);
      if(path.endsWith('gemini-settings.json'))assert.equal(config.mcpServers['taxlab-law'].type,'sse','Gemini 0.60 defaults url-only connections to Streamable HTTP');
      if(path.endsWith('antigravity-mcp.json'))assert.equal(config.mcpServers['taxlab-law'].serverUrl,'https://law.taxlab.kr/mcp');
      if(config.mcpServers)for(const server of Object.values(config.mcpServers))assert.equal(server.headers,undefined);
    }
  }
  const installer=await fetch(f.base+'/downloads/taxlab-law.mcpb');assert.equal(installer.status,200);
  assert.match(installer.headers.get('content-disposition'),/attachment;.*taxlab-law\.mcpb/);
  assert.deepEqual(Buffer.from(await installer.arrayBuffer()),await readFile(new URL('../dist/downloads/taxlab-law.mcpb',import.meta.url)));
  const bridge=await fetch(f.base+'/downloads/taxlab-bridge.zip');assert.equal(bridge.status,200);
  assert.match(bridge.headers.get('content-type'),/application\/zip/);
  assert.match(bridge.headers.get('content-disposition'),/attachment;.*taxlab-bridge\.zip/);
  assert.deepEqual(Buffer.from(await bridge.arrayBuffer()),await readFile(new URL('../dist/downloads/taxlab-law.mcpb',import.meta.url)));
  for(const path of ['/downloads/.env','/downloads/package.json','/downloads/%2e%2e%2f.env','/downloads/taxlab-law.mcpb.json'])assert.equal((await fetch(f.base+path)).status,404);
  assert.equal((await f.request('/api/tools',undefined,null)).status,401);assert.equal(f.calls.length,0);
});
test('public GPT Actions schemas retain compatibility with private authenticated read and draft-check routes',async t=>{
  const f=await fixture(t,{realAuth:true});
  const schema=await(await fetch(f.base+'/openapi.json')).json();
  assert.equal(schema.openapi,'3.1.0');assert.equal(schema.servers[0].url,'https://law.taxlab.kr');
  assert.deepEqual(schema.security,[]);assert.equal(schema.components?.securitySchemes,undefined);
  assert.deepEqual(Object.keys(schema.paths).sort(),['/api/analyze','/api/corrections/create','/api/corrections/prepare','/api/corrections/status',
    '/api/research/answer','/api/research/retrieve','/api/research/review','/api/research/start','/api/research/status','/api/research/update','/api/tools','/api/validate']);
  assert.equal(schema.paths['/api/corrections/create'].post['x-openai-isConsequential'],true);
  assert.equal(schema.paths['/api/corrections/prepare'].post['x-openai-isConsequential'],false);
  const ajv=new Ajv2020({strict:false});
  const examples=[['/api/tools',undefined],['/api/analyze',{query:'fixture',tool:'search_law',arguments:{display:3}}],['/api/validate',{draft_answer:'공개 합성 초안'}]];
  for(const [path,body] of examples) {
    const op=schema.paths[path][body?'post':'get'];assert.equal(op['x-openai-isConsequential'],false);
    if(body)assert.equal(ajv.compile(op.requestBody.content['application/json'].schema)(body),true);
    assert.equal((await f.request(path,body,null)).status,401);
    const res=await f.request(path,body,'Bearer fixture-key');assert.equal(res.status,200);
    const check=ajv.compile(op.responses['200'].content['application/json'].schema);assert.equal(check(res.body),true,JSON.stringify(check.errors));
  }
  assert.deepEqual(f.calls,[{name:'search_law',args:{display:3,query:'fixture'}}]);
});
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
test('expected tool diagnostics survive REST and MCP while configured secrets and internal fields are removed',async t=>{
  const secret='fixture-law-secret-value';
  const encodedDiagnostic='{"required":["event_date"],"headers":{"x-private":"unknown-private"},"detail":"\\u0066ixture-law-secret-value"}';
  const diagnostic={isError:true,content:[{type:'text',text:`PUBLIC_SYNTHETIC_EVENT_DATE_REQUIRED https://source.invalid?OC=${secret}`},{type:'text',text:encodedDiagnostic}],structuredContent:{required:['event_date'],headers:{authorization:secret},stack:secret,detail:'safe public fixture'},_meta:{token:secret}};
  const f=await fixture(t,{env:{LAW_OC:secret},error:new LawMcpError(502,'MCP_TOOL_ERROR','exception message must remain private',diagnostic)});
  const rest=await f.request('/api/analyze',{query:'fixture'});assert.equal(rest.status,502);assert.deepEqual(rest.body.result.structuredContent.required,['event_date']);assert.match(rest.body.result.content[0].text,/PUBLIC_SYNTHETIC/);
  assert.ok(!JSON.stringify(rest).includes(secret));assert.ok(!JSON.stringify(rest).includes('exception message'));
  assert.deepEqual(JSON.parse(rest.body.result.content[1].text),{required:['event_date'],detail:'[REDACTED]'});
  const client=new Client({name:'error-contract',version:'1'});t.after(()=>client.close());
  await client.connect(new SSEClientTransport(new URL(f.base+'/sse'),{requestInit:{headers:{authorization:'Bearer alice'}}}),{timeout:3000});
  const mcp=await client.callTool({name:'search_law',arguments:{query:'fixture'}});assert.equal(mcp.isError,true);assert.deepEqual(mcp.structuredContent.required,['event_date']);assert.match(mcp.content[0].text,/PUBLIC_SYNTHETIC/);assert.ok(!JSON.stringify(mcp).includes(secret));assert.equal(mcp.structuredContent.stack,undefined);
  assert.deepEqual(JSON.parse(mcp.content[1].text),{required:['event_date'],detail:'[REDACTED]'});
});
test('tool diagnostics bound oversized data and omit credential labels and internal traces',()=>{
  const result=safeToolDiagnostic({isError:true,content:[{type:'text',text:'PUBLIC_FIXTURE\nAuthorization: Bearer fixture-unknown-value\n    at /internal/private.js:10\nSUPABASE_SECRET=unconfigured-sensitive-value'}],structuredContent:{required:['event_date'],environment:{secret:'hidden'},large:'z'.repeat(20000)}},{});
  const json=JSON.stringify(result);assert.ok(json.includes('PUBLIC_FIXTURE'));assert.ok(!json.includes('fixture-unknown-value'));assert.ok(!json.includes('unconfigured-sensitive-value'));assert.ok(!json.includes('/internal/private.js'));assert.ok(Buffer.byteLength(json)<=16000);
});
test('nested public ambiguity candidates survive diagnostics while candidate secrets are removed',()=>{
  const secret='fixture-private-candidate-token';
  const candidates=[{documentNumber:'법인46012-1784',ntstDcmId:'010000000000062896',productionDate:'1998-07-02',headers:{authorization:secret},token:secret}];
  const result=safeToolDiagnostic({isError:true,content:[{type:'text',text:JSON.stringify({ok:false,error:{code:'AMBIGUOUS_DOCUMENT_NUMBER',detail:{candidates}}})}],structuredContent:{ok:false,error:{code:'AMBIGUOUS_DOCUMENT_NUMBER',detail:{candidates}}}},{LAW_OC:secret});
  assert.deepEqual(result.structuredContent.error.detail.candidates,[{documentNumber:'법인46012-1784',ntstDcmId:'010000000000062896',productionDate:'1998-07-02'}]);
  assert.equal(JSON.stringify(result).includes(secret),false);
});
test('JSON tool diagnostics decode before filtering nested private fields and escaped configured secrets',()=>{
  const secret='fixture-"law\\secret\nvalue';
  const encoded=JSON.stringify(secret).slice(1,-1).replace('f','\\u0066');
  const text=`{"code":"PUBLIC_ARGUMENT_REQUIRED","required":["event_date"],"headers":{"x-private":"unknown-credential"},"stack":"internal-trace","detail":"${encoded}"}`;
  const result=safeToolDiagnostic({isError:true,content:[{type:'text',text}],structuredContent:{nested:JSON.stringify({required:['event_date'],environment:{private:'unknown-environment'},detail:secret})}},{LAW_OC:secret});
  const parsed=JSON.parse(result.content[0].text);
  assert.equal(parsed.code,'PUBLIC_ARGUMENT_REQUIRED');assert.deepEqual(parsed.required,['event_date']);
  assert.equal(parsed.headers,undefined);assert.equal(parsed.stack,undefined);assert.equal(parsed.detail,'[REDACTED]');
  const nested=JSON.parse(result.structuredContent.nested);
  assert.deepEqual(nested.required,['event_date']);assert.equal(nested.environment,undefined);assert.equal(nested.detail,'[REDACTED]');
  const mixed=safeToolDiagnostic({isError:true,content:[{type:'text',text:'Source failure: '+text}]},{LAW_OC:secret});
  assert.ok(!JSON.stringify(mixed).includes('unknown-credential'));
});
test('numeric credentials and serialized traces never enter public tool diagnostics',()=>{
  const result=safeToolDiagnostic({isError:true,content:[{type:'text',text:JSON.stringify({required:['event_date'],stack:'Error: fixture\n at /internal/private.js:10:20'})}],structuredContent:{LAW_OC:123456789,detail:123456789,required:['event_date']}},{LAW_OC:'123456789'});
  assert.deepEqual(JSON.parse(result.content[0].text),{required:['event_date']});
  assert.equal(result.structuredContent.LAW_OC,undefined);assert.equal(result.structuredContent.detail,'[REDACTED]');
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
  const unrelatedSkip=e.validate({draft_answer:'arithmetic',facts:{allocation:{total:100,parts:[60,60]}},skip_gates:['QG-COST-03'],bypass_reason:'skip only contribution research'},'v');
  assert.equal(unrelatedSkip.blocked,true,'skipping a legal research question cannot disable an executed arithmetic failure');assert.equal(unrelatedSkip.scoped_pass,false);
  const revised=e.validate({draft_answer:'different'},'v');assert.notEqual(normal.draft_hash,revised.draft_hash);
  const exact='  original draft  \n';assert.equal(e.validate({draft_answer:exact},'v').draft_hash,digest(exact));
  assert.notEqual(e.validate({draft_answer:exact},'v').draft_hash,e.validate({draft_answer:exact.trim()},'v').draft_hash);
  assert.throws(()=>e.validate({draft_answer:'   \n'},'v'));
});
test('health records release and rule fingerprints',async t=>{const f=await fixture(t);const r=await f.request('/health');assert.equal(r.body.mcp_release,'4.13.0');assert.match(r.body.rules_version,/^[a-f0-9]{64}$/);});
