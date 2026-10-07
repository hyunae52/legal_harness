import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('pilot_evidence', Path(__file__).resolve().parents[1] / 'scripts/pilot_evidence.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def reviewed(text, status='completed'):
    digest = module.text_digest(text)
    return {'tool': 'review_legal_reasoning', 'arguments': {'research_id': 'r', 'draft_answer': text}, 'status': status,
            'result': {'structured_content': {'research_id': 'r', 'draft_hash': digest,
                'reasoning_artifact': {'artifact_id': 'a'}, 'review_content_hash': 'h',
                'answer_binding': {'draft_hash': digest, 'current': True}, 'ready_for_answer': False}}}


def accepted(text):
    return {'tool': 'submit_reasoning_review', 'arguments': {'research_id': 'r'}, 'status': 'completed',
            'result': {'structured_content': {'research_id': 'r', 'receipt': {'tool': 'submit_reasoning_review'},
                'packet': {'missing_units': []}, 'reasoning_artifact': {'artifact_id': 'a'}, 'review_content_hash': 'h',
                'answer_binding': {'draft_hash': module.text_digest(text), 'current': True},
                'model_review': {'status': 'recorded'}, 'ready_for_answer': True}}}


class EvidenceTests(unittest.TestCase):
    def test_normal_answer_cannot_inherit_another_drafts_review(self):
        flow = module.review_flow([reviewed('A'), accepted('A')], {'answer': 'B', 'review_ready': True}, 'normal', 'candidate')
        self.assertFalse(flow['draft_matches'])
        self.assertFalse(flow['required_flow'])
        self.assertFalse(flow['final_answer_ready'])

    def test_failed_last_review_is_not_a_successful_binding(self):
        flow = module.review_flow([reviewed('A'), accepted('A'), reviewed('B', 'failed')], {'answer': 'B'}, 'normal', 'candidate')
        self.assertEqual(flow['successful_structure_reviews'], 1)
        self.assertFalse(flow['required_flow'])

    def test_qualified_answer_need_not_have_readiness_true_to_complete_flow(self):
        submit = accepted('A'); submit['result']['structured_content']['ready_for_answer'] = False
        flow = module.review_flow([reviewed('A'), submit], {'answer': 'A', 'review_ready': False}, 'normal', 'candidate')
        self.assertTrue(flow['required_flow'])
        self.assertTrue(flow['draft_matches'])
        self.assertFalse(flow['final_answer_ready'])

    def test_audit_critique_is_measured_but_never_inherits_seed_readiness(self):
        flow = module.review_flow([reviewed('wrong seed'), accepted('wrong seed')], {'answer': 'correct critique', 'review_ready': True}, 'injected', 'candidate')
        self.assertTrue(flow['required_flow'])
        self.assertEqual(flow['evaluation_kind'], 'audit_of_seed_draft')
        self.assertFalse(flow['draft_matches'])
        self.assertFalse(flow['final_answer_ready'])

    def test_missing_or_changed_execution_bytes_cannot_verify(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); run = {}
            for name in ['input.txt', 'answer.txt', 'model-trace.jsonl']:
                (root / name).write_text('original', encoding='utf-8'); run[name + '_sha256'] = module.file_hash(root / name)
            self.assertEqual(module.evidence_errors(root, run), [])
            (root / 'model-trace.jsonl').unlink()
            self.assertIn('missing:model-trace.jsonl', module.evidence_errors(root, run))
            (root / 'answer.txt').write_text('changed', encoding='utf-8')
            self.assertIn('hash_mismatch:answer.txt', module.evidence_errors(root, run))

    def test_unchanged_manifest_cannot_hide_changed_frozen_protocol(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root / 'project'; source.mkdir(); frozen = root / 'frozen'; frozen.mkdir()
            manifest = {'runtime': {}}
            for name, key, canonical in [('protocol.json', 'protocol_sha256', 'docs/evidence/reasoning-quality-protocol-20261007.json'),
                                         ('oracle.json', 'oracle_sha256', 'docs/evidence/reasoning-quality-oracle-20261007.json'),
                                         ('pilot.mjs', 'driver_sha256', 'scripts/reasoning-model-pilot.mjs')]:
                p = source / canonical; p.parent.mkdir(parents=True, exist_ok=True); p.write_text('frozen', encoding='utf-8')
                (frozen / name).write_text('frozen', encoding='utf-8'); manifest[key] = module.file_hash(p)
            module.verify_frozen_files(frozen, manifest, source)
            (frozen / 'protocol.json').write_text('changed', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'protocol.json'):
                module.verify_frozen_files(frozen, manifest, source)


if __name__ == '__main__':
    unittest.main()
