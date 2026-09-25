// Metadata-only daily check. Never installs code, changes pins, or restarts services.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositories = {
  law: 'chrisryugj/korean-law-mcp',
  taxlaw: 'zisu17/korean-taxlaw-mcp',
};
const trustedTaxlawRepositories = new Set([repositories.taxlaw, 'hyunae52/korean-taxlaw-mcp']);
const sha = /^[a-f0-9]{40}$/;
const version = /^\d+\.\d+\.\d+$/;
const json = async path => JSON.parse(await readFile(path, 'utf8'));

export async function readInstalled(appDirectory, lawReleaseFile, taxlawReleaseFile) {
  const law = await json(lawReleaseFile);
  const taxlaw = await json(taxlawReleaseFile);
  const pin = await json(join(appDirectory, 'upstreams/korean-taxlaw-mcp.json'));
  if (!version.test(law.version) || !isAbsolute(law.entrypoint)
      || !version.test(taxlaw.version) || !sha.test(taxlaw.commit)
      || !isAbsolute(taxlaw.python) || !isAbsolute(taxlaw.cwd)
      || !trustedTaxlawRepositories.has(pin.repository)
      || pin.commit !== taxlaw.commit || pin.version !== taxlaw.version) {
    throw new Error('INSTALLED_MANIFEST_INVALID');
  }
  const metadata = await json(join(dirname(law.entrypoint), '..', 'package.json'));
  if (metadata.name !== 'korean-law-mcp' || metadata.version !== law.version) throw new Error('INSTALLED_PACKAGE_MISMATCH');
  return { law: { version: law.version },
    taxlaw: { version: taxlaw.version, commit: taxlaw.commit, repository: pin.repository } };
}

