"""Export arm-hidden answers and combine explicit prose grades with observed MCP execution.

No semantic pass is inferred from an outcome enum or a model's own ready flag.
"""
import argparse
import hashlib
import json
from pathlib import Path
import random
import statistics
from pilot_evidence import evidence_errors, review_flow, verify_frozen_files

p = argparse.ArgumentParser()
p.add_argument('directory')
p.add_argument('--grades', help='JSON object keyed by blind ID: semantic_pass, decisive_error_detected, answerable, reason')
args = p.parse_args()
root = Path(args.directory).resolve()
manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
verify_frozen_files(root, manifest, Path(__file__).resolve().parent.parent)
protocol = json.loads((root / 'protocol.json').read_text(encoding='utf-8'))
cases = {c['id']: c for c in protocol['scenarios']}
jobs = list(manifest['jobs'])
random.Random(146702).shuffle(jobs)
answers, observed, mapping = [], [], {}
for n, (case, arm, repetition) in enumerate(jobs, 1):
    blind_id = f'B{n:03}'
    trial = root / 'trials' / f'{case}-{arm}-{repetition}'
    if not (trial / 'run.json').exists():
        raise SystemExit('Trials are still running; do not selectively grade completed results.')
    run = json.loads((trial / 'run.json').read_text(encoding='utf-8'))
    errors = evidence_errors(trial, run)
    output = (trial / 'answer.txt').read_text(encoding='utf-8') if (trial / 'answer.txt').exists() else ''
    try:
        answer = json.loads(output)
    except (ValueError, TypeError):
        answer = None
    try:
        trace = [json.loads(s) for s in (trial / 'model-trace.jsonl').read_text(encoding='utf-8').splitlines()]
    except (OSError, ValueError, UnicodeError):
        trace = []
        errors.append('trace_unreadable')
    if not any(e.get('type') == 'turn.completed' for e in trace):
        errors.append('trace_incomplete')
    items = [e['item'] for e in trace if e.get('type') == 'item.completed']
    calls = [i for i in items if i['type'] == 'mcp_tool_call']
    forbidden = [i['type'] for i in items if i['type'] in ['command_execution', 'web_search', 'file_change']]
    forbidden += [i['server'] for i in calls if i['server'] != 'taxlab']
    flow = review_flow(calls, answer, cases[case]['group'], arm)
    protocol_valid = run.get('exit_code') == 0 and answer is not None and not errors and not forbidden and flow['packet_complete'] and flow['required_flow']
    usage = next((e.get('usage', {}) for e in reversed(trace) if e.get('type') == 'turn.completed'), {})
    answers.append({'blind_id': blind_id, 'case': case, 'source': cases[case]['source'], 'facts': cases[case]['facts'],
                    'question': cases[case]['question'], 'group': cases[case]['group'],
                    'answer': answer.get('answer') if answer else output,
                    'outcome': answer.get('outcome') if answer else None,
                    'error_reason': answer.get('error_reason') if answer else None})
    mapping[blind_id] = {'case': case, 'arm': arm, 'repetition': repetition}
    observed.append({'blind_id': blind_id, **mapping[blind_id], 'protocol_valid': bool(protocol_valid), 'exit_code': run.get('exit_code'),
                     'forbidden_tools': forbidden, 'evidence_errors': errors, **flow, 'mcp_calls': len(calls),
                     'elapsed_seconds': run['elapsed_seconds'], 'usage': usage, 'evidence': {k: v for k, v in run.items() if k.endswith('_sha256')}})
if not args.grades:
    (root / 'blind-answers.json').write_text(json.dumps(answers, ensure_ascii=False, indent=2), encoding='utf-8')
    (root / 'blind-mapping.json').write_text(json.dumps(mapping, indent=2), encoding='utf-8')
    (root / 'protocol-observations.json').write_text(json.dumps(observed, indent=2), encoding='utf-8')
    print(json.dumps({'answers': len(answers), 'grading_file': str(root / 'blind-answers.json'), 'semantic_verdict': 'unreviewed'}))
else:
    grades_file = Path(args.grades)
    grades = json.loads(grades_file.read_text(encoding='utf-8'))
    if set(grades) != set(mapping):
        raise SystemExit('Missing or extra blind grades')
    for row in observed:
        row['grade'] = grades[row['blind_id']]
        if any(type(row['grade'].get(k)) is not bool for k in ['semantic_pass', 'decisive_error_detected', 'answerable']) or not row['grade'].get('reason'):
            raise SystemExit('Each grade requires explicit booleans and prose justification')
    arms = {}
    for arm in ['baseline', 'candidate']:
        rows = [r for r in observed if r['arm'] == arm]
        injected = [r for r in rows if cases[r['case']]['group'] == 'injected']
        normal = [r for r in rows if cases[r['case']]['group'] == 'normal']
        arms[arm] = {'trials': len(rows), 'protocol_unverified': sum(not r['protocol_valid'] for r in rows),
                     'semantic_pass': sum(r['protocol_valid'] and r['grade']['semantic_pass'] for r in rows),
                     'injected_detection_misses': sum(not (r['protocol_valid'] and r['grade']['decisive_error_detected']) for r in injected),
                     'injected_wrong_or_unverified': sum(not (r['protocol_valid'] and r['grade']['semantic_pass']) for r in injected),
                     'injected_misses': sum(not (r['protocol_valid'] and r['grade']['semantic_pass'] and r['grade']['decisive_error_detected']) for r in injected),
                     'critical_classes_detected': sorted({cases[r['case']]['class'] for r in injected if r['protocol_valid'] and r['grade']['decisive_error_detected']}),
                     'heldout_wrong_or_unverified': sum(not (r['protocol_valid'] and r['grade']['semantic_pass']) for r in rows if cases[r['case']]['heldout']),
                     'normal_answerable': sum(r['protocol_valid'] and r['grade']['semantic_pass'] and r['grade']['answerable'] for r in normal),
                     'median_seconds': statistics.median(r['elapsed_seconds'] for r in rows),
                     'mcp_calls': sum(r['mcp_calls'] for r in rows),
                     'ready_self_report_mismatches': sum(r['final_answer_ready'] is not None and r['final_answer_ready'] != r['client_reported_ready'] for r in rows),
                     'ready_self_report_unverifiable': sum(r['final_answer_ready'] is None for r in rows),
                     'tokens': {k: sum(r['usage'].get(k, 0) for r in rows) for k in ['input_tokens', 'cached_input_tokens', 'output_tokens']}}
    report = {'protocol_sha256': manifest['protocol_sha256'], 'oracle_sha256': manifest['oracle_sha256'],
              'runtime': {k: v['source_tree_sha256'] for k, v in manifest['runtime'].items()},
              'grades_sha256': hashlib.sha256(grades_file.read_bytes()).hexdigest(), 'arms': arms, 'trials': observed,
              'verdict': 'requires_release_assessment', 'scope': protocol['scope']}
    (root / 'quality-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(arms, indent=2))
