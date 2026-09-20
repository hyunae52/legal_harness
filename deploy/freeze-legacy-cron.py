"""Operator action immediately before an approved merge. Default is read-only."""
import argparse, datetime, hashlib, json, os, pathlib, subprocess
p=argparse.ArgumentParser()
p.add_argument('--apply',action='store_true')
a=p.parse_args()
if subprocess.check_output(['id','-un'],text=True).strip()!='cta':
    raise SystemExit('HOLD: expected existing cta operator')
before=subprocess.check_output(['crontab','-l'],text=True)
targets=['/opt/legal_harness/scripts/cron-git-sync.sh','/opt/legal_harness/scripts/update-korean-law.sh']
lines=before.splitlines(keepends=True)
matches=[i for i,line in enumerate(lines) if not line.lstrip().startswith('#') and any(path in line for path in targets)]
if len(matches)!=2 or any(sum(path in lines[i] for i in matches)!=1 for path in targets):
    raise SystemExit('HOLD: legacy cron differs from the reviewed two jobs')
active=[]
for row in subprocess.check_output(['ps','-eo','pid=,args='],text=True).splitlines():
    if any(path in row for path in targets): active.append(int(row.split(None,1)[0]))
if active: raise SystemExit('HOLD: legacy updater is running; wait for it to finish')
backup=None
if a.apply:
    directory=pathlib.Path('/home/cta/.legal-harness-operator-backups')
    directory.mkdir(mode=0o700,exist_ok=True)
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup=directory/('crontab-'+stamp+'.txt')
    fd=os.open(backup,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as f:f.write(before)
    for i in matches: lines[i]='# FROZEN_FOR_REVIEWED_RELEASE '+lines[i]
    subprocess.run(['crontab','-'],input=''.join(lines),text=True,check=True)
    actual=subprocess.check_output(['crontab','-l'],text=True)
    if actual!=''.join(lines):raise SystemExit('HOLD: cron verification failed')
    # A cron launch can race the first process snapshot. Freeze scheduling first,
    # then refuse the subsequent merge if an updater was already dispatched.
    for row in subprocess.check_output(['ps','-eo','pid=,args='],text=True).splitlines():
        if any(path in row for path in targets):
            raise SystemExit('HOLD: cron frozen, but an updater started during the freeze; wait and recheck before merge')
print(json.dumps({'status':'frozen' if a.apply else 'ready_to_freeze','matched_jobs':2,'running_updaters':0,'backup':str(backup) if backup else None,'prior_sha256':hashlib.sha256(before.encode()).hexdigest()}))
