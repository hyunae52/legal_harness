#!/usr/bin/env node
// Linux qualification against an installed artifact. No law API calls or secrets.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { totalmem } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
const args = Object.fromEntries(process.argv.slice(2).map(a => { const i=a.indexOf('='); assert.ok(i>2); return [a.slice(2,i),a.slice(i+1)]; }));
assert.equal(process.platform,'linux');
const root=resolve(args['app-root']||'.'), fixture=resolve(args.fixture||'tests/fixtures/law-mcp-server.mjs');
const duration=Number(args['duration-ms']||900000), starts=Number(args.starts||20);
assert.ok(Number.isInteger(duration)&&duration>=1000&&duration<=1800000);
assert.ok(Number.isInteger(starts)&&starts>=1&&starts<=20);
const baseline=(args['baseline-pids']||'').split(',').filter(Boolean).map(Number);
assert.ok(baseline.every(p=>Number.isInteger(p)&&p>1));
const out=resolve(args.output||'.runtime/deployment-qualification.json');
await mkdir(resolve(out,'..'),{recursive:true});
const {KoreanLawClient,koreanLawOptionsFromEnv}=await import(pathToFileURL(join(root,'dist/koreanLawClient.js')));
const {createApp}=await import(pathToFileURL(join(root,'dist/app.js')));
const report={status:'running',node:process.version,platform:process.platform,started_at:new Date().toISOString(),duration_requested_ms:duration,cold_starts_requested:starts,law_api_calls:0,ram_bytes:totalmem(),baseline_pids:baseline,cold_starts:[],rounds:0,timeouts:0,disconnects:0,capacity_rejections:0,peak_combined_rss_bytes:0,peak_processes:[],sample_interval_ms:250,baseline_disappeared:[],orphan_pids:[]};
const children=new Set(), baselineMissing=new Set();
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='EPERM')return true;if(e.code==='ESRCH')return false;throw e;}};
function sample(){
  const rows=execFileSync('ps',['-eo','pid=,ppid=,rss=,comm='],{encoding:'utf8',timeout:2000,env:{...process.env,COLUMNS:'240',LINES:'60'}}).trim().split('\n').map(l=>{const [pid,ppid,rss,...comm]=l.trim().split(/\s+/);return {pid:Number(pid),ppid:Number(ppid),rss_bytes:Number(rss)*1024,comm:comm.join(' ')};});
  const ids=new Set([process.pid,...baseline]);
  let size;do{size=ids.size;for(const p of rows)if(ids.has(p.ppid)&&p.comm!=='ps')ids.add(p.pid);}while(size!==ids.size);
  for(const p of rows)if(p.ppid===process.pid&&p.comm==='node')children.add(p.pid);
  for(const p of baseline)if(!rows.some(r=>r.pid===p))baselineMissing.add(p);
  const included=rows.filter(r=>ids.has(r.pid)&&r.comm!=='ps'),rss=included.reduce((s,p)=>s+p.rss_bytes,0);
  if(rss>report.peak_combined_rss_bytes){report.peak_combined_rss_bytes=rss;report.peak_processes=included;}
}
const lag=monitorEventLoopDelay({resolution:20});lag.enable();
const cpuStart=process.cpuUsage();
let sampler,runtime,server,law;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function reapCheck(pids){for(const p of pids)assert.equal(alive(p),false,'child survived awaited close: '+p);}
try{
  sample();sampler=setInterval(sample,250);
  for(let i=0;i<starts;i++){
    const c=new KoreanLawClient(koreanLawOptionsFromEnv({}));
    const before=new Set(children),start=performance.now();
    const entry={attempt:i+1,status:'running'};report.cold_starts.push(entry);
    try{const catalog=await c.listTools();sample();entry.initialize_ms=performance.now()-start;assert.equal(catalog.server.name,'korean-law');assert.ok(catalog.tools.some(t=>t.name==='search_law'));assert.ok(entry.initialize_ms<10000);entry.tools=catalog.tools.length;entry.upstream=catalog.server.version;entry.status='pass';}
    catch(e){entry.status='fail';entry.error=e.code||e.message;throw e;}
    finally{const closeStart=performance.now();await c.close();entry.close_ms=performance.now()-closeStart;await reapCheck([...children].filter(p=>!before.has(p)));}
    await writeFile(out,JSON.stringify(report,null,2));
  }
  const opts=koreanLawOptionsFromEnv({LAW_OC:'synthetic-only',KOREAN_LAW_MCP_COMMAND:process.execPath,KOREAN_LAW_MCP_ARGS:JSON.stringify([fixture])});
  law=new KoreanLawClient(opts);
  runtime=createApp({law,env:{TAXLAB_API_KEY:'qualification-fixture'}});
  server=createServer(runtime.app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  const request=async(query,signal)=>{try{const r=await fetch(base+'/api/analyze',{method:'POST',headers:{'x-api-key':'qualification-fixture','content-type':'application/json'},body:JSON.stringify({query,tool:'search_law'}),signal:signal||AbortSignal.timeout(55000)});return {status:r.status,body:await r.json()};}catch(e){if(signal?.aborted)return {status:'disconnected'};throw e;}};
  const health=async()=>await(await fetch(base+'/health',{signal:AbortSignal.timeout(3000)})).json();
  const idle=async()=>{const deadline=Date.now()+5000;while((await health()).active_requests!==0){assert.ok(Date.now()<deadline,'capacity leaked after completion');await sleep(20);}};
  assert.equal((await fetch(base+'/api/tools')).status,401);
  assert.equal((await fetch(base+'/api/tools?apiKey=qualification-fixture')).status,401);
  assert.equal((await fetch(base+'/api/tools',{headers:{'x-api-key':'qualification-fixture',origin:'https://foreign.invalid'}})).status,403);
  assert.equal((await health()).maintenance,'unavailable');
  await law.listTools();
  const warm=await request('synthetic');assert.equal(warm.status,200);
  const soakStart=performance.now();
  while(performance.now()-soakStart<duration){
    const controller=new AbortController(), disconnect=report.rounds%5===0;
    const pending=[request('__budget_slow__',disconnect?controller.signal:undefined),request('__budget_slow__'),request('__budget_slow__')];
    try{
      const deadline=Date.now()+1200;while((await health()).active_requests<3){assert.ok(Date.now()<deadline,'three concurrent requests did not remain active');await sleep(10);}
      const excess=await request('excess');assert.equal(excess.status,429);report.capacity_rejections++;
      if(disconnect){controller.abort();report.disconnects++;assert.equal((await health()).active_requests,3,'disconnect released active work too early');}
      const replies=await Promise.all(pending);for(let i=0;i<replies.length;i++)assert.equal(replies[i].status,disconnect&&i===0?'disconnected':200);
    }finally{await Promise.allSettled(pending);}
    await idle();report.rounds++;
    if(report.rounds===1||report.rounds%90===0){
      const old=(await request('pid')).body.data.result.structuredContent.pid;
      const started=performance.now(),timeout=await request('__hang__');assert.equal(timeout.status,504);assert.equal(timeout.body.code,'MCP_TIMEOUT');
      assert.ok(performance.now()-started<50000);report.timeouts++;await reapCheck([old]);await idle();
      const next=await request('reconnected');assert.equal(next.status,200);assert.notEqual(next.body.data.result.structuredContent.pid,old);
    }
    sample();assert.ok(report.peak_combined_rss_bytes<=totalmem()*0.7,'combined app/upstreams/tunnel RSS exceeded 70% of VM RAM');
    await writeFile(out,JSON.stringify(report,null,2));await sleep(500);
  }
  report.soak_elapsed_ms=performance.now()-soakStart;
  await idle();report.final_active_requests=(await health()).active_requests;
  report.status=duration>=900000&&starts===20?'pass':'smoke_only';
}catch(e){report.status='fail';report.error={code:e.code||e.name,message:String(e.message).slice(0,500)};process.exitCode=1;}
finally{
  clearInterval(sampler);await runtime?.close();await law?.close();
  if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  sample();report.orphan_pids=[...children].filter(alive);report.baseline_disappeared=[...baselineMissing];
  if(report.orphan_pids.length||report.baseline_disappeared.length){report.status='fail';process.exitCode=1;}
  lag.disable();report.event_loop_p99_ms=lag.percentile(99)/1e6;report.event_loop_max_ms=lag.max/1e6;
  report.probe_cpu_micros=process.cpuUsage(cpuStart);report.finished_at=new Date().toISOString();
  await writeFile(out,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
