// Trusted publication job: never imports or executes the candidate's code.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { updateFiles, stableVersion, taxVersion, compareVersion } from './prepare-provider-update.mjs';
const repository = 'hyunae52/legal_harness';
export async function dispatchReviewedDeployment(api, head, {sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)), now=Date.now, budgetMs=19*60*1000}={}) {
  assert.match(head,/^[a-f0-9]{40}$/);
  const path='actions/workflows/review.yml/runs?event=workflow_dispatch&head_sha='+head+'&per_page=30';
  const before=new Set((await api(path)).workflow_runs.map(run=>run.id));
  await api('actions/workflows/review.yml/dispatches','POST',{ref:'main'});
  const deadline=now()+budgetMs;
  while(now()<deadline) {
    const runs=(await api(path)).workflow_runs.filter(run=>!before.has(run.id) && run.head_sha===head
      && run.head_branch==='main' && run.event==='workflow_dispatch' && run.path==='.github/workflows/review.yml');
    const source=runs.sort((a,b)=>b.id-a.id)[0];
    if(source?.status==='completed') {
      assert.equal(source.conclusion,'success','MAIN_REVIEW_FAILED');
      assert.equal((await api('git/ref/heads/main')).object.sha,head,'MAIN_MOVED_BEFORE_DEPLOY');
      // Token-triggered Review did not emit a downstream workflow_run in live
      // verification. Explicit dispatch also binds the exact successful attempt.
      await api('actions/workflows/deploy.yml/dispatches','POST',{ref:'main',inputs:{review_run_id:String(source.id),review_attempt:String(source.run_attempt)}});
      return {review_run_id:source.id,review_attempt:source.run_attempt,deploy_dispatched:true};
    }
    await sleep(15000);
  }
  throw Error('MAIN_REVIEW_TIMEOUT');
}
export function validateBundle(bundle, original) {
  assert.equal(bundle.schema_version, 1); assert.match(bundle.base, /^[a-f0-9]{40}$/);
  const entries = Object.entries(bundle.files); assert.ok(entries.length > 0 && entries.length <= 5);
  assert.ok(entries.every(([name, text]) => updateFiles.includes(name) && typeof text === 'string'));
  const get = name => JSON.parse(bundle.files[name] ?? original[name]);
  const oldPkg = JSON.parse(original['package.json']), pkg = get('package.json');
  assert.ok(stableVersion.test(bundle.law));
  assert.ok(compareVersion(bundle.law, oldPkg.dependencies['korean-law-mcp']) >= 0);
  const expected = structuredClone(oldPkg); expected.dependencies['korean-law-mcp'] = bundle.law;
  assert.deepEqual(pkg, expected, 'ONLY_LAW_PACKAGE_VERSION_MAY_CHANGE');
  assert.equal(get('package-lock.json').lockfileVersion, 3);
  assert.deepEqual(get('package-lock.json'), get('npm-shrinkwrap.json'), 'LOCKFILES_DIFFER');
  const lock = get('npm-shrinkwrap.json');
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
  assert.deepEqual(lock.packages[''].devDependencies, pkg.devDependencies);
  assert.equal(lock.packages['node_modules/korean-law-mcp'].version, bundle.law);
  for (const [name, item] of Object.entries(lock.packages)) {
    if (!name) continue;
    assert.ok(name.startsWith('node_modules/') && !name.split('/').includes('..'));
    assert.match(item.resolved ?? '', /^https:\/\/registry\.npmjs\.org\/[A-Za-z0-9_@./%+\-]+$/);
    assert.match(item.integrity ?? '', /^sha512-[A-Za-z0-9+/]+=*$/);
    assert.ok(!item.link, 'LINK_DEPENDENCY_FORBIDDEN');
  }
  const pin = get('upstreams/korean-taxlaw-mcp.json'), oldPin = JSON.parse(original['upstreams/korean-taxlaw-mcp.json']);
  assert.deepEqual(pin, bundle.tax); assert.equal(pin.repository, 'hyunae52/korean-taxlaw-mcp');
  assert.equal(pin.license, 'MIT'); assert.ok(taxVersion.test(pin.version));
  assert.match(pin.commit, /^[a-f0-9]{40}$/); assert.match(pin.archive_sha256, /^[a-f0-9]{64}$/);
  assert.equal(pin.archive_url, `https://codeload.github.com/${pin.repository}/zip/${pin.commit}`);
  assert.ok(compareVersion(pin.version, oldPin.version) >= 0);
  if (pin.version === oldPin.version) assert.deepEqual(pin, oldPin, 'RELEASE_VERSION_REUSED');
  const schema = get('upstreams/korean-taxlaw-mcp.tools.json'), oldSchema = JSON.parse(original['upstreams/korean-taxlaw-mcp.tools.json']);
  assert.ok(Array.isArray(schema) && schema.length < 100);
  assert.equal(new Set(schema.map(t => t.name)).size, schema.length);
  for (const tool of oldSchema) assert.ok(schema.some(t => t.name === tool.name), 'TOOL_REMOVED');
  assert.equal(bundle.changed, true); return entries;
}
async function main() {
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, { method,
      headers: { Authorization: 'Bearer ' + process.env.GH_TOKEN, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30000) });
    assert.ok(response.ok, `GITHUB_${response.status}`); return response.status === 204 ? null : response.json();
  };
  const base = process.env.TESTED_BASE; assert.match(base, /^[a-f0-9]{40}$/);
  assert.equal((await api('git/ref/heads/main')).object.sha, base, 'MAIN_MOVED_RETRY_NEXT_RUN');
  const text = await readFile(process.argv[2], 'utf8'); assert.ok(Buffer.byteLength(text) < 2 * 1024 * 1024);
  const bundle = JSON.parse(text); assert.equal(bundle.base, base);
  let reviewedHead=base;
  if (bundle.changed) {
    const original = Object.fromEntries(await Promise.all(updateFiles.map(async name => [name, await readFile(name, 'utf8')])));
    const entries = validateBundle(bundle, original);
    const tree = [];
    for (const [path, content] of entries) tree.push({ path, mode: '100644', type: 'blob', sha: (await api('git/blobs', 'POST', { content, encoding: 'utf-8' })).sha });
    const parent = await api('git/commits/' + base);
    const nextTree = await api('git/trees', 'POST', { base_tree: parent.tree.sha, tree });
    const commit = await api('git/commits', 'POST', { message: `chore: update MCP providers (law ${bundle.law}, tax ${bundle.tax.version})`, tree: nextTree.sha, parents: [base] });
    const branch = `automation/providers-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
    await api('git/refs', 'POST', { ref: 'refs/heads/' + branch, sha: commit.sha });
    await api('pulls', 'POST', { base: 'main', head: branch, title: `chore: update MCP providers to ${bundle.law} / ${bundle.tax.version}`,
      body: `Automated provider-only update. Full review, package smoke and runtime audit passed on these exact file contents.\n\nValidation: https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}\n\nProduction retrieval checks run before activation; a failure retains/restores the previous service.` });
    // Atomic non-force FF: concurrent main changes cannot be silently overwritten.
    await api('git/refs/heads/main', 'PATCH', { sha: commit.sha, force: false });
    reviewedHead=commit.sha;
    console.log(JSON.stringify({ published: commit.sha, law: bundle.law, tax: bundle.tax.version }));
  }
  // GITHUB_TOKEN pushes don't trigger Review. Also retry a previous failed deployment.
  console.log(JSON.stringify(await dispatchReviewedDeployment(api,reviewedHead)));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
