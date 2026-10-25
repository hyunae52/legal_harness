import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UsageStore, readUsage, readMorningUsage } from '../dist/usage.js';
import { usageFailureCode } from '../dist/usageFailures.js';
import { prepareUsageMail } from '../dist/usageMail.js';
import { createApp } from '../dist/app.js';
import { LawMcpError } from '../dist/koreanLawClient.js';

async function fixture(t, initial='2026-10-25T21:00:00Z') {
  const root=await mkdtemp(join(tmpdir(),'usage-reasons-')), path=join(root,'usage.sqlite');
  let wall=Date.parse(initial);
  const stores=[];
  t.after(async()=>{for(const store of stores)store.close();await rm(root,{recursive:true,force:true});});
  const open=()=>{const store=new UsageStore(path,()=>wall,()=>0);store.registerTools(['search_law']);stores.push(store);return store;};
  return {root,path,open,at:iso=>{wall=Date.parse(iso);},now:()=>wall};
}
const failure=code=>({isError:true,structuredContent:{ok:false,error:{code}},content:[]});
const total=rows=>rows.reduce((sum,row)=>sum+row.failures,0);

test('reason labels inspect bounded protocol fields, never prose, arbitrary codes or getters',()=>{
  assert.equal(usageFailureCode({result:failure('NOT_FOUND')}),'NOT_FOUND');
  assert.equal(usageFailureCode(new LawMcpError(504,'MCP_TOOL_ERROR','private',failure('TIMEOUT')),true),'TIMEOUT');
  assert.equal(usageFailureCode({isError:true,content:[{type:'text',text:'{"code":"INVALID_INPUT"}'}]}),'INVALID_INPUT');
  assert.equal(usageFailureCode({isError:true,content:[{type:'text',text:'private query NOT_FOUND'}]}),'UNCLASSIFIED_ERROR');
  assert.equal(usageFailureCode({isError:true,content:[{type:'text',text:'[NOT_FOUND] private query'}]}),'NOT_FOUND');
  assert.equal(usageFailureCode({isError:true,content:[{type:'text',text:'[UPSTREAM_NO_DATA] private query'}]}),'UPSTREAM_NO_DATA');
  assert.equal(usageFailureCode({isError:true,content:[{type:'text',text:'[PRIVATE_CODE_481237] private query'}]}),'UNCLASSIFIED_ERROR');
  assert.equal(usageFailureCode({code:'PRIVATE_CODE_481237',message:'NOT_FOUND'}),'UNCLASSIFIED_ERROR');
  assert.equal(usageFailureCode({isError:true,content:[{type:'text',text:'{"padding":"'+ 'x'.repeat(20000)+'","code":"NOT_FOUND"}'}]}),'UNCLASSIFIED_ERROR');
  const guarded={};Object.defineProperty(guarded,'code',{get(){throw Error('must not invoke getter');}});
  assert.equal(usageFailureCode(guarded),'UNCLASSIFIED_ERROR');
  const cycle={};cycle.result=cycle;assert.equal(usageFailureCode(cycle),'UNCLASSIFIED_ERROR');
});

test('failure counts use the same daily/start and morning/completion windows as totals',async t=>{
  const f=await fixture(t,'2026-10-25T20:59:59Z'),store=f.open();
  const finish=store.start('mcp','search_law');f.at('2026-10-25T21:00:01Z');finish(false,'NOT_FOUND');finish(false,'INTERNAL_ERROR');
  await store.measure('mcp','search_law',async()=>failure('INVALID_INPUT'));
  await store.measure('source','search_law',async()=>failure('NOT_FOUND'));
  const daily=readUsage(f.path,1,f.now());
  assert.equal(daily.totals.mcp.failures,2);assert.equal(total(daily.failure_reasons.filter(r=>r.scope==='mcp')),2);
  const before=readMorningUsage(f.path,Date.parse('2026-10-25T21:00:01Z'));
  assert.equal(total(before.failure_reasons),0);
  const after=readMorningUsage(f.path,Date.parse('2026-10-26T21:00:00Z'));
  assert.deepEqual(after.failure_reasons.filter(r=>r.scope==='mcp').map(r=>[r.code,r.category,r.failures]),[
    ['INVALID_INPUT','input',1],['NOT_FOUND','not_found',1],
  ]);
  const message=prepareUsageMail(after);
  assert.match(message.text,/입력 오류: 1건/);assert.match(message.text,/조회 결과 없음: 1건/);
  assert.match(message.html,/search_law \/ NOT_FOUND: 1건/);
});

