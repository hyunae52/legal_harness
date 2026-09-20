// Operator entry point: uses the same gate exercised by PH-06-B failure tests.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { performRollout } from '../scripts/rollout-gate.mjs';
const exec = promisify(execFile);
const [key, host, packet, report] = process.argv.slice(2);
if (!key || host !== 'cta@136.67.179.84' || !/^\/home\/cta\/research-[0-9a-f]{12}-packet\.json$/.test(packet) || !report) throw Error('Invalid fixed-target rollout arguments');
const events = [];
async function phase(name) {
  try {
    const result = await exec('ssh', ['-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-i', key,
      host, 'python3', '/home/cta/research-rollout.py', name, packet], { timeout: 180000, windowsHide: true, maxBuffer: 1024 * 1024 });
    const event = JSON.parse(result.stdout.trim()); events.push(event); console.log(JSON.stringify(event));
  } catch {
    events.push({ phase: name, status: 'failed' }); console.log(JSON.stringify(events.at(-1))); throw Error('Rollout phase failed');
  }
}
const result = await performRollout({ fence: () => phase('fence'), drain: () => phase('drain'), activate: () => phase('activate'),
  verifyCandidate: () => phase('verify-candidate'), rollback: () => phase('rollback'), verifyPrevious: () => phase('verify-previous'), resume: () => phase('resume') });
await writeFile(report, JSON.stringify({ ...result, events }, null, 2));
console.log(JSON.stringify(result));
if (result.status !== 'candidate_active_verified') process.exitCode = 1;
