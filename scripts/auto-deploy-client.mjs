// The CI runner can request/status a durable GCE job; its key cannot run a shell.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,unlink,rmdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const env=process.env;
const ids=['SOURCE_REVIEW_RUN_ID','SOURCE_REVIEW_ATTEMPT','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT'].map(k=>env[k]);
assert.ok(ids.every(v=>/^[1-9][0-9]{0,19}$/.test(v??'')),'INVALID_JOB_ID');
const job=ids.join('-');
assert.match(env.GCE_DEPLOY_HOST??'',/^[A-Za-z0-9.-]{1,253}$/);
assert.match(env.GCE_DEPLOY_USER??'',/^[a-z_][a-z0-9_-]{0,31}$/);
assert.ok(env.GCE_DEPLOY_PRIVATE_KEY?.includes('BEGIN OPENSSH PRIVATE KEY'),'MISSING_DEPLOY_KEY');
assert.ok(env.GCE_DEPLOY_KNOWN_HOSTS?.trim() && env.GITHUB_TOKEN,'MISSING_DEPLOY_AUTH');
const directory=await mkdtemp(join(tmpdir(),'law-deploy-'));
const key=join(directory,'key'),hosts=join(directory,'known_hosts');
const cleanEnv=Object.fromEntries(['PATH','HOME','USER','LANG'].filter(k=>env[k]).map(k=>[k,env[k]]));
const ssh=(verb,input='')=>new Promise((resolve,reject)=>{
  const child=spawn('ssh',['-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=15',
    '-o','UserKnownHostsFile='+hosts,'-i',key,env.GCE_DEPLOY_USER+'@'+env.GCE_DEPLOY_HOST,verb+' '+job],
    {env:cleanEnv,stdio:['pipe','pipe','pipe']});
  let output='',bytes=0;
  const deadline=setTimeout(()=>{child.kill();reject(Error('SSH_RESPONSE_TIMEOUT'));},25000);
  child.stdout.on('data',d=>{bytes+=d.length;if(bytes>128*1024){child.kill();reject(Error('SSH_RESPONSE_SIZE'));}else output+=d;});
  child.stderr.on('data',()=>{});
  child.on('error',()=>{clearTimeout(deadline);reject(Error('SSH_UNAVAILABLE'));});
  child.on('close',code=>{clearTimeout(deadline);try{const data=JSON.parse(output);assert.equal(data.job??job,job);if(code!==0)throw Error('SSH_REQUEST_FAILED');resolve(data);}catch{reject(Error('SSH_REQUEST_FAILED'));}});
  child.stdin.on('error',()=>{});child.stdin.end(input);
});
try{
  await writeFile(key,env.GCE_DEPLOY_PRIVATE_KEY.trim()+'\n',{mode:0o600});
  await writeFile(hosts,env.GCE_DEPLOY_KNOWN_HOSTS.trim()+'\n',{mode:0o600});
  let state;
  try{state=await ssh('submit',env.GITHUB_TOKEN+'\n');}
  catch{state=await ssh('status');} // A lost acknowledgement never submits twice.
  const until=Date.now()+25*60*1000;let last='';
  while(['queued','running'].includes(state.status)){
    const current=state.phase??state.status;
    if(current!==last){console.log(JSON.stringify({job,status:state.status,phase:state.phase}));last=current;}
    assert.ok(Date.now()<until,'DEPLOYMENT_POLL_TIMEOUT');
    await new Promise(r=>setTimeout(r,5000));
    state=await ssh('status');
  }
  console.log(JSON.stringify(state));
  if(state.status==='superseded')console.log('A newer main revision will be deployed after its review succeeds.');
  else{
    assert.equal(state.status,'deployed','DEPLOYMENT_NOT_VERIFIED');
    const response=await fetch('https://law.taxlab.kr/health',{signal:AbortSignal.timeout(15000)});
    assert.equal(response.status,200);const health=await response.json();
    assert.equal(health.status,'ok');assert.equal(health.release_commit,state.head);
    console.log(JSON.stringify({public_verification:'pass',head:state.head,policy:health.research_harness?.policy}));
  }
}finally{
  for(const path of [key,hosts])await unlink(path).catch(e=>{if(e.code!=='ENOENT')throw e;});
  await rmdir(directory);
}
