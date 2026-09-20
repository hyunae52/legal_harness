import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {Octokit} from '@octokit/rest';
import {CorrectionService,correctionContent,correctionFile} from '../dist/corrections.js';
import {createCorrectionRepository} from '../dist/correctionGitHub.js';
import {createApp} from '../dist/app.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {SSEClientTransport} from '@modelcontextprotocol/sdk/client/sse.js';

const baseSha='a'.repeat(40),headSha='b'.repeat(40);
const blobSha=content=>createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
const input=()=>({request_id:randomUUID(),title:'공식 출처의 기준일 구분',previous_claim:'공포일과 시행일을 같은 것으로 보았다.',correction:'두 날짜를 각각 확인해야 한다.',why:'공식 원문에 구분된 항목을 확인했다.',sources:[{url:'https://www.law.go.kr/법령/근로기준법',title:'국가법령정보센터',supporting_excerpt:'시행일과 공포일이 별도 표시된다.'}],keywords:['시행일'],next_checks:['사건 기준일과 시행일을 대조한다.'],public_safe:true});
async function fixture(t,{loseResponse=false,loseRefResponse=false,baseConflict=false,now}={}) {
  const state={ref:false,pr:false,merged:false,altered:false,extraFile:false,posts:[],unexpected:[],content:'',lawCalls:[]};
  let currentId;
  const pr=()=>({number:7,html_url:'https://github.com/fixture/legal/pull/7',state:state.merged?'closed':'open',merged:state.merged,draft:!state.merged,
    base:{ref:'main'},head:{sha:headSha,ref:'correction/'+currentId,repo:{full_name:'fixture/legal'}}});
  const github=createServer(async(req,res)=>{
    try {
      assert.equal(req.headers.authorization,'token github-fixture');
      let raw='';for await(const c of req)raw+=c;const body=raw?JSON.parse(raw):{};
      const url=new URL(req.url,'http://fixture'),path=decodeURIComponent(url.pathname).replace('/repos/fixture/legal','');
      const send=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
      if(req.method==='POST')state.posts.push({path,body});
      if(req.method==='GET'&&path==='/git/ref/heads/main')return send({object:{sha:baseSha}});
      if(req.method==='GET'&&path==='/pulls')return send(state.pr?[{number:7}]:[]);
      if(req.method==='GET'&&path==='/pulls/7')return send(pr());
      if(req.method==='GET'&&path.startsWith('/git/ref/heads/correction/'))return state.ref?send({object:{sha:headSha}}):send({message:'Not Found'},404);
      if(req.method==='GET'&&path==='/git/commits/'+baseSha)return send({sha:baseSha,tree:{sha:'c'.repeat(40)}});
      if(req.method==='GET'&&path==='/git/trees/'+'c'.repeat(40))return send({truncated:false,tree:state.merged?[{path:'corrections/proposals/'+currentId+'.json',mode:'100644',type:'blob',sha:blobSha(state.altered?'changed':state.content)}]:[]});
      if(req.method==='POST'&&path==='/git/blobs'){assert.equal(body.encoding,'utf-8');state.content=body.content;currentId=JSON.parse(body.content).proposal_id;return send({sha:'d'.repeat(40)},201);}
      if(req.method==='POST'&&path==='/git/trees'){
        assert.equal(body.base_tree,'c'.repeat(40));assert.deepEqual(body.tree,[{path:'corrections/proposals/'+currentId+'.json',mode:'100644',type:'blob',sha:'d'.repeat(40)}]);return send({sha:'e'.repeat(40)},201);}
      if(req.method==='POST'&&path==='/git/commits'){assert.deepEqual(body.parents,[baseSha]);return send({sha:headSha},201);}
      if(req.method==='POST'&&path==='/git/refs'){assert.equal(body.ref,'refs/heads/correction/'+currentId);assert.equal(body.sha,headSha);state.ref=true;if(loseRefResponse)return send({message:'Response lost after ref write'},503);return send({object:{sha:headSha}},201);}
      if(req.method==='POST'&&path==='/pulls'){
        assert.equal(body.draft,true);assert.equal(body.base,'main');assert.equal(body.head,'correction/'+currentId);assert.match(body.body,/별도 AI 검수는 미확인/);
        state.pr=true;if(loseResponse)return send({message:'Response lost after commit'},503);return send(pr(),201);}
      if(req.method==='GET'&&path.startsWith('/contents/corrections/proposals/')) {
        if(url.searchParams.get('ref')===baseSha)return baseConflict?send({encoding:'base64',content:Buffer.from('existing data').toString('base64')}):send({message:'Not Found'},404);
        assert.equal(path,'/contents/corrections/proposals/'+currentId+'.json');
        if(url.searchParams.get('ref')==='main'&&!state.merged)return send({message:'Not Found'},404);
        return send({encoding:'base64',content:Buffer.from(state.altered?'changed':state.content).toString('base64')});
      }
      if(req.method==='GET'&&path==='/compare/'+baseSha+'...'+headSha)return send({status:'ahead',behind_by:0,total_commits:1,files:[{filename:'corrections/proposals/'+currentId+'.json',status:'added'},...(state.extraFile?[{filename:'src/app.ts',status:'modified'}]:[])]});
      throw Error(req.method+' '+path);
    } catch(error){state.unexpected.push(error.message);res.writeHead(500,{'content-type':'application/json'});res.end('{"message":"Fixture rejected request"}');}
  });
  await new Promise(r=>github.listen(0,'127.0.0.1',r));
  t.after(async()=>{github.closeAllConnections();await new Promise(r=>github.close(r));assert.deepEqual(state.unexpected,[]);});
  const directory=await mkdtemp(join(tmpdir(),'taxlab-github-correction-'));t.after(async()=>{assert.ok(directory.startsWith(join(tmpdir(),'taxlab-github-correction-')));await rm(directory,{recursive:true,force:true});});
  const repository=createCorrectionRepository({token:'github-fixture',owner:'fixture',repo:'legal',baseBranch:'main'},new Octokit({auth:'github-fixture',baseUrl:'http://127.0.0.1:'+github.address().port,log:{debug(){},info(){},warn(){},error(){}}}));
  const corrections=new CorrectionService({directory,repository,now});t.after(()=>corrections.close());
  const runtime=createApp({env:{TAXLAB_API_KEY:'fixture-key'},corrections,law:{releaseVersion:'fixture',listTools:async()=>({tools:[{name:'search_law',inputSchema:{type:'object'}}]}),callTool:async(name,args)=>{state.lawCalls.push({name,args});return {result:{content:[{type:'text',text:'fixture source'}]}};},close:async()=>{}}});
  const server=createServer(runtime.app);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await runtime.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
  const origin='http://127.0.0.1:'+server.address().port;
  const post=async(path,body,key='fixture-key')=>{const res=await fetch(origin+path,{method:'POST',headers:{'content-type':'application/json',...(key?{authorization:'Bearer '+key}:{})},body:JSON.stringify(body)});return {status:res.status,body:await res.json()};};
  return {state,corrections,post,origin};
}
test('CP-01/04/05/06: real Octokit HTTP adapter creates one JSON-only draft, reconciles lost response and verifies merge/main contents',async t=>{
  const f=await fixture(t,{loseResponse:true});const request=input();
  assert.equal((await f.post('/api/corrections/prepare',request,null)).status,401);
  const p=(await f.post('/api/corrections/prepare',request)).body;assert.equal(p.state,'awaiting_confirmation');assert.equal(f.state.posts.length,0);
  const yes={proposal_id:p.proposal_id,proposal_hash:p.proposal_hash,confirmation_token:p.confirmation_token,confirm:true};
  const first=await f.post('/api/corrections/create',yes);assert.equal(first.status,200);assert.equal(first.body.state,'publication_uncertain');
  const checked=(await f.post('/api/corrections/status',{proposal_id:p.proposal_id})).body;assert.equal(checked.pr_url,'https://github.com/fixture/legal/pull/7');assert.equal(checked.state,'pending_review');
  await f.post('/api/corrections/create',yes);assert.equal(f.state.posts.filter(p=>p.path==='/pulls').length,1);
  assert.ok(!JSON.stringify(f.state.posts).includes(p.confirmation_token));assert.ok(!JSON.stringify(f.state.posts).includes('fixture-key'));
  await f.corrections.refresh();assert.equal(f.corrections.search('시행일').items.length,0);
  f.state.merged=true;await f.corrections.refresh();assert.equal(f.corrections.search('시행일').items.length,1);
  const retrieved=await f.post('/api/analyze',{query:'시행일',tool:'search_law'});assert.equal(retrieved.body.data.corrections.items.length,1);assert.equal(retrieved.body.data.evidence.applicability,'unverified');
  f.state.altered=true;const mismatch=await f.post('/api/corrections/status',{proposal_id:p.proposal_id});assert.equal(mismatch.body.state,'status_unavailable');
  await f.corrections.refresh();assert.equal(f.corrections.search('시행일').items.length,0);
});

