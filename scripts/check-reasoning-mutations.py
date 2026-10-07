"""Mutate isolated compiled copies; never modify the working source or live server."""
import hashlib
import json
import argparse
from pathlib import Path
import shutil
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--output', default='.runtime/reasoning-mutations')
args = parser.parse_args()
output = (root / args.output).resolve()
output.mkdir(parents=True, exist_ok=False)
mutations = [
    ('unknown-negation', 'reasoningApplication.js', "return v === 'unknown' ? v :", 'return false ? v :', 'independent three-valued'),
    ('incomplete-material', 'research.js', 'if (missing.length)', 'if (false)', 'the entire exact answer'),
    ('old-cas-replay', 'research.js', 'const accepted = acceptedReceipt(state, name, input);', 'const accepted = undefined;', 'accepted old-CAS replay'),
    ('snapshot-staleness', 'reasoningReviewState.js', 'contract: 2, snapshot, artifact', 'contract: 2, artifact', 'same-revision necessity changes'),
    ('whole-answer', 'reasoningApplication.js', 'if (renderAnswer(blocks) !== input.draft_answer)', 'if (false)', 'the entire exact answer'),
]
results = []
for name, filename, original, replacement, pattern in mutations:
    folder = output / name
    folder.mkdir()
    for directory in ['dist', 'tests', 'rules']:
        shutil.copytree(root / directory, folder / directory)
    shutil.copyfile(root / 'package.json', folder / 'package.json')
    target = folder / 'dist' / filename
    before = target.read_text(encoding='utf-8')
    if before.count(original) != 1:
        raise RuntimeError(f'{name}: expected unique mutation site')
    target.write_text(before.replace(original, replacement), encoding='utf-8')
    run = subprocess.run(['node', '--test', '--test-name-pattern=' + pattern, 'tests/reasoning-v2.test.mjs'], cwd=folder, capture_output=True)
    log = run.stdout + run.stderr
    (folder / 'result.log').write_bytes(log)
    # A syntax/import crash is not proof the discriminating assertion killed it.
    expected_failure = b'RESEARCH_STATE_CHANGED' if name == 'old-cas-replay' else b'AssertionError'
    killed = run.returncode != 0 and expected_failure in log and b'tests 1' in log
    results.append({'mutation': name, 'path': 'dist/' + filename, 'test_pattern': pattern,
                    'original_sha256': hashlib.sha256(before.encode()).hexdigest(), 'mutated_sha256': hashlib.sha256(target.read_bytes()).hexdigest(),
                    'exit_code': run.returncode, 'killed': killed, 'log_sha256': hashlib.sha256(log).hexdigest()})
    print(json.dumps(results[-1]), flush=True)
(output / 'result.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
sys.exit(0 if all(r['killed'] for r in results) else 1)