export async function readRunningService(service) {
  if (!/^[a-zA-Z0-9_-]+\.service$/.test(service)) throw new Error('INVALID_SERVICE');
  const show = property => execFileSync('/usr/bin/systemctl', ['show', service, '-p', property, '--value'],
    { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const pid = show('MainPID');
  const app = show('WorkingDirectory');
  if (!/^[1-9]\d*$/.test(pid) || !isAbsolute(app)) throw new Error('SERVICE_NOT_RUNNING');
  // Read only release locations; do not forward the server's credentials to fetch or children.
  const env = Object.fromEntries((await readFile(`/proc/${pid}/environ`, 'utf8')).split('\0')
    .filter(item => item.includes('=')).map(item => [item.slice(0, item.indexOf('=')), item.slice(item.indexOf('=') + 1)]));
  if (!env.KOREAN_LAW_MCP_RELEASE_FILE) throw new Error('LAW_RELEASE_NOT_CONFIGURED');
  const installed = await readInstalled(app, resolve(app, env.KOREAN_LAW_MCP_RELEASE_FILE),
    resolve(app, env.TAXLAW_MCP_RELEASE_FILE || '.runtime/taxlaw/active.json'));
  if (show('MainPID') !== pid || show('WorkingDirectory') !== app) throw new Error('SERVICE_CHANGED_DURING_CHECK');
  return installed;
}

export async function fetchMetadata(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'TaxLab-upstream-watch/1' },
    redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP_${response.status}`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 512 * 1024) throw new Error('RESPONSE_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const packageValue = data => {
  if (data?.name !== 'korean-law-mcp' || !version.test(data.version)) throw new Error('INVALID_METADATA');
  return { version: data.version, commit: sha.test(data.gitHead) ? data.gitHead : null };
};
const commitValue = data => {
  if (!Array.isArray(data) || !sha.test(data[0]?.sha)) throw new Error('INVALID_METADATA');
  return { commit: data[0].sha };
};
const comparisonValue = data => {
  if (!['ahead', 'behind', 'identical', 'diverged'].includes(data?.status)
      || !Number.isInteger(data.ahead_by) || !Number.isInteger(data.behind_by)) throw new Error('INVALID_METADATA');
  return { status: data.status, ahead_by: data.ahead_by, behind_by: data.behind_by };
};
const errorCode = error => /^(HTTP_\d{3}|RESPONSE_TOO_LARGE|INVALID_METADATA)$/.test(error?.message)
  ? error.message : error?.name === 'TimeoutError' ? 'TIMEOUT' : 'FETCH_FAILED';
const compareVersions = (a, b) => {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
};

export async function checkUpstreams(installed, previous = {}, { request = fetchMetadata, now = () => new Date().toISOString() } = {}) {
  const checkedAt = now();
  const definitions = {
    law_package: [`https://registry.npmjs.org/korean-law-mcp/latest`, packageValue],
    law_installed: [`https://registry.npmjs.org/korean-law-mcp/${installed.law.version}`, packageValue],
    law_repository: [`https://api.github.com/repos/${repositories.law}/commits?per_page=1`, commitValue],
    taxlaw_repository: [`https://api.github.com/repos/${repositories.taxlaw}/commits?per_page=1`, commitValue],
    taxlaw_relation: [`https://api.github.com/repos/${repositories.taxlaw}/compare/${installed.taxlaw.commit}...HEAD`, comparisonValue],
  };
  const sources = Object.fromEntries(await Promise.all(Object.entries(definitions).map(async ([name, [url, parse]]) => {
    const prior = previous.sources?.[name]?.url === url ? previous.sources[name] : undefined;
    // An immutable published version's commit is cached; latest and both repository heads are checked every run.
    if (name === 'law_installed' && prior?.value?.version === installed.law.version && sha.test(prior?.value?.commit)) {
      return [name, { ...prior, status: 'cached', error: undefined }];
    }
    try {
      const value = parse(await request(url));
      if (name === 'law_installed' && value.version !== installed.law.version) throw new Error('INVALID_METADATA');
      return [name, { url, status: 'ok', checked_at: checkedAt, last_success_at: checkedAt, value }];
    } catch (error) {
      return [name, { url, status: 'unavailable', checked_at: checkedAt, last_success_at: prior?.last_success_at ?? null,
        value: prior?.value ?? null, error: errorCode(error) }];
    }
  })));
  const candidates = [];
  const add = (provider, kind, source, value) => candidates.push({
    provider, kind, ...value, validation: 'pending', activation: 'human_review_required',
    source_status: source.status, last_confirmed_at: source.last_success_at,
  });
  const latest = sources.law_package;
  if (latest.value && compareVersions(latest.value.version, installed.law.version) > 0) {
    add('korean-law-mcp', 'npm_release', latest, latest.value);
  }
  const head = sources.law_repository, baseline = sources.law_installed.value?.commit;
  if (head.value && head.value.commit !== baseline) {
    add('korean-law-mcp', baseline ? 'repository_change' : 'repository_baseline_unknown', head, head.value);
  }
  const tax = sources.taxlaw_repository, relation = sources.taxlaw_relation;
  const taxStatus = tax.status === 'unavailable' || relation.status === 'unavailable' ? 'unavailable' : 'ok';
  const taxConfirmed = [tax.last_success_at, relation.last_success_at].filter(Boolean).sort()[0] ?? null;
  const taxSource = { status: taxStatus, last_success_at: taxConfirmed };
  if (tax.value && relation.value?.status === 'ahead') {
    add('korean-taxlaw-mcp', 'repository_change', taxSource, tax.value);
  } else if (tax.value && relation.value?.status === 'diverged') {
    add('korean-taxlaw-mcp', 'repository_diverged', taxSource, tax.value);
  }
  const failures = Object.values(sources).filter(source => source.status === 'unavailable').length;
  return { schema_version: 1, checked_at: checkedAt, status: failures ? 'partial' : candidates.length ? 'updates_available' : 'current',
    installed, repositories, sources, candidates, policy: { metadata_only: true, installs: false, production_restarts: false } };
}

export async function saveReport(stateDirectory, report) {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const file = join(stateDirectory, 'latest.json'), temporary = join(stateDirectory, `.check-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

async function main(args) {
  if (args.length !== 4 || args[0] !== '--service' || args[2] !== '--state-dir' || !isAbsolute(args[3])) {
    throw new Error('USAGE: --service legal-harness-a.service --state-dir /absolute/path');
  }
  const installed = await readRunningService(args[1]);
  let previous;
  try { previous = await json(join(args[3], 'latest.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('STATE_UNREADABLE'); }
  const report = await checkUpstreams(installed, previous);
  await saveReport(args[3], report);
  console.log(JSON.stringify({ checked_at: report.checked_at, status: report.status, installed,
    candidates: report.candidates, source_status: Object.fromEntries(Object.entries(report.sources).map(([key, value]) => [key, value.status])) }));
  if (report.status === 'partial') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => {
    // No upstream text, process environments, tokens, or raw exception output in cron logs.
    console.error(JSON.stringify({ checked_at: new Date().toISOString(), status: 'check_failed', production_changed: false }));
    process.exitCode = 1;
  });
}
