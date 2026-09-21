"""Exercise the real operator's lifecycle classifier without deployment effects."""
import importlib.util, json, os, pathlib, signal, subprocess, sys
from unittest.mock import patch

sys.dont_write_bytecode = True
root = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('rollout', root / 'deploy/transport-interview-rollout.py')
rollout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rollout)


class Process:
    pid = 123
    def __init__(self, result):
        self.returncode = result
    def poll(self):
        return self.returncode


def fault(case):
    process = Process(None if case == 'monitor_error_live' else 0)
    def sample():
        raise subprocess.CalledProcessError(1, ['ps'])
    def group_exists(_):
        if case == 'group_observation_error':
            raise PermissionError('Injected observation failure')
        return case == 'orphan_provider'
    try:
        with patch.object(rollout, 'smoke_group_exists', group_exists):
            rollout.monitor_smoke(process, sample)
        # An ordinary assertion after all owned processes completed.
        raise AssertionError('Injected output validation failure')
    except Exception as error:
        return {'phase': 'verify-candidate', 'finished_at': '2026-09-21T02:00:00Z',
                **rollout.failure_record(error)}


cases = {case: fault(case) for case in
    ['monitor_error_live', 'orphan_provider', 'group_observation_error', 'finished_assertion']}

if sys.platform == 'linux':
    # Own orphan reaping in this test, without changing the production process.
    import ctypes
    assert ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0
    for orphan in (False, True):
        child_pid = None
        code = 'import time; time.sleep(30)'
        if orphan:
            code = ('import subprocess,sys; p=subprocess.Popen([sys.executable,"-c",'
                    '"import time;time.sleep(30)"], stdout=subprocess.DEVNULL); print(p.pid,flush=True)')
        process = subprocess.Popen([sys.executable, '-c', code], stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, text=True, start_new_session=True)
        try:
            if orphan:
                child_pid = int(process.stdout.readline())
                process.wait(timeout=5)
            def fail_monitor():
                raise subprocess.CalledProcessError(1, ['ps'])
            try:
                rollout.monitor_smoke(process, fail_monitor)
                raise AssertionError('A running owned group was accepted')
            except rollout.SmokeStateUnknown as error:
                cases['real_orphan' if orphan else 'real_live'] = {
                    'phase': 'verify-candidate', 'finished_at': '2026-09-21T02:00:00Z',
                    **rollout.failure_record(error)}
        finally:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
            if child_pid:
                os.waitpid(child_pid, 0)
            process.stdout.close()
        assert not rollout.smoke_group_exists(process.pid)

print(json.dumps(cases))
