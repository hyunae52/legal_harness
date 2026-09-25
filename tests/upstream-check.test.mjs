import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { checkUpstreams, fetchMetadata, readInstalled, saveReport } from '../scripts/check-upstreams.mjs';

const installed = { law: { version: '4.13.0' },
  taxlaw: { version: '2.0.0', commit: 'a'.repeat(40), repository: 'hyunae52/korean-taxlaw-mcp' } };
const stamp = '2026-09-22T00:00:00.000Z';
function requests({ latest = '4.13.0', law = 'b'.repeat(40), tax = 'a'.repeat(40), fork = tax,
  upstreamRelation, forkRelation, syncRelation = tax === fork ? 'identical' : 'ahead',
  forkFiles = ['src/korean_taxlaw_mcp/server.py'], failure } = {}) {
  return async url => {
    if (failure?.(url)) throw new Error('HTTP_404');
    if (url.includes('/latest')) return { name: 'korean-law-mcp', version: latest, gitHead: law };
    if (url.includes('/4.13.0')) return { name: 'korean-law-mcp', version: '4.13.0', gitHead: 'b'.repeat(40) };
    if (url.includes('/compare/')) {
      const isFork = url.includes('/hyunae52/');
      const isHead = url.endsWith('...HEAD');
      const status = isFork && !isHead ? syncRelation
        : isFork ? (forkRelation ?? (fork === installed.taxlaw.commit ? 'identical' : 'ahead'))
          : (upstreamRelation ?? (tax === installed.taxlaw.commit ? 'identical' : 'ahead'));
      return { status, ahead_by: status === 'ahead' ? 1 : 0, behind_by: status === 'behind' ? 1 : 0,
        files: isFork && isHead ? forkFiles.map(filename => ({ filename })) : [] };
    }
    return [{ sha: url.includes('zisu17') ? tax : url.includes('hyunae52') ? fork : law }];
  };
}
const check = (request, previous) => checkUpstreams(installed, previous, { request, now: () => stamp });

test('daily upstream check detects npm and both repo changes without authorizing activation', async () => {
  const result = await check(requests({ latest: '4.13.1', law: 'c'.repeat(40),
    tax: 'd'.repeat(40), fork: 'd'.repeat(40), syncRelation: 'identical' }));
  assert.equal(result.status, 'updates_available');
  assert.equal(result.candidates.length, 3);
  assert.ok(result.candidates.every(c => c.validation === 'pending' && c.activation === 'human_review_required'));
  assert.deepEqual(result.policy, { metadata_only: true, installs: false, production_restarts: false });
});

test('private repos preserve last known candidates and do not mask fresh npm changes', async () => {
  const previous = await check(requests({ latest: '4.13.1', law: 'c'.repeat(40),
    tax: 'd'.repeat(40), fork: 'd'.repeat(40), syncRelation: 'identical' }));
  const result = await check(requests({ latest: '4.13.2', failure: url => url.includes('api.github.com') }), previous);
  assert.equal(result.status, 'partial');
  assert.equal(result.candidates.find(c => c.kind === 'npm_release').version, '4.13.2');
  const tax = result.candidates.find(c => c.provider === 'korean-taxlaw-mcp');
  assert.equal(tax.commit, 'd'.repeat(40));
  assert.equal(tax.source_status, 'unavailable');
  assert.equal(tax.last_confirmed_at, stamp);
  assert.deepEqual(result.installed, installed);
});

test('registry and repo outage on first run is unavailable, never falsely current', async () => {
  const result = await check(async () => { throw new Error('upstream response with secrets'); });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.candidates, []);
  assert.ok(Object.entries(result.sources).every(([name, source]) => source.value === null
    && source.error === (name === 'taxlaw_fork_sync' ? 'DEPENDENCY_UNAVAILABLE' : 'FETCH_FAILED')));
  assert.doesNotMatch(JSON.stringify(result), /with secrets/);
});

test('unchanged or older registry version does not propose a downgrade; repo-only edits remain visible', async () => {
  assert.equal((await check(requests())).status, 'current');
  const older = await check(requests({ latest: '4.12.9' }));
  assert.deepEqual(older.candidates, []);
  const changed = await check(requests({ law: 'e'.repeat(40) }));
  assert.deepEqual(changed.candidates.map(c => c.kind), ['repository_change']);
});

test('invalid metadata cannot become a candidate and HTTP bodies are size bounded', async () => {
  const result = await check(async url => url.includes('registry') ? { name: 'other', version: '4.14.0' } : [{ sha: 'not-a-sha' }]);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.candidates, []);
  await assert.rejects(fetchMetadata('https://example.test', async () => new Response('x'.repeat(512 * 1024 + 1))), /RESPONSE_TOO_LARGE/);
  await assert.rejects(fetchMetadata('https://example.test', async () => new Response('private', { status: 404 })), /HTTP_404/);
});

test('a newly deployed installed version cannot reuse the prior installed commit baseline', async () => {
  const previous = await check(requests());
  const next = { ...installed, law: { version: '4.13.1' } };
  const result = await checkUpstreams(next, previous, { request: async () => { throw new Error('HTTP_404'); } });
  assert.equal(result.sources.law_installed.value, null);
  assert.equal(result.sources.law_installed.status, 'unavailable');
});

