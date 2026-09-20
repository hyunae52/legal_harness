// Read-only identity check for the operator's reviewed manifest. Not deployment approval.
import assert from 'node:assert/strict';
import {readFileSync,realpathSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join,sep} from 'node:path';
const [manifestPath,expectedDigest]=process.argv.slice(2);
const hash=data=>createHash('sha256').update(data).digest('hex');
try {
  assert.match(expectedDigest||'',/^[a-f0-9]{64}$/,'Expected reviewed manifest digest is required');
  const bytes=readFileSync(manifestPath);assert.equal(hash(bytes),expectedDigest,'MANIFEST_MISMATCH');
  const m=JSON.parse(bytes);assert.equal(m.schema_version,1);assert.match(m.artifact_sha256,/^[a-f0-9]{64}$/);
  assert.equal(hash(readFileSync(m.artifact_path)),m.artifact_sha256,'ARTIFACT_MISMATCH');
  assert.equal(process.version,m.node,'NODE_MISMATCH');
  const root=realpathSync(m.app_root);
  const required=['dist/index.js','dist/app.js','dist/koreanLawClient.js','dist/auth.js','scripts/hermes-mcp-bridge.mjs','npm-shrinkwrap.json','package.json','rules/manifest.json'];
  for(const name of required)assert.ok(m.files[name],'MISSING_RUNTIME_FILE');
  for(const [name,digest]of Object.entries(m.files)){
    assert.ok(!name.includes('\\')&&!name.split('/').includes('..')&&!name.startsWith('/'));
    const file=resolve(root,name);assert.ok(realpathSync(file).startsWith(root+sep),'PATH_ESCAPE');assert.ok(lstatSync(file).isFile(),'NOT_A_REGULAR_FILE');
    assert.equal(hash(readFileSync(file)),digest,'RUNTIME_FILE_MISMATCH: '+name);
  }
  const lock=JSON.parse(readFileSync(join(root,'npm-shrinkwrap.json')));
  for(const name of Object.keys(lock.packages[''].dependencies)){
    const meta=JSON.parse(readFileSync(join(root,'node_modules',name,'package.json')));
    assert.equal(meta.version,lock.packages['node_modules/'+name].version,'DEPENDENCY_MISMATCH: '+name);
  }
  assert.ok(Array.isArray(m.config_files)&&m.config_files.length>=4,'CONFIGURATION_EVIDENCE_MISSING');
  for(const file of m.config_files)assert.equal(hash(readFileSync(file.path)),file.sha256,'CONFIGURATION_MISMATCH: '+file.label);
  console.log(JSON.stringify({status:'staged_identity_verified',manifest_sha256:expectedDigest,artifact_sha256:m.artifact_sha256,deployment_authorized:false}));
}catch(error){console.error(JSON.stringify({status:'hold',reason:String(error.message).slice(0,500)}));process.exitCode=1;}
