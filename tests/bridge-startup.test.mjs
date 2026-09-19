import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const run=promisify(execFile);
for(const headersOnly of [false,true])test(`bridge full startup deadline covers stalled SSE ${headersOnly?'without endpoint':'without headers'}`,async t=>{
  const server=createServer((req,res)=>{
    if(req.url==='/health'){res.setHeader('content-type','application/json');res.end('{"status":"ok"}');}
    else if(headersOnly){res.writeHead(200,{'content-type':'text/event-stream','connection':'keep-alive'});res.write(': heartbeat\n\n');}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  const env=Object.fromEntries(['PATH','Path','SystemRoot','SYSTEMROOT','TEMP','TMP','HOME','USERPROFILE'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  const started=Date.now();
  await assert.rejects(run(process.execPath,[fileURLToPath(new URL('../scripts/hermes-mcp-bridge.mjs',import.meta.url)),'--doctor'],{env:{...env,TAXLAB_SERVER_URL:`http://127.0.0.1:${server.address().port}`,TAXLAB_ALLOW_LOOPBACK_HTTP:'1',TAXLAB_API_KEY:'fixture',TAXLAB_CONNECT_TIMEOUT_MS:'250'},windowsHide:true,timeout:5000}),error=>{
    assert.equal(error.killed,false,'outer test deadline must not kill a hung bridge');assert.equal(error.code,1);assert.match(error.stderr,/Legal MCP connection failed/);return true;
  });
  assert.ok(Date.now()-started<5000);
});
