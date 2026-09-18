import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateMcp } from '../scripts/lib/mcp-update.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'legal-harness-update-'));
  t.after(async () => {
    const target = await realpath(root);
    assert.equal(dirname(target), await realpath(tmpdir()));
    assert.ok(basename(target).startsWith('legal-harness-update-'));
    await rm(target, { recursive: true, force: true });
  });
  const activeFile = join(root, 'active.json');
  const f = { root, activeFile, latest: '4.13.0', events: [], failInstall: false, failVerify: false, failHealth: new Set() };
  f.active = async () => JSON.parse(await readFile(activeFile, 'utf8'));
  f.directories = async () => (await readdir(join(root, 'releases'))).sort();
  f.operations = {
    latestVersion: async () => f.latest,
    install: async (directory, version) => {
      f.events.push('install:' + version);
      const packageRoot = join(directory, 'node_modules', 'korean-law-mcp');
      await mkdir(join(packageRoot, 'build'), { recursive: true });
      if (f.failInstall) throw new Error('Fixture install failure');
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'korean-law-mcp', version: f.installedVersion ?? version }));
      await writeFile(join(packageRoot, 'build', 'index.js'), '// fixture: never executed');
    },
    verify: async file => {
      const release = JSON.parse(await readFile(file, 'utf8'));
      f.events.push('verify:' + release.version);
      if (f.expectedOldVersion) assert.equal((await f.active()).version, f.expectedOldVersion, 'active release changed before verification');
      if (f.failVerify) throw new Error('Fixture verification failure');
    },
    restart: async () => { f.events.push('restart:' + (await f.active()).version); },
    checkHealth: async version => {
      f.events.push('health:' + version);
      if (f.failHealth.has(version)) throw new Error('Fixture health failure');
    },
  };
  f.run = options => updateMcp({ activeFile, ...options }, f.operations);
  f.initialize = async () => {
    await f.run({ bootstrap: true });
    f.events.length = 0;
    f.latest = '4.14.0';
  };
  return f;
}

test('deployment bootstrap validates a separate upstream installation without restarting Express', async t => {
  const f = await fixture(t);
  const result = await f.run({ bootstrap: true });
  assert.equal(result.status, 'initialized');
  assert.equal((await f.active()).version, '4.13.0');
  assert.deepEqual(f.events, ['install:4.13.0', 'verify:4.13.0']);
});

test('cron skips installation and restart when the registry has no newer version', async t => {
  const f = await fixture(t);
  await f.initialize();
  for (const version of ['4.13.0', '4.12.9']) {
    f.latest = version;
    assert.equal((await f.run()).status, 'unchanged');
  }
  assert.deepEqual(f.events, []);
});

test('update validates before atomic activation, checks the restarted version and keeps rollback files', async t => {
  const f = await fixture(t);
  await f.initialize();
  const old = await f.active();
  f.expectedOldVersion = old.version;
  assert.equal((await f.run()).status, 'updated');
  assert.equal((await f.active()).version, '4.14.0');
  assert.deepEqual(f.events, ['install:4.14.0', 'verify:4.14.0', 'restart:4.14.0', 'health:4.14.0']);
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'previous.json'), 'utf8')), old);
  assert.equal((await f.directories()).length, 2);
});

for (const failure of ['failInstall', 'failVerify']) {
  test(`${failure} preserves the active release and removes the incomplete installation`, async t => {
    const f = await fixture(t);
    await f.initialize();
    const old = await f.active();
    f[failure] = true;
    await assert.rejects(f.run());
    assert.deepEqual(await f.active(), old);
    assert.ok(f.events.every(event => !event.startsWith('restart:')));
    assert.equal((await f.directories()).length, 1);
  });
}

test('unhealthy activation restores and verifies the previous release', async t => {
  const f = await fixture(t);
  await f.initialize();
  f.failHealth.add('4.14.0');
  await assert.rejects(f.run(), /health failure/);
  assert.equal((await f.active()).version, '4.13.0');
  assert.deepEqual(f.events.slice(-4), ['restart:4.14.0', 'health:4.14.0', 'restart:4.13.0', 'health:4.13.0']);
  assert.equal((await f.directories()).length, 1);
  await assert.rejects(readFile(join(f.root, 'pending.json')), { code: 'ENOENT' });
});

test('failed rollback retains a recovery journal and the next cron run repairs the interrupted update', async t => {
  const f = await fixture(t);
  await f.initialize();
  f.failHealth.add('4.14.0').add('4.13.0');
  await assert.rejects(f.run(), /update and rollback failed/);
  const journal = JSON.parse(await readFile(join(f.root, 'pending.json'), 'utf8'));
  assert.equal(journal.previous.version, '4.13.0');
  f.failHealth.clear();
  f.latest = '4.13.0';
  f.events.length = 0;
  assert.equal((await f.run()).status, 'unchanged');
  assert.deepEqual(f.events, ['restart:4.13.0', 'health:4.13.0']);
  assert.equal((await f.active()).version, '4.13.0');
  await assert.rejects(readFile(join(f.root, 'pending.json')), { code: 'ENOENT' });
});

test('successive updates retain only the active and previous release, leaving unrelated files untouched', async t => {
  const f = await fixture(t);
  await f.initialize();
  const unrelated = join(f.root, 'releases', 'operator-notes');
  await mkdir(unrelated);
  await writeFile(join(unrelated, 'keep.txt'), 'keep');
  await f.run();
  f.latest = '4.15.0';
  await f.run();
  const directories = await f.directories();
  assert.equal(directories.filter(name => name.startsWith('release-')).length, 2);
  assert.equal(await readFile(join(unrelated, 'keep.txt'), 'utf8'), 'keep');
  assert.equal((await f.active()).version, '4.15.0');
});

test('unexpected installed version fails verification without switching the active process', async t => {
  const f = await fixture(t);
  await f.initialize();
  f.installedVersion = '4.99.0';
  await assert.rejects(f.run(), /identity\/version/);
  assert.equal((await f.active()).version, '4.13.0');
  assert.deepEqual(f.events, ['install:4.14.0']);
});

test('cron requires bootstrap, rejects unsupported versions and cannot overwrite an initialized store with bootstrap', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run(), /--bootstrap/);
  f.latest = '4.14.0-beta.1';
  await assert.rejects(f.run({ bootstrap: true }), /stable numeric/);
  f.latest = '4.13.0';
  await f.run({ bootstrap: true });
  await assert.rejects(f.run({ bootstrap: true }), /already initialized/);
});
