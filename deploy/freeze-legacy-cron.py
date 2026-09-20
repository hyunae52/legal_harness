"""Operator action immediately before an approved merge. Default is read-only."""
import argparse, datetime, hashlib, json, os, pathlib, subprocess

TARGETS = ['/opt/legal_harness/scripts/cron-git-sync.sh', '/opt/legal_harness/scripts/update-korean-law.sh']

def pending(rows, include_scheduler=False):
    found = []
    for row in rows.splitlines():
        parts = row.strip().split(None, 2)
        if len(parts) != 3:
            raise RuntimeError('HOLD: incomplete process snapshot')
        pid, comm, args = parts
        # Debian's dispatched child is named CRON before the user script exec.
        if comm == 'CRON' or (include_scheduler and comm == 'cron') or any(path in args for path in TARGETS):
            found.append(int(pid))
    return found

def freeze(apply=False, *, read=None, run=None, backup=None):
    read = read or (lambda args: subprocess.check_output(args, text=True))
    run = run or (lambda args, **kw: subprocess.run(args, check=True, text=True, **kw))
    if read(['id', '-un']).strip() != 'cta':
        raise RuntimeError('HOLD: expected existing cta operator')
    before = read(['crontab', '-l'])
    lines = before.splitlines(keepends=True)
    matches = [i for i, line in enumerate(lines) if not line.lstrip().startswith('#') and any(path in line for path in TARGETS)]
    if len(matches) != 2 or any(sum(path in lines[i] for i in matches) != 1 for path in TARGETS):
        raise RuntimeError('HOLD: legacy cron differs from the reviewed two jobs')
    snapshot = lambda: read(['ps', '-eo', 'pid=,comm=,args='])
    if pending(snapshot()):
        raise RuntimeError('HOLD: dispatched or running cron work exists; wait before applying')
    saved = None
    if apply:
        if read(['systemctl', 'show', 'cron.service', '--property=KillMode', '--value']).strip() != 'process':
            raise RuntimeError('HOLD: unreviewed scheduler stop semantics; do not stop unrelated jobs')
        # Briefly pause scheduling for every user. Do not kill or claim
        # completion of jobs that Debian cron has already dispatched.
        run(['sudo', '-n', 'systemctl', 'stop', 'cron.service'])
        state = read(['systemctl', 'show', 'cron.service', '--property=ActiveState', '--value']).strip()
        main = read(['systemctl', 'show', 'cron.service', '--property=MainPID', '--value']).strip()
        if state != 'inactive' or main != '0' or pending(snapshot(), include_scheduler=True):
            raise RuntimeError('HOLD: scheduler stopped but dispatched/running work remains; keep cron stopped and do not merge')
        if read(['crontab', '-l']) != before:
            raise RuntimeError('HOLD: crontab changed while stopping scheduler; cron remains stopped')
        if backup:
            saved = backup(before)
        else:
            directory = pathlib.Path('/home/cta/.legal-harness-operator-backups')
            directory.mkdir(mode=0o700, exist_ok=True)
            stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
            saved = directory / ('crontab-' + stamp + '.txt')
            fd = os.open(saved, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as stream:
                stream.write(before)
        for index in matches:
            lines[index] = '# FROZEN_FOR_REVIEWED_RELEASE ' + lines[index]
        expected = ''.join(lines)
        run(['crontab', '-'], input=expected)
        if read(['crontab', '-l']) != expected or pending(snapshot(), include_scheduler=True):
            raise RuntimeError('HOLD: freeze not quiescent or verified; cron remains stopped; do not merge')
        run(['sudo', '-n', 'systemctl', 'start', 'cron.service'])
        if read(['systemctl', 'show', 'cron.service', '--property=ActiveState', '--value']).strip() != 'active' or read(['crontab', '-l']) != expected:
            raise RuntimeError('HOLD: scheduler restart or final crontab verification failed')
    return {'status': 'frozen' if apply else 'ready_to_freeze', 'matched_jobs': 2, 'dispatched_work_drained': apply, 'scheduler_resumed': apply, 'backup': str(saved) if saved else None, 'prior_sha256': hashlib.sha256(before.encode()).hexdigest()}

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    try:
        print(json.dumps(freeze(parser.parse_args().apply)))
    except (RuntimeError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error))
