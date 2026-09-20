import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprintDependencies } from '../deploy/installed-dependencies.mjs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

test('installed closure detects unchanged-version code replacement and extra transitive files', () => {
  const root = mkdtempSync(join(tmpdir(), 'legal-dependencies-'));
  try {
    mkdirSync(join(root, 'upstream'));
    writeFileSync(join(root, 'upstream/package.json'), '{"version":"4.13.0"}');
    writeFileSync(join(root, 'upstream/index.js'), 'export const trusted = true;');
    const approved = fingerprintDependencies(root);
    assert.deepEqual(fingerprintDependencies(root), approved);
    writeFileSync(join(root, 'upstream/index.js'), 'export const trusted = false;');
    assert.notEqual(fingerprintDependencies(root).sha256, approved.sha256);
    writeFileSync(join(root, 'upstream/index.js'), 'export const trusted = true;');
    assert.deepEqual(fingerprintDependencies(root), approved);
    writeFileSync(join(root, 'upstream/injected.js'), 'export const extra = true;');
    assert.notEqual(fingerprintDependencies(root).sha256, approved.sha256);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('installed closure binds internal bin links and rejects escape from the closure', () => {
  const root = mkdtempSync(join(tmpdir(), 'legal-links-'));
  try {
    mkdirSync(join(root, 'node_modules')); mkdirSync(join(root, 'node_modules/.bin'));
    mkdirSync(join(root, 'node_modules/upstream'));
    writeFileSync(join(root, 'node_modules/upstream/index.js'), 'export {};');
    // Directory junctions work on Windows without symlink privilege; their
    // target is still required to remain inside the installed dependency root.
    symlinkSync(join(root, 'node_modules/upstream'), join(root, 'node_modules/.bin/internal'), 'junction');
    assert.equal(fingerprintDependencies(join(root, 'node_modules')).links, 1);
    mkdirSync(join(root, 'outside'));
    symlinkSync(join(root, 'outside'), join(root, 'node_modules/.bin/escape'), 'junction');
    assert.throws(() => fingerprintDependencies(join(root, 'node_modules')), /DEPENDENCY_LINK_ESCAPE/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('full candidate verifier rejects same-version upstream and transitive mutations, missing files and relinked bins', () => {
  const root = mkdtempSync(join(tmpdir(), 'legal-full-identity-'));
  const hash = data => createHash('sha256').update(data).digest('hex');
  try {
    const files = {};
    const write = (path, content) => {
      const full = join(root, path); mkdirSync(join(full, '..'), {recursive:true}); writeFileSync(full, content); return full;
    };
    const required = ['dist/index.js','dist/app.js','dist/koreanLawClient.js','dist/auth.js','scripts/hermes-mcp-bridge.mjs','rules/manifest.json'];
    for (const name of required) { write(name, 'synthetic'); files[name]=hash('synthetic'); }
    const pkg = JSON.stringify({name:'fixture',version:'2.2.0'});
    write('package.json',pkg); files['package.json']=hash(pkg);
    const lock=JSON.stringify({packages:{'':{dependencies:{upstream:'4.13.0'}},'node_modules/upstream':{version:'4.13.0'}}});
    write('npm-shrinkwrap.json',lock); files['npm-shrinkwrap.json']=hash(lock);
    write('node_modules/upstream/package.json','{"version":"4.13.0"}');
    const upstream=write('node_modules/upstream/index.js','trusted upstream');
    const transitive=write('node_modules/upstream/node_modules/transitive/index.js','trusted transitive');
    write('node_modules/alternative/index.js','alternative');
    mkdirSync(join(root,'node_modules/.bin'));
    const link=join(root,'node_modules/.bin/tool');
    symlinkSync(join(root,'node_modules/upstream'),link,'junction');
    const configs=Array.from({length:4},(_,i)=>({path:write('config-'+i,'fixture'),sha256:hash('fixture'),label:'fixture'}));
    const artifact=write('artifact.tgz','fixture');
    const manifest={schema_version:1,artifact_path:artifact,artifact_sha256:hash('fixture'),node:process.version,app_root:root,files,config_files:configs,installed_dependencies:fingerprintDependencies(join(root,'node_modules'))};
    const text=JSON.stringify(manifest),path=write('manifest.json',text);
    const verify=()=>spawnSync(process.execPath,['deploy/verify-a-candidate.mjs',path,hash(text)],{encoding:'utf8'});
    assert.equal(verify().status,0);
    const rejected=()=>{const r=verify();assert.equal(r.status,1,r.stdout+r.stderr);assert.match(r.stderr,/INSTALLED_DEPENDENCIES_MISMATCH/);};
    writeFileSync(upstream,'changed without version change');rejected();writeFileSync(upstream,'trusted upstream');
    writeFileSync(transitive,'changed transitive');rejected();writeFileSync(transitive,'trusted transitive');
    rmSync(transitive);rejected();writeFileSync(transitive,'trusted transitive');
    rmSync(link);symlinkSync(join(root,'node_modules/alternative'),link,'junction');rejected();
  } finally { rmSync(root,{recursive:true,force:true}); }
});
