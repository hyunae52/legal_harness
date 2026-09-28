"""Pure identity/archive checks shared by the fixed GCE deployment controller."""
import hashlib, io, json, re, stat, tarfile, zipfile
from pathlib import PurePosixPath

REPOSITORY = 'hyunae52/legal_harness'
REPOSITORY_ID = 1376493772
WORKFLOW_PATH = '.github/workflows/review.yml'
SHA = re.compile(r'[a-f0-9]{40}')
HASH = re.compile(r'[a-f0-9]{64}')
JOB = re.compile(r'[1-9][0-9]{0,19}(?:-[1-9][0-9]{0,19}){3}')
MAX_ARCHIVE = 32 * 1024 * 1024
REQUIRED_STEPS = ['npm ci --ignore-scripts --omit=optional --no-audit --no-fund',
    'npm run audit:runtime', 'npm run security:secrets', 'npm run review', 'npm run review:package', 'Export tested deployment package']

class Rejected(Exception):
    """Only fixed public-safe codes are reported across the SSH boundary."""

def require(condition, code):
    if not condition: raise Rejected(code)

def command(value):
    match = re.fullmatch(r'(submit|status) ([1-9][0-9]{0,19}(?:-[1-9][0-9]{0,19}){3})', value)
    require(match is not None, 'COMMAND_NOT_ALLOWED')
    return match.group(1), match.group(2)

def verify_run(run, jobs, run_id, attempt):
    require(run.get('id') == run_id and run.get('run_attempt') == attempt, 'RUN_IDENTITY')
    require(run.get('repository', {}).get('id') == REPOSITORY_ID
        and run.get('head_repository', {}).get('id') == REPOSITORY_ID, 'REPOSITORY_IDENTITY')
    require(run.get('event') == 'push' and run.get('head_branch') == 'main'
        and run.get('path') == WORKFLOW_PATH, 'TRIGGER_NOT_APPROVED')
    require(run.get('status') == 'completed' and run.get('conclusion') == 'success', 'REVIEW_NOT_SUCCESSFUL')
    require(isinstance(run.get('head_sha'), str) and SHA.fullmatch(run['head_sha']), 'INVALID_HEAD')
    selected = [j for j in jobs if j.get('name') == 'review / Node 22']
    require(len(selected) == 1, 'REVIEW_JOB_IDENTITY')
    job = selected[0]
    require(job.get('status') == 'completed' and job.get('conclusion') == 'success', 'REVIEW_JOB_FAILED')
    for name in REQUIRED_STEPS:
        steps = [s for s in job.get('steps', []) if s.get('name') == name]
        require(len(steps) == 1 and steps[0].get('status') == 'completed'
            and steps[0].get('conclusion') == 'success', 'REVIEW_STEP_NOT_EXECUTED')
    return run['head_sha']

def select_artifact(artifacts, run_id, attempt, head):
    selected = [a for a in artifacts if a.get('name') == f'law-release-{head}-{attempt}']
    require(len(selected) == 1, 'ARTIFACT_IDENTITY')
    artifact = selected[0]; origin = artifact.get('workflow_run', {})
    require(origin.get('id') == run_id and origin.get('head_sha') == head
        and origin.get('head_branch') == 'main' and origin.get('repository_id') == REPOSITORY_ID
        and origin.get('head_repository_id') == REPOSITORY_ID, 'ARTIFACT_RUN_IDENTITY')
    require(artifact.get('expired') is False and 0 < artifact.get('size_in_bytes', 0) <= MAX_ARCHIVE, 'ARTIFACT_UNAVAILABLE')
    require(re.fullmatch(r'sha256:[a-f0-9]{64}', artifact.get('digest', '')), 'ARTIFACT_DIGEST_REQUIRED')
    return artifact

def decode_bundle(payload, artifact, run_id, attempt, head, protection):
    require(len(payload) <= MAX_ARCHIVE, 'ARTIFACT_SIZE')
    require('sha256:' + hashlib.sha256(payload).hexdigest() == artifact['digest'], 'ARTIFACT_DIGEST_MISMATCH')
    with zipfile.ZipFile(io.BytesIO(payload)) as bundle:
        entries = bundle.infolist()
        require(len(entries) == 2 and {e.filename for e in entries} == {'manifest.json', 'package.tgz'}, 'BUNDLE_MEMBERS')
        require(sum(e.file_size for e in entries) <= MAX_ARCHIVE, 'BUNDLE_SIZE')
        require(all(not e.is_dir() and not stat.S_ISLNK(e.external_attr >> 16) for e in entries), 'BUNDLE_LINK')
        require(bundle.getinfo('manifest.json').file_size < 32_000, 'MANIFEST_SIZE')
        manifest = json.loads(bundle.read('manifest.json'))
        package = bundle.read('package.tgz')
    require(manifest.get('schema_version') == 1 and manifest.get('repository') == REPOSITORY
        and manifest.get('head') == head and manifest.get('run_id') == run_id
        and manifest.get('run_attempt') == attempt, 'MANIFEST_IDENTITY')
    require(manifest.get('protection') == protection, 'MANUAL_OPERATIONS_REQUIRED')
    require(hashlib.sha256(package).hexdigest() == manifest.get('package_sha256'), 'PACKAGE_DIGEST_MISMATCH')
    return manifest, package

def package_files(payload):
    """Return validated regular files; never let tarfile write filesystem paths."""
    with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as bundle:
        entries = bundle.getmembers()
        require(0 < len(entries) <= 2000 and sum(e.size for e in entries) <= 64*1024*1024, 'PACKAGE_SIZE')
        files = {}
        for entry in entries:
            require(entry.isfile() and entry.name.startswith('package/'), 'PACKAGE_MEMBER_TYPE')
            name = entry.name.removeprefix('package/'); path = PurePosixPath(name)
            require(name and path.as_posix() == name and not path.is_absolute() and '..' not in path.parts and '.' not in path.parts
                and '\\' not in name and ':' not in name and name not in files, 'PACKAGE_PATH')
            require(not any(p.startswith('.env') or p in ('.git', '.runtime', 'node_modules') for p in path.parts), 'PRIVATE_PACKAGE_FILE')
            require(path.parts[0] in ('dist', 'rules', 'upstreams', 'scripts')
                or name in ('package.json', 'npm-shrinkwrap.json', 'README.md', 'LICENSE'), 'UNEXPECTED_PACKAGE_FILE')
            files[name] = bundle.extractfile(entry).read()
        require({'dist/index.js', 'package.json', 'npm-shrinkwrap.json', 'upstreams/korean-taxlaw-mcp.json'} <= files.keys(), 'INCOMPLETE_PACKAGE')
        return files
