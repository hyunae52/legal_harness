"""Stage immutable provider selections without touching the running service."""
import hashlib, json, os, pathlib, re, secrets, shutil, signal, socket, subprocess, time, urllib.request
from protocol import require

def version(value):
    require(isinstance(value, str) and re.fullmatch(r'\d+\.\d+\.\d+(?:\.post[1-9]\d*)?', value), 'INVALID_PROVIDER_VERSION')
    parts = tuple(map(int, value.replace('.post', '.').split('.')))
    return parts + (0,) * (4 - len(parts))

def validate_pin(pin, previous):
    require(pin.get('repository') == 'hyunae52/korean-taxlaw-mcp' and pin.get('license') == 'MIT', 'TAX_REPOSITORY')
    require(re.fullmatch(r'[a-f0-9]{40}', pin.get('commit', '')) and re.fullmatch(r'[a-f0-9]{64}', pin.get('archive_sha256', '')), 'TAX_IDENTITY')
    require(pin.get('archive_url') == 'https://codeload.github.com/hyunae52/korean-taxlaw-mcp/zip/' + pin['commit'], 'TAX_ARCHIVE_URL')
    require(version(pin['version']) >= version(previous['version']), 'PROVIDER_DOWNGRADE')
    if pin['version'] == previous['version']:
        require(pin == previous, 'TAX_VERSION_REUSED')

def process_environment(pid):
    require(re.fullmatch(r'[1-9]\d*', pid), 'PROCESS_ID')
    return dict(entry.split('=', 1) for entry in pathlib.Path('/proc', pid, 'environ').read_text().split('\0') if '=' in entry)

def fingerprint(directory):
    """Include source and installed closure; exclude disposable Python bytecode."""
    root = pathlib.Path(directory); digest = hashlib.sha256()
    require(root.is_dir() and not root.is_symlink(), 'TAX_DIRECTORY')
    for path in sorted(root.rglob('*')):
        relative = path.relative_to(root)
        if '__pycache__' in relative.parts or path.suffix in ('.pyc', '.pyo'):
            continue
        if path.is_symlink(): value = 'L:' + os.readlink(path)
        elif path.is_file(): value = 'F:' + hashlib.sha256(path.read_bytes()).hexdigest()
        elif path.is_dir(): continue
        else: raise ValueError('UNSUPPORTED_TAX_FILE')
        digest.update((relative.as_posix() + '\0' + value + '\0').encode())
    return digest.hexdigest()

def prune_stores(root, keep):
    directory = root/'providers'
    if not directory.exists(): return
    for path in directory.iterdir():
        require(not path.is_symlink() and path.resolve().parent == directory.resolve(), 'PROVIDER_CLEANUP_PATH')
        if not path.is_dir() or not re.fullmatch(r'[a-f0-9]{40}', path.name): continue
        if any(path == item or path in item.parents for item in keep): continue
        marker = path/'.provider.json'
        if not marker.is_file(): continue
        require(json.loads(marker.read_text()) == {'owner':'legal-harness-autodeploy','commit':path.name}, 'PROVIDER_CLEANUP_OWNER')
        shutil.rmtree(path)