test('migration preserves old totals and marks missing history without inventing causes',async t=>{
  const f=await fixture(t),old=f.open();old.start('mcp','search_law')(false);old.close();
  const db=new DatabaseSync(f.path);db.exec("DROP TABLE usage_failures; DELETE FROM usage_meta WHERE key='failure_started_at'");db.close();
  const historical=readUsage(f.path,1,f.now());assert.equal(historical.failure_started_at,null);
  assert.equal(historical.failure_reasons[0].code,'UNRECORDED');
  f.at('2026-10-26T00:00:00Z');const store=f.open();
  await store.measure('mcp','search_law',async()=>failure('NOT_FOUND'));
  const report=readMorningUsage(f.path,Date.parse('2026-10-26T21:00:00Z'));
  assert.equal(report.totals.mcp.failures,2);
  assert.equal(report.failure_started_at,'2026-10-26T00:00:00.000Z');
  assert.equal(total(report.failure_reasons),2);
  assert.deepEqual(report.failure_reasons.map(r=>[r.code,r.failures]),[['NOT_FOUND',1],['UNRECORDED',1]]);
  const mail=prepareUsageMail(report);assert.match(mail.text,/원인 기록 없음: 1건/);assert.match(mail.html,/원인을 추정하지 않습니다/);
});

test('failure reason writes are atomic with totals and retention prunes both kinds of bucket',async t=>{
  const f=await fixture(t),store=f.open(),db=new DatabaseSync(f.path);
  db.exec("CREATE TRIGGER block_reason BEFORE INSERT ON usage_failures BEGIN SELECT RAISE(ABORT,'fixture'); END");
  const result=failure('NOT_FOUND');assert.equal(await store.measure('mcp','search_law',async()=>result),result);
  assert.equal(store.status().failed_writes,1);assert.deepEqual(readUsage(f.path,1,f.now()).totals,{});
  assert.equal(db.prepare('SELECT count(*) AS n FROM usage_morning').get().n,0);
  db.exec('DROP TRIGGER block_reason');store.start('mcp','search_law')(false,'NOT_FOUND');
  f.at(new Date(f.now()+400*86400000).toISOString());store.start('mcp','search_law')(false,'INVALID_INPUT');
  assert.equal(db.prepare('SELECT sum(failures) AS n FROM usage_failures').get().n,2);
  db.close();
});

test('arbitrary labels and diagnostics never persist, while thrown errors keep identity',async t=>{
  const f=await fixture(t),store=f.open(),secret='PRIVATE_BODY_TOKEN_481237';
  for(let i=0;i<300;i++)store.start('mcp',secret+i)(false,secret+i);
  const result={isError:true,structuredContent:{error:{code:'NOT_FOUND',message:secret},query:secret},content:[{type:'text',text:secret}]};
  assert.equal(await store.measure('mcp','search_law',async()=>result),result);
  const thrown=Object.assign(Error(secret),{code:secret});
  await assert.rejects(store.measure('source','search_law',async()=>{throw thrown;}),e=>e===thrown);
  const report=readUsage(f.path,1,f.now());assert.equal(report.failure_reasons.length,3);
  assert.equal(report.failure_reasons.find(r=>r.tool==='_unknown').failures,300);
  assert.equal(report.failure_reasons.find(r=>r.scope==='source').code,'UNCLASSIFIED_EXCEPTION');
  for(const name of await readdir(f.root))assert.equal((await readFile(join(f.root,name))).includes(Buffer.from(secret)),false);
});

test('real MCP errors retain specific codes through sanitization and count once per scope',async t=>{
  const f=await fixture(t),usage=f.open();
  const law={releaseVersion:'fixture',close:async()=>{},listTools:async()=>({tools:[{name:'search_law',inputSchema:{type:'object',properties:{query:{type:'string'}}}}]}),
    callTool:async(_name,args)=>{
      if(args.query==='missing')throw new LawMcpError(404,'MCP_TOOL_ERROR','private exception',failure('NOT_FOUND'));
      if(args.query==='no_data')throw new LawMcpError(502,'MCP_TOOL_ERROR','private exception',
        {isError:true,content:[{type:'text',text:'[UPSTREAM_NO_DATA] private query'}]});
      if(args.query==='timeout')throw new LawMcpError(504,'MCP_TIMEOUT','private exception');
      return {result:{content:[{type:'text',text:'fixture'}]}};
    }};
  const runtime=createApp({law,usage,env:{TAXLAB_PUBLIC_ACCESS:'1',TAXLAB_PUBLIC_SESSION_SECRET:'synthetic-usage-session-secret-0123456789'}});
  const server=createServer(runtime.app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const client=new Client({name:'failure-count-test',version:'1'});
  t.after(async()=>{await client.close();await runtime.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
  await client.listTools();
  for(const query of ['success','missing','no_data','timeout'])await client.callTool({name:'search_law',arguments:{query}});
  await client.callTool({name:'validate_legal_draft',arguments:{}});
  const report=readUsage(f.path,1,f.now());
  assert.equal(report.totals.mcp.calls,5);assert.equal(report.totals.mcp.failures,4);
  assert.equal(report.totals.source.calls,4);assert.equal(report.totals.source.failures,3);
  assert.deepEqual(report.failure_reasons.filter(r=>r.scope==='mcp').map(r=>r.code).sort(),['INVALID_INPUT','MCP_TIMEOUT','NOT_FOUND','UPSTREAM_NO_DATA']);
  assert.equal(report.failure_reasons.find(r=>r.code==='UPSTREAM_NO_DATA').category,'upstream');
  assert.equal(total(report.failure_reasons.filter(r=>r.scope==='mcp')),4);
});
