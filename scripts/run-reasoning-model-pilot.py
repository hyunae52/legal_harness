"""Frozen paired MCP trials. Retains all failures; semantic scoring is a separate blind review."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path
import random
import shutil
import subprocess
import time
from pilot_readiness import wait_for_ready

parser = argparse.ArgumentParser()
parser.add_argument('--codex', required=True)
parser.add_argument('--baseline', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--cases', default='')
parser.add_argument('--repetitions', type=int, default=3, choices=[1, 2, 3])
parser.add_argument('--arms', default='baseline,candidate')
parser.add_argument('--workers', type=int, default=2, choices=[1, 2, 3])
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
out = Path(args.output).resolve()
out.mkdir(parents=True, exist_ok=False)
protocol_file = root / 'docs/evidence/reasoning-quality-protocol-20261007.json'
oracle_file = root / 'docs/evidence/reasoning-quality-oracle-20261007.json'
protocol = json.loads(protocol_file.read_text(encoding='utf-8'))
hash_file = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
shutil.copyfile(protocol_file, out / 'protocol.json')
shutil.copyfile(oracle_file, out / 'oracle.json')
shutil.copyfile(root / 'scripts/reasoning-model-pilot.mjs', out / 'pilot.mjs')
frozen = {}
for arm in args.arms.split(','):
    if arm not in ['baseline', 'candidate']:
        raise SystemExit('Invalid arm')
    source = Path(args.baseline).resolve() if arm == 'baseline' else root
    target = out / ('runtime-' + arm)
    files = []
    for name in ['src', 'dist', 'rules']:
        for p in (source / name).rglob('*'):
            if p.is_file() and p.suffix in ['.ts', '.js', '.json']:
                q = target / p.relative_to(source)
                q.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(p, q)
                files.append({'path': p.relative_to(source).as_posix(), 'sha256': hash_file(q)})
    for name in ['package.json', 'package-lock.json']:
        shutil.copyfile(source / name, target / name)
    frozen[arm] = {'source_tree_sha256': hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest(), 'files': files}
cases = [s for s in protocol['scenarios'] if not args.cases or s['id'] in args.cases.split(',')]
jobs = [(s['id'], arm, n) for s in cases for arm in args.arms.split(',') for n in range(1, args.repetitions + 1)]
random.Random(20261007).shuffle(jobs)
manifest = {'protocol_sha256': hash_file(out / 'protocol.json'), 'oracle_sha256': hash_file(out / 'oracle.json'),
            'driver_sha256': hash_file(out / 'pilot.mjs'), 'runner_sha256': hash_file(Path(__file__)), 'runtime': frozen,
            'model': protocol['model'], 'effort': protocol['reasoning_effort'], 'jobs': jobs,
            'client_version': subprocess.check_output([args.codex, '--version'], text=True).strip(),
            'full_release_experiment': len(jobs) == 72, 'started_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
(out / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')


def run(job):
    scenario, arm, repetition = job
    trial = out / 'trials' / f'{scenario}-{arm}-{repetition}'
    trial.mkdir(parents=True)
    workspace = trial / 'empty-workspace'
    workspace.mkdir()
    metadata = {'case': scenario, 'arm': arm, 'repetition': repetition, 'started': time.time(), 'semantic_verdict': 'unreviewed'}
    with (trial / 'server.log').open('wb') as log:
        server = subprocess.Popen(['node', str(out / 'pilot.mjs'), str(out / ('runtime-' + arm)), str(out / 'protocol.json'), scenario, arm, str(trial)],
                                  cwd=root, stdin=subprocess.PIPE, stdout=log, stderr=log)
        try:
            ready = wait_for_ready(trial / 'ready.json', server)
            prompt = (trial / 'input.txt').read_bytes()
            command = [args.codex, 'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '-C', str(workspace), '-s', 'read-only',
                       '-m', protocol['model'], '-c', f'model_reasoning_effort="{protocol["reasoning_effort"]}"', '-c', 'approval_policy="never"',
                       '-c', f'mcp_servers.taxlab.url="{ready}"', '--json', '-o', str(trial / 'answer.txt'), '-']
            tools = ['start_legal_research', 'update_legal_research', 'get_legal_research', 'reuse_legal_evidence', 'answer_legal_question',
                     'research_legal_sources', 'run_required_legal_research', 'review_legal_reasoning', 'prepare_reasoning_review', 'submit_reasoning_review']
            command[2:2] = [arg for name in tools for arg in ['-c', f'mcp_servers.taxlab.tools.{name}.approval_mode="approve"']]
            with (trial / 'model-trace.jsonl').open('wb') as trace, (trial / 'model-stderr.log').open('wb') as errors:
                try:
                    process = subprocess.run(command, cwd=workspace, input=prompt, stdout=trace, stderr=errors, timeout=1500)
                    metadata['exit_code'] = process.returncode
                except subprocess.TimeoutExpired:
                    metadata['exit_code'] = 'timeout'
        except Exception as error:
            metadata['setup_error'] = str(error)
        finally:
            if server.poll() is None:
                try:
                    server.stdin.write(b'quit\n')
                    server.stdin.flush()
                    server.wait(timeout=15)
                except (OSError, subprocess.TimeoutExpired):
                    server.terminate()
                    server.wait(timeout=10)
            metadata['elapsed_seconds'] = round(time.time() - metadata['started'], 2)
            for name in ['input.txt', 'answer.txt', 'model-trace.jsonl', 'mcp.jsonl', 'server.log']:
                if (trial / name).exists():
                    metadata[name + '_sha256'] = hash_file(trial / name)
            (trial / 'run.json').write_text(json.dumps(metadata, indent=2), encoding='utf-8')
    return {k: metadata.get(k) for k in ['case', 'arm', 'repetition', 'exit_code', 'setup_error', 'elapsed_seconds']}


with ThreadPoolExecutor(max_workers=args.workers) as pool:
    for future in as_completed([pool.submit(run, job) for job in jobs]):
        print(json.dumps(future.result()), flush=True)
print(json.dumps({'complete': True, 'trials': len(jobs), 'semantic_verdict': 'unreviewed', 'output': str(out)}), flush=True)
