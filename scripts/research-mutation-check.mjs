// Three deliberate guard removals in isolated copies prove the assertions can fail.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile), hash = data => createHash('sha256').update(data).digest('hex');
await mkdir(join(root, '.runtime'), { recursive: true });
const work = await mkdtemp(join(root, '.runtime/research-mutations-'));
const cases = [
  { name: 'quote', file: 'researchReview.js', from: 'passage.text.includes(citation.quote)', to: 'true', pattern: 'RH-03: empty' },
  { name: 'actor', file: 'research.js', from: 'session.actor !== owner(actor)', to: 'false', pattern: 'RH-02:' },
  { name: 'required_fact', file: 'researchReview.js', from: 'for (const factId of issue.required_fact_ids)', to: 'for (const factId of [])', pattern: 'RH-05/06:' },
];
const report = [];
for (const mutation of cases) {
  const target = join(work, mutation.name); await mkdir(target);
  for (const name of ['dist', 'rules', 'upstreams']) await cp(join(root, name), join(target, name), { recursive: true });
  await mkdir(join(target, 'tests'));
  await cp(join(root, 'tests/research-harness.test.mjs'), join(target, 'tests/research-harness.test.mjs'));
  await writeFile(join(target, 'package.json'), '{"type":"module"}');
  await symlink(join(root, 'node_modules'), join(target, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const original = await readFile(join(root, 'dist', mutation.file), 'utf8');
  assert.equal(original.split(mutation.from).length, 2, 'Mutation target must be unique');
  await writeFile(join(target, 'dist', mutation.file), original.replace(mutation.from, mutation.to));
  let code = 0, output = '';
  try { output = (await exec(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=10000', '--test-name-pattern=' + mutation.pattern, 'tests/research-harness.test.mjs'],
    { cwd: target, timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024 })).stdout; }
  catch (error) { code = error.code; output = String(error.stdout) + String(error.stderr); }
  assert.equal(code, 1, 'Guard removal must fail an assertion');
  assert.match(output, /AssertionError/); assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|SyntaxError/);
  assert.equal(hash(await readFile(join(root, 'dist', mutation.file))), hash(original), 'Working build was modified');
  await writeFile(join(target, 'result.log'), output);
  report.push({ guard: mutation.name, outcome: 'killed_by_assertion', original_sha256: hash(original) });
}
await writeFile(join(work, 'evidence.json'), JSON.stringify({ isolated_copies_only: true, mutations: report }, null, 2));
console.log(JSON.stringify({ status: 'pass', evidence: join(work, 'evidence.json'), mutations_killed: report.length }));
