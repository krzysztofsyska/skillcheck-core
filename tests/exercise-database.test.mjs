import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { parseExerciseDefinition } from '../lib/exercise-definition.ts';

test('exercise definitions: actual migration, tenant isolation and revision history', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`create role anon nologin; create role authenticated nologin; create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`);
  for (const name of ['20260930000100_skillcheck_core','20261001000100_idempotent_onboarding','20261001000200_candidate_documents',
    '20261002000100_behavior_assessments','20261002000200_behavior_conflict_response','20261002000300_exercise_definitions'])
    await db.exec(await readFile(new URL('../supabase/migrations/' + name + '.sql', import.meta.url), 'utf8'));
  const ids = [1,2,3,4].map(n => '00000000-0000-0000-0000-00000000000' + n);
  const [ownerA,ownerB,recruiter,viewer] = ids;
  for (const id of ids) await db.query('insert into auth.users values($1)',[id]);
  const as = async (id, role='authenticated') => { await db.exec('reset role;set role '+role); await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id??'']); };
  const seed = async owner => {
    await as(owner);
    const company = (await db.query("select public.create_company('TEST') id")).rows[0].id;
    const position = (await db.query("insert into public.positions(company_id,title,tasks) values($1,'TEST',array['Zadanie']) returning id,updated_at::text stamp",[company])).rows[0];
    const recruitment = (await db.query("insert into public.recruitments(company_id,position_id,name) values($1,$2,'TEST') returning id",[company,position.id])).rows[0].id;
    return {company,position,recruitment};
  };
  const a = await seed(ownerA), b = await seed(ownerB);
  await as(ownerA);
  for (const [user,role] of [[recruiter,'recruiter'],[viewer,'viewer']]) await db.query('insert into public.company_members(company_id,user_id,role) values($1,$2,$3)',[a.company,user,role]);
  const exercise = '10000000-0000-0000-0000-000000000001';
  const definition = () => ({kind:'competency_test',title:' Zadanie ',instructions:'Uporządkuj zgłoszenia.',expectedOutput:'Lista z uzasadnieniem.',durationMinutes:20,
    criteria:[{competency:'Planowanie pracy',below:'Pomija pilne zadania.',meets:'Uwzględnia terminy.',above:'Dodatkowo wskazuje zależności.'}]});
  const sql = 'select public.save_exercise_definition($1,$2,$3::jsonb,$4,$5,$6) id';
  const args = (version=0, value=definition(), target=a, id=exercise) => [target.recruitment,id,JSON.stringify(value),version,target.position.id,target.position.stamp];
  const deny = (query, values=[],code='42501') => assert.rejects(db.query(query,values),e=>e.code===code);

  await t.test('owner creates and recruiter appends canonical immutable revisions with real author and profile',async()=>{
    await db.query(sql,args()); await as(recruiter);
    await db.query(sql,args(1,{...definition(),kind:'assessment_center',title:'Nowe zadanie'}));
    const rows=(await db.query('select * from public.exercise_definition_entries order by version')).rows;
    assert.equal(rows.length,2); assert.deepEqual(rows.map(r=>r.author_id),[ownerA,recruiter]);
    assert.deepEqual(rows[0].definition,parseExerciseDefinition(definition()));
    assert.deepEqual(rows[0].position_snapshot.tasks,['Zadanie']); assert.equal(rows[1].version,2);
    assert.equal((await db.query('select version from public.latest_exercise_definitions')).rows[0].version,2);
  });
  await t.test('viewer reads; anonymous, absent identity and another tenant cannot write or obtain foreign data',async()=>{
    await as(viewer); assert.equal((await db.query('select * from public.latest_exercise_definitions')).rows.length,1); await deny(sql,args(2));
    await as(ownerB);
    for(const relation of ['exercise_definition_entries','latest_exercise_definitions']) assert.equal((await db.query('select * from public.'+relation)).rows.length,0);
    await deny(sql,args(2)); await deny(sql,args(2,definition(),b));
    await db.query(sql,args(0,definition(),b,'10000000-0000-0000-0000-000000000002'));
    await as(null); await deny(sql,args(2));
    await as(null,'anon'); await deny(sql,args(2)); await deny('select * from public.exercise_definition_entries');
    await as(ownerA); assert.equal((await db.query('select * from public.exercise_definition_entries where company_id=$1',[b.company])).rows.length,0);
  });
  await t.test('API cannot modify history or move an exercise to another recruitment',async()=>{
    for(const query of ['delete from public.exercise_definition_entries',"update public.exercise_definition_entries set definition='{}'","insert into public.exercise_definition_entries(id) values(gen_random_uuid())"])
      await deny(query);
    const recruitment=(await db.query("insert into public.recruitments(company_id,position_id,name) values($1,$2,'Second') returning id",[a.company,a.position.id])).rows[0].id;
    await deny(sql,args(2,definition(),{...a,recruitment}));
    assert.equal((await db.query("select has_table_privilege('authenticated','public.latest_exercise_definitions','UPDATE') ok")).rows[0].ok,false);
  });
  await t.test('stale revision and profile are rejected and previous snapshots survive edits',async()=>{
    await deny(sql,args(0),'PT409'); await deny(sql,args(1),'PT409');
    await db.query("update public.positions set tasks=array['Nowe zadanie'] where id=$1",[a.position.id]);
    await deny(sql,args(2),'PT409');
    a.position.stamp=(await db.query('select updated_at::text stamp from public.positions where id=$1',[a.position.id])).rows[0].stamp;
    await db.query(sql,args(2));
    const rows=(await db.query('select position_snapshot from public.exercise_definition_entries order by version')).rows;
    assert.deepEqual(rows[0].position_snapshot.tasks,['Zadanie']); assert.deepEqual(rows[2].position_snapshot.tasks,['Nowe zadanie']);
  });
  await t.test('SQL validates payload independently, normalizes duplicates and strips untrusted metadata',async()=>{
    const invalid=[null,[],{}, {...definition(),kind:'hired'},{...definition(),durationMinutes:'20'},{...definition(),durationMinutes:1.5},
      {...definition(),durationMinutes:181},{...definition(),title:'\t\u2009\ufeff'}, {...definition(),criteria:[]}, {...definition(),criteria:[null]},
      {...definition(),instructions:'x'.repeat(10001)}, {...definition(),criteria:Array(13).fill(definition().criteria[0])}];
    for(const competency of ['PLANOWANIE\t PRACY','Ｐｌａｎｏｗａｎｉｅ pracy','Planowanie\u2009pracy'])
      invalid.push({...definition(),criteria:[definition().criteria[0],{...definition().criteria[0],competency}]});
    invalid.push({...definition(),criteria:[{...definition().criteria[0],above:definition().criteria[0].meets.toUpperCase()}]});
    for(const value of invalid) await deny(sql,args(3,value),'22023');
    const values=args(3); values[3]=null; await deny(sql,values,'22023');
    const forged=args(3); forged[4]=b.position.id; await deny(sql,forged,'PT409');
    await db.query(sql,args(3,{...definition(),company_id:b.company,score:100,author_id:ownerB}));
    const row=(await db.query('select * from public.latest_exercise_definitions')).rows[0];
    assert.deepEqual(row.definition,parseExerciseDefinition(definition())); assert.equal(row.author_id,ownerA);
  });
  await t.test('closed or archived workflow and revoked membership block writes',async()=>{
    await db.query("update public.recruitments set status='closed' where id=$1",[a.recruitment]); await deny(sql,args(4),'55000');
    await db.query("update public.recruitments set status='draft' where id=$1",[a.recruitment]);
    await db.query("update public.positions set status='archived' where id=$1",[a.position.id]); await deny(sql,args(4),'55000');
    await db.query('delete from public.company_members where company_id=$1 and user_id=$2',[a.company,recruiter]);
    await as(recruiter); await deny(sql,args(4)); assert.equal((await db.query('select * from public.latest_exercise_definitions')).rows.length,0);
  });
});
