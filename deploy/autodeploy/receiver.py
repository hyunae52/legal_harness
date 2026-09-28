"""OpenSSH forced command: bounded submit/status, no shell or arbitrary paths."""
import json, os, subprocess, sys
from worker import ROOT, Deployment, save, now
from protocol import command, Rejected, require

def main():
    os.umask(0o077)
    action,job=command(os.environ.get('SSH_ORIGINAL_COMMAND',''))
    directory=ROOT/'jobs'/job
    if action=='submit':
        token=sys.stdin.buffer.readline(4098)
        require(token.endswith(b'\n') and 20<=len(token.strip())<=4096,'INVALID_TOKEN')
        text=token.decode('ascii').strip()
        require(not any(c.isspace() for c in text),'INVALID_TOKEN')
        try: directory.mkdir(mode=0o700)
        except FileExistsError:
            require((directory/'status.json').is_file(),'JOB_STATE_UNKNOWN')
            print((directory/'status.json').read_text()); return
        with (directory/'token').open('x') as stream: stream.write(text+'\n')
        save(directory/'status.json',{'job':job,'status':'queued','updated_at':now()})
        try:
            subprocess.run(['sudo','-n','systemctl','start','legal-harness-deploy@'+job+'.service'],
                check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15)
        except Exception:
            (directory/'token').unlink(missing_ok=True)
            save(directory/'status.json',{'job':job,'status':'failed','error_code':'JOB_LAUNCH_FAILED','updated_at':now()})
            raise Rejected('JOB_LAUNCH_FAILED')
    require((directory/'status.json').is_file(),'JOB_NOT_FOUND')
    data=json.loads((directory/'status.json').read_text())
    if data['status']=='running':
        state=subprocess.check_output(['systemctl','show','legal-harness-deploy@'+job+'.service','--property=ActiveState','--value'],text=True,timeout=5).strip()
        if state not in ('active','activating','deactivating'):
            data.update(status='failed',error_code='WORKER_STOPPED',operator_check_required=True)
    print(json.dumps(data))

if __name__=='__main__':
    try: main()
    except Exception as error:
        print(json.dumps({'status':'failed','error_code':str(error) if isinstance(error,Rejected) else type(error).__name__}))
        raise SystemExit(1)
