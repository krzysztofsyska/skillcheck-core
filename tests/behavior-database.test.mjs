import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { behaviorAreas } from '../lib/position-fields.ts';
import { buildBehaviorGuide } from '../lib/behavior-guide.ts';

test('behavior revisions: migration, RLS, evidence, snapshots and optimistic concurrency', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`create role anon nologin; create role authenticated nologin; create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;`);
  for (const name of ['20260930000100_skillcheck_core', '20261001000100_idempotent_onboarding', '20261001000200_candidate_documents', '20261002000100_behavior_assessments'])
    await db.exec(await readFile(new URL('../supabase/migrations/' + name + '.sql', import.meta.url), 'utf8'));
  const [ownerA, ownerB, recruiter, viewer] = [1,2,3,4].map(n => '00000000-0000-0000-0000-00000000000' + n);
  for (const id of [ownerA, ownerB, recruiter, viewer]) await db.query('insert into auth.users values($1)', [id]);
  const as = async (id, role = 'authenticated') => { await db.exec('reset role;set role ' + role); await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id ?? '']); };
  const insert = async (table, values) => (await db.query(`insert into public.${table} (${Object.keys(values).join(',')}) values (${Object.keys(values).map((_, i) => '$' + (i + 1)).join(',')}) returning *`, Object.values(values))).rows[0];
  const requirements = behaviorAreas.map(([, label]) => label + ': Standardowy');
  const seed = async owner => {
    await as(owner); const company = (await db.query("select public.create_company('TEST') id")).rows[0].id;
    const position = await insert('positions', { company_id: company, title: 'TEST', tasks: ['Zadanie'], kpis: ['Miernik'], required_behaviors: requirements });
    // Preserve all PostgreSQL timestamp digits for a real CAS comparison.
    position.updated_at = (await db.query('select updated_at::text as stamp from public.positions where id=$1', [position.id])).rows[0].stamp;
    const recruitment = await insert('recruitments', { company_id: company, position_id: position.id, name: 'TEST' });
    const candidate = await insert('candidates', { company_id: company, first_name: 'TEST', last_name: 'Fikcyjny' });
    const application = await insert('applications', { company_id: company, recruitment_id: recruitment.id, candidate_id: candidate.id });
    return { company, position, recruitment, application };
  };
  const a = await seed(ownerA), b = await seed(ownerB);
  await as(ownerA);
  await insert('company_members', { company_id: a.company, user_id: recruiter, role: 'recruiter' });
  await insert('company_members', { company_id: a.company, user_id: viewer, role: 'viewer' });
  const rpc = 'select public.save_behavior_assessment($1,$2,$3,$4,$5,$6,$7) id';
  const args = (record = a, area = 'responsibility', version = 0, rating = 'meets', evidence = 'Przykład: działanie, kontekst i wynik.') =>
    [record.application.id, area, rating, evidence, version, record.position.updated_at, record.position.id];
  const save = async (...values) => (await db.query(rpc, args(...values))).rows[0].id;
  const denied = (sql, values = [], code = '42501') => assert.rejects(db.query(sql, values), e => e.code === code);
  const refreshPosition = async () => { a.position.updated_at = (await db.query('select updated_at::text stamp from public.positions where id=$1', [a.position.id])).rows[0].stamp; };

  await t.test('owner and recruiter append; latest view returns actual author and immutable snapshot', async () => {
    await save(); await as(recruiter); await save(a, 'responsibility', 1, 'above', 'Drugi dowód');
    const rows = (await db.query('select * from public.behavior_assessment_entries order by version')).rows;
    assert.equal(rows.length, 2); assert.deepEqual(rows.map(r => r.author_id), [ownerA, recruiter]);
    assert.equal(rows[0].required_level, 'Standardowy'); assert.equal(rows[0].position_snapshot.title, 'TEST');
    assert.deepEqual(rows[0].position_snapshot.tasks, ['Zadanie']); assert.ok(rows[0].created_at);
    assert.equal((await db.query('select version from public.latest_behavior_assessments')).rows[0].version, 2);
    for (const [area] of behaviorAreas.slice(1)) await save(a, area, 0, 'insufficient_data', '');
    assert.equal((await db.query('select * from public.latest_behavior_assessments')).rows.length, 8);
  });

  await t.test('anonymous and absent session fail; viewer reads but cannot write; foreign tenant cannot read table or view or invoke RPC', async () => {
    await as(null, 'anon'); for (const relation of ['behavior_assessment_entries', 'latest_behavior_assessments']) await denied('select * from public.' + relation);
    await denied(rpc, args()); await as(null); await denied(rpc, args());
    await as(viewer); assert.equal((await db.query('select * from public.latest_behavior_assessments')).rows.length, 8); await denied(rpc, args(a, 'responsibility', 2));
    await as(ownerB); assert.equal((await db.query('select * from public.behavior_assessment_entries')).rows.length, 0);
    assert.equal((await db.query('select * from public.latest_behavior_assessments')).rows.length, 0); await denied(rpc, args(a, 'responsibility', 2));
    await save(b); assert.equal((await db.query('select * from public.latest_behavior_assessments')).rows.length, 1);
    await as(ownerA); assert.equal((await db.query('select * from public.latest_behavior_assessments where company_id=$1', [b.company])).rows.length, 0);
  });

  await t.test('even owner cannot forge, replace or delete revision columns through the API', async () => {
    for (const sql of ["update public.behavior_assessment_entries set evidence='tampered'", 'delete from public.behavior_assessment_entries',
      "update public.behavior_assessment_entries set version=999", "insert into public.behavior_assessment_entries(id) values(gen_random_uuid())"]) await denied(sql);
    assert.equal((await db.query("select has_table_privilege('authenticated','public.latest_behavior_assessments','UPDATE') ok")).rows[0].ok, false);
    await denied("update public.latest_behavior_assessments set evidence='tampered'", [], '55000');
  });

  await t.test('stale writes including duplicate first save fail without destroying previous evidence', async () => {
    await denied(rpc, args(a, 'responsibility', 1), '40001'); await denied(rpc, args(a, 'initiative', 0), '40001');
    await save(a, 'responsibility', 2, 'insufficient_data', 'Potrzebne dalsze pytanie');
    const rows = (await db.query("select version,evidence from public.behavior_assessment_entries where area_key='responsibility' order by version")).rows;
    assert.equal(rows.length, 3); assert.equal(rows[1].evidence, 'Drugi dowód'); assert.equal(rows[2].version, 3);
  });

  await t.test('RPC independently validates rating, evidence, known area, version and snapshot reference', async () => {
    for (const [offset, value] of [[1, 'unknown'], [2, 'hired'], [3, '\t\n\u00a0\u2009\ufeff'], [3, 'x'.repeat(10001)], [3, null], [4, -1], [4, null], [5, null], [6, null]]) {
      const values = args(a, 'responsibility', 3); values[offset] = value; await denied(rpc, values, '22023');
    }
    const forged = args(a, 'responsibility', 3); forged[6] = b.position.id; await denied(rpc, forged, '40001');
  });

  await t.test('changed profile blocks stale editor; new revision preserves old requirements and full profile', async () => {
    await db.query("update public.positions set title='Nowy profil',tasks=array['Nowe zadanie'],required_behaviors=$1 where id=$2", [requirements.map(r => r.replace('Standardowy', 'Wysoki')), a.position.id]);
    await denied(rpc, args(a, 'responsibility', 3), '40001'); await refreshPosition(); await save(a, 'responsibility', 3);
    const rows = (await db.query("select * from public.behavior_assessment_entries where area_key='responsibility' order by version")).rows;
    assert.equal(rows[0].required_level, 'Standardowy'); assert.equal(rows[0].position_snapshot.title, 'TEST');
    assert.equal(rows[3].required_level, 'Wysoki'); assert.equal(rows[3].position_snapshot.title, 'Nowy profil'); assert.deepEqual(rows[3].position_snapshot.tasks, ['Nowe zadanie']);
  });

  await t.test('legacy missing, duplicated and malformed requirements are rejected, including Unicode whitespace', async () => {
    for (const behaviors of [[], ['Odpowiedzialność'], ['Odpowiedzialność: nieznany'], ['Odpowiedzialność: Wysoki: x'],
      ['Odpowiedzialność: Wysoki', '\t\u00a0Odpowiedzialność\t: Niski\n'], ['Odpowiedzialność: Wysoki', 'Odpowiedzialność']]) {
      assert.equal(buildBehaviorGuide(behaviors).areas[0].requiredLevel, null);
      await db.query('update public.positions set required_behaviors=$1 where id=$2', [behaviors, a.position.id]); await refreshPosition();
      await denied(rpc, args(a, 'responsibility', 4), '22023');
    }
    const normalized = ['\t\u00a0Odpowiedzialność\n: Wysoki\ufeff'];
    assert.equal(buildBehaviorGuide(normalized).areas[0].requiredLevel, 'Wysoki');
    await db.query('update public.positions set required_behaviors=$1 where id=$2', [normalized, a.position.id]); await refreshPosition(); await save(a, 'responsibility', 4);
  });

  await t.test('closed workflows and revoked editing membership block writes, while history remains readable', async () => {
    for (const [table, id, statuses, restored] of [['applications', a.application.id, ['hired', 'rejected', 'withdrawn'], 'new'],
      ['recruitments', a.recruitment.id, ['closed', 'paused'], 'open'], ['positions', a.position.id, ['archived'], 'active']]) {
      for (const status of statuses) { await db.query(`update public.${table} set status=$1 where id=$2`, [status, id]); await refreshPosition(); await denied(rpc, args(a, 'responsibility', 5), '55000'); }
      await db.query(`update public.${table} set status=$1 where id=$2`, [restored, id]); await refreshPosition();
    }
    await db.query("update public.company_members set role='viewer' where company_id=$1 and user_id=$2", [a.company, recruiter]);
    await as(recruiter); await denied(rpc, args(a, 'responsibility', 5));
    assert.equal((await db.query("select * from public.behavior_assessment_entries where area_key='responsibility'")).rows.length, 5);
  });
});
