// R6-1c part 8: the last SC-010-R4-VOICE differences as a real migration
// (20261120150000_r6_voice_retention.sql) on the full checked-in chain:
// the purge manifest refuses a tenant with an unresolvable voice plan request
// key (as the erasure preview already does), and an UPDATE that changes nothing
// no longer restarts a candidate's retention clock. No table, row or grant
// changes; the erasure signature and inventory stay R23. Native disposable
// PostgreSQL only; synthetic data; no provider, no API grant, no reader.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { activeBoot, users } from './helpers/competency-active-fixture.mjs';
import { lifecycleHarness } from './helpers/erasure-lifecycle-fixture.mjs';
import { seedSyntheticPolicy } from './helpers/sc19-migration-fixture.mjs';

const signature = 'bc5fe11ba2c0cd33015c00b2283403532f338630f3e9661b91847d6979726235';
const migration = new URL('../supabase/migrations/20261120150000_r6_voice_retention.sql', import.meta.url);
const isolated = new URL('../db/isolated/sc010-r4-voice-retention.sql', import.meta.url);
const fns = ['private.erasure_check_purge_scope(uuid)', 'private.retention_observe_candidate()'];
const message = (c, m) => e => e.code === c && e.message === m;
const sha = value => createHash('sha256').update(value).digest('hex');
const bodyOf = (source, name) => {
  const start = source.search(new RegExp(`create (?:or replace )?function ${name.replaceAll('.', '\\.')}\\(`));
  return source.slice(start, source.indexOf('$$;', start) + 3).split('$$')[1];
};

test('R6-1c part 8: voice request keys fail the purge scope closed and no-op updates keep the retention clock', async t => {
  const { db, h, x } = await activeBoot(t, { fullChain: true });
  const one = async (sql, args) => (await db.query(sql, args)).rows[0].v;
  const source = await readFile(isolated, 'utf8');

  await t.test('installs the reviewed isolated bodies; signature, inventory and owner-only ACL unchanged', async () => {
    await h.asAdmin();
    assert.equal(await one('select private.erasure_schema_signature() as v'), signature);
    assert.equal(await one('select schema_signature as v from private.erasure_inventory_baseline_r23 where singleton'), signature);
    assert.equal(await one("select to_regclass('private.erasure_inventory_baseline_r4_voice') is null as v"), true, 'no isolated baseline table');
    for (const fn of fns) {
      const row = (await db.query(`select encode(sha256(convert_to(prosrc,'UTF8')),'hex') h,pg_get_userbyid(proowner) o,prosecdef,
        proconfig,proacl::text acl from pg_proc where oid=$1::regprocedure`, [fn])).rows[0];
      assert.equal(row.h, sha(bodyOf(source, fn.slice(0, fn.indexOf('(')))), fn);
      assert.deepEqual([row.o, row.prosecdef, row.proconfig, row.acl], ['postgres', true, ['search_path=""'], '{postgres=X/postgres}'], fn);
      for (const role of ['anon', 'authenticated', 'service_role']) {
        if (!await one('select to_regrole($1) is not null as v', [role])) continue;
        assert.equal(await one('select has_function_privilege($1,$2,$3) as v', [role, fn, 'execute']), false, `${role} ${fn}`);
      }
    }
    await h.asUser(users.owner);
    await assert.rejects(db.query('select private.erasure_check_purge_scope($1)', [randomUUID()]), e => e.code === '42501');
    await h.asAdmin();
  });

  await t.test('a second run stops before changing anything', async () => {
    await h.asAdmin();
    const before = await one(`select string_agg(encode(sha256(convert_to(prosrc,'UTF8')),'hex'),',' order by oid) as v from pg_proc
      where oid=any($1::regprocedure[])`, [fns]);
    await assert.rejects(db.query(await readFile(migration, 'utf8')), message('55000', 'voice_retention_already_installed'));
    await db.query('rollback');
    assert.equal(await one(`select string_agg(encode(sha256(convert_to(prosrc,'UTF8')),'hex'),',' order by oid) as v from pg_proc
      where oid=any($1::regprocedure[])`, [fns]), before);
  });

  const life = lifecycleHarness(h);
  const f = await life.ready();
  // A separate tenant for the clock check: its pending screening would block an erasure preview.
  const g = await life.ready({ owner: users.otherOwner });
  const clock = async () => {
    await h.asAdmin();
    return (await db.query('select observed_at,generation from private.retention_candidate_clocks where candidate_id=$1', [g.candidate.id])).rows[0];
  };

  await t.test('an UPDATE that changes nothing keeps the retention clock; a real change restarts it', async () => {
    // A screening analysis row has no updated_at stamp, so an UPDATE of it can be a true no-op.
    await h.asAdmin();
    await seedSyntheticPolicy(db);
    await db.query('select private.sc19_grant_paid($1,$2)', [g.companyId, `synthetic-voice-retention-${randomUUID()}`]);
    const started = await h.start(g);
    const before = await clock();
    assert.ok(before, 'the candidate has a retention clock');
    await h.asAdmin();
    const noop = await db.query('update public.screening_analysis_versions set company_id=company_id where id=$1', [started.analysis_id]);
    assert.equal(noop.rowCount, 1);
    assert.deepEqual(await clock(), before, 'no-op update');
    await db.query("update public.candidates set last_name=last_name||' X' where id=$1", [g.candidate.id]);
    assert.ok(Number((await clock()).generation) > Number(before.generation), 'real change');
  });

  await t.test('an unresolvable voice plan request key in the tenant blocks the purge; nothing is deleted', async () => {
    await h.asUser(f.owner);
    await x.configure();
    const frozen = await life.freeze(f);
    // Legacy malformed key (no resolvable result), written after the preview with
    // the voice guard bypassed: the preview could not see it.
    await h.asAdmin();
    await db.query('begin');
    await db.query('alter table private.voice_plan_request_keys disable trigger user');
    await db.query(`insert into private.voice_plan_request_keys values($1,$2,'generate',$3,$4,null,now(),'test',now()+interval '1 day')`,
      [f.companyId, f.owner, randomUUID(), 'a'.repeat(64)]);
    await db.query('alter table private.voice_plan_request_keys enable trigger user');
    await db.query('commit');
    await h.asUser(f.owner);
    await assert.rejects((async () => {
      await x.transition(frozen.request_id, 0, 'authorized');
      await x.transition(frozen.request_id, 1, 'erasing');
      await x.purge(frozen.request_id, 2);
    })(), message('PT409', 'Unknown voice request dependency'));
    await h.asAdmin();
    assert.equal(await one('select count(*)::int as v from public.candidates where id=$1', [f.candidate.id]), 1, 'candidate kept');
    assert.equal(await one('select count(*)::int as v from private.voice_plan_request_keys where company_id=$1', [f.companyId]), 1);
  });

  await t.test('operational rollback keeps both bodies, the signature and the owner-only ACL', async () => {
    await h.asAdmin();
    const before = await one(`select string_agg(encode(sha256(convert_to(prosrc,'UTF8')),'hex'),',' order by oid) as v from pg_proc
      where oid=any($1::regprocedure[])`, [fns]);
    await db.query(await readFile(new URL('../supabase/rollbacks/20261120150000_r6_voice_retention_down.sql', import.meta.url), 'utf8'));
    assert.equal(await one('select private.erasure_schema_signature() as v'), signature);
    assert.equal(await one(`select string_agg(encode(sha256(convert_to(prosrc,'UTF8')),'hex'),',' order by oid) as v from pg_proc
      where oid=any($1::regprocedure[])`, [fns]), before);
    for (const fn of fns) assert.equal(await one('select proacl::text as v from pg_proc where oid=$1::regprocedure', [fn]), '{postgres=X/postgres}');
  });
});

