"""Run frozen model-input trials; does NOT manufacture semantic pass verdicts."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--codex', default=shutil.which('codex'))
parser.add_argument('--scenario', required=True)
parser.add_argument('--repetition', type=int, choices=[1, 2, 3], required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--taxlaw-release', required=True)
args = parser.parse_args()
if not args.codex:
    raise SystemExit('Codex CLI required only for the model evaluation; no server LLM dependency.')
protocol_path = root / 'docs/evidence/authority-pilot-protocol-20261001.json'
protocol_bytes = protocol_path.read_bytes()
protocol = json.loads(protocol_bytes)
scenario = next(s for s in protocol['scenarios'] if s['id'] == args.scenario)
destination = Path(args.output).resolve()
if (destination.parent / 'CANCELLED').exists():
    raise SystemExit('Batch cancelled; retained attempts are not release evidence.')
destination.mkdir(parents=True, exist_ok=False)
workspace = destination / 'empty-workspace'
workspace.mkdir()
environment = os.environ.copy()
environment['TAXLAW_MCP_RELEASE_FILE'] = str(Path(args.taxlaw_release).resolve())
source_files = sorted((root / 'src').glob('*.ts'))
source_hash = hashlib.sha256(b''.join(str(f.relative_to(root)).encode() + b'\0' + f.read_bytes() for f in source_files)).hexdigest()
metadata = dict(scenario=args.scenario, repetition=args.repetition, source_mode=scenario['source_mode'],
                source_identity_kind='source_tree_sha256', source_sha=source_hash,
                frozen_protocol_hash=hashlib.sha256(protocol_bytes).hexdigest(), model_id=protocol['model_id'],
                reasoning_effort=protocol['reasoning_effort'], started_at=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                client_version=subprocess.check_output([args.codex, '--version'], text=True).strip())
prompt = protocol['common_prompt'] + '\n\n' + scenario['prompt']
(destination / 'input.txt').write_text(prompt, encoding='utf-8')
with (destination / 'server.log').open('wb') as log:
    server = subprocess.Popen(['node', str(root / 'scripts/authority-pilot-server.mjs'), args.scenario, str(destination)],
                              cwd=root, env=environment, stdin=subprocess.PIPE, stdout=log, stderr=log)
    try:
        until = time.monotonic() + 45
        while not (destination / 'ready.json').exists():
            if server.poll() is not None or time.monotonic() >= until:
                raise RuntimeError('Evaluation server did not start')
            time.sleep(0.1)
        endpoint = json.loads((destination / 'ready.json').read_text(encoding='utf-8'))['url']
        command = [args.codex, 'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check',
                   '-C', str(workspace), '-s', 'read-only', '-m', protocol['model_id'],
                   '-c', 'model_reasoning_effort="' + protocol['reasoning_effort'] + '"',
                   '-c', 'approval_policy="never"', '-c', 'mcp_servers.taxlab.url="' + endpoint + '"',
                   '--json', '-o', str(destination / 'answer.txt'), '-']
        # This task authorizes ephemeral research state and official read-only retrieval.
        # Grant only those tools for this local evaluation process, not PR publication or general MCP writes.
        permitted = ['start_legal_research', 'update_legal_research', 'get_legal_research', 'answer_legal_question',
                     'research_legal_sources', 'run_required_legal_research', 'reuse_legal_evidence', 'review_legal_reasoning']
        overrides = [value for tool in permitted for value in ['-c', f'mcp_servers.taxlab.tools.{tool}.approval_mode="approve"']]
        command[2:2] = overrides
        metadata['authorized_evaluation_tools'] = permitted
        metadata['client_config_reference'] = 'https://learn.chatgpt.com/docs/config-file/config-reference'
        with (destination / 'model-trace.jsonl').open('wb') as trace, (destination / 'model-stderr.log').open('wb') as errors:
            try:
                completed = subprocess.run(command, cwd=workspace, input=prompt.encode('utf-8'), stdout=trace, stderr=errors, timeout=1500)
                metadata['exit_code'] = completed.returncode
            except subprocess.TimeoutExpired:
                metadata['exit_code'] = 'timeout'
    finally:
        if server.poll() is None:
            try:
                server.stdin.write(b'quit\n')
                server.stdin.flush()
                server.wait(timeout=30)
            except (OSError, subprocess.TimeoutExpired):
                server.terminate()
                server.wait(timeout=10)
        for name in ['model-trace.jsonl', 'answer.txt', 'sources.jsonl', 'mcp.jsonl']:
            file = destination / name
            if file.exists():
                metadata[name + '_sha256'] = hashlib.sha256(file.read_bytes()).hexdigest()
        metadata['semantic_verdict'] = 'unreviewed'
        (destination / 'run.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({key: value for key, value in metadata.items() if key not in ['source_sha']}, ensure_ascii=False))
