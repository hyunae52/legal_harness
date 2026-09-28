import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile} from 'node:fs/promises';
import {performRollout} from './rollout-gate.mjs';
import {runRemotePhase} from './remote-phase.mjs';
const job=process.argv[2];
if(!/^[1-9][0-9]{0,19}(?:-[1-9][0-9]{0,19}){3}$/.test(job))throw Error('INVALID_JOB');
const exec=promisify(execFile), events=[];
const phase=async name=>{
  const event=await runRemotePhase(name,()=>exec('python3',['/opt/legal-harness-deployer/worker.py','phase',job,name],{timeout:240000,maxBuffer:1024*1024}));
  events.push(event);
};
const result=await performRollout({fence:()=>phase('fence'),drain:()=>phase('drain'),activate:()=>phase('activate'),
  verifyCandidate:()=>phase('verify-candidate'),rollback:()=>phase('rollback'),verifyPrevious:()=>phase('verify-previous'),resume:()=>phase('resume')});
await writeFile('/home/cta/legal-harness-autodeploy/jobs/'+job+'/rollout.json',JSON.stringify({...result,events},null,2)+'\n');
if(result.status!=='candidate_active_verified')process.exitCode=1;
