// Runs in a credential-free validation job, never on the production service.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import semver from 'semver';

export const updateFiles = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json',
  'upstreams/korean-taxlaw-mcp.json', 'upstreams/korean-taxlaw-mcp.tools.json', 'upstreams/document-parser.json'];
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
export function npm(args, options = {}) {
  // Invoke the CLI through Node on Windows; .cmd files cannot be execFile'd.
  const cli = process.env.npm_execpath || (process.platform === 'win32'
    ? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js') : null);
  return execFileSync(cli ? process.execPath : 'npm', cli ? [cli, ...args] : args,
    { encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, ...options });
}
export function parserPin(metadata, current) {
  assert.equal(metadata.name, 'kordoc'); assert.ok(stableVersion.test(metadata.version));
  assert.equal(metadata.repository?.url, 'git+https://github.com/chrisryugj/kordoc.git');
  assert.equal(metadata.license, 'MIT'); assert.match(metadata.gitHead, /^[a-f0-9]{40}$/);
  assert.match(metadata.dist?.integrity ?? '', /^sha512-[A-Za-z0-9+/]+=*$/);
  assert.ok(typeof metadata.dependencies?.zod === 'string' && metadata.dependencies.zod.length < 200
    && semver.validRange(metadata.dependencies.zod), 'INVALID_KORDOC_ZOD_RANGE');
  const pin = { ...current, version: metadata.version, commit: metadata.gitHead, integrity: metadata.dist.integrity };
  assert.ok(compareVersion(pin.version, current.version) >= 0, 'PARSER_DOWNGRADE');
  if (pin.version === current.version) assert.deepEqual(pin, current, 'PARSER_VERSION_REUSED');
  return pin;
}
export function documentCandidates(metadata, pkg, current, versions) {
  const pin = parserPin(metadata, current);
  assert.equal(current.version, pkg.dependencies.kordoc, 'PARSER_PIN_DRIFT');
  assert.ok(Array.isArray(versions) && versions.every(v => typeof v === 'string'), 'INVALID_ZOD_VERSIONS');
  // Use the highest stable release *inside kordoc's declared range*, even when
  // npm's latest tag points at a different major. No overrides or forced peers.
  const zod = semver.maxSatisfying(versions.filter(v => stableVersion.test(v)), metadata.dependencies.zod);
  assert.ok(zod, 'NO_COMPATIBLE_ZOD');
  assert.ok(compareVersion(zod, pkg.dependencies.zod) >= 0, 'ZOD_DOWNGRADE_REQUIRED');
  return { kordoc: pin.version, zod, parser: pin,
    changed: pin.version !== pkg.dependencies.kordoc || zod !== pkg.dependencies.zod };
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
  const currentParser = JSON.parse(await readFile('upstreams/document-parser.json', 'utf8'));
  let kordoc = await json('https://registry.npmjs.org/kordoc/latest');
  assert.equal(kordoc.name, 'kordoc'); assert.ok(stableVersion.test(kordoc.version));
  if (compareVersion(kordoc.version, pkg.dependencies.kordoc) < 0)
    kordoc = await json('https://registry.npmjs.org/kordoc/' + pkg.dependencies.kordoc);
  const documents = documentCandidates(kordoc, pkg, currentParser,
    JSON.parse(npm(['view', 'zod', 'versions', '--json', '--registry=https://registry.npmjs.org/'])));
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
  if (law || documents.changed) {
    npm(['install', 'korean-law-mcp@' + (law || pkg.dependencies['korean-law-mcp']),
      'kordoc@' + documents.kordoc, 'zod@' + documents.zod,
      '--save-exact', '--package-lock-only', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund'], { stdio: 'inherit' });
    await copyFile('npm-shrinkwrap.json', 'package-lock.json');
  }
  if (documents.kordoc !== currentParser.version)
    await writeFile('upstreams/document-parser.json', JSON.stringify(documents.parser, null, 2) + '\n');
  const plan = { schema_version: 2, base: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    changed: Boolean(law || tax || documents.changed), tax_changed: Boolean(tax),
    law: law || pkg.dependencies['korean-law-mcp'], tax: tax || currentTax,
    kordoc: documents.kordoc, zod: documents.zod };
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
