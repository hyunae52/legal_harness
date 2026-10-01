import importlib.util
from pathlib import Path
import tempfile
import threading
import time
import unittest

spec = importlib.util.spec_from_file_location('pilot_readiness', Path(__file__).resolve().parents[1] / 'scripts/pilot_readiness.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Process:
    def __init__(self, status=None):
        self.status = status

    def poll(self):
        return self.status


class ReadinessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'ready.json'

    def test_created_empty_file_is_not_yet_ready(self):
        self.path.write_text('', encoding='utf-8')
        writer = threading.Timer(0.03, lambda: self.path.write_text('{"url":"http://127.0.0.1:1234/mcp"}', encoding='utf-8'))
        writer.start()
        self.addCleanup(writer.join)
        self.assertEqual(module.wait_for_ready(self.path, Process(), timeout=2), 'http://127.0.0.1:1234/mcp')

    def test_partial_json_is_not_yet_ready(self):
        self.path.write_text('{"url":', encoding='utf-8')
        writer = threading.Timer(0.03, lambda: self.path.write_text('{"url":"http://127.0.0.1:1234/mcp"}', encoding='utf-8'))
        writer.start()
        self.addCleanup(writer.join)
        self.assertEqual(module.wait_for_ready(self.path, Process(), timeout=2), 'http://127.0.0.1:1234/mcp')

    def test_invalid_record_never_extends_deadline(self):
        self.path.write_text('{"url":null}', encoding='utf-8')
        started = time.monotonic()
        with self.assertRaisesRegex(RuntimeError, 'valid readiness'):
            module.wait_for_ready(self.path, Process(), timeout=0.03)
        self.assertLess(time.monotonic() - started, 1)

    def test_dead_server_does_not_start_model_from_stale_ready_file(self):
        self.path.write_text('{"url":"http://127.0.0.1:1234/mcp"}', encoding='utf-8')
        with self.assertRaisesRegex(RuntimeError, 'exited'):
            module.wait_for_ready(self.path, Process(1), timeout=2)


if __name__ == '__main__':
    unittest.main()
