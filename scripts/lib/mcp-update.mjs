import { access, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
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
export async function updateMcp({ activeFile, bootstrap = false }, operations) {
  const log = operations.log ?? (() => {});
  const active = resolve(activeFile);
  await mkdir(dirname(active), { recursive: true, mode: 0o700 });
  const state = await realpath(dirname(active));
  const releases = join(state, 'releases');
  const pendingFile = join(state, 'pending.json');
  const previousFile = join(state, 'previous.json');
  await mkdir(releases, { recursive: true, mode: 0o700 });

  const pending = await readJson(pendingFile);
  if (pending) {
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
  const version = await operations.latestVersion();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a stable numeric upstream release version');
  if (current && !newerVersion(version, current.version)) {
    const previousJson = await readJson(previousFile);
    await prune(releases, [current, previousJson ? McpReleaseSchema.parse(previousJson) : undefined]);
    log(`No newer MCP release; keeping ${current.version}`);
    return { status: 'unchanged', version: current.version };
  }

  const directory = await mkdtemp(join(releases, `release-${version}-`));
  let activationPending = false;
  let activated = false;
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

    if (current) {
      // Durable rollback information precedes the atomic active-file switch.
      await writeJson(pendingFile, { previous: current, candidate });
      activationPending = true;
    }
    await writeJson(active, candidate);
    if (current) {
      await operations.restart();
      await operations.checkHealth(candidate.version);
      await writeJson(previousFile, current);
      await rm(pendingFile);
    }
    activationPending = false;
    activated = true;
    // Keep only the selected and immediately previous releases on the free tier.
    await prune(releases, [candidate, current]);
    log(`MCP ${version} ${bootstrap ? 'initialized; start Express next' : 'activated'}`);
    return { status: bootstrap ? 'initialized' : 'updated', version };
  } catch (error) {
    if (activationPending) {
      log('Activation failed; restoring the previous release');
      try {
        await writeJson(active, current);
        await operations.restart();
        await operations.checkHealth(current.version);
        await rm(pendingFile);
        activationPending = false;
      } catch (rollbackError) {
        // Keep the journal/artifacts so the next run can retry recovery.
        throw new AggregateError([error, rollbackError], 'MCP update and rollback failed; pending recovery retained');
      }
    }
    if (!activated && !activationPending) await removeRelease(releases, directory);
    throw error;
  }
}
