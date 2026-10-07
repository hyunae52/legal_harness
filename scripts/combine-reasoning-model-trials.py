"""Pair a retained baseline with a later full candidate run without discarding attempts."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
from pilot_evidence import evidence_errors, verify_frozen_files

p = argparse.ArgumentParser()
p.add_argument('--baseline', required=True)
p.add_argument('--candidate', required=True)
p.add_argument('--output', required=True)
args = p.parse_args()
sources = {arm: Path(getattr(args, arm)).resolve() for arm in ['baseline', 'candidate']}
manifests = {arm: json.loads((root / 'manifest.json').read_text(encoding='utf-8')) for arm, root in sources.items()}
for arm, root in sources.items():
    verify_frozen_files(root, manifests[arm], Path(__file__).resolve().parent.parent)
for key in ['protocol_sha256', 'oracle_sha256', 'driver_sha256', 'model', 'effort', 'client_version']:
    if manifests['baseline'][key] != manifests['candidate'][key]:
        raise SystemExit('Cannot combine different protocols: ' + key)
jobs = {arm: [job for job in manifest['jobs'] if job[1] == arm] for arm, manifest in manifests.items()}
expected = {(f'C{i:02}', n) for i in range(1, 13) for n in range(1, 4)}
for arm, arm_jobs in jobs.items():
    if len(arm_jobs) != 36 or {(case, n) for case, _, n in arm_jobs} != expected:
        raise SystemExit('Each arm must retain all 12 cases x 3 repetitions')
    for case, _, n in arm_jobs:
        trial = sources[arm] / 'trials' / f'{case}-{arm}-{n}'
        if not (trial / 'run.json').exists():
            raise SystemExit('All trials must finish before combining')
        errors = evidence_errors(trial, json.loads((trial / 'run.json').read_text(encoding='utf-8')))
        if errors:
            raise SystemExit('Trial evidence mismatch: ' + str(trial) + ' ' + ','.join(errors))
out = Path(args.output).resolve()
out.mkdir(parents=True, exist_ok=False)
for name in ['protocol.json', 'oracle.json', 'pilot.mjs']:
    shutil.copyfile(sources['baseline'] / name, out / name)
for arm, arm_jobs in jobs.items():
    shutil.copytree(sources[arm] / ('runtime-' + arm), out / ('runtime-' + arm))
    for case, _, n in arm_jobs:
        trial = f'{case}-{arm}-{n}'
        shutil.copytree(sources[arm] / 'trials' / trial, out / 'trials' / trial)
merged = {k: v for k, v in manifests['candidate'].items() if k not in ['runtime', 'jobs', 'started_at']}
merged.update(runtime={arm: manifests[arm]['runtime'][arm] for arm in sources}, jobs=jobs['baseline'] + jobs['candidate'],
              full_release_experiment=True, provenance={arm: {'directory': str(root),
              'manifest_sha256': hashlib.sha256((root / 'manifest.json').read_bytes()).hexdigest()} for arm, root in sources.items()},
              note='Unchanged baseline reused; all superseded candidate trials retained in original directory. No failed trial excluded.')
(out / 'manifest.json').write_text(json.dumps(merged, indent=2), encoding='utf-8')
print(json.dumps({'trials': 72, 'output': str(out), 'semantic_verdict': 'unreviewed'}))
