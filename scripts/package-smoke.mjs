// Pack, install into an empty prefix, then exercise real stdio -> SSE -> app.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const exec=promisify(execFile),npm=process.env.npm_execpath;
if(!npm) throw Error('Run npm run review:package');
const env=Object.fromEntries(['PATH','Path','SystemRoot','SYSTEMROOT','TEMP','TMP','HOME','USERPROFILE','COMSPEC','ComSpec','PATHEXT'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
await mkdir(join(root,'.runtime'),{recursive:true});
const work=await mkdtemp(join(root,'.runtime','package-review-'));
const command=async args=>(await exec(process.execPath,[npm,...args],{cwd:root,env,windowsHide:true,timeout:180000,maxBuffer:4*1024*1024})).stdout;
const [packed]=JSON.parse(await command(['pack','--ignore-scripts','--json','--pack-destination',work]));
assert.ok(packed.files.every(f=>!/(^|\/)(?:\.env(?:\.|$)|docs|tests|\.git|\.runtime)/.test(f.path)),'Private files in package');
assert.ok(packed.files.some(f=>f.path==='rules/manifest.json'));
assert.ok(packed.files.some(f=>f.path==='dist/landing.js'),'The public connection guide must ship with the app');
for(const path of ['dist/setup.js','dist/downloads/taxlab-law.mcpb'])assert.ok(packed.files.some(f=>f.path===path),'Missing setup artifact: '+path);
for(const path of ['dist/research.js','dist/researchContracts.js','dist/researchEvidence.js','dist/researchReview.js','dist/researchInterview.js','dist/statelessHttp.js','dist/resourceBudgets.js'])assert.ok(packed.files.some(f=>f.path===path),'Missing research module: '+path);
assert.ok(packed.files.some(f=>f.path==='npm-shrinkwrap.json'),'Published dependencies must be pinned');
assert.deepEqual(JSON.parse(await readFile(join(root,'npm-shrinkwrap.json'),'utf8')),JSON.parse(await readFile(join(root,'package-lock.json'),'utf8')),'Published and development locks must agree');
const artifact=join(work,packed.filename),prefix=join(work,'clean-prefix');
await mkdir(prefix);await writeFile(join(prefix,'package.json'),'{"private":true}');
await command(['install','--prefix',prefix,'--ignore-scripts','--omit=optional','--no-audit','--no-fund',artifact]);
const installed=join(prefix,'node_modules/k-tax-agent-backend');
// Local-tarball npm install may ignore a dependency's shrinkwrap metadata.
// Treat the installed CLI as a locked application root before ever running it.
await command(['ci','--prefix',installed,'--ignore-scripts','--omit=dev','--omit=optional','--no-audit','--no-fund']);
const shrinkwrap=JSON.parse(await readFile(join(installed,'npm-shrinkwrap.json'),'utf8'));
assert.deepEqual(shrinkwrap,JSON.parse(await readFile(join(root,'package-lock.json'),'utf8')));
const versions={};
for(const name of Object.keys(shrinkwrap.packages[''].dependencies)){
  let metadata;for(const location of [join(installed,'node_modules',name,'package.json'),join(prefix,'node_modules',name,'package.json')]){try{metadata=JSON.parse(await readFile(location,'utf8'));break;}catch(error){if(error.code!=='ENOENT')throw error;}}
  assert.equal(metadata?.version,shrinkwrap.packages['node_modules/'+name].version,`Installed version drift: ${name}`);versions[name]=metadata.version;
}
const {createApp}=await import(pathToFileURL(join(installed,'dist/app.js')).href);
const runtime=createApp({env:{TAXLAB_API_KEY:'package-fixture'},law:{releaseVersion:'fixture',listTools:async()=>({tools:[{name:'search_law',inputSchema:{type:'object'}}]}),callTool:async()=>({result:{content:[{type:'text',text:'package-fixture-result'}]}}),close:async()=>{}}});
const server=createServer(runtime.app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
const childEnv={...env,TAXLAB_API_KEY:'package-fixture',TAXLAB_SERVER_URL:`http://127.0.0.1:${server.address().port}`,TAXLAB_ALLOW_LOOPBACK_HTTP:'1'};
const client=new Client({name:'clean-package-check',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args:[join(installed,'scripts/hermes-mcp-bridge.mjs')],cwd:prefix,env:childEnv,stderr:'pipe'});
transport.stderr?.on('data',()=>{});
try {
  await client.connect(transport,{timeout:5000});
  const tools=await client.listTools(undefined,{timeout:5000});assert.ok(tools.tools.some(t=>t.name==='validate_legal_draft'));
  const result=await client.callTool({name:'search_law',arguments:{query:'synthetic'}},undefined,{timeout:5000});assert.equal(result.content[0].text,'package-fixture-result');
  assert.ok(tools.tools.some(t=>t.name==='review_legal_reasoning'));
  const research=await client.callTool({name:'start_legal_research',arguments:{plan:{query:'Package synthetic',issues:[{id:'fixture',question:'Synthetic issue',required_fact_ids:[],required_date_roles:[]}],facts:[],event_dates:[]}}});
  assert.equal(research.structuredContent.revision,1);assert.deepEqual(JSON.parse(research.content[0].text),research.structuredContent);
  const httpClient = new Client({name:'clean-package-http-check',version:'1'});
  try {
    await httpClient.connect(new StreamableHTTPClientTransport(new URL(childEnv.TAXLAB_SERVER_URL + '/mcp'), {requestInit:{headers:{authorization:'Bearer package-fixture'}}}));
    const tools = await httpClient.listTools(); assert.ok(tools.tools.some(t => t.name === 'answer_legal_question'));
    const state = await httpClient.callTool({name:'get_legal_research',arguments:{research_id:research.structuredContent.research_id}});
    assert.equal(state.structuredContent.interview.next_action,'research_sources_and_review');
  } finally { await httpClient.close(); }
  const {stdout}=await exec(process.execPath,[join(installed,'scripts/hermes-mcp-bridge.mjs'),'--doctor'],{cwd:prefix,env:childEnv,windowsHide:true,timeout:10000});assert.equal(JSON.parse(stdout).status,'ok');
  const {stdout:imported}=await exec(process.execPath,['--input-type=module','-e',"const {GateEngine}=await import('k-tax-agent-backend/dist/gates.js');console.log(new GateEngine().rules.length)"],{cwd:prefix,env,windowsHide:true,timeout:10000});assert.equal(imported.trim(),'10');
  const digest=createHash('sha256').update(await readFile(artifact)).digest('hex');
  await writeFile(join(work,'evidence.json'),JSON.stringify({status:'pass',artifact,sha256:digest,files:packed.files.length,checks:['clean_install','stdio_sse_authenticated_call','doctor','packaged_rules','published_lock','installed_dependency_versions','installed_research_app_and_bridge','stateless_http_interview_contract'],versions,fixture_only:true},null,2));
  console.log(JSON.stringify({status:'pass',artifact,sha256:digest,checks:8,versions}));
} finally {
  await client.close();await transport.close();await runtime.close();server.closeAllConnections();await new Promise(r=>server.close(r));
}
