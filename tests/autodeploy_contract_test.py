import contextlib, copy, hashlib, io, json, pathlib, subprocess, sys, tarfile, tempfile, unittest, zipfile
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'deploy/autodeploy'))
import protocol as p
import worker as w
import receiver as receiver

HEAD='a'*40
PROTECTION={'migrations':'1'*64,'deployer':'2'*64,'tax_provider':'3'*64,'law_version':'4.14.2'}
def run_fixture():
    source={'id':7,'run_attempt':2,'repository':{'id':p.REPOSITORY_ID},'head_repository':{'id':p.REPOSITORY_ID},
        'event':'push','head_branch':'main','path':p.WORKFLOW_PATH,'head_sha':HEAD,'status':'completed','conclusion':'success'}
    jobs=[{'name':'review / Node 22','status':'completed','conclusion':'success',
        'steps':[{'name':n,'status':'completed','conclusion':'success'} for n in p.REQUIRED_STEPS]}]
    return source,jobs
def artifact_fixture():
    return {'id':8,'name':f'law-release-{HEAD}-2','expired':False,'size_in_bytes':1000,'digest':'sha256:'+'0'*64,
        'workflow_run':{'id':7,'head_sha':HEAD,'head_branch':'main','repository_id':p.REPOSITORY_ID,'head_repository_id':p.REPOSITORY_ID}}
def zip_fixture(package=b'synthetic-package', mutate=None, extra=None):
    manifest={'schema_version':1,'repository':p.REPOSITORY,'head':HEAD,'run_id':7,'run_attempt':2,
        'package_sha256':hashlib.sha256(package).hexdigest(),'protection':copy.deepcopy(PROTECTION)}
    if mutate: mutate(manifest)
    out=io.BytesIO()
    with zipfile.ZipFile(out,'w') as z:
        z.writestr('manifest.json',json.dumps(manifest));z.writestr('package.tgz',package)
        if extra:z.writestr(extra,b'x')
    payload=out.getvalue();a=artifact_fixture();a['digest']='sha256:'+hashlib.sha256(payload).hexdigest()
    return payload,a
def tar_fixture(extra=None,kind=None):
    out=io.BytesIO()
    with tarfile.open(fileobj=out,mode='w:gz') as t:
        for name in ['dist/index.js','package.json','npm-shrinkwrap.json','upstreams/korean-taxlaw-mcp.json']:
            e=tarfile.TarInfo('package/'+name);e.size=2;t.addfile(e,io.BytesIO(b'{}'))
        if extra:
            e=tarfile.TarInfo(extra);e.size=1
            if kind:e.type=kind;e.linkname='/outside'
            t.addfile(e,io.BytesIO(b'x'))
    return out.getvalue()