for (const partialRefresh of [false,true]) test(partialRefresh?'CP-14: timed-out merge batches persist progress, resume after restart and recheck current main':'CP-09: all 60 merged proposals survive restart without repeated PR reads, and main file changes revoke cached matches',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'taxlab-merged-correction-'));
  t.after(async()=>{assert.ok(directory.startsWith(join(tmpdir(),'taxlab-merged-correction-')));await rm(directory,{recursive:true,force:true});});
  const records=[];
  for(let i=0;i<60;i++){
    const {request_id,...proposal}=input();proposal.keywords=['unique-case-'+String(i).padStart(3,'0')];
    const record={id:request_id,actor:'fixture',created_at:new Date().toISOString(),expires_at:new Date().toISOString(),proposal,
      proposal_hash:createHash('sha256').update(JSON.stringify(proposal)).digest('hex'),confirmation_token:'0'.repeat(64),state:'published',base_sha:baseSha,
      pr:{number:i+1,url:'https://github.com/fixture/legal/pull/'+(i+1),head_sha:headSha}};
    records.push(record);await writeFile(join(directory,record.id+'.json'),JSON.stringify(record));
  }
  let prReads=0,treeReads=0,altered=false,failingNumber;const readsByNumber=new Map();
  const unexpected=[];
  const server=createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://fixture'),path=decodeURIComponent(url.pathname).replace('/repos/fixture/legal','');
      assert.equal(req.method,'GET');assert.equal(req.headers.authorization,'token github-fixture');
      let data;
      if(path==='/git/ref/heads/main')data={object:{sha:baseSha}};
      else if(path==='/git/commits/'+baseSha)data={tree:{sha:'c'.repeat(40)}};
      else if(path==='/git/trees/'+'c'.repeat(40)){
        assert.equal(url.searchParams.get('recursive'),'1');treeReads++;
        data={truncated:false,tree:records.map((r,i)=>({path:correctionFile(r),type:'blob',mode:'100644',sha:blobSha(altered&&i===0?'changed':correctionContent(r))}))};
      } else if(/^\/pulls\/\d+$/.test(path)){
        const record=records[Number(path.split('/').at(-1))-1];assert.ok(record);prReads++;
        readsByNumber.set(record.pr.number,(readsByNumber.get(record.pr.number)||0)+1);
        if(record.pr.number===failingNumber){res.writeHead(403,{'content-type':'application/json'});res.end('{"message":"Temporarily unavailable"}');return;}
        if(partialRefresh)await new Promise(r=>setTimeout(r,20));
        data={number:record.pr.number,merged:true,base:{ref:'main'},head:{ref:'correction/'+record.id,sha:headSha,repo:{full_name:'fixture/legal'}}};
      } else throw Error(path);
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(data));
    }catch(error){unexpected.push(error.message);res.writeHead(500,{'content-type':'application/json'});res.end('{}');}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));assert.deepEqual(unexpected,[]);});
  const repository=createCorrectionRepository({token:'github-fixture',owner:'fixture',repo:'legal',baseBranch:'main'},new Octokit({auth:'github-fixture',baseUrl:'http://127.0.0.1:'+server.address().port,log:{debug(){},info(){},warn(){},error(){}}}));
  const serviceOptions={directory,repository,refreshTimeoutMs:partialRefresh?150:30000};
  const service=new CorrectionService(serviceOptions);t.after(()=>service.close());
  await service.refresh();assert.equal(treeReads,1);
  const saved=(await Promise.all(records.map(async r=>JSON.parse(await readFile(join(directory,r.id+'.json'),'utf8'))))).filter(r=>r.merge_verified);
  if(partialRefresh)assert.ok(saved.length>0&&saved.length<60,'partial verification must be durable before the refresh deadline');
  else {assert.equal(prReads,60);assert.equal(saved.length,60);}
  for(const r of saved)assert.equal(service.search(r.proposal.keywords[0]).items[0]?.proposal_id,r.id,'deadline must not discard completed main verification');
  await service.close();const restarted=new CorrectionService(serviceOptions);t.after(()=>restarted.close());
  for(let pass=0;pass<(partialRefresh?20:1);pass++){
    await restarted.refresh();if(records.every(r=>restarted.search(r.proposal.keywords[0]).items.length===1))break;
  }
  if(!partialRefresh){assert.equal(prReads,60);assert.equal(treeReads,2);}
  for(const r of saved)assert.equal(readsByNumber.get(r.pr.number),1,'restart must reuse a verified merge event');
  for(const record of records)assert.equal(restarted.search(record.proposal.keywords[0]).items[0]?.proposal_id,record.id);
  const beforeReads=prReads;altered=true;await restarted.refresh();assert.equal(prReads,beforeReads);assert.equal(restarted.search(records[0].proposal.keywords[0]).items.length,0);
  assert.equal(restarted.search(records[59].proposal.keywords[0]).items.length,1);
  if(partialRefresh){
    failingNumber=60;const failedRecord=JSON.parse(await readFile(join(directory,records[59].id+'.json'),'utf8'));
    delete failedRecord.merge_verified;await writeFile(join(directory,failedRecord.id+'.json'),JSON.stringify(failedRecord));
    await restarted.refresh();
    assert.equal(restarted.search(records[0].proposal.keywords[0]).items.length,0,'changed main file must stay excluded');
    assert.equal(restarted.search(records[1].proposal.keywords[0]).items.length,1,'unverified PR failure must not block verified main files');
    assert.equal(restarted.search(records[59].proposal.keywords[0]).items.length,0,'failed verification must not refresh that note');
  }
});

