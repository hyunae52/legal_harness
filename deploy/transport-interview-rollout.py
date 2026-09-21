"""One reviewed release on the existing GCE host. Gate orchestration is separate.

Only public-safe reports are emitted. Credentials stay in the existing protected
environment file. This helper never resumes public traffic in an error handler.
"""
import datetime, hashlib, json, os, pathlib, re, shutil, subprocess, sys, tarfile, time
import urllib.request

BASE = pathlib.Path('/home/cta')
UNIT = 'legal-harness-a.service'
OLD = BASE / 'legal-harness-research-75314179eb1d'
OLD_HEAD = '75314179eb1d2fbf17ad5eb2ad367031d99749dc'
OLD_SHA = 'd63b301deaeea5d48c9719da7918b23cb3cff6216abae4a83d8de603f9464ce6'
ENV = BASE / '.config/legal-harness/corrections.env'
RUNTIME_ENV = BASE / 'legal-harness-candidate-ddddafa/.runtime/candidate.env'
DROPIN = pathlib.Path('/etc/systemd/system/legal-harness-a.service.d/95-transport-interview.conf')
os.umask(0o077)


def run(args, timeout=60):
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE, timeout=timeout).strip()


def prop(name, unit=UNIT):
    return run(['systemctl', 'show', unit, '--property=' + name, '--value'])


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def health():
    with urllib.request.urlopen('http://127.0.0.1:3100/health', timeout=4) as response:
        data = json.load(response)
    assert data['status'] == 'ok' and data['mcp_release'] == '4.13.0'
    assert data['correction_pr'] == 'available' and data['maintenance'] == 'unavailable'
    return data


def ready():
    until = time.monotonic() + 25
    while True:
        try:
            return health()
        except Exception:
            if time.monotonic() >= until:
                raise
            time.sleep(.3)


def closure(root):
    code = "import {fingerprintDependencies} from '/home/cta/installed-dependencies.mjs';console.log(JSON.stringify(fingerprintDependencies(process.argv[1])));"
    return json.loads(run(['node', '--input-type=module', '-e', code, str(root / 'node_modules')]))


def files(root, manifest):
    for name, expected in manifest['files'].items():
        path = root / name
        assert path.resolve().is_relative_to(root) and path.is_file() and sha(path) == expected


def previous():
    record = json.loads((BASE / 'research-75314179eb1d-packet.json').read_text())
    assert record['head'] == OLD_HEAD and record['artifact_sha256'] == OLD_SHA
    assert sha(BASE / 'research-75314179eb1d.tgz') == OLD_SHA
    files(OLD, record)
    installed = json.loads((BASE / 'research-75314179eb1d-deployment.json').read_text())
    expected = installed['installed_dependencies']
    assert closure(OLD) == expected
    selected = json.loads((OLD / '.runtime/taxlaw/active.json').read_text())
    assert selected == installed['python_selection']
    assert sha(pathlib.Path(selected['cwd']).parent / 'installed-dependencies.txt') == installed['python_dependencies_sha256']
    return expected


def resources():
    mem = {s.split(':')[0]: int(s.split()[1]) * 1024 for s in pathlib.Path('/proc/meminfo').read_text().splitlines() if s.startswith(('MemAvailable:', 'SwapFree:'))}
    return {**mem, 'disk_free': shutil.disk_usage(BASE).free, 'service_memory': int(prop('MemoryCurrent'))}


def cron_quiet():
    targets = ('/opt/legal_harness/scripts/cron-git-sync.sh', '/opt/legal_harness/scripts/update-korean-law.sh')
    cron = run(['crontab', '-l'])
    assert sum(s.startswith('# FROZEN_FOR_REVIEWED_RELEASE') for s in cron.splitlines()) == 2
    assert not any(not s.lstrip().startswith('#') and any(p in s for p in targets) for s in cron.splitlines())
    rows = run(['ps', '-eo', 'comm=,args='])
    assert not any(any(p in row for p in targets) for row in rows.splitlines())


class SmokeStateUnknown(RuntimeError):
    operation_state_unknown = True


