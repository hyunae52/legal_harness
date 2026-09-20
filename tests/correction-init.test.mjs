import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configuredCorrectionService} from '../dist/correctionGitHub.js';
import {createApp} from '../dist/app.js';

test('CP-12: invalid optional PR configuration and unusable state storage do not prevent authenticated law lookup',async t=>{
  const root=await mkdtemp(join(tmpdir(),'taxlab-correction-init-'));
  t.after(async()=>{assert.ok(root.startsWith(join(tmpdir(),'taxlab-correction-init-')));await rm(root,{recursive:true,force:true});});
  const file=join(root,'not-a-directory');await writeFile(file,'fixture');
  const warnings=[];t.mock.method(console,'error',message=>warnings.push(String(message)));
  const valid={CORRECTION_PR_ENABLED:'1',CORRECTION_STATE_DIR:join(root,'state'),GITHUB_TOKEN:'fixture-initialization-private-token',GITHUB_OWNER:'fixture',GITHUB_REPO:'legal'};
  for(const env of [{...valid,GITHUB_TOKEN:''},{...valid,GITHUB_REPO:'invalid/repo'},{...valid,GITHUB_BASE_BRANCH:'other'},{...valid,CORRECTION_STATE_DIR:file}]){
    const corrections=configuredCorrectionService(env);assert.equal(corrections,undefined);
    const runtime=createApp({env:{TAXLAB_API_KEY:'fixture-key'},corrections,law:{releaseVersion:'fixture',listTools:async()=>({tools:[{name:'search_law',inputSchema:{type:'object'}}]}),callTool:async()=>({result:{content:[{type:'text',text:'fixture source'}]}}),close:async()=>{}}});
    const server=createServer(runtime.app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
    try{
      const origin='http://127.0.0.1:'+server.address().port;
      const health=await fetch(origin+'/health');assert.equal(health.status,200);assert.equal((await health.json()).correction_pr,'unavailable');
      assert.equal((await fetch(origin+'/api/analyze',{method:'POST',headers:{authorization:'Bearer fixture-key','content-type':'application/json'},body:JSON.stringify({query:'시행일',tool:'search_law'})})).status,200);
      const unavailable=await fetch(origin+'/api/corrections/prepare',{method:'POST',headers:{authorization:'Bearer fixture-key','content-type':'application/json'},body:'{}'});
      assert.equal(unavailable.status,503);assert.equal((await unavailable.json()).code,'CORRECTION_PR_UNAVAILABLE');
    }finally{await runtime.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
  }
  assert.equal(warnings.length,4);assert.ok(!warnings.join('').includes(valid.GITHUB_TOKEN));
});
