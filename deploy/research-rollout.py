"""One reviewed release on the existing GCE host. Gate orchestration is separate.

Only public-safe reports are emitted. Credentials stay in the existing protected
environment file. This helper never resumes public traffic in an error handler.
"""
import datetime, hashlib, json, os, pathlib, re, shutil, subprocess, sys, tarfile, time
import urllib.request

BASE = pathlib.Path('/home/cta')
UNIT = 'legal-harness-a.service'
OLD = BASE / 'legal-harness-client-guide-a9808dd'
OLD_HEAD = 'a9808ddd629f18cb915e710bf52835fe6db400e5'
OLD_SHA = 'c0977a5e3508d02c1340cde15307b05ba8c10413c14fb182f96809b584df1561'
ENV = BASE / '.config/legal-harness/corrections.env'
DROPIN = pathlib.Path('/etc/systemd/system/legal-harness-a.service.d/90-research.conf')
AUTH_HASHES = {
    'dist/auth.js': 'f515f8054c9f738a720bb7b650865e6b4ac7ab63929dda9f53a7f53276410699',
    'node_modules/@supabase/auth-js/dist/module/GoTrueClient.js': '3cb8e370ebf6c366510d7650b63d5a409a907cf956a1e18bc4dbaf558d8c1c98',
    'node_modules/@supabase/auth-js/dist/module/lib/fetch.js': 'a2ad61127a66873e5aa411e599de32deef155e3cb0daaefc59e7a6a65964edde',
    'node_modules/@supabase/auth-js/dist/main/GoTrueClient.js': '9aad21a85ebe67f5c0fd1c1bc134d8fcf98f9d7a0958c28f5d8de8b54032a864',
    'node_modules/@supabase/auth-js/dist/main/lib/fetch.js': '50fa4e318e07a49de1179256e3fa3dc927a6a46664386f0baed30ef80f3c1d0b',
}
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
    record = json.loads((BASE / 'client-guide-release-manifest.json').read_text())
    assert record['head'] == OLD_HEAD and record['artifact_sha256'] == OLD_SHA
    assert sha(BASE / 'legal-harness-client-guide-a9808dd.tgz') == OLD_SHA
    files(OLD, record)
    expected = json.loads((BASE / 'a-staged-manifest.json').read_text())['installed_dependencies']
    assert closure(OLD) == expected
    for name, expected_sha in AUTH_HASHES.items():
        assert sha(OLD / name) == expected_sha
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


