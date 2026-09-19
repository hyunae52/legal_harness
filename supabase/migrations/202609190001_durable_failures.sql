-- Expand-only migration. Legacy records remain readable; legacy direct writes stop.
begin;
revoke insert on public.evolution_logs from authenticated;
drop policy if exists evolution_logs_insert_own_pending on public.evolution_logs;

create table public.harness_actors (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('auth_user','api_client')),
  user_id uuid unique references auth.users(id) on delete restrict,
  client_id text unique,
  check ((kind='auth_user' and user_id is not null and client_id is null) or
         (kind='api_client' and user_id is null and client_id='partner'))
);
insert into public.harness_actors(kind,client_id) values ('api_client','partner');
create table public.harness_failures (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references public.harness_actors(id),
  request_id uuid not null,
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb not null check (octet_length(payload::text)<=4096),
  created_at timestamptz not null default now(),
  unique(actor_id,request_id)
);
create table public.harness_jobs (
  id uuid primary key default gen_random_uuid(),
  failure_id uuid not null unique references public.harness_failures(id),
  state text not null default 'queued' check(state in
    ('queued','reproducing','patching','testing','ai_review','revision_required','ready_for_human','waiting_dependency','needs_evidence','exhausted','merged','deployed')),
  attempt integer not null default 0 check(attempt between 0 and 3),
  fence bigint not null default 0,
  lease_owner uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz not null default now(),
  execution_hash text,
  head_sha text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.harness_outbox (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.harness_jobs(id),
  operation text not null check(operation in ('process_failure','publish_pr')),
  state text not null default 'pending' check(state in ('pending','unknown','done','blocked')),
  correlation_id uuid not null unique default gen_random_uuid(),
  remote_id text,
  created_at timestamptz not null default now(),
  unique(job_id,operation)
);
create table public.harness_events (
  id bigint generated always as identity primary key,
  job_id uuid not null references public.harness_jobs(id),
  fence bigint not null,
  event text not null,
  evidence jsonb not null default '{}' check(octet_length(evidence::text)<=65536),
  created_at timestamptz not null default now()
);
create index harness_jobs_queue on public.harness_jobs(next_attempt_at) where state in ('queued','revision_required','waiting_dependency');

alter table public.harness_actors enable row level security;
alter table public.harness_failures enable row level security;
alter table public.harness_jobs enable row level security;
alter table public.harness_outbox enable row level security;
alter table public.harness_events enable row level security;
revoke all on public.harness_actors, public.harness_failures, public.harness_jobs, public.harness_outbox, public.harness_events from public,anon,authenticated;
grant select on public.harness_actors, public.harness_failures, public.harness_jobs to authenticated;
grant all on public.harness_actors, public.harness_failures, public.harness_jobs, public.harness_outbox, public.harness_events to service_role;
grant usage, select on sequence public.harness_events_id_seq to service_role;
create policy actor_own on public.harness_actors for select to authenticated using(user_id=(select auth.uid()));
create policy failure_own on public.harness_failures for select to authenticated using(actor_id in(select id from public.harness_actors where user_id=(select auth.uid())));
create policy job_own on public.harness_jobs for select to authenticated using(failure_id in(select id from public.harness_failures));

-- Privileged caller must derive identity from verified authentication, never JSON input.
create function public.harness_submit_failure(p_kind text,p_subject text,p_request uuid,p_hash text,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare aid uuid; fid uuid; jid uuid; existing_hash text;
begin
  -- Serializes capacity and dedup decisions across all service processes.
  perform pg_advisory_xact_lock(716204);
  if p_kind='auth_user' then
    insert into public.harness_actors(kind,user_id) values('auth_user',p_subject::uuid)
      on conflict(user_id) do nothing;
    select id into aid from public.harness_actors where user_id=p_subject::uuid;
  elsif p_kind='api_client' and p_subject='partner' then
    select id into aid from public.harness_actors where client_id='partner';
  end if;
  if aid is null then raise exception 'INVALID_ACTOR' using errcode='22023'; end if;
  select id,payload_hash into fid,existing_hash from public.harness_failures where actor_id=aid and request_id=p_request;
  if fid is not null then
    if existing_hash<>p_hash then raise exception 'IDEMPOTENCY_CONFLICT' using errcode='23505'; end if;
    select id into jid from public.harness_jobs where failure_id=fid;
    return jsonb_build_object('receipt_id',fid,'job_id',jid,'status',(select state from public.harness_jobs where id=jid),'duplicate',true);
  end if;
  if (select count(*) from public.harness_jobs where state not in('merged','deployed','exhausted'))>=100 or
     (select count(*) from public.harness_jobs j join public.harness_failures f on j.failure_id=f.id where f.actor_id=aid and j.state not in('merged','deployed','exhausted'))>=20 then
    raise exception 'QUEUE_CAPACITY' using errcode='54000';
  end if;
  insert into public.harness_failures(actor_id,request_id,payload_hash,payload) values(aid,p_request,p_hash,p_payload) returning id into fid;
  insert into public.harness_jobs(failure_id) values(fid) returning id into jid;
  insert into public.harness_outbox(job_id,operation) values(jid,'process_failure');
  insert into public.harness_events(job_id,fence,event) values(jid,0,'queued');
  return jsonb_build_object('receipt_id',fid,'job_id',jid,'status','queued','duplicate',false);
end;
$$;

create function public.harness_failure_status(p_kind text,p_subject text,p_id uuid)
returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('receipt_id',f.id,'job_id',j.id,'status',j.state,'attempt',j.attempt)
  from public.harness_failures f join public.harness_actors a on a.id=f.actor_id join public.harness_jobs j on j.failure_id=f.id
  where f.id=p_id and a.kind=p_kind and
    ((a.kind='auth_user' and a.user_id::text=p_subject) or (a.kind='api_client' and a.client_id=p_subject));
$$;

create function public.harness_claim_job(p_owner uuid)
returns jsonb language plpgsql set search_path='' as $$
declare j public.harness_jobs;
begin
  perform pg_advisory_xact_lock(716205);
  update public.harness_jobs set state='exhausted',lease_owner=null,lease_until=null,updated_at=now()
    where attempt>=3 and lease_until<now() and state in('reproducing','patching','testing','ai_review');
  if exists(select 1 from public.harness_jobs where lease_until>now()) then return null; end if;
  select * into j from public.harness_jobs where state in('queued','revision_required','waiting_dependency','reproducing','patching','testing','ai_review')
    and next_attempt_at<=now() and (lease_until is null or lease_until<now()) and attempt<3
    order by created_at for update skip locked limit 1;
  if j.id is null then return null; end if;
  update public.harness_jobs set state='reproducing',attempt=attempt+1,fence=fence+1,lease_owner=p_owner,lease_until=now()+interval '45 minutes',updated_at=now() where id=j.id returning * into j;
  return to_jsonb(j)||jsonb_build_object('payload',(select payload from public.harness_failures where id=j.failure_id));
end;
$$;

-- CAS/fencing protects coordinator persistence; external writes also go through it.
create function public.harness_finish_attempt(p_job uuid,p_owner uuid,p_fence bigint,p_state text,p_evidence jsonb)
returns boolean language plpgsql set search_path='' as $$
declare updated uuid;
begin
  if p_state not in('needs_evidence','waiting_dependency','revision_required','exhausted') then
    raise exception 'PROMOTION_REQUIRES_TRUSTED_EVIDENCE' using errcode='22023';
  end if;
  update public.harness_jobs set state=case when attempt>=3 and p_state in('revision_required','waiting_dependency') then 'exhausted' else p_state end,
    lease_owner=null,lease_until=null,next_attempt_at=now()+interval '15 minutes',updated_at=now()
    where id=p_job and lease_owner=p_owner and fence=p_fence and lease_until>now() returning id into updated;
  if updated is null then return false; end if;
  insert into public.harness_events(job_id,fence,event,evidence) values(p_job,p_fence,p_state,p_evidence);
  return true;
end;
$$;
revoke all on function public.harness_submit_failure(text,text,uuid,text,jsonb), public.harness_failure_status(text,text,uuid),public.harness_claim_job(uuid),public.harness_finish_attempt(uuid,uuid,bigint,text,jsonb) from public,anon,authenticated;
grant execute on function public.harness_submit_failure(text,text,uuid,text,jsonb), public.harness_failure_status(text,text,uuid),public.harness_claim_job(uuid),public.harness_finish_attempt(uuid,uuid,bigint,text,jsonb) to service_role;
comment on table public.harness_events is 'Coordinator-produced audit events; user/agent JSON cannot attest AI approval.';
commit;