test('CP-13: a base path collision is a definitive block with zero GitHub writes',async t=>{
  const f=await fixture(t,{baseConflict:true});const p=(await f.post('/api/corrections/prepare',input())).body;
  const result=(await f.post('/api/corrections/create',{proposal_id:p.proposal_id,proposal_hash:p.proposal_hash,confirmation_token:p.confirmation_token,confirm:true})).body;
  assert.equal(result.state,'publication_blocked');assert.equal(result.error_code,'CORRECTION_PATH_CONFLICT');assert.equal(f.state.posts.length,0);
  assert.equal((await f.post('/api/corrections/status',{proposal_id:p.proposal_id})).body.state,'publication_blocked');
  const fresh=await fixture(t);fresh.state.extraFile=true;const q=(await fresh.post('/api/corrections/prepare',input())).body;
  const rejected=(await fresh.post('/api/corrections/create',{proposal_id:q.proposal_id,proposal_hash:q.proposal_hash,confirmation_token:q.confirmation_token,confirm:true})).body;
  assert.equal(rejected.error_code,'CORRECTION_SCOPE_CHANGED');assert.equal(fresh.state.ref,false);assert.equal(fresh.state.pr,false);
  assert.equal(fresh.state.posts.filter(p=>p.path==='/git/refs'||p.path==='/pulls').length,0,'fresh commit must be validated before publication');
});