def main(mode, packet):
    assert run(['id', '-un']) == 'cta'
    config = json.loads(pathlib.Path(packet).read_text())
    assert sha(pathlib.Path(__file__)) == config['operator_sha256']
    head = config['head']; assert re.fullmatch('[0-9a-f]{40}', head)
    new = BASE / ('legal-harness-research-' + head[:12])
    archive = BASE / ('research-' + head[:12] + '.tgz')
    report_file = BASE / ('research-' + head[:12] + '-deployment.json')
    assert new.parent == BASE and new != OLD
    report = json.loads(report_file.read_text()) if report_file.exists() else {'head': head, 'events': []}
    event = {'phase': mode, 'started_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    tag = 'taxlab-research-' + head[:12]
    rule = ['OUTPUT', '-o', 'lo', '-p', 'tcp', '-d', '127.0.0.1', '--dport', '3100', '-m', 'owner', '--uid-owner', '0', '-m', 'comment', '--comment', tag, '-j', 'REJECT', '--reject-with', 'tcp-reset']

    def iptables(action):
        args = [rule[0], '1', *rule[1:]] if action == '-I' else rule
        return run(['sudo', '-n', '/usr/sbin/iptables', '-w', '5', action, *args])

    def candidate():
        assert sha(archive) == config['artifact_sha256']
        files(new, config)
        for name, expected in config['operator_files'].items():
            assert sha(new / name) == expected
        assert closure(new) == report['installed_dependencies']
        selected = json.loads((new / '.runtime/taxlaw/active.json').read_text())
        assert selected['commit'] == 'd77c94e5b64892fe85928508544366e418397c71'
        assert sha(pathlib.Path(selected['cwd']).parent / 'installed-dependencies.txt') == report['python_dependencies_sha256']

    def smoke(endpoint=None):
        import resource
        # Read the existing file inside the trusted Node process, copying only
        # the keys needed by this read-only smoke. No correction publisher exists
        # in the staged createApp; no persistent correction directory is passed.
        bootstrap = """import {readFileSync} from 'node:fs';import dotenv from 'dotenv';
const saved=dotenv.parse(readFileSync('/home/cta/.config/legal-harness/corrections.env'));
if(process.env.TAXLAB_SERVER_URL)process.env.TAXLAB_API_KEY=saved.TAXLAB_API_KEY;
else process.env.LAW_OC=saved.LAW_OC||saved.KOREAN_LAW_API_KEY||'';
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
            process = subprocess.Popen(['node', '--input-type=module', '-e', bootstrap, '--', '--live'], cwd=new, env=env, stdout=stream, stderr=stream)
            deadline = time.monotonic() + 120
            while process.poll() is None:
                if time.monotonic() >= deadline:
                    process.terminate(); process.wait(timeout=10); raise RuntimeError('Smoke deadline')
                rows = [tuple(map(int, line.split())) for line in run(['ps', '-eo', 'pid=,ppid=,rss=']).splitlines()]
                pids = {process.pid}
                for _ in range(8):
                    pids |= {pid for pid, parent, rss in rows if parent in pids}
                peak_rss = max(peak_rss, sum(rss * 1024 for pid, parent, rss in rows if pid in pids))
                minimum_available = min(minimum_available, resources()['MemAvailable'])
                time.sleep(.3)
            assert process.returncode == 0
        data = json.loads(output.read_text()); assert data['status'] == 'pass' and data['tool_count'] == 35
        usage = resource.getrusage(resource.RUSAGE_CHILDREN)
        return {'result': data, 'peak_smoke_tree_rss': peak_rss, 'minimum_mem_available': minimum_available,
                'wall_seconds': round(time.monotonic() - started, 3), 'child_cpu_seconds': round(usage.ru_utime + usage.ru_stime - cpu_before, 3)}

    try:
        if mode == 'stage':
            assert not new.exists() and not DROPIN.exists()
            assert prop('WorkingDirectory') == str(OLD)
            assert ENV.stat().st_uid == os.getuid() and ENV.stat().st_mode & 0o777 == 0o600
            expected_closure = previous(); cron_quiet()
            assert config['ci']['head_sha'] == head and config['ci']['conclusion'] == 'success'
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
                source = BASE / ('research-operator-' + pathlib.Path(name).name)
                assert sha(source) == expected
                destination = new / name; assert destination.resolve().is_relative_to(new)
                destination.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(source, destination)
            (new / '.runtime').mkdir(mode=0o700, exist_ok=True)
            with (new / '.runtime/install-taxlaw.log').open('w') as stream:
                subprocess.run(['python3', str(new / 'scripts/install-taxlaw-mcp.py')], cwd=new, check=True, stdout=stream, stderr=stream, timeout=240)
            selected = json.loads((new / '.runtime/taxlaw/active.json').read_text())
            dependency_file = pathlib.Path(selected['cwd']).parent / 'installed-dependencies.txt'
            report.update(installed_dependencies=expected_closure, python_selection=selected, python_dependencies_sha256=sha(dependency_file), python_dependencies=dependency_file.read_text().splitlines())
            candidate()
            event.update(before=before, staged_smoke=smoke(), after=resources(), artifact_sha256=config['artifact_sha256'])
            assert event['staged_smoke']['minimum_mem_available'] > 80 * 1024 * 1024
            conf = '[Service]\nWorkingDirectory=' + str(new) + '\nExecStart=\nExecStart=/usr/bin/node ' + str(new / 'dist/index.js') + '\nReadOnlyPaths=' + str(new) + '\nEnvironmentFile=' + str(ENV) + '\nStateDirectory=legal-harness-corrections\nStateDirectoryMode=0700\nTimeoutStopSec=90\nEnvironment=TAXLAB_RELEASE_COMMIT=' + head + '\n'
            (BASE / ('research-' + head[:12] + '.conf')).write_text(conf)
        elif mode == 'fence':
            assert report['events'][-1]['phase'] == 'stage' and report['events'][-1]['status'] == 'pass'
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
            for name, expected_sha in AUTH_HASHES.items(): assert sha(OLD / name) == expected_sha
            # Existing auth is a reviewed single getUser(jwt) fetch with a 5s
            # AbortSignal, no refresh/retry. All prior client sockets were closed.
            # Wait its bound plus margin, then demand event-loop progress and no
            # work; future ingress remains fenced throughout this observation.
            deadline = time.monotonic() + 60
            samples = []
            while True:
                elapsed = time.monotonic() - report['fenced_monotonic']
                current = health(); samples.append({'elapsed': round(elapsed, 3), 'active': current['active_requests']})
                if elapsed >= 6 and current['active_requests'] == 0:
                    break
                assert time.monotonic() < deadline
                time.sleep(.5)
            assert prop('MainPID') == report['old_pid'] and prop('WorkingDirectory') == str(OLD)
            cron_quiet(); iptables('-C')
            event.update(samples=samples, authentication_bound_ms=5000, authentication_hashes=AUTH_HASHES, status_condition='fenced_connections_closed_auth_bound_elapsed_work_zero')
        elif mode == 'activate':
            assert report['events'][-1]['phase'] == 'drain' and report['events'][-1]['status'] == 'pass'
            iptables('-C'); candidate(); assert prop('MainPID') == report['old_pid'] and health()['active_requests'] == 0
            assert not DROPIN.exists()
            run(['sudo', '-n', 'install', '-m', '0644', str(BASE / ('research-' + head[:12] + '.conf')), str(DROPIN)])
            run(['sudo', '-n', 'systemctl', 'daemon-reload'])
            run(['sudo', '-n', 'systemctl', 'restart', UNIT], timeout=100)
        elif mode == 'verify-candidate':
            iptables('-C'); current = ready(); candidate()
            assert prop('WorkingDirectory') == str(new) and current['release_commit'] == head
            assert current['research_harness']['tools'] == 5
            assert not pathlib.Path('/proc', report['old_pid']).exists()
            state = pathlib.Path('/var/lib/legal-harness-corrections')
            assert state.stat().st_mode & 0o777 == 0o700 and state.stat().st_uid == os.getuid()
            event.update(health=current, smoke=smoke('http://127.0.0.1:3100'), resources=resources(), timeout_stop=prop('TimeoutStopUSec'))
        elif mode == 'rollback':
            iptables('-C')
            # Removing only our override restores the preserved 70-client-guide.
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
        event.update(status='failed', error_type=type(error).__name__)
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
