// Exports only the artifact that package-smoke actually installed and tested.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join,sep} from 'node:path';
import {createHash} from 'node:crypto';
const root=process.cwd(), env=process.env;
const hash=data=>createHash('sha256').update(data).digest('hex');
const tracked=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean).sort();
export async function protection(root,files){
  const fingerprint=async names=>{const digest=createHash('sha256');for(const name of names){digest.update(name+'\0');digest.update(hash(await readFile(join(root,name)))+'\0');}return digest.digest('hex');};
  const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
  return {migrations:await fingerprint(files.filter(p=>p.startsWith('supabase/')&&p.endsWith('.sql'))),
    deployer:await fingerprint(files.filter(p=>p.startsWith('deploy/autodeploy/')||['scripts/rollout-gate.mjs','deploy/remote-phase.mjs','deploy/installed-dependencies.mjs'].includes(p))),
    tax_provider:hash(await readFile(join(root,'upstreams/korean-taxlaw-mcp.json'))),law_version:pkg.dependencies['korean-law-mcp']};
}
if(process.argv.includes('--protection-only')){
  console.log(JSON.stringify(await protection(root,tracked)));
}else{
  assert.equal(env.GITHUB_REPOSITORY,'hyunae52/legal_harness');
  assert.equal(env.GITHUB_EVENT_NAME,'push');assert.equal(env.GITHUB_REF,'refs/heads/main');
  const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();assert.equal(head,env.GITHUB_SHA);
  const run=Number(env.GITHUB_RUN_ID),attempt=Number(env.GITHUB_RUN_ATTEMPT);
  assert.ok(Number.isSafeInteger(run)&&run>0&&Number.isSafeInteger(attempt)&&attempt>0);
  const record=JSON.parse(await readFile('.runtime/package-smoke-latest.json','utf8'));
  assert.equal(record.status,'pass');assert.equal(record.head,head);
  execFileSync('git',['diff','--quiet','HEAD']);
  const artifact=resolve(record.artifact);assert.ok(artifact.startsWith(resolve('.runtime')+sep));
  const packageHash=hash(await readFile(artifact));assert.equal(packageHash,record.sha256);
  const output=resolve('.runtime/deploy-artifact');await mkdir(output,{recursive:true});
  await copyFile(artifact,join(output,'package.tgz'));
  const manifest={schema_version:1,repository:env.GITHUB_REPOSITORY,head,run_id:run,run_attempt:attempt,package_sha256:packageHash,
    protection:await protection(root,tracked)};
  await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  console.log(JSON.stringify({head,package_sha256:packageHash,artifact_name:`law-release-${head}-${attempt}`}));
}