def smoke_group_exists(pid):
    # The smoke and its stdio providers inherit a dedicated POSIX process group.
    # Parent exit alone is insufficient: orphaned providers retain this group.
    try:
        os.killpg(pid, 0)
        return True
    except ProcessLookupError:
        return False


def monitor_smoke(process, sample, deadline_seconds=120):
    def completed():
        return process.poll() is not None and not smoke_group_exists(process.pid)

    try:
        deadline = time.monotonic() + deadline_seconds
        while process.poll() is None:
            if time.monotonic() >= deadline:
                raise SmokeStateUnknown('Smoke deadline; owned work may remain')
            sample()
            time.sleep(.3)
        if not completed():
            raise SmokeStateUnknown('Smoke descendants may remain')
        assert process.returncode == 0
    except Exception as error:
        # Do not turn a monitoring error into permission to replace the service.
        # Failed observation (including permissions) also leaves state unknown.
        try:
            finished = completed()
        except Exception:
            finished = False
        if not finished:
            raise SmokeStateUnknown('Owned smoke completion unconfirmed') from error
        raise


def failure_record(error):
    result = {'status': 'failed', 'error_type': type(error).__name__}
    if isinstance(error, subprocess.TimeoutExpired) or getattr(error, 'operation_state_unknown', False):
        result['operation_state_unknown'] = True
    return result


def wait_for_idle():
    deadline = time.monotonic() + 60
    samples = []
    while True:
        current = health()
        counters = {key: current[key] for key in ('active_requests', 'active_authentications', 'active_dispatches')}
        samples.append(counters)
        if all(value == 0 for value in counters.values()):
            return samples
        assert time.monotonic() < deadline
        time.sleep(.2)


