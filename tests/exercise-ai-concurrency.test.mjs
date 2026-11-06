import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { bootMigrationDatabase } from './helpers/sc19-migration-fixture.mjs';
import { activeBoot, users, definition } from './helpers/competency-active-fixture.mjs';

const auth = async client => {
  await client.exec('reset role;set role authenticated');
  await client.query("select set_config('request.jwt.claim.sub',$1,false)", [users.owner]);
};
const waitForLock = async (observer, pid) => {
  for (let i = 0; i < 100; i++) {
    const row = (await observer.query('select wait_event_type from pg_stat_activity where pid=$1', [pid])).rows[0];
    if (row?.wait_event_type === 'Lock') return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Expected independently connected operation to wait on a database lock');
};

const bootDomain = async t => {
  const e = await bootMigrationDatabase(t);
  await e.db.exec(`do $$ begin
    if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
    if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    end $$;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`);
  for (const name of ['20260930000100_skillcheck_core', '20261001000100_idempotent_onboarding',
    '20261001000200_candidate_documents', '20261002000100_behavior_assessments',
    '20261002000200_behavior_conflict_response', '20261002000300_exercise_definitions']) {
    await e.db.exec(await readFile(new URL('../supabase/migrations/' + name + '.sql', import.meta.url), 'utf8'));
  }
  await e.db.exec(await readFile(new URL('../db/components/exercise-ai-proposals.sql', import.meta.url), 'utf8'));
  await e.db.query('insert into auth.users values($1)', [users.owner]);
  return e;
};

// The complete chain denies parent DELETE when its cascaded definition checks
// the now-missing parent. Keep that contract intact. The separate domain fixture
// checks successful CASCADE and the lock-order regression where DELETE is allowed.
for (const fullChain of [true, false]) test(`C6 native PostgreSQL: approval/delete serialization (${fullChain ? 'full chain, guarded DELETE' : 'isolated domain, allowed CASCADE'})`, async t => {
  assert.equal(process.env.SC_WER_PGLITE_PATH, undefined, 'Independent native connections required');
  const e = fullChain
    ? await activeBoot(t, { fullChain: true, throughMigration: '20261106130000_exercise_ai_proposals.sql' })
    : await bootDomain(t);
  const { db } = e, approver = await e.connect(), observer = await e.connect();
  const approvePid = (await approver.query('select pg_backend_pid() id')).rows[0].id;
  const deletePid = (await db.query('select pg_backend_pid() id')).rows[0].id;
  await auth(db);
  const company = (await db.query("select public.create_company('Concurrency') id")).rows[0].id;
  for (const deleteFirst of [true, false]) {
    await auth(db); await auth(approver);
    const position = (await db.query("insert into public.positions(company_id,title,tasks) values($1,'TEST',array['Task']) returning id,updated_at::text stamp", [company])).rows[0];
    const recruitment = (await db.query("insert into public.recruitments(company_id,position_id,name) values($1,$2,'TEST') returning id", [company, position.id])).rows[0].id;
    const entry = (await db.query('select public.save_exercise_definition($1,$2,$3::jsonb,0,$4,$5) id',
      [recruitment, randomUUID(), JSON.stringify(definition()), position.id, position.stamp])).rows[0].id;
    const trace = { provider: 'openai', model: 'synthetic', prompt_version: 'v1', payload_schema_version: 1,
      result_schema_version: 1, input_fingerprint: 'a'.repeat(64), position_id: position.id, position_updated_at: position.stamp };
    await db.query('select exercise_ai.record_proposal($1,$2,$3::jsonb,20)', [recruitment, entry, JSON.stringify(trace)]);
    if (deleteFirst) {
      await db.exec('begin');
      let pending;
      try {
        // Hold only the parent before starting approval. On the old lock order,
        // approval grabs the child then waits here; CASCADE creates a deadlock.
        await db.query('select id from public.recruitments where id=$1 for update', [recruitment]);
        pending = approver.query('select exercise_ai.approve_proposal($1)', [entry]).then(value => ({ value }), error => ({ error }));
        await waitForLock(observer, approvePid);
        if (fullChain) {
          await assert.rejects(db.query('delete from public.recruitments where id=$1', [recruitment]), error => error.code === 'PT404');
          await db.exec('rollback');
          const result = await pending;
          assert.equal(result.error, undefined, 'approval succeeds after the denied DELETE rolls back');
        } else {
          await db.query('delete from public.recruitments where id=$1', [recruitment]);
          await db.exec('commit');
          const result = await pending;
          assert.equal(result.error?.code, '55000', 'approval must see the deleted parent, never deadlock or approve an orphan');
        }
      } finally { await db.exec('rollback'); if (pending) await pending; }
    } else {
      await approver.exec('begin');
      let pending;
      try {
        await approver.query('select exercise_ai.approve_proposal($1)', [entry]);
        pending = db.query('delete from public.recruitments where id=$1', [recruitment]).then(value => ({ value }), error => ({ error }));
        await waitForLock(observer, deletePid);
        await approver.exec('commit');
        const result = await pending;
        if (fullChain) assert.equal(result.error?.code, 'PT404', 'the complete chain retains its existing deletion guard');
        else {
          assert.equal(result.error, undefined);
          assert.equal(result.value.rowCount, 1);
        }
      } finally { await approver.exec('rollback'); if (pending) await pending; }
    }
    const rows = (await db.query('select approval_mode from exercise_ai.proposals where definition_entry_id=$1', [entry])).rows;
    assert.equal(rows.length, fullChain ? 1 : 0);
    if (fullChain) {
      assert.equal(rows[0].approval_mode, 'manual');
      assert.equal((await db.query('select count(*)::int n from public.recruitments where id=$1', [recruitment])).rows[0].n, 1);
    }
  }
});
