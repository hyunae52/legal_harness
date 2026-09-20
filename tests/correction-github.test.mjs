import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
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
async function fixture(t,{loseResponse=false}={}) {
  const state={ref:false,pr:false,merged:false,altered:false,extraFile:false,posts:[],unexpected:[],content:''};
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
      if(req.method==='POST'&&path==='/git/refs'){assert.equal(body.ref,'refs/heads/correction/'+currentId);assert.equal(body.sha,headSha);state.ref=true;return send({object:{sha:headSha}},201);}
      if(req.method==='POST'&&path==='/pulls'){
        assert.equal(body.draft,true);assert.equal(body.base,'main');assert.equal(body.head,'correction/'+currentId);assert.match(body.body,/별도 AI 검수는 미확인/);
        state.pr=true;if(loseResponse)return send({message:'Response lost after commit'},503);return send(pr(),201);}
      if(req.method==='GET'&&path.startsWith('/contents/corrections/proposals/')) {
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
  const corrections=new CorrectionService({directory,repository});t.after(()=>corrections.close());
  const runtime=createApp({env:{TAXLAB_API_KEY:'fixture-key'},corrections,law:{releaseVersion:'fixture',listTools:async()=>({tools:[{name:'search_law',inputSchema:{type:'object'}}]}),callTool:async()=>({result:{content:[{type:'text',text:'fixture source'}]}}),close:async()=>{}}});
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

test('CP-09: all 60 merged proposals survive restart without repeated PR reads, and main file changes revoke cached matches',async t=>{
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
  let prReads=0,treeReads=0,altered=false;
  const unexpected=[];
  const server=createServer((req,res)=>{
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
        data={number:record.pr.number,merged:true,base:{ref:'main'},head:{ref:'correction/'+record.id,sha:headSha,repo:{full_name:'fixture/legal'}}};
      } else throw Error(path);
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(data));
    }catch(error){unexpected.push(error.message);res.writeHead(500,{'content-type':'application/json'});res.end('{}');}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));assert.deepEqual(unexpected,[]);});
  const repository=createCorrectionRepository({token:'github-fixture',owner:'fixture',repo:'legal',baseBranch:'main'},new Octokit({auth:'github-fixture',baseUrl:'http://127.0.0.1:'+server.address().port}));
  const service=new CorrectionService({directory,repository});t.after(()=>service.close());
  await service.refresh();assert.equal(prReads,60);assert.equal(treeReads,1);
  for(const record of records)assert.equal(service.search(record.proposal.keywords[0]).items[0]?.proposal_id,record.id);
  await service.close();const restarted=new CorrectionService({directory,repository});t.after(()=>restarted.close());
  await restarted.refresh();assert.equal(prReads,60);assert.equal(treeReads,2);
  for(const record of records)assert.equal(restarted.search(record.proposal.keywords[0]).items[0]?.proposal_id,record.id);
  altered=true;await restarted.refresh();assert.equal(prReads,60);assert.equal(restarted.search(records[0].proposal.keywords[0]).items.length,0);
  assert.equal(restarted.search(records[59].proposal.keywords[0]).items.length,1);
});
test('CP-07: MCP prepare/consent returns the actual PR and an altered branch cannot become approved',async t=>{
  const f=await fixture(t);const client=new Client({name:'correction-mcp-integration',version:'1'});t.after(()=>client.close());
  await client.connect(new SSEClientTransport(new URL(f.origin+'/sse'),{requestInit:{headers:{authorization:'Bearer fixture-key'}}}));
  const p=(await client.callTool({name:'prepare_correction_pr',arguments:input()})).structuredContent;assert.match(p.question,/PR/);assert.equal(f.state.posts.length,0);
  const result=(await client.callTool({name:'create_correction_pr',arguments:{proposal_id:p.proposal_id,proposal_hash:p.proposal_hash,confirmation_token:p.confirmation_token,confirm:true}})).structuredContent;
  assert.equal(result.state,'pending_review');assert.equal(result.pr_url,'https://github.com/fixture/legal/pull/7');
  f.state.extraFile=true;const status=(await client.callTool({name:'get_correction_pr',arguments:{proposal_id:p.proposal_id}})).structuredContent;assert.equal(status.state,'status_unavailable');
});
