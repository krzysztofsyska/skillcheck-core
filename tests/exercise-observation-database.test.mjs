import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('exercise observations preserve evidence, immutable rubric and tenant boundaries', async t => {
  const db=new PGlite(); t.after(()=>db.close());
  await db.exec(`create role anon nologin; create role authenticated nologin; create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`);
  for(const name of ['20260930000100_skillcheck_core','20261001000100_idempotent_onboarding','20261001000200_candidate_documents',
    '20261002000100_behavior_assessments','20261002000200_behavior_conflict_response','20261002000300_exercise_definitions','20261004000100_exercise_observations'])
    await db.exec(await readFile(new URL('../supabase/migrations/'+name+'.sql',import.meta.url),'utf8'));
  const [ownerA,ownerB,recruiter,viewer]=[1,2,3,4].map(n=>'00000000-0000-0000-0000-00000000000'+n);
  for(const id of [ownerA,ownerB,recruiter,viewer]) await db.query('insert into auth.users values($1)',[id]);
  const as=async(id,role='authenticated')=>{await db.exec('reset role;set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id??'']);};
  const definition={kind:'competency_test',title:'TEST',instructions:'Zadanie',expectedOutput:'Praca',durationMinutes:20,
    criteria:[{competency:'Planowanie',below:'Pomija termin',meets:'Uwzględnia termin',above:'Wskazuje zależności'},
      {competency:'Komunikacja',below:'Nie informuje',meets:'Podaje informację',above:'Potwierdza zrozumienie'}]};
  const seed=async owner=>{
    await as(owner);
    const company=(await db.query("select public.create_company('TEST') id")).rows[0].id;
    const position=(await db.query("insert into public.positions(company_id,title) values($1,'TEST') returning id,updated_at::text stamp",[company])).rows[0];
    const recruitment=(await db.query("insert into public.recruitments(company_id,position_id,name) values($1,$2,'TEST') returning id",[company,position.id])).rows[0].id;
    const candidate=(await db.query("insert into public.candidates(company_id,first_name,last_name) values($1,'TEST','TEST') returning id",[company])).rows[0].id;
    const application=(await db.query('insert into public.applications(company_id,recruitment_id,candidate_id) values($1,$2,$3) returning id',[company,recruitment,candidate])).rows[0].id;
    const exercise=(await db.query('select gen_random_uuid() id')).rows[0].id;
    const revision=(await db.query('select public.save_exercise_definition($1,$2,$3,0,$4,$5) id',[recruitment,exercise,JSON.stringify(definition),position.id,position.stamp])).rows[0].id;
    return {company,position,recruitment,application,exercise,revision};
  };
  const a=await seed(ownerA),b=await seed(ownerB);
  await as(ownerA);
  for(const [id,role] of [[recruiter,'recruiter'],[viewer,'viewer']]) await db.query('insert into public.company_members(company_id,user_id,role) values($1,$2,$3)',[a.company,id,role]);
  const observations=()=>[{criterionIndex:0,rating:'meets',evidence:' Wskazał termin. '},{criterionIndex:1,rating:'insufficient_data',evidence:''}];
  const sql='select public.save_exercise_observations($1,$2,$3,$4,$5) id';
  const args=(version=0,target=a,items=observations())=>[target.application,target.revision,version,' Praca TEST ',JSON.stringify(items)];
  const deny=(query,values=[],code='42501')=>assert.rejects(db.query(query,values),e=>e.code===code);
  await t.test('owner and recruiter append attributed revisions; missing data stays distinct',async()=>{
    await db.query(sql,args()); await as(recruiter); await db.query(sql,args(1));
    const rows=(await db.query('select * from public.exercise_observation_entries order by version')).rows;
    assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>r.author_id),[ownerA,recruiter]);
    assert.equal(rows[0].work_sample,'Praca TEST');assert.equal(rows[0].observations[0].evidence,'Wskazał termin.');
    assert.equal(rows[0].observations[1].rating,'insufficient_data');
    assert.equal((await db.query('select version from public.latest_exercise_observations')).rows[0].version,2);
  });
  await t.test('viewer reads only; other firms cannot read or mix definitions and applications',async()=>{
    await as(viewer);assert.equal((await db.query('select * from public.latest_exercise_observations')).rows.length,1);await deny(sql,args(2));
    await as(ownerB);
    for(const relation of ['exercise_observation_entries','latest_exercise_observations']) assert.equal((await db.query('select * from public.'+relation)).rows.length,0);
    await deny(sql,args(2));await deny(sql,args(0,{...b,revision:a.revision}));await db.query(sql,args(0,b));
    await as(ownerA);await deny(sql,args(2,{...a,revision:b.revision}));
    assert.equal((await db.query('select * from public.exercise_observation_entries where company_id=$1',[b.company])).rows.length,0);
    await as(null);await deny(sql,args(2));await as(null,'anon');await deny(sql,args(2));await deny('select * from public.latest_exercise_observations');await as(ownerA);
  });
  await t.test('history is immutable and stale requests cannot append duplicate revisions',async()=>{
    for(const query of ['delete from public.exercise_observation_entries',"update public.exercise_observation_entries set work_sample='forged'","insert into public.exercise_observation_entries(id) values(gen_random_uuid())"])
      await deny(query);
    await deny(sql,args(0),'PT409');await deny(sql,args(1),'PT409');
    const otherRecruitment=(await db.query("insert into public.recruitments(company_id,position_id,name) values($1,$2,'Other') returning id",[a.company,a.position.id])).rows[0].id;
    const foreignRevision=(await db.query('select public.save_exercise_definition($1,gen_random_uuid(),$2,0,$3,$4) id',[otherRecruitment,JSON.stringify(definition),a.position.id,a.position.stamp])).rows[0].id;
    await deny(sql,args(2,{...a,revision:foreignRevision}));
  });
  await t.test('SQL rejects malformed, reordered or ungrounded observations and strips extra metadata',async()=>{
    const bad=[null,{},[],[null],observations().slice(0,1),[...observations(),observations()[0]],observations().reverse()];
    for(const patch of [{criterionIndex:'0'},{criterionIndex:0.5},{rating:'hired'},{rating:null},{evidence:'\u2009\ufeff'},{evidence:'x'.repeat(10001)},{evidence:null}]) bad.push([{...observations()[0],...patch},observations()[1]]);
    for(const value of bad) await deny(sql,args(2,a,value),'22023');
    const sample=args(2);sample[3]='x'.repeat(20001);await deny(sql,sample,'22023');
    const missing=args(2);missing[2]=null;await deny(sql,missing,'22023');
    await db.query(sql,args(2,a,observations().map(x=>({...x,author_id:ownerB,score:100}))));
    assert.equal((await db.query('select observations from public.latest_exercise_observations')).rows[0].observations[0].score,undefined);
  });
  await t.test('new rubric revisions never rewrite the criteria behind an observation',async()=>{
    await db.query('select public.save_exercise_definition($1,$2,$3,1,$4,$5)',[a.recruitment,a.exercise,JSON.stringify({...definition,title:'Changed',criteria:definition.criteria.slice(0,1)}),a.position.id,a.position.stamp]);
    await db.query(sql,args(3));
    const row=(await db.query('select d.definition from public.latest_exercise_observations o join public.exercise_definition_entries d on d.id=o.definition_entry_id')).rows[0];
    assert.equal(row.definition.title,'TEST');assert.equal(row.definition.criteria.length,2);
  });
  await t.test('closed workflow and revoked membership prohibit further writes',async()=>{
    await db.query("update public.applications set status='withdrawn' where id=$1",[a.application]);await deny(sql,args(4),'55000');
    await db.query("update public.applications set status='new' where id=$1",[a.application]);
    await db.query("update public.recruitments set status='paused' where id=$1",[a.recruitment]);await deny(sql,args(4),'55000');
    await db.query("update public.recruitments set status='draft' where id=$1",[a.recruitment]);
    await db.query("update public.positions set status='archived' where id=$1",[a.position.id]);await deny(sql,args(4),'55000');
    await db.query('delete from public.company_members where company_id=$1 and user_id=$2',[a.company,recruiter]);
    await as(recruiter);await deny(sql,args(4));assert.equal((await db.query('select * from public.latest_exercise_observations')).rows.length,0);
  });
});
