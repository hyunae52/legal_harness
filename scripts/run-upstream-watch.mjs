import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendUpstreamEmail, validateEmailConfigFilename } from './upstream-email-report.mjs';

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

export async function runWatch(options, { spawn = spawnSync, send = sendUpstreamEmail } = {}) {
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
