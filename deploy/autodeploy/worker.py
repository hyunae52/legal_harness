"""Fixed GCE controller. The SSH receiver never evaluates uploaded commands."""
import datetime, hashlib, json, os, pathlib, shutil, subprocess, sys, time, urllib.error, urllib.parse, urllib.request
from protocol import REPOSITORY, REPOSITORY_ID, JOB, MAX_ARCHIVE, Rejected, require, verify_run, select_artifact, decode_bundle, package_files

ROOT = pathlib.Path('/home/cta/legal-harness-autodeploy')
BIN = pathlib.Path('/opt/legal-harness-deployer')
SERVICE = 'legal-harness-a.service'
DROPIN = pathlib.Path('/etc/systemd/system/legal-harness-a.service.d/zzzzzz-auto-deploy.conf')
MARKER = ROOT / 'maintenance.json'
RULE = ['OUTPUT','-o','lo','-p','tcp','-d','127.0.0.1','--dport','3100','-m','owner','--uid-owner','0','-m','comment','--comment','legal-harness-autodeploy','-j','REJECT','--reject-with','tcp-reset']

def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def save(path, value):
    temporary = path.with_suffix(path.suffix + '.pending')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    os.replace(temporary, path)
def run(args, timeout=60, **kwargs):
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE, timeout=timeout, **kwargs).strip()
def prop(name, service=SERVICE): return run(['systemctl','show',service,'--property='+name,'--value'])
def health():
    with urllib.request.urlopen('http://127.0.0.1:3100/health', timeout=5) as response: return json.load(response)

def cleanup_token(job):
    require(JOB.fullmatch(job),'INVALID_JOB')
    (ROOT/'jobs'/job/'token').unlink(missing_ok=True)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None

class GitHub:
    def __init__(self, token): self.token = token
    def get(self, suffix):
        require(not suffix.startswith('/') and '..' not in suffix, 'INVALID_GITHUB_PATH')
        request = urllib.request.Request('https://api.github.com/repos/'+REPOSITORY+'/'+suffix,
            headers={'Authorization':'Bearer '+self.token,'Accept':'application/vnd.github+json','User-Agent':'TaxLab-GCE-deployer'})
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = response.read(2*1024*1024+1)
        require(len(payload)<=2*1024*1024, 'GITHUB_RESPONSE_SIZE')
        return json.loads(payload)
    def archive(self, artifact_id):
        request = urllib.request.Request(f'https://api.github.com/repos/{REPOSITORY}/actions/artifacts/{artifact_id}/zip',
            headers={'Authorization':'Bearer '+self.token,'User-Agent':'TaxLab-GCE-deployer'})
        try:
            urllib.request.build_opener(NoRedirect).open(request,timeout=30)
            raise Rejected('ARTIFACT_REDIRECT_REQUIRED')
        except urllib.error.HTTPError as error:
            require(error.code == 302, 'ARTIFACT_DOWNLOAD_REJECTED')
            location=error.headers['Location']
        parsed=urllib.parse.urlsplit(location)
        require(parsed.scheme=='https' and parsed.hostname and not parsed.username and not parsed.password, 'ARTIFACT_DOWNLOAD_URL')
        # Signed storage URLs get no GitHub Authorization header.
        with urllib.request.urlopen(location,timeout=60) as response: payload=response.read(MAX_ARCHIVE+1)
        require(len(payload)<=MAX_ARCHIVE,'ARTIFACT_SIZE')
        return payload

