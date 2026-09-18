import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(new URL('../supabase/migrations/202609140001_profiles_evolution_logs.sql', import.meta.url), 'utf8');
const alice = '00000000-0000-4000-8000-000000000001';
const bob = '00000000-0000-4000-8000-000000000002';

test('Supabase DDL executes in PostgreSQL and enforces ownership and reviewer boundaries', async t => {
  // Local PostgreSQL WASM, with only Supabase's auth schema/roles emulated.
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth, public to anon, authenticated, service_role;
    grant execute on function auth.uid() to authenticated;
  `);
  await db.query('insert into auth.users (id) values ($1)', [alice]);
  await db.exec(migration);
  await db.query('insert into auth.users (id, raw_user_meta_data) values ($1, $2)', [bob, { display_name: 'Bob', role: 'admin' }]);

  const asUser = (id, sql, params = [], role = 'authenticated') => db.transaction(async tx => {
    await tx.exec(`set local role ${role}`);
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [id]);
    return tx.query(sql, params);
  });
  const insert = `insert into public.evolution_logs
    (proposer_id, issue_summary, rule_content, correction_prompt, pr_url, status)
    values ($1, 'Fixture issue', 'Fixture rule', 'Fixture correction', 'https://example.invalid/pull/1', $2)
    returning id`;
  let logId;

  await t.test('existing/new users receive profiles and metadata grants no privileges', async () => {
    const profiles = (await db.query('select * from public.profiles order by id')).rows;
    assert.equal(profiles.length, 2);
    assert.equal(profiles[1].display_name, 'Bob');
    assert.equal(profiles[1].role, undefined);
    const own = (await asUser(alice, 'select id from public.profiles')).rows;
    assert.deepEqual(own, [{ id: alice }]);
    await asUser(alice, 'update public.profiles set display_name = $1 where id = $2', ['Alice', alice]);
    const other = await asUser(alice, 'update public.profiles set display_name = $1 where id = $2 returning id', ['Spoof', bob]);
    assert.equal(other.rows.length, 0);
    await assert.rejects(asUser(alice, 'update public.profiles set created_at = now()'));
  });
  await t.test('authenticated insert matches /api/evolve and other users cannot read it', async () => {
    logId = (await asUser(alice, insert, [alice, 'pending_human_review'])).rows[0].id;
    assert.equal((await asUser(alice, 'select * from public.evolution_logs')).rows.length, 1);
    assert.equal((await asUser(bob, 'select * from public.evolution_logs')).rows.length, 0);
  });
  await t.test('anonymous access, spoofed proposer and client approval are denied', async () => {
    await assert.rejects(asUser('', 'select * from public.profiles', [], 'anon'));
    await assert.rejects(asUser('', 'select * from public.evolution_logs', [], 'anon'));
    await assert.rejects(asUser(bob, insert, [alice, 'pending_human_review']));
    await assert.rejects(asUser(alice, insert, [alice, 'approved']));
    await assert.rejects(asUser(alice, "update public.evolution_logs set status = 'approved' where id = $1", [logId]));
    await assert.rejects(asUser(alice, 'delete from public.evolution_logs where id = $1', [logId]));
  });
  await t.test('trusted reviewer can record approval and owner can read the result', async () => {
    await asUser('', "update public.evolution_logs set status = 'approved', reviewed_by = $1, reviewed_at = now() where id = $2", [bob, logId], 'service_role');
    const log = (await asUser(alice, 'select * from public.evolution_logs where id = $1', [logId])).rows[0];
    assert.equal(log.status, 'approved');
    assert.equal(log.reviewed_by, bob);
    assert.ok(log.reviewed_at);
  });
  await t.test('deleting the auth user cleans up owned profile and evolution rows', async () => {
    await db.query('delete from auth.users where id = $1', [alice]);
    assert.equal((await db.query('select * from public.profiles where id = $1', [alice])).rows.length, 0);
    assert.equal((await db.query('select * from public.evolution_logs')).rows.length, 0);
  });
});