test('CP-15: Actions identifier lookups keep correction query context without changing upstream arguments',async t=>{
  let clock=Date.now();const f=await fixture(t,{now:()=>clock});const p=(await f.post('/api/corrections/prepare',input())).body;
  await f.post('/api/corrections/create',{proposal_id:p.proposal_id,proposal_hash:p.proposal_hash,confirmation_token:p.confirmation_token,confirm:true});
  const lookups=[['get_law_text',{law_id:'fixture-law'}],['get_decision_text',{decision_id:'fixture-decision'}]];
  const check=async(expected)=>{for(const [tool,args] of lookups){const result=await f.post('/api/analyze',{query:'시행일 확인',tool,arguments:args});assert.equal(result.status,200);assert.equal(result.body.data.corrections.items.length,expected);assert.deepEqual(f.state.lawCalls.at(-1),{name:tool,args});}};
  await f.corrections.refresh();await check(0);
  f.state.merged=true;await f.corrections.refresh();await check(1);
  f.state.altered=true;await f.corrections.refresh();await check(0);
  f.state.altered=false;await f.corrections.refresh();clock+=11*60000;await check(0);
});
test('CP-07: MCP prepare/consent returns the actual PR and an altered branch cannot become approved',async t=>{
  const f=await fixture(t);const client=new Client({name:'correction-mcp-integration',version:'1'});t.after(()=>client.close());
  await client.connect(new SSEClientTransport(new URL(f.origin+'/sse'),{requestInit:{headers:{authorization:'Bearer fixture-key'}}}));
  const p=(await client.callTool({name:'prepare_correction_pr',arguments:input()})).structuredContent;assert.match(p.question,/PR/);assert.equal(f.state.posts.length,0);
  const result=(await client.callTool({name:'create_correction_pr',arguments:{proposal_id:p.proposal_id,proposal_hash:p.proposal_hash,confirmation_token:p.confirmation_token,confirm:true}})).structuredContent;
  assert.equal(result.state,'pending_review');assert.equal(result.pr_url,'https://github.com/fixture/legal/pull/7');
  f.state.extraFile=true;const status=(await client.callTool({name:'get_correction_pr',arguments:{proposal_id:p.proposal_id}})).structuredContent;assert.equal(status.state,'status_unavailable');
});

