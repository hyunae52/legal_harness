import dotenv from 'dotenv';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { updateMcp } from './lib/mcp-update.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: join(appDir, '.env') });
const log = message => console.log(`[${new Date().toISOString()}] ${message}`);
const exec = promisify(execFile);

async function runNode(args, { cwd = appDir, env = process.env, timeout = 300_000, capture = false } = {}) {
  let result;
  try {
    result = await exec(process.execPath, args, { cwd, env, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    if (error.stdout) process.stderr.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    throw error;
  }
  if (!capture) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  return result.stdout.trim();
}

try {
  if (process.env.LEGAL_HARNESS_UPDATE_LOCKED !== '1') {
    throw new Error('Run bash scripts/update-korean-law.sh so concurrent updates are protected by flock');
  }
  if (!process.env.npm_execpath) throw new Error('The update wrapper must invoke npm run mcp:update');
  if (!process.env.KOREAN_LAW_MCP_RELEASE_FILE) throw new Error('Set KOREAN_LAW_MCP_RELEASE_FILE in .env before deployment');
  if (process.env.KOREAN_LAW_MCP_COMMAND || process.env.KOREAN_LAW_MCP_ARGS || process.env.KOREAN_LAW_MCP_CWD) {
    throw new Error('Remove manual MCP command/args/cwd settings when enabling release-file updates');
  }
  const args = process.argv.slice(2);
  if (args.length>2 || (args.length===1 && args[0]!=='--bootstrap') || (args.length===2 && (args[0]!=='--activate' || !/^[a-f0-9]{64}$/.test(args[1])))) throw new Error('Use no arguments (candidate check), --bootstrap, or --activate APPROVED_SHA256');
  const npm = process.env.npm_execpath;
  const healthUrl = process.env.KOREAN_LAW_UPDATE_HEALTH_URL || `http://127.0.0.1:${process.env.PORT || 3000}/health`;
  const result=await updateMcp({ activeFile: resolve(appDir, process.env.KOREAN_LAW_MCP_RELEASE_FILE), bootstrap: args.includes('--bootstrap'),activateHash:args[0]==='--activate'?args[1]:undefined }, {
    log,
    latestVersion: async () => JSON.parse(await runNode([npm, 'view', 'korean-law-mcp@latest', 'version', '--json'], { capture: true, timeout: 30_000 })),
    install: async (directory, version) => {
      await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'legal-harness-mcp-runtime', private: true,
        dependencies: { 'korean-law-mcp': version } }, null, 2));
      await runNode([npm, 'install', '--ignore-scripts', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund'], { cwd: directory });
    },
    verify: async candidateFile => {
      await runNode([npm, 'run', 'review']);
      log('Checking the candidate MCP process and required tool schemas');
      await runNode([join(appDir, 'scripts', 'mcp-smoke.mjs')], { env: { ...process.env, KOREAN_LAW_MCP_RELEASE_FILE: candidateFile }, timeout: 30_000 });
    },
    restart: async () => {
      await runNode([join(appDir, 'node_modules', 'pm2', 'bin', 'pm2'), 'restart',
        join(appDir, 'ecosystem.config.cjs'), '--only', 'k-tax-agent', '--update-env'], { timeout: 45_000 });
    },
    checkHealth: async version => {
      for (let attempt = 0; attempt < 20; attempt++) {
        let selected = false;
        try {
          const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
          const health = await response.json();
          selected = response.ok && health.status === 'ok' && health.mcp_release === version;
        } catch { /* Startup may briefly refuse connections. */ }
        if (selected) {
          // Recheck the active executable after switching, using the same file
          // selected by Express. This still makes no legal API requests.
          await runNode([join(appDir, 'scripts', 'mcp-smoke.mjs')], { timeout: 30_000 });
          return;
        }
        await delay(500);
      }
      throw new Error(`Express did not report the selected MCP release ${version}`);
    },
  });
  log(JSON.stringify(result));
} catch (error) {
  console.error(`[${new Date().toISOString()}] MCP update failed: ${error.message}`);
  process.exitCode = 1;
}
