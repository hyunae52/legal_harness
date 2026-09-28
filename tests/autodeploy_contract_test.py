import copy, hashlib, io, json, pathlib, sys, tarfile, tempfile, unittest, zipfile
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'deploy/autodeploy'))
import protocol as p
import worker as w

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
        for key,value in [('event','pull_request'),('event','workflow_dispatch'),('head_branch','feature'),('path','.github/workflows/other.yml'),
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
