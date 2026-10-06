// Runs in a credential-free validation job, never on the production service.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const updateFiles = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json',
  'upstreams/korean-taxlaw-mcp.json', 'upstreams/korean-taxlaw-mcp.tools.json'];
export const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const taxVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.post([1-9]\d*))?$/;
export function compareVersion(a, b) {
  const parse = value => { assert.ok(taxVersion.test(value), 'INVALID_VERSION'); return value.replace('.post', '.').split('.').map(Number); };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 4; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  return 0;
}
export async function json(url) {
  const response = await fetch(url, { redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': 'TaxLab-provider-update' }, signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200, 'METADATA_UNAVAILABLE');
  const text = await response.text(); assert.ok(Buffer.byteLength(text) < 1024 * 1024, 'METADATA_TOO_LARGE');
  return JSON.parse(text);
}
export function lawCandidate(pkg, installed) {
  assert.equal(pkg.name, 'korean-law-mcp'); assert.ok(stableVersion.test(pkg.version));
  return compareVersion(pkg.version, installed) > 0 ? pkg.version : null;
}
export function taxCandidate(release, ref, metadata, installed) {
  assert.equal(release.draft, false); assert.equal(release.prerelease, false);
  assert.ok(taxVersion.test(metadata.fork.version));
  assert.equal(release.tag_name, 'taxlab-v' + metadata.fork.version);
  assert.equal(ref.ref, 'refs/tags/' + release.tag_name); assert.equal(ref.object.type, 'commit');
  assert.match(ref.object.sha, /^[a-f0-9]{40}$/);
  assert.equal(metadata.fork.repository, 'hyunae52/korean-taxlaw-mcp');
  assert.equal(metadata.upstream.repository, 'zisu17/korean-taxlaw-mcp');
  const newer = compareVersion(metadata.fork.version, installed.version);
  if (newer === 0) { assert.equal(ref.object.sha, installed.commit, 'EXISTING_RELEASE_TAG_MOVED'); return null; }
  if (newer < 0) return null;
  return { repository: metadata.fork.repository, version: metadata.fork.version, commit: ref.object.sha,
    archive_url: `https://codeload.github.com/hyunae52/korean-taxlaw-mcp/zip/${ref.object.sha}`, license: 'MIT' };
}
async function prepare() {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const currentTax = JSON.parse(await readFile('upstreams/korean-taxlaw-mcp.json', 'utf8'));
  const law = lawCandidate(await json('https://registry.npmjs.org/korean-law-mcp/latest'), pkg.dependencies['korean-law-mcp']);
  const release = await json('https://api.github.com/repos/hyunae52/korean-taxlaw-mcp/releases/latest');
  assert.match(release.tag_name, /^taxlab-v\d+\.\d+\.\d+(?:\.post[1-9]\d*)?$/);
  const ref = await json('https://api.github.com/repos/hyunae52/korean-taxlaw-mcp/git/ref/tags/' + release.tag_name);
  assert.match(ref.object.sha, /^[a-f0-9]{40}$/);
  // The first recorded deployment predates release metadata. The unchanged
  // immutable installed commit needs no new metadata or installation.
  assert.equal(release.draft, false); assert.equal(release.prerelease, false);
  assert.equal(ref.object.type, 'commit');
  let tax = null;
  if (release.tag_name === 'taxlab-v' + currentTax.version) {
    assert.equal(ref.object.sha, currentTax.commit, 'EXISTING_RELEASE_TAG_MOVED');
  } else {
    const file = await json('https://api.github.com/repos/hyunae52/korean-taxlaw-mcp/contents/.github/taxlab-release.json?ref=' + ref.object.sha);
    const metadata = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
    tax = taxCandidate(release, ref, metadata, currentTax);
  }
  if (tax) {
    const response = await fetch(tax.archive_url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
    assert.equal(response.status, 200);
    const payload = Buffer.from(await response.arrayBuffer()); assert.ok(payload.length <= 20 * 1024 * 1024);
    tax = { ...tax, archive_sha256: createHash('sha256').update(payload).digest('hex') };
    await writeFile('upstreams/korean-taxlaw-mcp.json', JSON.stringify(tax, null, 2) + '\n');
  }
  if (law) {
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', 'korean-law-mcp@' + law, '--save-exact', '--package-lock-only', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund'], { stdio: 'inherit', timeout: 120000 });
    await copyFile('npm-shrinkwrap.json', 'package-lock.json');
  }
  const plan = { schema_version: 1, base: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    changed: Boolean(law || tax), tax_changed: Boolean(tax), law: law || pkg.dependencies['korean-law-mcp'], tax: tax || currentTax };
  await mkdir('.runtime', { recursive: true }); await writeFile('.runtime/provider-update.json', JSON.stringify(plan, null, 2) + '\n');
  if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `changed=${plan.changed}\ntax_changed=${plan.tax_changed}\n`, { flag: 'a' });
  console.log(JSON.stringify(plan));
}
async function bundle() {
  const plan = JSON.parse(await readFile('.runtime/provider-update.json', 'utf8'));
  const names = execFileSync('git', ['diff', '--name-only', 'HEAD'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  assert.ok(names.every(name => updateFiles.includes(name)), 'UNEXPECTED_AUTOMATED_CHANGE');
  const files = Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(name, 'utf8')])));
  const output = JSON.stringify({ ...plan, files }); assert.ok(Buffer.byteLength(output) < 2 * 1024 * 1024);
  await writeFile('.runtime/provider-update-bundle.json', output + '\n');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] === 'prepare') await prepare();
  else if (process.argv[2] === 'bundle') await bundle();
  else throw Error('Use prepare or bundle');
}