test('trusted fork pins stay monitored against canonical history without proposing a rollback', async () => {
  const fork = { ...installed,
    taxlaw: { ...installed.taxlaw, commit: 'f'.repeat(40), repository: 'hyunae52/korean-taxlaw-mcp' } };
  const pending = await checkUpstreams(fork, {}, { request: requests({ tax: 'a'.repeat(40), fork: 'f'.repeat(40),
    upstreamRelation: 'behind', forkRelation: 'identical', syncRelation: 'ahead' }), now: () => stamp });
  assert.equal(pending.status, 'current');
  assert.deepEqual(pending.candidates.filter(c => c.provider === 'korean-taxlaw-mcp'), []);
  assert.equal(pending.sources.taxlaw_relation.value.status, 'behind');
  const merged = await checkUpstreams(fork, {}, { request: requests({ tax: 'a'.repeat(40), fork: 'd'.repeat(40),
    upstreamRelation: 'behind', forkRelation: 'ahead', syncRelation: 'ahead' }), now: () => stamp });
  const candidate = merged.candidates.find(c => c.provider === 'korean-taxlaw-mcp');
  assert.equal(candidate.kind, 'repository_change');
  assert.equal(candidate.commit, 'd'.repeat(40));
});

test('canonical changes require fork review and never become direct production candidates', async () => {
  const result = await check(requests({ tax: 'd'.repeat(40), fork: installed.taxlaw.commit,
    upstreamRelation: 'ahead', forkRelation: 'identical', syncRelation: 'behind' }));
  const candidate = result.candidates.find(c => c.kind === 'upstream_sync_required');
  assert.equal(candidate.commit, 'd'.repeat(40));
  assert.equal(candidate.repository, 'zisu17/korean-taxlaw-mcp');
  assert.equal(candidate.activation, 'fork_review_required');
  assert.equal(result.candidates.some(c => c.kind === 'repository_change'), false);
});

test('fork workflow and documentation commits are not production runtime candidates', async () => {
  const result = await check(requests({ fork: 'd'.repeat(40), forkRelation: 'ahead', syncRelation: 'ahead',
    forkFiles: ['.github/workflows/upstream-sync.yml', 'README.md', 'docs/FORK_MAINTENANCE.md'] }));
  assert.deepEqual(result.candidates.filter(c => c.provider === 'korean-taxlaw-mcp'), []);
  assert.equal(result.sources.taxlaw_fork_relation.value.status, 'ahead');
  assert.deepEqual(result.sources.taxlaw_fork_relation.value.changed_files,
    ['.github/workflows/upstream-sync.yml', 'README.md', 'docs/FORK_MAINTENANCE.md']);
});

test('report persistence leaves runtime manifests intact; changed pinned provider refuses checks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'taxlab-upstream-watch-'));
  t.after(async () => {
    const target = await realpath(root);
    assert.equal(dirname(target), await realpath(tmpdir()));
    assert.ok(basename(target).startsWith('taxlab-upstream-watch-'));
    await rm(target, { recursive: true, force: true });
  });
  await mkdir(join(root, 'upstreams'));
  await mkdir(join(root, 'law', 'build'), { recursive: true });
  await writeFile(join(root, 'law', 'package.json'), JSON.stringify({ name: 'korean-law-mcp', version: '4.13.0' }));
  const lawFile = join(root, 'law.json'), taxFile = join(root, 'tax.json'), pinFile = join(root, 'upstreams/korean-taxlaw-mcp.json');
  const lawText = JSON.stringify({ version: '4.13.0', entrypoint: join(root, 'law/build/index.js') });
  const taxText = JSON.stringify({ ...installed.taxlaw, python: join(root, 'python'), cwd: root });
  await writeFile(lawFile, lawText); await writeFile(taxFile, taxText);
  const canonical = { ...installed,
    taxlaw: { ...installed.taxlaw, repository: 'zisu17/korean-taxlaw-mcp' } };
  await writeFile(pinFile, JSON.stringify(canonical.taxlaw));
  assert.deepEqual(await readInstalled(root, lawFile, taxFile), canonical);
  await writeFile(pinFile, JSON.stringify({ ...installed.taxlaw, repository: 'hyunae52/korean-taxlaw-mcp' }));
  assert.deepEqual((await readInstalled(root, lawFile, taxFile)).taxlaw.repository, 'hyunae52/korean-taxlaw-mcp');
  const state = join(root, 'state');
  await saveReport(state, await check(requests()));
  await saveReport(state, await check(requests({ failure: () => true })));
  assert.equal(JSON.parse(await readFile(join(state, 'latest.json'), 'utf8')).status, 'partial');
  assert.equal(await readFile(lawFile, 'utf8'), lawText);
  assert.equal(await readFile(taxFile, 'utf8'), taxText);
  await writeFile(pinFile, JSON.stringify({ ...installed.taxlaw, repository: 'untrusted/example', commit: 'f'.repeat(40) }));
  await assert.rejects(readInstalled(root, lawFile, taxFile), /INSTALLED_MANIFEST_INVALID/);
});