def main(mode, packet):
    assert run(['id', '-un']) == 'cta'
    config = json.loads(pathlib.Path(packet).read_text())
    assert sha(pathlib.Path(__file__)) == config['operator_sha256']
    assert sha(BASE / 'installed-dependencies.mjs') == config['operator_files']['deploy/installed-dependencies.mjs']
    head = config['head']; assert re.fullmatch('[0-9a-f]{40}', head)
    new = BASE / ('legal-harness-transport-' + head[:12])
    archive = BASE / ('transport-' + head[:12] + '.tgz')
    report_file = BASE / ('transport-' + head[:12] + '-deployment.json')
    assert new.parent == BASE and new != OLD
    report = json.loads(report_file.read_text()) if report_file.exists() else {'head': head, 'events': []}
    event = {'phase': mode, 'started_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
             'operator_sha256': config['operator_sha256'], 'operator_commit': config.get('operator_commit')}
    tag = 'taxlab-transport-' + head[:12]
    rule = ['OUTPUT', '-o', 'lo', '-p', 'tcp', '-d', '127.0.0.1', '--dport', '3100', '-m', 'owner', '--uid-owner', '0', '-m', 'comment', '--comment', tag, '-j', 'REJECT', '--reject-with', 'tcp-reset']

    def iptables(action):
        args = [rule[0], '1', *rule[1:]] if action == '-I' else rule
        return run(['sudo', '-n', '/usr/sbin/iptables', '-w', '5', action, *args])

    def candidate():
        for path, expected in config['protected_config_hashes'].items(): assert sha(pathlib.Path(path)) == expected
        assert sha(archive) == config['artifact_sha256']
        files(new, config)
        for name, expected in config['operator_files'].items():
            assert sha(new / name) == expected
        assert closure(new) == report['installed_dependencies']
        selected = json.loads((new / '.runtime/taxlaw/active.json').read_text())
        assert selected['commit'] == 'd77c94e5b64892fe85928508544366e418397c71'
        assert sha(pathlib.Path(selected['cwd']).parent / 'installed-dependencies.txt') == report['python_dependencies_sha256']

    def write_override():
        conf = '[Service]\nWorkingDirectory=' + str(new) + '\nExecStart=\nExecStart=/usr/bin/node ' + str(new / 'dist/index.js') + '\nReadOnlyPaths=' + str(new) + '\nEnvironmentFile=' + str(ENV) + '\nStateDirectory=legal-harness-corrections\nStateDirectoryMode=0700\nTimeoutStopSec=90\nEnvironment=TAXLAB_RELEASE_COMMIT=' + head + '\n'
        (BASE / ('transport-' + head[:12] + '.conf')).write_text(conf)

    def smoke(endpoint=None):
        import resource
        # Read the existing file inside the trusted Node process, copying only
        # the keys needed by this read-only smoke. No correction publisher exists
        # in the staged createApp; no persistent correction directory is passed.
        bootstrap = """import {readFileSync} from 'node:fs';import dotenv from 'dotenv';
const saved=dotenv.parse(readFileSync('/home/cta/legal-harness-candidate-ddddafa/.runtime/candidate.env'));
if(process.env.TAXLAB_SERVER_URL)process.env.TAXLAB_API_KEY=saved.TAXLAB_API_KEY;
else for(const name of ['LAW_OC','KOREAN_LAW_API_KEY','KOREAN_LAW_MCP_RELEASE_FILE','LAW_API_PROTOCOL',
 'MCP_MAX_UPSTREAM_REQUESTS','MCP_MAX_UPSTREAM_BODY_BYTES','MCP_MAX_TOTAL_UPSTREAM_BODY_BYTES','MCP_MAX_TOOL_RESPONSE_CHARS'])
 if(saved[name])process.env[name]=saved[name];
await import('./scripts/research-smoke.mjs');"""
        env = {k: os.environ[k] for k in ['PATH', 'HOME', 'USER', 'LANG'] if k in os.environ}
        output = new / '.runtime' / ('public-smoke.json' if endpoint and endpoint.startswith('https:') else 'candidate-smoke.json' if endpoint else 'stage-smoke.json')
        env['RESEARCH_SMOKE_REPORT'] = str(output)
        if endpoint:
            env['TAXLAB_SERVER_URL'] = endpoint
        log = new / '.runtime' / ('smoke-' + mode + '.log')
        minimum_available = resources()['MemAvailable']; peak_rss = 0
        usage = resource.getrusage(resource.RUSAGE_CHILDREN)
        cpu_before = usage.ru_utime + usage.ru_stime; started = time.monotonic()
        with log.open('w') as stream:
            process = subprocess.Popen(['node', '--input-type=module', '-e', bootstrap, '--', '--live'], cwd=new, env=env, stdout=stream, stderr=stream, start_new_session=True)
            event['smoke_process_group'] = process.pid
            def sample():
                nonlocal peak_rss, minimum_available
                rows = [tuple(map(int, line.split())) for line in run(['ps', '-eo', 'pid=,ppid=,rss=']).splitlines()]
                pids = {process.pid}
                for _ in range(8):
                    pids |= {pid for pid, parent, rss in rows if parent in pids}
                peak_rss = max(peak_rss, sum(rss * 1024 for pid, parent, rss in rows if pid in pids))
                minimum_available = min(minimum_available, resources()['MemAvailable'])
            monitor_smoke(process, sample)
            event['smoke_owned_processes_completed'] = True
        data = json.loads(output.read_text()); assert data['status'] == 'pass' and data['tool_count'] == 36 and data['interview_unknown_preserved'] is True
        usage = resource.getrusage(resource.RUSAGE_CHILDREN)
        return {'result': data, 'peak_smoke_tree_rss': peak_rss, 'minimum_mem_available': minimum_available,
                'wall_seconds': round(time.monotonic() - started, 3), 'child_cpu_seconds': round(usage.ru_utime + usage.ru_stime - cpu_before, 3)}

    try:
        if mode == 'stage':
            assert not new.exists() and not DROPIN.exists()
            assert prop('WorkingDirectory') == str(OLD)
            assert ENV.stat().st_uid == os.getuid() and ENV.stat().st_mode & 0o777 == 0o600
            assert RUNTIME_ENV.stat().st_uid == os.getuid() and RUNTIME_ENV.stat().st_mode & 0o777 == 0o600
            expected_closure = previous(); cron_quiet()
            assert config['ci']['head_sha'] == head and config['ci']['conclusion'] == 'success'
            for path, expected in config['protected_config_hashes'].items(): assert sha(pathlib.Path(path)) == expected
            assert sha(archive) == config['artifact_sha256']
            before = resources(); assert before['disk_free'] > 500 * 1024 * 1024 and before['MemAvailable'] > 220 * 1024 * 1024
            new.mkdir(mode=0o750); seen = set()
            with tarfile.open(archive, 'r:gz') as bundle:
                for member in bundle.getmembers():
                    assert member.isfile() and member.name.startswith('package/')
                    name = member.name.removeprefix('package/')
                    assert name in config['files'] and name not in seen and '..' not in pathlib.PurePosixPath(name).parts
                    target = new / name; assert target.resolve().is_relative_to(new)
                    content = bundle.extractfile(member).read(); assert hashlib.sha256(content).hexdigest() == config['files'][name]
                    target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(content); seen.add(name)
            assert seen == config['files'].keys()
            shutil.copytree(OLD / 'node_modules', new / 'node_modules', symlinks=True)
            assert closure(new) == expected_closure
            assert json.loads((new / 'node_modules/zod-to-json-schema/package.json').read_text())['version'] == '3.25.2'
            for name, expected in config['operator_files'].items():
                source = BASE / ('transport-operator-' + pathlib.Path(name).name)
                assert sha(source) == expected
                destination = new / name; assert destination.resolve().is_relative_to(new)
                destination.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(source, destination)
            (new / '.runtime').mkdir(mode=0o700, exist_ok=True)
            # Reuse the already pinned and verified provider, retaining OLD for rollback.
            (new / '.runtime/taxlaw').mkdir(mode=0o700)
            shutil.copyfile(OLD / '.runtime/taxlaw/active.json', new / '.runtime/taxlaw/active.json')
            selected = json.loads((new / '.runtime/taxlaw/active.json').read_text())
            dependency_file = pathlib.Path(selected['cwd']).parent / 'installed-dependencies.txt'
            report.update(installed_dependencies=expected_closure, python_selection=selected, python_dependencies_sha256=sha(dependency_file), python_dependencies=dependency_file.read_text().splitlines())
            candidate()
            event.update(before=before, staged_smoke=smoke(), after=resources(), artifact_sha256=config['artifact_sha256'])
            assert event['staged_smoke']['minimum_mem_available'] > 80 * 1024 * 1024
            write_override()
        elif mode in ('restage', 'verify-stage'):
            # A completed failed smoke may be retried on the same immutable
            # installation. Never reuse an unknown/running operation or a
            # modified installation, and never activate from a failed record.
            assert report['events'][-1]['phase'] in ('stage', 'restage', 'verify-stage')
            assert report['events'][-1]['status'] == ('failed' if mode == 'restage' else 'pass')
            assert not report['events'][-1].get('operation_state_unknown')
            assert not DROPIN.exists() and prop('WorkingDirectory') == str(OLD)
            previous(); candidate(); cron_quiet()
            before = resources()
            event.update(before=before, staged_smoke=smoke(), after=resources(), artifact_sha256=config['artifact_sha256'])
            assert event['staged_smoke']['minimum_mem_available'] > 80 * 1024 * 1024
            write_override()
        elif mode == 'fence':
            assert report['events'][-1]['phase'] in ('stage', 'restage', 'verify-stage') and report['events'][-1]['status'] == 'pass'
            candidate(); previous(); cron_quiet()
            assert not DROPIN.exists() and prop('WorkingDirectory') == str(OLD)
            assert prop('User', 'cloudflared.service') in ('', 'root')
            tunnel = subprocess.check_output(['sudo', '-n', 'cat', '/etc/cloudflared/config.yml'], text=True, timeout=5)
            assert hashlib.sha256(tunnel.encode()).hexdigest() == config['tunnel_config_sha256']
            assert 'http://127.0.0.1:3100' in tunnel and 'law.taxlab.kr' in tunnel
            report['old_pid'] = prop('MainPID'); assert pathlib.Path('/proc', report['old_pid']).exists()
            # Insert only this task's root->loopback service-port rule. cta/SSH stay available.
            iptables('-I'); iptables('-C')
            code = "import socket; s=socket.socket();s.settimeout(2);assert s.connect_ex(('127.0.0.1',3100))!=0"
            run(['sudo', '-n', 'python3', '-c', code], timeout=5)
            health()
            run(['sudo', '-n', 'ss', '-K', 'dst 127.0.0.1 dport = :3100'])
            assert not run(['ss', '-H', '-tan', 'state', 'established', 'dst 127.0.0.1 dport = :3100'])
            report['fenced_monotonic'] = time.monotonic()
            event.update(root_probe='blocked', operator_probe='reachable', ingress_connections='cleared', old_pid=report['old_pid'])
        elif mode == 'drain':
            iptables('-C'); assert prop('MainPID') == report['old_pid']
            # This reviewed baseline exposes all three application drain counters.
            # Ingress is fenced and prior ingress sockets have been closed.
            samples = wait_for_idle()
            assert prop('MainPID') == report['old_pid'] and prop('WorkingDirectory') == str(OLD)
            cron_quiet(); iptables('-C')
            event.update(samples=samples, status_condition='fenced_work_auth_dispatch_zero')
        elif mode == 'activate':
            assert report['events'][-1]['phase'] == 'drain' and report['events'][-1]['status'] == 'pass'
            iptables('-C'); candidate(); assert prop('MainPID') == report['old_pid'] and health()['active_requests'] == 0
            assert not DROPIN.exists()
            run(['sudo', '-n', 'install', '-m', '0644', str(BASE / ('transport-' + head[:12] + '.conf')), str(DROPIN)])
            run(['sudo', '-n', 'systemctl', 'daemon-reload'])
            run(['sudo', '-n', 'systemctl', 'restart', UNIT], timeout=100)
        elif mode == 'verify-candidate':
            iptables('-C'); current = ready(); candidate()
            assert prop('WorkingDirectory') == str(new) and current['release_commit'] == head
            assert current['research_harness']['tools'] == 6 and current['mcp_transport']['mode'] == 'stateless'
            assert not pathlib.Path('/proc', report['old_pid']).exists()
            state = pathlib.Path('/var/lib/legal-harness-corrections')
            assert state.stat().st_mode & 0o777 == 0o700 and state.stat().st_uid == os.getuid()
            event.update(health=current, smoke=smoke('http://127.0.0.1:3100'), resources=resources(), timeout_stop=prop('TimeoutStopUSec'))
        elif mode == 'rollback':
            iptables('-C')
            # A completed smoke process does not imply that requests it started
            # have finished on the application. Verify that boundary separately.
            event['drain_samples'] = wait_for_idle()
            # Removing only our override restores the preserved 90-research release.
            if DROPIN.exists():
                assert head in DROPIN.read_text()
                run(['sudo', '-n', 'rm', '--', str(DROPIN)])
            run(['sudo', '-n', 'systemctl', 'daemon-reload'])
            run(['sudo', '-n', 'systemctl', 'restart', UNIT], timeout=100)
        elif mode == 'verify-previous':
            previous(); current = ready()
            assert prop('WorkingDirectory') == str(OLD) and not DROPIN.exists()
            event.update(health=current, previous_head=OLD_HEAD, previous_sha256=OLD_SHA)
        elif mode == 'resume':
            assert report['events'][-1]['phase'] in ('verify-candidate', 'verify-previous') and report['events'][-1]['status'] == 'pass'
            iptables('-D')
            event['public_resumed'] = True
        elif mode == 'public-smoke':
            assert prop('WorkingDirectory') == str(new) and health()['release_commit'] == head
            event.update(smoke=smoke('https://law.taxlab.kr'), resources=resources())
        else:
            raise ValueError('Unknown phase')
        event['status'] = 'pass'
    except Exception as error:
        event.update(failure_record(error))
        raise
    finally:
        event['finished_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        report['events'].append(event)
        report_file.write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(event))


if __name__ == '__main__':
    try:
        main(sys.argv[1], sys.argv[2])
    except Exception:
        # Private subprocess errors can contain source response text; emit no raw exception.
        raise SystemExit(1)
