import copy, hashlib, io, json, pathlib, sys, tempfile, unittest
from unittest.mock import patch, Mock
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]/'deploy/autodeploy'))
import protocol, providers, worker
from autodeploy_contract_test import zip_fixture, run_fixture, PROTECTION, HEAD

class ProviderUpdates(unittest.TestCase):
    def test_main_dispatch_is_accepted_only_with_all_review_steps(self):
        run, jobs = run_fixture(); run['event'] = 'workflow_dispatch'
        self.assertEqual(protocol.verify_run(run,jobs,7,2),HEAD)
        jobs[0]['steps'][-1]['conclusion'] = 'skipped'
        with self.assertRaises(protocol.Rejected): protocol.verify_run(run,jobs,7,2)

    def test_provider_opt_in_never_allows_migrations_or_controller_changes(self):
        payload, artifact = zip_fixture(mutate=lambda m:m['protection'].update(law_version='4.15.7',tax_provider='f'*64))
        protocol.decode_bundle(payload,artifact,7,2,HEAD,PROTECTION,True)
        with self.assertRaises(protocol.Rejected): protocol.decode_bundle(payload,artifact,7,2,HEAD,PROTECTION)
        for key in ('migrations','deployer'):
            payload, artifact = zip_fixture(mutate=lambda m:m['protection'].update({key:'f'*64}))
            with self.assertRaises(protocol.Rejected): protocol.decode_bundle(payload,artifact,7,2,HEAD,PROTECTION,True)

    def pin(self):
        return {'repository':'hyunae52/korean-taxlaw-mcp','version':'2.1.0.post1','commit':'a'*40,
            'archive_url':'https://codeload.github.com/hyunae52/korean-taxlaw-mcp/zip/'+'a'*40,'archive_sha256':'b'*64,'license':'MIT'}

    def test_downgrade_retag_and_alternate_download_host_rejected(self):
        old = self.pin()
        for change in ({'version':'2.0.0'}, {'commit':'c'*40}, {'archive_sha256':'c'*64},
                       {'repository':'attacker/fork'}, {'archive_url':'http://localhost/private'}):
            with self.subTest(change=change),self.assertRaises(protocol.Rejected): providers.validate_pin({**old,**change},old)

    def fixture(self, root):
        candidate, previous, tax_root = root/'candidate',root/'previous',root/'legacy-tax'
        for app,version in ((candidate,'4.15.7'),(previous,'4.15.6')):
            (app/'upstreams').mkdir(parents=True)
            (app/'package.json').write_text(json.dumps({'dependencies':{'korean-law-mcp':version}}))
            (app/'upstreams/korean-taxlaw-mcp.json').write_text(json.dumps(self.pin()))
        (tax_root/'source').mkdir(parents=True); (tax_root/'venv').mkdir()
        (tax_root/'venv/package.py').write_text('real dependency')
        release = {'version':'2.1.0.post1','commit':'a'*40,'python':str(tax_root/'venv/python'),'cwd':str(tax_root/'source')}
        manifest=root/'active-tax.json';manifest.write_text(json.dumps(release))
        return candidate,previous,tax_root,{'TAXLAW_MCP_RELEASE_FILE':str(manifest)}

    def test_selection_is_per_release_and_existing_provider_never_mutated(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp); candidate,previous,tax_root,env=self.fixture(root)
            baseline=providers.fingerprint(tax_root); old=pathlib.Path(env['TAXLAW_MCP_RELEASE_FILE']).read_bytes()
            selection=providers.stage(candidate,previous,env,root,root,root,baseline)
            self.assertEqual(selection['law'],'4.15.7');providers.verify(selection)
            self.assertEqual(pathlib.Path(env['TAXLAW_MCP_RELEASE_FILE']).read_bytes(),old)
            self.assertEqual(providers.fingerprint(tax_root),baseline)
            self.assertIn(str(candidate/'providers/law.json'),pathlib.Path(selection['env_file']).read_text())
            (tax_root/'venv/package.py').write_text('tamper')
            with self.assertRaisesRegex(protocol.Rejected,'FILES_CHANGED'): providers.verify(selection)

    def test_existing_tax_tamper_blocks_stage_before_selection(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp); candidate,previous,tax_root,env=self.fixture(root)
            with self.assertRaisesRegex(protocol.Rejected,'FILES_CHANGED'): providers.stage(candidate,previous,env,root,root,root,'0'*64)
            self.assertFalse((candidate/'providers').exists())

    def test_bytecode_is_disposable_but_manifest_tamper_is_not(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp); candidate,previous,tax_root,env=self.fixture(root)
            selection=providers.stage(candidate,previous,env,root,root,root,providers.fingerprint(tax_root))
            (tax_root/'source/__pycache__').mkdir();(tax_root/'source/__pycache__/a.pyc').write_bytes(b'cache')
            providers.verify(selection)
            pathlib.Path(selection['env_file']).write_text('different')
            with self.assertRaisesRegex(protocol.Rejected,'MANIFEST_CHANGED'): providers.verify(selection)

    def test_cleanup_keeps_current_previous_and_unowned_provider(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp); paths=[]
            for char in 'abcd':
                path=root/'providers'/(char*40);path.mkdir(parents=True);paths.append(path)
                if char!='d': (path/'.provider.json').write_text(json.dumps({'owner':'legal-harness-autodeploy','commit':char*40}))
            providers.prune_stores(root,[paths[0]/'source',paths[1]/'source'])
            self.assertTrue(paths[0].exists());self.assertTrue(paths[1].exists())
            self.assertFalse(paths[2].exists());self.assertTrue(paths[3].exists())

    def test_rollback_checks_previous_provider_even_when_candidate_is_corrupt(self):
        deployment=object.__new__(worker.Deployment);deployment.config={'provider_manifests':{}}
        deployment.data={'provider_selection':{'name':'broken'},'previous_providers':{'name':'healthy'}}
        seen=[]
        with patch.object(providers,'verify',side_effect=lambda s:seen.append(s['name'])): deployment.providers(False)
        self.assertEqual(seen,['healthy'])

    def test_preflight_uses_ephemeral_loopback_port_and_only_source_credentials(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp); captured={}; child=Mock(pid=76543);child.poll.return_value=None
            def launch(args,**kwargs):captured.update(kwargs['env']);return child
            def health(*args,**kwargs):
                return io.BytesIO(json.dumps({'release_commit':captured['TAXLAB_RELEASE_COMMIT'],'mcp_release':'4.15.7',
                    'taxlaw_release':{'commit':'a'*40}}).encode())
            with patch.object(providers.subprocess,'Popen',side_effect=launch),patch.object(providers.subprocess,'run',return_value=Mock(stdout='{"status":"pass"}')) as run,\
                patch.object(providers.urllib.request,'urlopen',side_effect=health),patch.object(providers.os,'killpg',create=True),\
                patch.dict(providers.os.environ,{'GITHUB_TOKEN':'private','SUPABASE_KEY':'private'}):
                providers.preflight(root,{'law':'4.15.7','tax_commit':'a'*40,'environment':{}},
                    {'LAW_OC':'source-id','GITHUB_TOKEN':'private','SUPABASE_KEY':'private'},root,root)
            self.assertEqual(captured['HOST'],'127.0.0.1');self.assertNotIn('GITHUB_TOKEN',captured)
            self.assertNotIn('SUPABASE_KEY',captured);self.assertEqual(captured['LAW_OC'],'source-id')
            self.assertEqual(run.call_args.kwargs['env']['SMOKE_PORT'],captured['PORT'])

if __name__=='__main__':unittest.main()
