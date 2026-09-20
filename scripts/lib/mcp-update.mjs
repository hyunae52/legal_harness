import { access, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { McpReleaseSchema } from '../../dist/koreanLawClient.js';

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function writeJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

function releaseDirectory(release) {
  return resolve(dirname(release.entrypoint), '../../..');
}

async function removeRelease(releases, directory) {
  // Delete only a direct child we allocated under the canonical releases root.
  const root = await realpath(releases);
  const target = await realpath(directory);
  if (dirname(target) !== root || !target.slice(root.length + 1).startsWith('release-')) {
    throw new Error('Refusing to remove a directory outside the MCP release store');
  }
  await rm(target, { recursive: true, force: true });
}

async function prune(releases, keep) {
  const protectedPaths = new Set(keep.filter(Boolean).map(releaseDirectory));
  for (const entry of await readdir(releases, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith('release-')) continue;
    const directory = resolve(releases, entry.name);
    if (!protectedPaths.has(directory)) await removeRelease(releases, directory);
  }
}

function newerVersion(candidate, current) {
  const a = candidate.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}

/** Called under the deployment wrapper's OS flock. Operations are injectable for offline tests. */
export async function updateMcp({ activeFile, bootstrap = false, activateHash }, operations) {
  if (bootstrap && activateHash) throw new Error('Bootstrap and activation are separate operator actions');
  const log = operations.log ?? (() => {});
  const active = resolve(activeFile);
  await mkdir(dirname(active), { recursive: true, mode: 0o700 });
  const state = await realpath(dirname(active));
  const releases = join(state, 'releases');
  const pendingFile = join(state, 'pending.json');
  const previousFile = join(state, 'previous.json');
  const stagedFile = join(state, 'candidate.json');
  await mkdir(releases, { recursive: true, mode: 0o700 });

  const pending = await readJson(pendingFile);
  if (pending) {
    if (!activateHash) throw new Error('Interrupted activation requires explicit operator recovery; cron cannot restart production');
    // A previous run stopped between activation and health verification.
    const previous = McpReleaseSchema.parse(pending.previous);
    log(`Recovering interrupted update to ${previous.version}`);
    await writeJson(active, previous);
    await operations.restart();
    await operations.checkHealth(previous.version);
    await rm(pendingFile);
  }

  const currentJson = await readJson(active);
  const current = currentJson ? McpReleaseSchema.parse(currentJson) : undefined;
  if (bootstrap && current) throw new Error('MCP is already initialized; run without --bootstrap');
  if (!bootstrap && !current) throw new Error('Initialize the release store with --bootstrap before enabling cron');
  if (activateHash && !/^[a-f0-9]{64}$/.test(activateHash)) throw new Error('Expected the approved candidate SHA-256');
  if (activateHash) {
    const staged = await readJson(stagedFile);
    if (!staged || staged.fingerprint !== activateHash) throw new Error('Approved candidate is missing or changed');
    const candidate = McpReleaseSchema.parse(staged.release);
    const directory = releaseDirectory(candidate);
    const fingerprint = await releaseFingerprint(candidate);
    if (fingerprint !== activateHash) throw new Error('Candidate content changed after review');
    await operations.verify(join(directory,'release.json'));
    await writeJson(pendingFile,{previous:current,candidate});
    try {
      await writeJson(active,candidate);
      await operations.restart(); await operations.checkHealth(candidate.version);
      await writeJson(previousFile,current); await rm(pendingFile); await rm(stagedFile);
      await prune(releases,[candidate,current]);
      return {status:'updated',version:candidate.version};
    } catch (error) {
      try {
        await writeJson(active,current); await operations.restart(); await operations.checkHealth(current.version); await rm(pendingFile);
      } catch (rollbackError) { throw new AggregateError([error,rollbackError],'MCP update and rollback failed; pending recovery retained'); }
      throw error;
    }
  }
  const version = await operations.latestVersion();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a stable numeric upstream release version');
  if (current && !newerVersion(version, current.version)) {
    const previousJson = await readJson(previousFile);
    const staged = await readJson(stagedFile);
    await prune(releases, [current, previousJson ? McpReleaseSchema.parse(previousJson) : undefined, staged?.release]);
    log(`No newer MCP release; keeping ${current.version}`);
    return { status: 'unchanged', version: current.version };
  }
  const staged=await readJson(stagedFile);
  if(staged?.release?.version===version && staged.fingerprint===await releaseFingerprint(McpReleaseSchema.parse(staged.release))) {
    return {status:'candidate',version,fingerprint:staged.fingerprint};
  }

  const directory = await mkdtemp(join(releases, `release-${version}-`));
  let retained = false;
  try {
    log(`Installing MCP ${version} in a separate release directory`);
    await operations.install(directory, version);
    const packageRoot = join(directory, 'node_modules', 'korean-law-mcp');
    const metadata = await readJson(join(packageRoot, 'package.json'));
    if (metadata?.name !== 'korean-law-mcp' || metadata.version !== version) {
      throw new Error('Installed package identity/version did not match the requested release');
    }
    const candidate = McpReleaseSchema.parse({ version, entrypoint: join(packageRoot, 'build', 'index.js') });
    await access(candidate.entrypoint);
    const candidateFile = join(directory, 'release.json');
    await writeJson(candidateFile, candidate);
    await operations.verify(candidateFile);

    if (!bootstrap) {
      const fingerprint=await releaseFingerprint(candidate);
      await writeJson(stagedFile,{release:candidate,fingerprint,checked_at:new Date().toISOString()});
      retained = true;
      const previous=await readJson(previousFile);
      await prune(releases,[current,candidate,previous?McpReleaseSchema.parse(previous):undefined]);
      log(`MCP ${version} is a tested candidate; production remains ${current.version}`);
      return {status:'candidate',version,fingerprint};
    }

    await writeJson(active, candidate);
    retained = true;
    await prune(releases, [candidate, current]);
    log(`MCP ${version} initialized; start Express next`);
    return { status: 'initialized', version };
  } catch (error) {
    if (!retained) await removeRelease(releases, directory);
    throw error;
  }
}

// The lock captures exact transitive versions and registry integrity; hash the
// installed executable too. A human batch records this immutable fingerprint.
async function releaseFingerprint(release) {
  const root=releaseDirectory(release);
  const hash=createHash('sha256').update(JSON.stringify(release)).update(await readFile(join(root,'package-lock.json')));
  async function walk(directory,relative='') {
    for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'))) {
      const name=relative+'/'+entry.name,path=join(directory,entry.name);
      if(entry.isDirectory()) await walk(path,name);
      else if(entry.isSymbolicLink()) hash.update(JSON.stringify([name,'symlink',await readlink(path)]));
      else if(entry.isFile()) {const bytes=await readFile(path);hash.update(JSON.stringify([name,bytes.length])).update(bytes);}
      else throw new Error('Unexpected file type in candidate');
    }
  }
  await walk(join(root,'node_modules'));
  return hash.digest('hex');
}
