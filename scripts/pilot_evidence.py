"""Verify retained experiment bytes and separate an audit from a reviewed answer."""
import hashlib
import json
from pathlib import Path


def file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def text_digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def verify_frozen_files(root, manifest, project):
    files = [('protocol.json', 'protocol_sha256', 'docs/evidence/reasoning-quality-protocol-20261007.json'),
             ('oracle.json', 'oracle_sha256', 'docs/evidence/reasoning-quality-oracle-20261007.json'),
             ('pilot.mjs', 'driver_sha256', 'scripts/reasoning-model-pilot.mjs')]
    for name, key, canonical in files:
        if file_hash(root / name) != manifest[key] or file_hash(project / canonical) != manifest[key]:
            raise ValueError('Frozen file mismatch: ' + name)
    for arm, runtime in manifest['runtime'].items():
        base = (root / ('runtime-' + arm)).resolve()
        for item in runtime['files']:
            path = (base / item['path']).resolve()
            if not path.is_relative_to(base) or file_hash(path) != item['sha256']:
                raise ValueError('Frozen runtime mismatch: ' + item['path'])
        if hashlib.sha256(json.dumps(runtime['files'], sort_keys=True).encode()).hexdigest() != runtime['source_tree_sha256']:
            raise ValueError('Frozen runtime manifest mismatch: ' + arm)


def evidence_errors(trial, run):
    errors = []
    for name in ['input.txt', 'answer.txt', 'model-trace.jsonl']:
        if name + '_sha256' not in run or not (trial / name).is_file():
            errors.append('missing:' + name)
    for key, expected in run.items():
        if not key.endswith('_sha256'):
            continue
        name = key[:-7]
        path = (trial / name).resolve()
        if not path.is_relative_to(trial.resolve()) or not path.is_file():
            errors.append('missing:' + name)
        elif file_hash(path) != expected:
            errors.append('hash_mismatch:' + name)
    return sorted(set(errors))


def successful_result(item):
    result = item.get('result') or {}
    value = result.get('structured_content')
    if item.get('status') != 'completed' or item.get('error') or result.get('isError') or result.get('is_error'):
        return None
    return value if isinstance(value, dict) and value else None


def review_flow(calls, answer, group, arm):
    successful = [(i, successful_result(i)) for i in calls]
    successful = [(i, v) for i, v in successful if v is not None and v.get('research_id') == i.get('arguments', {}).get('research_id')]
    reviews = [(i, v) for i, v in successful if i['tool'] == 'review_legal_reasoning'
               and v.get('draft_hash') == text_digest(i['arguments'].get('draft_answer'))]
    accepted = [(i, v) for i, v in successful if i['tool'] == 'submit_reasoning_review'
                and v.get('receipt', {}).get('tool') == i['tool'] and not v.get('replayed')]
    states = [v for _, v in successful if 'ready_for_answer' in v]
    state = states[-1] if states else {}
    final_hash = text_digest(answer.get('answer')) if answer else None
    final_review = reviews[-1][1] if reviews else {}
    draft_matches = bool(final_hash and final_review.get('draft_hash') == final_hash)
    binding = state.get('answer_binding') or {}
    final_ready = (bool(state.get('ready_for_answer') is True and binding.get('current') is True
                        and binding.get('draft_hash') == final_hash and draft_matches)
                   if 'ready_for_answer' in state else None)
    packet_complete = arm == 'baseline' or bool(accepted and all(v['packet'].get('missing_units') == [] for _, v in accepted))
    if arm == 'candidate' and group == 'normal':
        last = accepted[-1][1] if accepted else {}
        current_acceptance = bool(last and last.get('review_content_hash') == state.get('review_content_hash')
            and last.get('reasoning_artifact') == final_review.get('reasoning_artifact')
            and (last.get('answer_binding') or {}).get('draft_hash') == final_hash
            and (state.get('model_review') or {}).get('status') == 'recorded')
        required_flow = draft_matches and current_acceptance
    elif group == 'normal':
        required_flow = draft_matches
    else:
        # The frozen driver explicitly asks for an audit/corrected critique without
        # rewriting the seeded draft. Its final prose is NOT a reviewed-answer claim.
        required_flow = arm == 'baseline' or bool(accepted)
    return {'draft_matches': draft_matches, 'draft_binding_required': group == 'normal',
            'evaluation_kind': 'answer_from_scratch' if group == 'normal' else 'audit_of_seed_draft',
            'required_flow': bool(required_flow), 'packet_complete': packet_complete,
            'accepted_model_reviews': len(accepted), 'successful_structure_reviews': len(reviews),
            'last_observed_server_ready': state.get('ready_for_answer'),
            'final_answer_ready': final_ready, 'final_answer_hash': final_hash,
            'last_successful_draft_hash': final_review.get('draft_hash'),
            'client_reported_ready': answer.get('review_ready') if answer else None}