def stage(candidate, previous, environment, root, binary, log_directory, expected_fingerprint=None):
    read = lambda path: json.loads(pathlib.Path(path).read_text())
    package, old_package = read(candidate/'package.json'), read(previous/'package.json')
    law = package['dependencies']['korean-law-mcp']
    require(version(law) >= version(old_package['dependencies']['korean-law-mcp']), 'PROVIDER_DOWNGRADE')
    pin, old_pin = read(candidate/'upstreams/korean-taxlaw-mcp.json'), read(previous/'upstreams/korean-taxlaw-mcp.json')
    validate_pin(pin, old_pin)
    old_tax = read(environment['TAXLAW_MCP_RELEASE_FILE'])
    require(old_tax['commit'] == old_pin['commit'] and old_tax['version'] == old_pin['version'], 'OLD_TAX_SELECTION')
    old_root = pathlib.Path(old_tax['cwd']).parent
    require(expected_fingerprint and fingerprint(old_root) == expected_fingerprint, 'TAX_INSTALLED_FILES_CHANGED')
    safe = {key: os.environ[key] for key in ('PATH','HOME','USER','LANG') if key in os.environ}
    safe.update(PYTHONDONTWRITEBYTECODE='1', PIP_NO_CACHE_DIR='1')
    if pin['commit'] == old_pin['commit']:
        tax = old_tax
    else:
        store = root/'providers'/pin['commit']
        # A failed previous install is rebuilt; never remove the active provider.
        require(not store.exists(), 'PROVIDER_CANDIDATE_ALREADY_EXISTS')
        store.mkdir(parents=True, mode=0o750)
        (store/'.provider.json').write_text(json.dumps({'owner':'legal-harness-autodeploy','commit':pin['commit']}))
        with (log_directory/'tax-install.log').open('w') as log:
            subprocess.run(['python3', str(binary/'install-taxlaw-mcp.py'), '--pin', str(candidate/'upstreams/korean-taxlaw-mcp.json'), '--directory', str(store)],
                env=safe, stdout=log, stderr=log, timeout=360, check=True)
        tax = read(store/'active.json')
    require(tax['commit'] == pin['commit'] and tax['version'] == pin['version'], 'TAX_INSTALL_IDENTITY')
    selection = candidate/'providers'; selection.mkdir()
    law_file, tax_file = selection/'law.json', selection/'tax.json'
    law_file.write_text(json.dumps({'version':law,'entrypoint':str(candidate/'node_modules/korean-law-mcp/build/index.js')}))
    tax_file.write_text(json.dumps(tax))
    values = {'KOREAN_LAW_MCP_RELEASE_FILE':str(law_file), 'TAXLAW_MCP_RELEASE_FILE':str(tax_file)}
    env_file = selection/'provider.env'; env_file.write_text(''.join(k+'='+v+'\n' for k,v in values.items()))
    hashes = {str(path):hashlib.sha256(path.read_bytes()).hexdigest() for path in (law_file,tax_file,env_file)}
    return {'law':law,'tax_commit':pin['commit'],'tax_version':pin['version'], 'environment':values,
            'env_file':str(env_file), 'manifest_hashes':hashes, 'tax_root':str(pathlib.Path(tax['cwd']).parent),
            'tax_fingerprint':fingerprint(pathlib.Path(tax['cwd']).parent)}

def verify(selection):
    for name, expected in selection['manifest_hashes'].items():
        require(hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest() == expected, 'PROVIDER_MANIFEST_CHANGED')
    require(fingerprint(selection['tax_root']) == selection['tax_fingerprint'], 'TAX_INSTALLED_FILES_CHANGED')

def preflight(candidate, selection, current_environment, binary, log_directory):
    # Candidate gets only the public-source credential. No DB/GitHub/SMTP tokens.
    env = {k:os.environ[k] for k in ('PATH','HOME','USER','LANG') if k in os.environ}
    for key in ('LAW_OC','KOREAN_LAW_API_KEY','LAW_API_PROTOCOL','MCP_MAX_UPSTREAM_BODY_BYTES','MCP_MAX_TOTAL_UPSTREAM_BODY_BYTES'):
        if key in current_environment: env[key] = current_environment[key]
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1',0)); port = str(reservation.getsockname()[1])
    identity = secrets.token_hex(20)
    env.update(selection['environment'], HOST='127.0.0.1', PORT=port, TAXLAB_PUBLIC_ACCESS='1',
               TAXLAB_PUBLIC_SESSION_SECRET=secrets.token_hex(32), TAXLAB_RELEASE_COMMIT=identity, PYTHONDONTWRITEBYTECODE='1')
    with (log_directory/'provider-preflight.log').open('w') as log:
        child = subprocess.Popen(['node', str(candidate/'dist/index.js')], cwd=candidate, env=env, stdout=log, stderr=log, start_new_session=True)
        try:
            until = time.monotonic() + 30
            while True:
                require(child.poll() is None, 'PREFLIGHT_PROCESS_EXITED')
                try:
                    with urllib.request.urlopen('http://127.0.0.1:'+port+'/health', timeout=2) as response: health = json.load(response)
                    require(health.get('release_commit') == identity and health['mcp_release'] == selection['law']
                        and health['taxlaw_release']['commit'] == selection['tax_commit'], 'PREFLIGHT_VERSION')
                    break
                except (OSError, ValueError):
                    require(time.monotonic() < until, 'PREFLIGHT_NOT_READY'); time.sleep(.3)
            result = subprocess.run(['python3', str(binary/'smoke.py')], env={**env,'SMOKE_PORT':port}, capture_output=True, text=True, timeout=180, check=True)
            report = json.loads(result.stdout); require(report['status'] == 'pass', 'PREFLIGHT_RETRIEVAL_FAILED')
            return report
        finally:
            try: os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError: pass
            try: child.wait(timeout=10)
            except subprocess.TimeoutExpired: pass
            try: os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            child.wait(timeout=10)
