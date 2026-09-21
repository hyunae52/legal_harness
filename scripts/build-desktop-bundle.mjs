// Build a self-contained MCPB from the reviewed bridge and its installed SDK closure.
// No install commands, secrets, server dependencies or upstream law process ship here.
import assert from 'node:assert/strict';
import { readFile, readdir, lstat, realpath, mkdir, writeFile, access } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modules = await realpath(join(root, 'node_modules'));
const zip = new JSZip(), packages = new Map();
const stamp = new Date('2020-01-01T00:00:00Z');
const add = (name, bytes) => {
  assert.ok(!/(^|\/)(?:\.env(?:\.|$)|\.npmrc$|\.git(?:\/|$))/.test(name), 'Private configuration must not enter the bundle');
  zip.file(name, bytes, { date: stamp, createFolders: false, unixPermissions: 0o100644 });
};
async function resolvePackage(name, from) {
  let directory = from;
  while (directory.startsWith(root)) {
    const candidate = join(directory, 'node_modules', name);
    try { await access(join(candidate, 'package.json')); return candidate; } catch {}
    if (directory === root) break;
    directory = dirname(directory);
  }
  throw new Error('Missing installed dependency: ' + name);
}
async function copyFiles(directory, packageRoot) {
  for (const name of (await readdir(directory)).sort()) {
    if (name === 'node_modules') continue; // handled according to each dependency's actual resolution
    const path = join(directory, name), stat = await lstat(path);
    assert.ok(!stat.isSymbolicLink(), 'Unexpected symlink in a packaged dependency');
    if (stat.isDirectory()) await copyFiles(path, packageRoot);
    else if (stat.isFile()) add('node_modules/' + relative(modules, path).split(sep).join('/'), await readFile(path));
  }
}
async function collect(packageRoot) {
  const directory = await realpath(packageRoot);
  assert.ok(directory.startsWith(modules + sep), 'Dependency path escapes the installed closure');
  if (packages.has(directory)) return;
  const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  packages.set(directory, { name: metadata.name, version: metadata.version });
  await copyFiles(directory, directory);
  for (const name of Object.keys({ ...metadata.dependencies, ...metadata.peerDependencies }).sort()) {
    let child;
    try { child = await resolvePackage(name, directory); }
    catch (error) { if (metadata.peerDependenciesMeta?.[name]?.optional || metadata.optionalDependencies?.[name]) continue; throw error; }
    await collect(child);
  }
}
await collect(await resolvePackage('@modelcontextprotocol/sdk', root));
const manifest = JSON.parse(await readFile(join(root, 'desktop/manifest.json'), 'utf8'));
assert.equal(manifest.user_config, undefined);
assert.deepEqual(manifest.server.mcp_config.env, { TAXLAB_SERVER_URL: 'https://law.taxlab.kr' });
add('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
add('server/bridge.mjs', (await readFile(join(root, 'scripts/hermes-mcp-bridge.mjs'), 'utf8')).replaceAll('\r\n', '\n'));
add('package.json', JSON.stringify({ name: 'taxlab-law-desktop', version: manifest.version, private: true, type: 'module' }) + '\n');
add('LICENSE', (await readFile(join(root, 'LICENSE'), 'utf8')).replaceAll('\r\n', '\n'));
add('README.md', '# TaxLab 법령\n\nClaude PC 앱의 설정 → 확장 → 고급 설정 → Install Extension에서 이 .mcpb 파일을 선택하세요. 접속키나 별도 로그인이 필요 없습니다.\n\n연결·데이터 전송 안내: https://law.taxlab.kr/\n');
const bundle = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'UNIX' });
const out = join(root, 'dist/downloads');
await mkdir(out, { recursive: true });
await writeFile(join(out, 'taxlab-law.mcpb'), bundle);
const record = { version: manifest.version, sha256: createHash('sha256').update(bundle).digest('hex'), bytes: bundle.length,
  files: Object.keys(zip.files).length, dependencies: [...packages.values()].sort((a, b) => a.name.localeCompare(b.name)) };
await writeFile(join(out, 'taxlab-law.mcpb.json'), JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify({ desktop_bundle: 'dist/downloads/taxlab-law.mcpb', bytes: record.bytes, sha256: record.sha256, packages: packages.size }));
