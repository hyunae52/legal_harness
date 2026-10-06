import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendUpstreamEmail, validateEmailConfigFilename } from './upstream-email-report.mjs';
import { fetchMetadata } from './check-upstreams.mjs';

const checkScript = fileURLToPath(new URL('./check-upstreams.mjs', import.meta.url));

function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) values[args[index]] = args[index + 1];
  if (args.length !== 6 || !values['--service'] || !isAbsolute(values['--state-dir'])
      || !isAbsolute(values['--email-config'])) throw new Error('WATCH_USAGE_INVALID');
  validateEmailConfigFilename(values['--email-config']);
  return { service: values['--service'], stateDirectory: values['--state-dir'], configPath: values['--email-config'] };
}

function resultLine(output) {
  return output.trim().split(/\r?\n/).reverse().find(Boolean);
}

export async function readAutomation(request = fetchMetadata, now = Date.now()) {
  return Promise.all([
    ['세법 포크 동기화','hyunae52/korean-taxlaw-mcp','upstream-sync.yml'],
    ['MCP 자동 갱신','hyunae52/legal_harness','provider-update.yml'],
    ['운영 배포','hyunae52/legal_harness','deploy.yml'],
  ].map(async ([name, repository, workflow]) => {
    try {
      const data = await request(`https://api.github.com/repos/${repository}/actions/workflows/${workflow}/runs?branch=main&per_page=1`);
      const run = data.workflow_runs?.[0];
      if (!run) return {name,status:'실행 기록 없음',failed:true};
      const stale = workflow !== 'deploy.yml' && now - Date.parse(run.created_at) > 36*3600*1000;
      return {name,status:stale ? '36시간 이상 실행 없음' : (run.conclusion || run.status),
        failed: stale || (run.status === 'completed' && run.conclusion !== 'success'),
        url:`https://github.com/${repository}/actions/runs/${Number(run.id)}`};
    } catch { return {name,status:'조회 실패',failed:true}; }
  }));
}

export async function runWatch(options, { spawn = spawnSync, send = sendUpstreamEmail, automation = readAutomation } = {}) {
  const checkedAt = new Date().toISOString();
  const child = spawn(process.execPath, [checkScript, '--service', options.service, '--state-dir', options.stateDirectory], {
    encoding: 'utf8', timeout: 125000, maxBuffer: 1024 * 1024,
  });
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  let execution = { checked_at: checkedAt, status: 'check_failed' };
  let report = null;
  try {
    const parsed = JSON.parse(resultLine(child.stdout || ''));
    if (['current', 'updates_available', 'partial'].includes(parsed.status) && parsed.checked_at) {
      execution = { checked_at: parsed.checked_at, status: parsed.status };
      report = JSON.parse(await readFile(join(options.stateDirectory, 'latest.json'), 'utf8'));
    }
  } catch { /* Keep the public-safe check_failed result. */ }
  const updates = await automation();
  if (updates?.length) {
    report = {...(report || {}), automation:updates};
    if (execution.status !== 'check_failed' && updates.some(item => item.failed)) execution.status = 'partial';
  }
  const emailResult = await send({ configPath: options.configPath, stateDirectory: options.stateDirectory, report, execution });
  console.log(JSON.stringify({ checked_at: execution.checked_at, email: emailResult.sent ? 'sent' : emailResult.reason,
    check_status: execution.status }));
  return { exitCode: child.status === 0 && execution.status !== 'check_failed' ? 0 : 1, execution, emailResult };
}

async function main(args) {
  const result = await runWatch(parseArgs(args));
  process.exitCode = result.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => {
    console.error(JSON.stringify({ checked_at: new Date().toISOString(), status: 'notification_failed' }));
    process.exitCode = 1;
  });
}