test('R6-1c part 8: before the migration the same unresolvable key does not block the manifest', async t => {
  const { db, h, x } = await activeBoot(t, { fullChain: true, throughMigration: '20261120120000_r6_voice_transcripts_r23.sql' });
  const one = async (sql, args) => (await db.query(sql, args)).rows[0].v;
  await h.asAdmin();
  assert.equal(await one("select prosrc like '%Unknown voice request dependency%' as v from pg_proc where oid='private.erasure_check_purge_scope(uuid)'::regprocedure"), false);
  const life = lifecycleHarness(h);
  const f = await life.ready();
  await h.asUser(f.owner);
  await x.configure();
  const frozen = await life.freeze(f);
  await h.asAdmin();
  await db.query('begin');
  await db.query('alter table private.voice_plan_request_keys disable trigger user');
  await db.query(`insert into private.voice_plan_request_keys values($1,$2,'generate',$3,$4,null,now(),'test',now()+interval '1 day')`,
    [f.companyId, f.owner, randomUUID(), 'a'.repeat(64)]);
  await db.query('alter table private.voice_plan_request_keys enable trigger user');
  await db.query('commit');
  await h.asUser(f.owner);
  await x.transition(frozen.request_id, 0, 'authorized');
  await x.transition(frozen.request_id, 1, 'erasing');
  await x.purge(frozen.request_id, 2);
  await h.asAdmin();
  assert.equal(await one('select count(*)::int as v from public.candidates where id=$1', [f.candidate.id]), 0, 'purged despite the unresolvable key');
  // The migration then installs on this pre-migration schema.
  await db.query(await readFile(migration, 'utf8'));
  assert.equal(await one('select private.erasure_schema_signature() as v'), signature);
});
