"""Wait for a complete startup record; file creation alone is not readiness."""
import json
import time


def wait_for_ready(path, server, timeout=45):
    deadline = time.monotonic() + timeout
    while True:
        if server.poll() is not None:
            raise RuntimeError('Evaluation server exited before readiness')
        try:
            record = json.loads(path.read_text(encoding='utf-8'))
            endpoint = record['url']
            if not isinstance(endpoint, str) or not endpoint:
                raise ValueError('Missing evaluation endpoint')
            return endpoint
        except (FileNotFoundError, json.JSONDecodeError, KeyError, ValueError):
            if time.monotonic() >= deadline:
                raise RuntimeError('Evaluation server did not produce a valid readiness record') from None
            time.sleep(min(0.1, max(0, deadline - time.monotonic())))