test('CP-11: failure after branch creation provides an explicit same-proposal retry and produces one PR',async t=>{
  const f=await fixture(t,{loseRefResponse:true});const p=(await f.post('/api/corrections/prepare',input())).body;
  const first=(await f.post('/api/corrections/create',{proposal_id:p.proposal_id,proposal_hash:p.proposal_hash,confirmation_token:p.confirmation_token,confirm:true})).body;
  assert.equal(first.state,'publication_uncertain');assert.equal(f.state.ref,true);assert.equal(f.state.pr,false);
  f.state.extraFile=true;const unsafe=(await f.post('/api/corrections/status',{proposal_id:p.proposal_id})).body;assert.equal(unsafe.state,'status_unavailable');assert.equal(unsafe.retry,undefined);f.state.extraFile=false;
  const recover=(await f.post('/api/corrections/status',{proposal_id:p.proposal_id})).body;
  assert.equal(recover.state,'retry_available');assert.equal(recover.retry.tool,'create_correction_pr');assert.equal(recover.retry.arguments.proposal_id,p.proposal_id);
  assert.equal((await f.post('/api/corrections/create',recover.retry.arguments)).body.state,'pending_review');
  assert.equal(f.state.posts.filter(p=>p.path==='/pulls').length,1);assert.equal(f.state.posts.filter(p=>p.path==='/git/refs').length,1);
});
