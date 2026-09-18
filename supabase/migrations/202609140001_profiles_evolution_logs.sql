-- Run once in Supabase SQL Editor or through `supabase db push`.
-- Supabase owns auth.users; passwords/tokens do not belong in public tables.
begin;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.evolution_logs (
  id uuid primary key default gen_random_uuid(),
  proposer_id uuid not null references auth.users(id) on delete cascade,
  issue_summary text not null check (char_length(btrim(issue_summary)) between 1 and 20000),
  rule_content text not null check (char_length(btrim(rule_content)) between 1 and 20000),
  correction_prompt text not null check (char_length(btrim(correction_prompt)) between 1 and 20000),
  pr_url text not null check (pr_url ~ '^https://[^[:space:]]+$'),
  status text not null default 'pending_human_review'
    check (status in ('pending_human_review', 'approved', 'rejected', 'merged')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index evolution_logs_proposer_created_idx
  on public.evolution_logs (proposer_id, created_at desc);
create index evolution_logs_pending_idx
  on public.evolution_logs (created_at)
  where status = 'pending_human_review';

create function public.legal_harness_set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.legal_harness_set_updated_at();
create trigger evolution_logs_set_updated_at before update on public.evolution_logs
for each row execute function public.legal_harness_set_updated_at();

create function public.legal_harness_handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, left(coalesce(new.raw_user_meta_data ->> 'display_name', ''), 120));
  return new;
end;
$$;

create trigger legal_harness_auth_user_created after insert on auth.users
for each row execute function public.legal_harness_handle_new_user();

-- Also create profiles for users registered before this migration.
insert into public.profiles (id, display_name)
select id, left(coalesce(raw_user_meta_data ->> 'display_name', ''), 120)
from auth.users;

alter table public.profiles enable row level security;
alter table public.evolution_logs enable row level security;

-- Override Supabase's default table grants before granting only needed columns.
revoke all on public.profiles, public.evolution_logs from public, anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant select on public.evolution_logs to authenticated;
grant insert (proposer_id, issue_summary, rule_content, correction_prompt, pr_url, status)
  on public.evolution_logs to authenticated;
grant all on public.profiles, public.evolution_logs to service_role;

create policy profiles_select_own on public.profiles
for select to authenticated using ((select auth.uid()) = id);
create policy profiles_update_own on public.profiles
for update to authenticated
using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

create policy evolution_logs_select_own on public.evolution_logs
for select to authenticated using ((select auth.uid()) = proposer_id);
create policy evolution_logs_insert_own_pending on public.evolution_logs
for insert to authenticated with check (
  (select auth.uid()) = proposer_id
  and status = 'pending_human_review'
  and reviewed_by is null and reviewed_at is null and review_note is null
);

-- Review outcomes are updated by the trusted reviewer/backend, never by a
-- proposer JWT. A pending row is a submission, not proof of AI/human approval.
revoke all on function public.legal_harness_set_updated_at() from public, anon, authenticated;
revoke all on function public.legal_harness_handle_new_user() from public, anon, authenticated;

comment on table public.evolution_logs is
  'Patch submissions. Final approval/merge requires trusted review; client-created rows are not attestations of AI review.';

commit;