class Deployment:
    def __init__(self, job):
        require(JOB.fullmatch(job), 'INVALID_JOB')
        self.job=job; self.directory=ROOT/'jobs'/job
        self.config=json.loads((BIN/'config.json').read_text())
        self.record=self.directory/'record.json'
        self.data=json.loads(self.record.read_text()) if self.record.exists() else {'job':job,'events':[]}
    def github(self):
        token=(self.directory/'token').read_text().strip()
        require(20<=len(token)<=4096 and not any(c.isspace() for c in token),'INVALID_TOKEN')
        return GitHub(token)
    def state(self, status, **extra):
        save(self.directory/'status.json',{'job':self.job,'status':status,'updated_at':now(),**extra})
    @property
    def candidate(self): return ROOT/'releases'/self.data['head']
    def providers(self):
        for path,expected in self.config['provider_manifests'].items(): require(sha(pathlib.Path(path))==expected,'PROVIDER_SELECTION_CHANGED')
    def files(self):
        for name,expected in self.data['files'].items():
            path=self.candidate/name
            require(path.resolve().is_relative_to(self.candidate) and sha(path)==expected,'INSTALLED_FILE_MISMATCH')
    def dependencies(self,path):
        code="import {fingerprintDependencies} from '/opt/legal-harness-deployer/installed-dependencies.mjs';console.log(JSON.stringify(fingerprintDependencies(process.argv[1])));"
        return json.loads(run(['node','--input-type=module','-e',code,str(path/'node_modules')]))
    def ready(self, expected):
        until=time.monotonic()+30
        while True:
            try:
                h=health()
                require(h['status']=='ok' and h['release_commit']==expected,'RELEASE_NOT_READY')
                require(h['access_mode']=='public' and h['correction_pr']=='available','RUNTIME_POLICY_CHANGED')
                require(h['mcp_release']==self.config['protection']['law_version']
                    and h['taxlaw_release']['commit']==self.config['tax_commit'],'PROVIDER_VERSION_CHANGED')
                return h
            except Exception:
                if time.monotonic()>=until: raise
                time.sleep(.3)
    def idle(self):
        until=time.monotonic()+60
        while True:
            h=health(); counts={k:h[k] for k in ['active_requests','active_authentications','active_dispatches']}
            if not any(counts.values()): return counts
            require(time.monotonic()<until,'DRAIN_TIMEOUT'); time.sleep(.2)
    def fence(self, action):
        args=[RULE[0],'1',*RULE[1:]] if action=='-I' else RULE
        return run(['sudo','-n','/usr/sbin/iptables','-w','5',action,*args])
    def fence_present(self):
        result=subprocess.run(['sudo','-n','/usr/sbin/iptables','-w','5','-C',*RULE],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        require(result.returncode in (0,1),'FENCE_STATE_UNKNOWN'); return result.returncode==0
    def safe_remove_release(self,path,keep):
        require(path.parent==ROOT/'releases' and not path.is_symlink() and path.resolve().parent==(ROOT/'releases').resolve(),'CLEANUP_PATH')
        if str(path) in keep: return
        marker=path/'.release.json'
        if not marker.is_file(): return
        owner=json.loads(marker.read_text())
        require(owner=={'owner':'legal-harness-autodeploy','head':path.name},'CLEANUP_OWNERSHIP')
        require(len(path.name)==40 and all(c in '0123456789abcdef' for c in path.name),'CLEANUP_NAME')
        shutil.rmtree(path)
    def stage(self):
        require(not MARKER.exists() and not self.fence_present(),'OPERATOR_RECOVERY_REQUIRED')
        run_id,attempt,_,_=map(int,self.job.split('-')); gh=self.github()
        source=gh.get(f'actions/runs/{run_id}/attempts/{attempt}')
        jobs=gh.get(f'actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100')
        require(jobs.get('total_count',101)<=100,'TOO_MANY_JOBS')
        head=verify_run(source,jobs['jobs'],run_id,attempt); self.data['head']=head
        if gh.get('git/ref/heads/main')['object']['sha']!=head: return {'superseded':True}
        artifacts=gh.get(f'actions/runs/{run_id}/artifacts?per_page=100')
        require(artifacts.get('total_count',101)<=100,'TOO_MANY_ARTIFACTS')
        artifact=select_artifact(artifacts['artifacts'],run_id,attempt,head)
        manifest,package=decode_bundle(gh.archive(artifact['id']),artifact,run_id,attempt,head,self.config['protection'])
        self.providers(); current=health()
        if current.get('release_commit')==head:
            self.ready(head); return {'already_active':True}
        previous=pathlib.Path(prop('WorkingDirectory'))
        require(previous.is_dir() and previous.is_absolute(),'PREVIOUS_RELEASE_MISSING')
        self.ready(current['release_commit'])
        self.data.update(previous_path=str(previous),previous_head=current['release_commit'],previous_entry=sha(previous/'dist/index.js'),
            previous_config=DROPIN.read_text() if DROPIN.exists() else None,previous_pid=prop('MainPID'),
            artifact_digest=artifact['digest'],package_sha256=manifest['package_sha256'])
        root=ROOT/'releases'; root.mkdir(exist_ok=True)
        active=json.loads((ROOT/'active.json').read_text()) if (ROOT/'active.json').exists() else {}
        self.data['previous_active']=active
        expected=active.get('dependencies') if active.get('path')==str(previous) else self.config.get('initial_dependencies') if self.config.get('initial_path')==str(previous) else None
        require(expected and self.dependencies(previous)==expected,'PREVIOUS_DEPENDENCIES_CHANGED')
        keep={str(previous),active.get('previous_path','')}
        for path in root.iterdir():
            if path.is_dir(): self.safe_remove_release(path,keep)
        require(not self.candidate.exists(),'CANDIDATE_ALREADY_EXISTS')
        available=next(int(s.split()[1])*1024 for s in pathlib.Path('/proc/meminfo').read_text().splitlines() if s.startswith('MemAvailable:'))
        require(shutil.disk_usage(ROOT).free>400*1024*1024 and available>200*1024*1024,'INSUFFICIENT_RESOURCES')
        files=package_files(package)
        self.candidate.mkdir(mode=0o750); save(self.candidate/'.release.json',{'owner':'legal-harness-autodeploy','head':head})
        self.data['files']={name:hashlib.sha256(content).hexdigest() for name,content in files.items()}
        for name,content in files.items():
            target=self.candidate/name; require(target.resolve().is_relative_to(self.candidate),'PACKAGE_PATH')
            target.parent.mkdir(parents=True,exist_ok=True); target.write_bytes(content)
        if sha(previous/'npm-shrinkwrap.json')==sha(self.candidate/'npm-shrinkwrap.json'):
            shutil.copytree(previous/'node_modules',self.candidate/'node_modules',symlinks=True)
            self.data['dependency_install']='reused_unchanged_lock'
            require(self.dependencies(self.candidate)==expected,'COPIED_DEPENDENCIES_CHANGED')
        else:
            safe={k:os.environ[k] for k in ['PATH','HOME','USER','LANG'] if k in os.environ}
            safe.update(NPM_CONFIG_USERCONFIG='/dev/null',NPM_CONFIG_IGNORE_SCRIPTS='true')
            with (self.directory/'npm-install.log').open('w') as log:
                subprocess.run(['npm','ci','--ignore-scripts','--omit=dev','--omit=optional','--no-audit','--no-fund'],cwd=self.candidate,env=safe,
                    stdout=log,stderr=log,timeout=240,check=True)
            self.data['dependency_install']='locked_npm_ci'
        self.data['dependencies']=self.dependencies(self.candidate)
        self.files()
        require(json.loads((self.candidate/'node_modules/korean-law-mcp/package.json').read_text())['version']==self.config['protection']['law_version'],'LAW_DEPENDENCY_VERSION')
        conf='[Service]\nWorkingDirectory='+str(self.candidate)+'\nExecStart=\nExecStart=/usr/bin/node '+str(self.candidate/'dist/index.js')+'\nReadOnlyPaths='+str(self.candidate)+'\nEnvironment=TAXLAB_RELEASE_COMMIT='+head+'\n'
        (self.directory/'candidate.conf').write_text(conf)
        return {'head':head,'package_sha256':manifest['package_sha256']}
    def phase_fence(self):
        require(self.github().get('git/ref/heads/main')['object']['sha']==self.data['head'],'SUPERSEDED_BEFORE_ACTIVATION')
        self.providers(); self.files(); self.ready(self.data['previous_head'])
        require(prop('WorkingDirectory')==self.data['previous_path'] and prop('MainPID')==self.data['previous_pid'],'PREVIOUS_STATE_CHANGED')
        require(prop('User','cloudflared.service') in ('','root'),'INGRESS_USER_CHANGED')
        require(not MARKER.exists() and not self.fence_present(),'OPERATOR_RECOVERY_REQUIRED')
        save(MARKER,{'job':self.job,'head':self.data['head']})
        self.fence('-I'); self.fence('-C')
        run(['sudo','-n','python3','-c',"import socket;s=socket.socket();s.settimeout(2);assert s.connect_ex(('127.0.0.1',3100))!=0"])
        run(['sudo','-n','ss','-K','dst','127.0.0.1','dport','=',':3100'])
        (self.directory/'token').unlink(missing_ok=True)
        return {'ingress':'fenced'}
    def phase_drain(self): self.fence('-C'); return {'counters':self.idle()}
    def phase_activate(self):
        require(self.data['events'][-1]['phase']=='drain' and self.data['events'][-1]['status']=='pass','DRAIN_NOT_VERIFIED')
        self.fence('-C'); self.idle(); self.files(); self.providers()
        run(['sudo','-n','install','-m','0644',str(self.directory/'candidate.conf'),str(DROPIN)])
        run(['sudo','-n','systemctl','daemon-reload']); run(['sudo','-n','systemctl','restart',SERVICE],timeout=100)
        return {}
    def phase_verify_candidate(self):
        self.fence('-C'); h=self.ready(self.data['head']); self.files(); self.providers()
        require(prop('WorkingDirectory')==str(self.candidate),'CANDIDATE_PROCESS_PATH')
        require(not pathlib.Path('/proc',self.data['previous_pid']).exists(),'PREVIOUS_PROCESS_ALIVE')
        result=json.loads(run(['python3',str(BIN/'smoke.py')],timeout=180))
        require(result['status']=='pass','MCP_SMOKE_FAILED')
        # Commit the next deployment's baseline before opening public traffic.
        # A crash after resume must not leave an active release with no baseline.
        save(ROOT/'active.json',{'head':self.data['head'],'path':str(self.candidate),'previous_path':self.data['previous_path'],
            'dependencies':self.data['dependencies'],'job':self.job})
        return {'health':h,'smoke':result}
    def phase_rollback(self):
        self.fence('-C')
        if DROPIN.exists():
            require(DROPIN.read_text() in ((self.directory/'candidate.conf').read_text(),self.data['previous_config']),'DROPIN_CHANGED')
        # Public ingress is still fenced and smoke performs only reads. A broken
        # candidate's health endpoint cannot be a prerequisite for restoring it.
        require(prop('KillMode')=='control-group','PROCESS_CLEANUP_POLICY_CHANGED')
        run(['sudo','-n','systemctl','stop',SERVICE],timeout=100)
        require(prop('MainPID')=='0','CANDIDATE_PROCESS_ALIVE')
        if self.data['previous_config'] is None:
            if DROPIN.exists():
                require(self.data['head'] in DROPIN.read_text(),'DROPIN_CHANGED')
                run(['sudo','-n','rm','--',str(DROPIN)])
        else:
            backup=self.directory/'previous.conf'; backup.write_text(self.data['previous_config'])
            run(['sudo','-n','install','-m','0644',str(backup),str(DROPIN)])
        run(['sudo','-n','systemctl','daemon-reload']); run(['sudo','-n','systemctl','restart',SERVICE],timeout=100)
        return {}
    def phase_verify_previous(self):
        self.providers(); h=self.ready(self.data['previous_head'])
        require(prop('WorkingDirectory')==self.data['previous_path'] and sha(pathlib.Path(self.data['previous_path'])/'dist/index.js')==self.data['previous_entry'],'PREVIOUS_RELEASE_MISMATCH')
        if self.data['previous_active']:save(ROOT/'active.json',self.data['previous_active'])
        else:(ROOT/'active.json').unlink(missing_ok=True)
        return {'health':h}
    def phase_resume(self):
        previous=self.data['events'][-1]
        require(previous['phase'] in ('verify-candidate','verify-previous') and previous['status']=='pass','RESUME_NOT_VERIFIED')
        if MARKER.exists():
            require(json.loads(MARKER.read_text())['job']==self.job,'MAINTENANCE_OWNER_MISMATCH')
        if self.fence_present(): self.fence('-D')
        MARKER.unlink(missing_ok=True)
        return {'public_resumed':True}
    def phase(self,name):
        require(name in ('stage','fence','drain','activate','verify-candidate','rollback','verify-previous','resume'),'INVALID_PHASE')
        self.state('running',phase=name,head=self.data.get('head'))
        event={'phase':name,'started_at':now()}
        try:
            event.update(self.stage() if name=='stage' else getattr(self,'phase_'+name.replace('-','_'))())
            event['status']='pass'
        except Exception as error:
            event.update(status='failed',error_code=str(error) if isinstance(error,Rejected) else type(error).__name__)
            # Killing systemctl's client cannot cancel a job already queued in PID 1.
            # The shared rollout gate must not race it with rollback or resume.
            if isinstance(error,subprocess.TimeoutExpired):event['operation_state_unknown']=True
        finally:
            event['finished_at']=now(); self.data['events'].append(event); save(self.record,self.data)
            print(json.dumps(event),flush=True)
        return event

def execute(job):
    import fcntl
    deployment=Deployment(job)
    with (ROOT/'deployment.lock').open('a') as lock:
        try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            deployment.state('failed',error_code='DEPLOYMENT_BUSY')
            (deployment.directory/'token').unlink(missing_ok=True)
            return 1
        try:
            event=deployment.phase('stage')
            if event['status']!='pass': deployment.state('failed',error_code=event['error_code']); return 1
            if event.get('superseded'): deployment.state('superseded',head=deployment.data['head']); return 0
            if event.get('already_active'): deployment.state('deployed',head=deployment.data['head'],reused=True); return 0
            result=subprocess.run(['node',str(BIN/'run.mjs'),job],timeout=900,capture_output=True,text=True)
            require((deployment.directory/'rollout.json').is_file(),'ROLLOUT_RESULT_MISSING')
            outcome=json.loads((deployment.directory/'rollout.json').read_text())
            success=outcome['status']=='candidate_active_verified' and outcome['public_resumed'] is True
            deployment.state('deployed' if success else 'failed',head=deployment.data['head'],rollout=outcome)
            return 0 if success else 1
        except Exception as error:
            deployment.state('failed',error_code=str(error) if isinstance(error,Rejected) else type(error).__name__,operator_check_required=MARKER.exists())
            return 1
        finally: (deployment.directory/'token').unlink(missing_ok=True)

if __name__=='__main__':
    os.umask(0o077)
    if len(sys.argv)==3 and sys.argv[1]=='cleanup': cleanup_token(sys.argv[2]); raise SystemExit(0)
    if len(sys.argv)==3 and sys.argv[1]=='execute': raise SystemExit(execute(sys.argv[2]))
    if len(sys.argv)==4 and sys.argv[1]=='phase': raise SystemExit(0 if Deployment(sys.argv[2]).phase(sys.argv[3])['status']=='pass' else 1)
    raise SystemExit(2)
