"""Controlled scheduler/process port regression; never changes the host cron."""
import importlib.util, json, sys, os, signal, subprocess, tempfile, pathlib
spec = importlib.util.spec_from_file_location('freeze', 'deploy/freeze-legacy-cron.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
initial = 'PATH=/usr/bin\n*/10 * * * * /opt/legal_harness/scripts/cron-git-sync.sh\n30 18 * * * /opt/legal_harness/scripts/update-korean-law.sh\n1 * * * * /usr/bin/unrelated\n'

class Host:
    def __init__(self, during_stop='', initially=''):
        self.table=initial; self.state='active'; self.rows=initially; self.during_stop=during_stop; self.calls=[]
    def read(self,args):
        if args==['id','-un']:return 'cta\n'
        if args==['crontab','-l']:return self.table
        if args[0]=='ps':return ('10 cron /usr/sbin/cron\n' if self.state=='active' else '')+self.rows
        if '--property=ActiveState' in args:return self.state+'\n'
        if '--property=MainPID' in args:return ('10' if self.state=='active' else '0')+'\n'
        if '--property=KillMode' in args:return 'process\n'
        raise AssertionError(args)
    def run(self,args,**kw):
        self.calls.append(args)
        if args==['sudo','-n','systemctl','stop','cron.service']:self.state='inactive';self.rows=self.during_stop
        elif args==['sudo','-n','systemctl','start','cron.service']:self.state='active'
        elif args==['crontab','-']:self.table=kw['input']
        else:raise AssertionError(args)
    def freeze(self):return m.freeze(True,read=self.read,run=self.run,backup=lambda text:'synthetic-backup')

# A child dispatches between the initial snapshot and scheduler stop. The
# command path is absent. The previous implementation incorrectly passed it.
h=Host(during_stop='11 CRON CRON\n')
try:h.freeze();raise AssertionError('pre-exec child accepted')
except RuntimeError as e:assert 'dispatched/running work remains' in str(e)
assert h.state=='inactive' and h.table==initial and ['crontab','-'] not in h.calls
# Resuming that delayed job cannot authorize merge: the previous result is HOLD.
h.rows='12 bash /bin/bash /opt/legal_harness/scripts/cron-git-sync.sh\n'
try:h.freeze();raise AssertionError('running updater accepted')
except RuntimeError as e:assert 'dispatched or running' in str(e)
assert h.table==initial
# Once it ends, a stopped scheduler cannot enqueue an older command.
h.rows='';h.during_stop='';r=h.freeze()
assert r['status']=='frozen' and r['dispatched_work_drained'] and r['scheduler_resumed']
assert h.state=='active' and h.table.count('# FROZEN_FOR_REVIEWED_RELEASE ')==2
assert '1 * * * * /usr/bin/unrelated\n' in h.table
h=Host(initially='11 CRON CRON\n')
try:h.freeze();raise AssertionError('preexisting dispatch accepted')
except RuntimeError:pass
assert h.calls==[] and h.table==initial
checks=4
if sys.platform=='linux':
    # Real stopped pre-exec child; only scheduler/crontab ports are synthetic.
    with tempfile.TemporaryDirectory(prefix='legal-cron-dispatch-') as directory:
        marker=pathlib.Path(directory)/'user-command-ran'
        code="import ctypes,os,signal,sys,pathlib; ctypes.CDLL(None).prctl(15,b'CRON',0,0,0); os.kill(os.getpid(),signal.SIGSTOP); pathlib.Path(sys.argv[1]).write_text('ran')"
        child=subprocess.Popen([sys.executable,'-c',code,str(marker)])
        try:
            def deadline(*_):raise TimeoutError('synthetic child did not stop')
            old_handler=signal.signal(signal.SIGALRM,deadline);signal.alarm(5)
            _,status=os.waitpid(child.pid,os.WUNTRACED)
            signal.alarm(0);signal.signal(signal.SIGALRM,old_handler)
            assert os.WIFSTOPPED(status)
            rows=subprocess.check_output(['ps','-p',str(child.pid),'-o','pid=,comm=,args='],text=True)
            assert rows.split(None,2)[1]=='CRON'
            h=Host(during_stop=rows)
            try:h.freeze();raise AssertionError('real delayed child accepted')
            except RuntimeError as e:assert 'dispatched/running work remains' in str(e)
            assert h.table==initial and h.state=='inactive' and not marker.exists()
            os.kill(child.pid,signal.SIGCONT);assert child.wait(timeout=5)==0
            assert marker.read_text()=='ran'
            checks+=1
        finally:
            signal.alarm(0)
            if child.poll() is None:child.kill();child.wait(timeout=5)
print(json.dumps({'status':'pass','checks':checks}))