class DeploymentContract(unittest.TestCase):
    def test_approved_main_run(self):
        source,jobs=run_fixture();self.assertEqual(p.verify_run(source,jobs,7,2),HEAD)
    def test_unapproved_trigger_or_identity(self):
        for key,value in [('event','pull_request'),('event','schedule'),('head_branch','feature'),('path','.github/workflows/other.yml'),
            ('conclusion','failure'),('conclusion','cancelled'),('status','in_progress'),('id',9),('run_attempt',1),('head_sha','bad')]:
            with self.subTest(key=key,value=value):
                source,jobs=run_fixture();source[key]=value
                with self.assertRaises(p.Rejected):p.verify_run(source,jobs,7,2)
    def test_fork_cannot_supply_artifact(self):
        for field in ['repository','head_repository']:
            source,jobs=run_fixture();source[field]['id']=123
            with self.assertRaises(p.Rejected):p.verify_run(source,jobs,7,2)
    def test_every_required_gate_really_ran(self):
        for name in p.REQUIRED_STEPS:
            with self.subTest(gate=name):
                source,jobs=run_fixture();next(s for s in jobs[0]['steps'] if s['name']==name)['conclusion']='skipped'
                with self.assertRaises(p.Rejected):p.verify_run(source,jobs,7,2)
    def test_duplicate_gate_and_job_rejected(self):
        source,jobs=run_fixture();jobs[0]['steps'].append(copy.deepcopy(jobs[0]['steps'][0]))
        with self.assertRaises(p.Rejected):p.verify_run(source,jobs,7,2)
        source,jobs=run_fixture();jobs.append(copy.deepcopy(jobs[0]))
        with self.assertRaises(p.Rejected):p.verify_run(source,jobs,7,2)
    def test_artifact_matches_exact_attempt(self):
        a=artifact_fixture();self.assertEqual(p.select_artifact([a],7,2,HEAD)['id'],8)
        for field,value in [('name',f'law-release-{HEAD}-1'),('expired',True),('digest',''),('size_in_bytes',p.MAX_ARCHIVE+1)]:
            b=copy.deepcopy(a);b[field]=value
            with self.assertRaises(p.Rejected):p.select_artifact([b],7,2,HEAD)
    def test_artifact_cannot_claim_another_run_or_fork(self):
        for field,value in [('id',9),('head_sha','b'*40),('head_branch','feature'),('repository_id',1),('head_repository_id',2)]:
            a=artifact_fixture();a['workflow_run'][field]=value
            with self.assertRaises(p.Rejected):p.select_artifact([a],7,2,HEAD)
    def test_bundle_from_github_digest(self):
        payload,a=zip_fixture();manifest,package=p.decode_bundle(payload,a,7,2,HEAD,PROTECTION)
        self.assertEqual(package,b'synthetic-package');self.assertEqual(manifest['head'],HEAD)
        with self.assertRaises(p.Rejected):p.decode_bundle(payload+b'tamper',a,7,2,HEAD,PROTECTION)
    def test_manifest_identity_and_package_bytes(self):
        for key,value in [('head','b'*40),('repository','fork/legal_harness'),('run_id',8),('run_attempt',1),('schema_version',2),('package_sha256','0'*64)]:
            payload,a=zip_fixture(mutate=lambda m:m.update({key:value}))
            with self.assertRaises(p.Rejected):p.decode_bundle(payload,a,7,2,HEAD,PROTECTION)
    def test_operations_outside_auto_scope_stop_before_activation(self):
        for field in PROTECTION:
            payload,a=zip_fixture(mutate=lambda m:m['protection'].update({field:'changed'}))
            with self.assertRaisesRegex(p.Rejected,'MANUAL_OPERATIONS_REQUIRED'):p.decode_bundle(payload,a,7,2,HEAD,PROTECTION)
    def test_extra_zip_paths_rejected(self):
        payload,a=zip_fixture(extra='../escape')
        with self.assertRaises(p.Rejected):p.decode_bundle(payload,a,7,2,HEAD,PROTECTION)
    def test_tar_regular_files_and_required_entrypoints(self):
        self.assertEqual(len(p.package_files(tar_fixture())),4)
    def test_tar_path_and_private_file_injection(self):
        for path in ['package/../../escape','package//absolute','package/dist/./index.js','package/dist//other.js',
            'package/.env','package/dist/.env.secret','package/node_modules/code.js','package/dist\\bad','outside/file','package/README.md/../../escape']:
            with self.subTest(path=path):
                with self.assertRaises(p.Rejected):p.package_files(tar_fixture(path))
    def test_tar_symlinks_and_hardlinks_rejected(self):
        for kind in [tarfile.SYMTYPE,tarfile.LNKTYPE]:
            with self.assertRaises(p.Rejected):p.package_files(tar_fixture('package/dist/link',kind))
    def test_ssh_command_boundary(self):
        self.assertEqual(p.command('submit 7-2-8-1'),('submit','7-2-8-1'))
        for value in ['bash','submit 7-2-8-1; id','status ../../etc/passwd','status 7-2-8-1\nwhoami','status 0-2-8-1','scp -t /tmp/a','submit 7-2-8-1 extra']:
            with self.assertRaises(p.Rejected):p.command(value)
    def test_resume_requires_successful_verification(self):
        d=object.__new__(w.Deployment);d.job='7-2-8-1';d.data={'events':[{'phase':'activate','status':'pass'}]}
        with self.assertRaisesRegex(p.Rejected,'RESUME_NOT_VERIFIED'):d.phase_resume()
    def test_systemd_timeout_is_uncertain_even_after_local_command_is_killed(self):
        with tempfile.TemporaryDirectory() as temp:
            d=object.__new__(w.Deployment);d.job='7-2-8-1';d.directory=pathlib.Path(temp)
            d.record=d.directory/'record.json';d.data={'events':[]}
            def restart():raise subprocess.TimeoutExpired(['systemctl','restart',w.SERVICE],100)
            d.phase_activate=restart
            with contextlib.redirect_stdout(io.StringIO()):event=d.phase('activate')
            self.assertEqual(event['status'],'failed')
            self.assertTrue(event.get('operation_state_unknown'))
    def test_verified_baseline_survives_worker_exit_after_resume_and_restores_on_rollback(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp);d=object.__new__(w.Deployment);d.job='7-2-8-1';d.directory=root/'job';d.directory.mkdir()
            d.record=d.directory/'record.json';previous=root/'previous';(previous/'dist').mkdir(parents=True)
            (previous/'dist/index.js').write_text('old')
            prior={'head':'b'*40,'path':str(previous),'dependencies':{'sha256':'old'}}
            d.data={'events':[],'head':HEAD,'previous_pid':'999999999','previous_path':str(previous),'previous_head':'b'*40,
                'previous_entry':w.sha(previous/'dist/index.js'),'dependencies':{'sha256':'new'},'previous_active':prior,
                'files':{},'package_sha256':'4'*64,'artifact_digest':'sha256:'+'5'*64}
            d.fence=lambda action:None;d.fence_present=lambda:True;d.files=lambda:None;d.providers=lambda *args:None;d.ready=lambda head:{'release_commit':head}
            with patch.object(w,'ROOT',root),patch.object(w,'MARKER',root/'maintenance.json'),patch.object(w,'run',return_value='{"status":"pass"}'),contextlib.redirect_stdout(io.StringIO()):
                with patch.object(w,'prop',return_value=str(d.candidate)):
                    self.assertEqual(d.phase('verify-candidate')['status'],'pass')
                    self.assertEqual(json.loads((root/'active.json').read_text())['head'],HEAD)
                    d.phase_resume()
                    self.assertEqual(json.loads((root/'active.json').read_text())['dependencies'],{'sha256':'new'})
                with patch.object(w,'prop',return_value=str(previous)):
                    d.phase_verify_previous();self.assertEqual(json.loads((root/'active.json').read_text()),prior)
    def test_unhealthy_candidate_can_roll_back_without_a_working_health_endpoint(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp);d=object.__new__(w.Deployment);d.directory=root
            d.data={'head':HEAD,'previous_config':None};(root/'candidate.conf').write_text(HEAD)
            dropin=root/'dropin.conf';dropin.write_text(HEAD)
            d.fence=lambda a:None;d.idle=lambda:(_ for _ in ()).throw(ConnectionError('unhealthy candidate'))
            calls=[]
            values={'KillMode':'control-group','MainPID':'0','ActiveState':'inactive','ControlGroup':'','Job':''}
            with patch.object(w,'DROPIN',dropin),patch.object(w,'prop',side_effect=lambda name:values[name]),patch.object(w,'run',side_effect=lambda args,**kwargs:calls.append(args)):
                d.phase_rollback()
            stop=['sudo','-n','systemctl','stop',w.SERVICE];restart=['sudo','-n','systemctl','restart',w.SERVICE]
            self.assertIn(stop,calls);self.assertIn(restart,calls);self.assertLess(calls.index(stop),calls.index(restart))
            for field,value in [('MainPID','123'),('ActiveState','active'),('Job','pending-job')]:
                with self.subTest(field=field),patch.object(w,'DROPIN',dropin),patch.object(w,'prop',side_effect=lambda name:{**values,field:value}[name]),patch.object(w,'run',side_effect=lambda args,**kwargs:calls.append(args)):
                    calls.clear()
                    with self.assertRaises(p.Rejected):d.phase_rollback()
                    self.assertNotIn(restart,calls)
    def test_stop_post_cleanup_works_without_record_or_configuration(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp);job=root/'jobs/7-2-8-1';job.mkdir(parents=True);token=job/'token';token.write_text('synthetic')
            with patch.object(w,'ROOT',root):
                with self.assertRaises(p.Rejected):w.cleanup_token('../../outside')
                self.assertTrue(token.exists());w.cleanup_token('7-2-8-1');self.assertFalse(token.exists())
                w.cleanup_token('7-2-8-1')
            for state in ['queued','running','deployed']:
                token.write_text('synthetic');status=job/'status.json';status.write_text(json.dumps({'job':'7-2-8-1','status':state}))
                marker=root/'maintenance.json';marker.write_text('{}')
                with patch.object(w,'ROOT',root),patch.object(w,'MARKER',marker):w.cleanup_token('7-2-8-1')
                self.assertFalse(token.exists());self.assertTrue(marker.exists())
                data=json.loads(status.read_text());self.assertEqual(data['status'],'deployed' if state=='deployed' else 'failed')
                if state!='deployed':self.assertTrue(data['operator_check_required'])
        unit=(pathlib.Path(__file__).resolve().parents[1]/'deploy/autodeploy/legal-harness-deploy@.service').read_text()
        self.assertIn('ExecStopPost=/usr/bin/python3 /opt/legal-harness-deployer/worker.py cleanup %i',unit)
    def test_same_head_retry_requires_matching_package_files_path_and_dependencies(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(w,'ROOT',pathlib.Path(temp)):
            d=object.__new__(w.Deployment);d.data={'head':HEAD};package=tar_fixture();files=p.package_files(package)
            for name,content in files.items():
                path=d.candidate/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(content)
            manifest={'package_sha256':hashlib.sha256(package).hexdigest()}
            active={'head':HEAD,'path':str(d.candidate),'package_sha256':manifest['package_sha256'],
                'files':{name:hashlib.sha256(content).hexdigest() for name,content in files.items()},'dependencies':{'sha256':'expected'}}
            d.dependencies=lambda path:{'sha256':'expected'};d.ready=lambda head:None
            with patch.object(w,'prop',return_value=str(d.candidate)):
                d.verify_existing(active,manifest,package)
                for field,value in [('head','b'*40),('path','/other'),('package_sha256','different'),('files',{}),('dependencies',{})]:
                    with self.subTest(field=field),self.assertRaises(p.Rejected):d.verify_existing({**active,field:value},manifest,package)
                with self.assertRaises(p.Rejected):d.verify_existing({},manifest,package)
                (d.candidate/'dist/index.js').write_text('tampered')
                with self.assertRaises(p.Rejected):d.verify_existing(active,manifest,package)
    def test_receiver_reconciles_dead_workers_but_preserves_pending_start_jobs(self):
        import datetime,os
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp);directory=root/'jobs/7-2-8-1';directory.mkdir(parents=True)
            for state,age,unit,pending,expected in [('queued',90,'inactive','pending','queued'),('queued',1,'inactive','','queued'),
                ('queued',90,'inactive','','failed'),('running',1,'failed','','failed'),('running',90,'active','','running')]:
                (directory/'token').write_text('synthetic')
                stamp=(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(seconds=age)).isoformat()
                (directory/'status.json').write_text(json.dumps({'job':'7-2-8-1','status':state,'updated_at':stamp}))
                output=io.StringIO()
                with patch.object(w,'ROOT',root),patch.object(receiver,'ROOT',root),patch.dict(os.environ,{'SSH_ORIGINAL_COMMAND':'status 7-2-8-1'}),patch.object(receiver,'prop',side_effect=lambda name,service:unit if name=='ActiveState' else pending),contextlib.redirect_stdout(output):receiver.main()
                self.assertEqual(json.loads(output.getvalue())['status'],expected)
                self.assertEqual((directory/'token').exists(),expected!='failed')
    def test_other_job_fence_is_not_removed(self):
        with tempfile.TemporaryDirectory() as temp:
            marker=pathlib.Path(temp)/'maintenance.json';marker.write_text(json.dumps({'job':'9-2-8-1'}))
            d=object.__new__(w.Deployment);d.job='7-2-8-1';d.data={'events':[{'phase':'verify-candidate','status':'pass'}]}
            calls=[];d.fence_present=lambda:True;d.fence=lambda a:calls.append(a)
            with patch.object(w,'MARKER',marker):
                with self.assertRaisesRegex(p.Rejected,'MAINTENANCE_OWNER_MISMATCH'):d.phase_resume()
            self.assertEqual(calls,[]);self.assertTrue(marker.exists())
    def test_cleanup_preserves_active_and_unowned_directories(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp);releases=root/'releases';releases.mkdir()
            d=object.__new__(w.Deployment);old=releases/('a'*40);old.mkdir();(old/'.release.json').write_text(json.dumps({'owner':'legal-harness-autodeploy','head':old.name}))
            other=releases/('b'*40);other.mkdir();(other/'user-note').write_text('keep')
            with patch.object(w,'ROOT',root):
                d.safe_remove_release(old,{str(old)});d.safe_remove_release(other,set())
                self.assertTrue(old.exists());self.assertTrue(other.exists())
                with self.assertRaises(p.Rejected):d.safe_remove_release(root,set())
                d.safe_remove_release(old,set());self.assertFalse(old.exists())

if __name__=='__main__':unittest.main()
