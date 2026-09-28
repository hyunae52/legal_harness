import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {createHash} from 'node:crypto';
import * as yaml from 'js-yaml';
const exec=promisify(execFile);
test('auto-deploy: server identity, archive, command and recovery contracts',async()=>{
  const result=await exec(process.platform==='win32'?'python':'python3',['tests/autodeploy_contract_test.py'],{timeout:20000,windowsHide:true});
  assert.match(result.stderr,/Ran 22 tests/);assert.match(result.stderr,/OK/);
});
test('auto-deploy: export binds passed package bytes to a clean, exact main source',async()=>{
  const parent=resolve('.runtime/export-contract');await mkdir(parent,{recursive:true});
  const root=await mkdtemp(join(parent,'case-')),script=resolve('scripts/export-deploy-package.mjs');
  assert.ok(root.startsWith(parent+sep));
  try{
    for(const path of ['.runtime','upstreams','supabase','deploy/autodeploy'])await mkdir(join(root,path),{recursive:true});
    await writeFile(join(root,'.gitignore'),'.runtime/\n');
    await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{'korean-law-mcp':'4.14.2'}}));
    await writeFile(join(root,'upstreams/korean-taxlaw-mcp.json'),'{}');
    await writeFile(join(root,'supabase/schema.sql'),'select 1;');
    await writeFile(join(root,'deploy/autodeploy/controller.py'),'# trusted\n');
    const git=async args=>(await exec('git',args,{cwd:root,windowsHide:true})).stdout.trim();
    await git(['init','-q']);await git(['add','.']);
    await git(['-c','user.name=Contract','-c','user.email=contract@example.invalid','commit','-qm','fixture']);
    const head=await git(['rev-parse','HEAD']),artifact=join(root,'.runtime/tested.tgz');
    await writeFile(artifact,'tested bytes');
    const record={status:'pass',head,artifact,sha256:createHash('sha256').update('tested bytes').digest('hex')};
    const evidence=()=>writeFile(join(root,'.runtime/package-smoke-latest.json'),JSON.stringify(record));
    await evidence();
    const env={...process.env,GITHUB_REPOSITORY:'hyunae52/legal_harness',GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/main',GITHUB_SHA:head,GITHUB_RUN_ID:'7',GITHUB_RUN_ATTEMPT:'2'};
    const exportPackage=overrides=>exec(process.execPath,[script],{cwd:root,env:{...env,...overrides},windowsHide:true});
    await exportPackage();
    const manifest=JSON.parse(await readFile(join(root,'.runtime/deploy-artifact/manifest.json'),'utf8'));
    assert.equal(manifest.head,head);assert.equal(manifest.package_sha256,record.sha256);
    assert.equal(await readFile(join(root,'.runtime/deploy-artifact/package.tgz'),'utf8'),'tested bytes');
    await assert.rejects(exportPackage({GITHUB_EVENT_NAME:'pull_request'}));
    await assert.rejects(exportPackage({GITHUB_SHA:'a'.repeat(40)}));
    record.head='b'.repeat(40);await evidence();await assert.rejects(exportPackage());
    record.head=head;await evidence();await writeFile(artifact,'replaced bytes');await assert.rejects(exportPackage());
    await writeFile(artifact,'tested bytes');await writeFile(join(root,'supabase/schema.sql'),'select 2;');
    await assert.rejects(exportPackage());
  }finally{assert.ok(root.startsWith(parent+sep));await rm(root,{recursive:true,force:true});}
});
test('auto-deploy: PR jobs have no deployment environment and activation cannot be cancelled by a newer push',async()=>{
  const review=yaml.load(await readFile('.github/workflows/review.yml','utf8'));
  const deploy=yaml.load(await readFile('.github/workflows/deploy.yml','utf8'));
  assert.equal(review.permissions.contents,'read');assert.equal(review.jobs.review.environment,undefined);
  for(const step of review.jobs.review.steps.filter(s=>s.name?.includes('deployment package')))assert.match(step.if,/github.event_name == 'push'.*refs\/heads\/main/);
  assert.equal(deploy.concurrency['cancel-in-progress'],false);
  assert.equal(deploy.jobs.deploy.environment,'production');
  assert.match(deploy.jobs.deploy.if,/workflow_run.event == 'push'/);
  assert.match(deploy.jobs.deploy.if,/head_repository.full_name == github.repository/);
  assert.equal(deploy.jobs.deploy.steps.find(s=>s.uses?.startsWith('actions/checkout@')).with.ref,'${{ steps.source.outputs.head }}');
  assert.equal(deploy.on.pull_request,undefined);assert.equal(deploy.on.pull_request_target,undefined);
});
