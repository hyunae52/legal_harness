import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import JSZip from 'jszip';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createApp } from '../dist/app.js';

test('PA-08: Claude bundle needs no key and runs from a clean directory without installing dependencies',async t=>{
  const archive=await readFile(new URL('../dist/downloads/taxlab-law.mcpb',import.meta.url));
  const record=JSON.parse(await readFile(new URL('../dist/downloads/taxlab-law.mcpb.json',import.meta.url),'utf8'));
  assert.equal(createHash('sha256').update(archive).digest('hex'),record.sha256);
  const zip=await JSZip.loadAsync(archive);
  const manifest=JSON.parse(await zip.file('manifest.json').async('string'));
  assert.equal(manifest.manifest_version,'0.3');assert.equal(manifest.user_config,undefined);
  assert.deepEqual(manifest.server.mcp_config.env,{TAXLAB_SERVER_URL:'https://law.taxlab.kr'});
  assert.equal(manifest.server.entry_point,'server/bridge.mjs');
  const bridge=(await readFile(new URL('../scripts/hermes-mcp-bridge.mjs',import.meta.url),'utf8')).replaceAll('\r\n','\n');
  assert.equal(await zip.file('server/bridge.mjs').async('string'),bridge);
  assert.ok(record.dependencies.every(p=>!['korean-law-mcp','@supabase/supabase-js','dotenv','jszip'].includes(p.name)));
  const temp=await mkdtemp(join(tmpdir(),'taxlab-mcpb-'));
  assert.ok(!temp.startsWith(resolve('.')+sep),'Do not resolve dependencies from this repository');
  t.after(async()=>{assert.ok(temp.startsWith(join(tmpdir(),'taxlab-mcpb-')));await rm(temp,{recursive:true,force:true});});
  for(const [name,entry] of Object.entries(zip.files)) {
    assert.ok(!/(^|\/)(\.env(?:\.|$)|\.npmrc$|\.git(?:\/|$))/.test(name));
    assert.ok(name.startsWith('node_modules/')||['manifest.json','server/bridge.mjs','package.json','LICENSE','README.md'].includes(name));
    const target=resolve(temp,name);assert.ok(target.startsWith(temp+sep));assert.equal(entry.dir,false);
    await mkdir(dirname(target),{recursive:true});await writeFile(target,await entry.async('nodebuffer'));
  }
  const calls=[];
  const runtime=createApp({env:{TAXLAB_PUBLIC_ACCESS:'1',TAXLAB_PUBLIC_SESSION_SECRET:'bundle-fixture-signing-secret-0123456789abcdef'},law:{releaseVersion:'fixture',listTools:async()=>({tools:[{name:'search_law',inputSchema:{type:'object'}}]}),
    callTool:async(name,args)=>{calls.push({name,args});return {result:{content:[{type:'text',text:'bundle-fixture-result'}]}};},close:async()=>{}}});
  const server=createServer(runtime.app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await runtime.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
  const env=Object.fromEntries(['PATH','Path','SystemRoot','SYSTEMROOT','TEMP','TMP','HOME','USERPROFILE'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  const transport=new StdioClientTransport({command:process.execPath,args:[join(temp,'server/bridge.mjs')],cwd:temp,
    env:{...env,NODE_PATH:'',NODE_OPTIONS:'',TAXLAB_SERVER_URL:'http://127.0.0.1:'+server.address().port,TAXLAB_ALLOW_LOOPBACK_HTTP:'1'},stderr:'pipe'});
  transport.stderr?.on('data',()=>{});
  const client=new Client({name:'desktop-bundle-check',version:'1'});
  try {
    await client.connect(transport,{timeout:15000});
    const tools=await client.listTools(undefined,{timeout:5000});assert.ok(tools.tools.some(tool=>tool.name==='search_law'));
    const result=await client.callTool({name:'search_law',arguments:{query:'synthetic'}},undefined,{timeout:5000});
    assert.equal(result.content[0].text,'bundle-fixture-result');assert.deepEqual(calls,[{name:'search_law',args:{query:'synthetic'}}]);
  } finally {await client.close();await transport.close();}
});
