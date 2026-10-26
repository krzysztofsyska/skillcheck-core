import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const migration = new URL('../supabase/migrations/20261026215600_sc_step4_interview_decision.sql', import.meta.url);
const rollback = new URL('../supabase/rollbacks/20261026215600_sc_step4_interview_decision.down.sql', import.meta.url);

test('Step 4 SQL end-to-end: multi-tenant stage → interview note → human decision → down', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`create role anon nologin; create role authenticated nologin; create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;`);
  for (const path of ['20260930000100_skillcheck_core.sql', '20261001000100_idempotent_onboarding.sql']) {
    await db.exec(await readFile(new URL('../supabase/migrations/' + path, import.meta.url), 'utf8'));
  }
  await db.exec(await readFile(migration, 'utf8'));
  const [ownerA, ownerB, viewer] = [1,2,3].map(n => `00000000-0000-0000-0000-00000000000${n}`);
  for (const id of [ownerA, ownerB, viewer]) await db.query('insert into auth.users values($1)', [id]);
  const as = async (id, role = 'authenticated') => {
    await db.exec('reset role; set role ' + role);
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id ?? '']);
  };
  const insert = async (table, values) => {
    const keys = Object.keys(values);
    return (await db.query(`insert into public.${table} (${keys.join(',')}) values (${keys.map((_, i) => '$' + (i + 1)).join(',')}) returning *`, Object.values(values))).rows[0];
  };
  const seed = async (owner, label) => {
    await as(owner);
    const company = (await db.query('select public.create_company($1) as id', [label])).rows[0].id;
    const position = await insert('positions', { company_id: company, title: 'Doradca' });
    const recruitment = await insert('recruitments', { company_id: company, position_id: position.id, name: 'Doradcy' });
    const candidate = await insert('candidates', { company_id: company, first_name: 'Test', last_name: label });
    const application = await insert('applications', { company_id: company, recruitment_id: recruitment.id, candidate_id: candidate.id });
    const interview = await insert('assessment_stages', { company_id: company, recruitment_id: recruitment.id, name: 'Rozmowa', sequence: 1 });
    const reference = await insert('assessment_stages', { company_id: company, recruitment_id: recruitment.id, name: 'Referencje', sequence: 2 });
    return { company, recruitment, candidate, application, interview, reference };
  };
  const a = await seed(ownerA, 'A'), b = await seed(ownerB, 'B');
  await as(ownerA);
  await insert('company_members', { company_id: a.company, user_id: viewer, role: 'viewer' });

  await t.test('no decision until a human makes an explicit action', async () => {
    const { rows } = await db.query('select human_decision,human_decision_reason,current_stage_id from public.applications where id=$1', [a.application.id]);
    assert.deepEqual(rows[0], { human_decision: null, human_decision_reason: null, current_stage_id: null });
    for (const table of ['application_stage_events', 'application_decision_events', 'candidate_assessment_note_revisions'])
      assert.equal((await db.query(`select * from public.${table}`)).rows.length, 0);
  });
  await t.test('manual move and reorder produce an accurate actor/timestamp and current stage', async () => {
    await db.query('select public.move_assessment_stage($1,$2,$3,$4)', [a.company, a.recruitment.id, a.reference.id, -1]);
    const seq = (await db.query('select id,sequence from public.assessment_stages where company_id=$1 order by sequence', [a.company])).rows;
    assert.deepEqual(seq.map(v => v.id), [a.reference.id, a.interview.id]);
    await db.query('select public.move_application_stage($1,$2,$3,$4)', [a.company, a.recruitment.id, a.application.id, a.interview.id]);
    await db.query('select public.move_application_stage($1,$2,$3,$4)', [a.company, a.recruitment.id, a.application.id, a.reference.id]);
    const rows = (await db.query('select from_stage_id,to_stage_id,actor_id,created_at from public.application_stage_events order by created_at,id')).rows;
    assert.equal(rows.length, 2);
    assert.ok(rows.every(r => r.actor_id === ownerA && r.created_at));
    const current = (await db.query('select current_stage_id from public.applications where id=$1', [a.application.id])).rows[0].current_stage_id;
    assert.equal(current, a.reference.id);
    await assert.rejects(db.query('delete from public.assessment_stages where id=$1', [a.interview.id]), err => err.code === '23503');
  });
  await t.test('note autosave and revision history have the real user and nullable question', async () => {
    const assessment = await insert('candidate_assessments', {
      company_id: a.company, recruitment_id: a.recruitment.id, application_id: a.application.id, stage_id: a.interview.id,
      notes: 'Opis sytuacji, wynik i obserwacja',
    });
    await db.query('update public.candidate_assessments set notes=$1 where id=$2', ['Druga obserwacja i rezultat', assessment.id]);
    const versions = (await db.query('select body,author_id,guide_question_id,created_at from public.candidate_assessment_note_revisions where assessment_id=$1 order by created_at,id', [assessment.id])).rows;
    assert.equal(versions.length, 2);
    assert.deepEqual(versions.map(r => r.body), ['Opis sytuacji, wynik i obserwacja', 'Druga obserwacja i rezultat']);
    assert.ok(versions.every(r => r.author_id === ownerA && r.created_at && r.guide_question_id === null));
    await assert.rejects(db.query("delete from public.candidate_assessment_note_revisions"), err => err.code === '42501');
  });
  await t.test('explicit decision demands reason, logs both transitions, forbids direct write', async () => {
    const args = [a.company, a.recruitment.id, a.application.id];
    await assert.rejects(db.query('select public.set_application_human_decision($1,$2,$3,$4,$5)', [...args, 'closed', ' ']), e => e.code === '22023');
    await assert.rejects(db.query("update public.applications set human_decision='closed' where id=$1", [a.application.id]), e => e.code === '42501');
    await db.query('select public.set_application_human_decision($1,$2,$3,$4,$5)', [...args, 'on_hold', 'Brak odpowiedzi dotyczących wyniku.']);
    await db.query('select public.set_application_human_decision($1,$2,$3,$4,$5)', [...args, 'next_stage', 'Uzupełniono potwierdzenie doświadczenia.']);
    const log = (await db.query('select previous_decision,new_decision,reason,actor_id from public.application_decision_events where company_id=$1 order by created_at,id', [a.company])).rows;
    assert.equal(log.length, 2);
    assert.equal(log[0].previous_decision, null);
    assert.equal(log[0].new_decision, 'on_hold');
    assert.equal(log[1].previous_decision, 'on_hold');
    assert.equal(log[1].new_decision, 'next_stage');
    assert.ok(log.every(e => e.actor_id === ownerA && e.reason.length >= 10));
  });
  await t.test('RLS: tenant B cannot read/write tenant A, viewer cannot invoke human RPC', async () => {
    await as(ownerB);
    for (const table of ['applications','assessment_stages','candidate_assessments',
      'application_stage_events','application_decision_events','candidate_assessment_note_revisions']) {
      assert.equal((await db.query(`select * from public.${table} where company_id=$1`, [a.company])).rows.length, 0);
    }
    await assert.rejects(db.query('select public.move_application_stage($1,$2,$3,$4)',
      [a.company,a.recruitment.id,a.application.id,a.interview.id]), e => e.code === '42501');
    await assert.rejects(db.query('select public.set_application_human_decision($1,$2,$3,$4,$5)',
      [a.company,a.recruitment.id,a.application.id,'closed','Wroga zmiana decyzji w innym tenancie']), e => e.code === '42501');
    const hostileWrite = await db.query('update public.candidate_assessments set notes=$1 where company_id=$2 returning id',
      ['Wroga notatka', a.company]);
    assert.equal(hostileWrite.rows.length, 0);
    await as(viewer);
    await assert.rejects(db.query('select public.set_application_human_decision($1,$2,$3,$4,$5)',
      [a.company,a.recruitment.id,a.application.id,'closed','Viewer nie ma prawa zapisywać decyzji']), e => e.code === '42501');
    await as(ownerA);
    const still = (await db.query('select human_decision from public.applications where id=$1', [a.application.id])).rows[0].human_decision;
    assert.equal(still, 'next_stage');
  });
  await t.test('down migration removes only Step 4 schema', async () => {
    await db.exec('reset role');
    await db.exec(await readFile(rollback, 'utf8'));
    const columns = (await db.query("select column_name from information_schema.columns where table_schema='public' and table_name='applications'")).rows.map(r => r.column_name);
    assert.equal(columns.includes('human_decision'), false);
    assert.equal(columns.includes('current_stage_id'), false);
    assert.equal((await db.query("select to_regclass('public.application_decision_events') as table_name")).rows[0].table_name, null);
    assert.equal((await db.query("select to_regprocedure('public.set_application_human_decision(uuid,uuid,uuid,text,text)') as fn")).rows[0].fn, null);
  });
});
