import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { refreshRuntimeTransport, updateFiles } from '../scripts/prepare-provider-update.mjs';
import { validateBundle } from '../scripts/publish-provider-update.mjs';

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'runtime-transport-update-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const original = Object.fromEntries(await Promise.all(updateFiles.map(async name => [name, await readFile(name, 'utf8')])));
  for (const name of ['package.json', 'npm-shrinkwrap.json', 'package-lock.json'])
    await writeFile(join(cwd, name), original[name]);
  return { cwd, original };
}

test('transport-only refresh is a publishable change with matching locks and unchanged provider pins', async t => {
  const { cwd, original } = await fixture(t);
  const lock = JSON.parse(original['npm-shrinkwrap.json']);
  const adapter = lock.packages['node_modules/@hono/node-server'];
  const parts = adapter.version.split('.').map(Number); parts[2]++;
  adapter.version = parts.join('.');
  adapter.resolved = 'https://registry.npmjs.org/@hono/node-server/-/node-server-' + adapter.version + '.tgz';
  adapter.integrity = 'sha512-YWJjZA==';
  const changed = await refreshRuntimeTransport({ cwd, runNpm: (args, options) => {
    assert.deepEqual(args.slice(0, 2), ['update', '@hono/node-server']);
    assert.ok(args.includes('--ignore-scripts') && args.includes('--package-lock-only'));
    assert.ok(!args.includes('--force')); assert.equal(options.cwd, cwd);
    writeFileSync(join(cwd, 'npm-shrinkwrap.json'), JSON.stringify(lock, null, 2) + '\n');
  } });
  assert.equal(changed, true);
  assert.equal(await readFile(join(cwd, 'package.json'), 'utf8'), original['package.json']);
  const files = Object.fromEntries(await Promise.all(['npm-shrinkwrap.json', 'package-lock.json'].map(async name =>
    [name, await readFile(join(cwd, name), 'utf8')])));
  assert.equal(files['npm-shrinkwrap.json'], files['package-lock.json']);
  const pkg = JSON.parse(original['package.json']);
  assert.equal(validateBundle({ schema_version: 2, base: 'a'.repeat(40), changed,
    law: pkg.dependencies['korean-law-mcp'], kordoc: pkg.dependencies.kordoc, zod: pkg.dependencies.zod,
    tax: JSON.parse(original['upstreams/korean-taxlaw-mcp.json']), files }, original).length, 2);
});

test('unchanged transport does not manufacture an update', async t => {
  const { cwd, original } = await fixture(t);
  assert.equal(await refreshRuntimeTransport({ cwd, runNpm: () => {} }), false);
  assert.equal(await readFile(join(cwd, 'npm-shrinkwrap.json'), 'utf8'), original['npm-shrinkwrap.json']);
});

test('transport refresh rejects manifest edits and failed dependency resolution', async t => {
  const { cwd } = await fixture(t);
  await assert.rejects(refreshRuntimeTransport({ cwd, runNpm: () => {
    writeFileSync(join(cwd, 'package.json'), '{"dependencies":{"attacker":"1.0.0"}}');
  } }), /RUNTIME_REFRESH_CHANGED_MANIFEST/);
  await assert.rejects(refreshRuntimeTransport({ cwd, runNpm: () => { throw Error('registry unavailable'); } }), /registry unavailable/);
});
