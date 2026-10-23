import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { parse } from 'pg-connection-string';
import { setupRankingDatabase, createRankingHarness, users } from './helpers/screening-ranking-fixture.mjs';

const databaseName=`screening_sc008_${process.pid}`;
const maintenanceUrl=process.env.SCREENING_TEST_DATABASE_URL;
const outcome=async promise=>{try{return {ok:true,value:await promise};}catch(error){return {ok:false,code:error.code,message:error.message};}};
const assertConflict=value=>{assert.equal(value.ok,false);assert.equal(value.code,'PT409',value.message);};

test('SC-008 real PostgreSQL transaction races preserve confirmed snapshots',async t=>{
  assert.ok(maintenanceUrl,'SCREENING_TEST_DATABASE_URL is required; PGlite cannot verify multi-session races');
  const config=name=>({...parse(maintenanceUrl),database:name});
  const maintenance=new Client(config('postgres'));await maintenance.connect();
  await maintenance.query(`drop database if exists ${databaseName}`);await maintenance.query(`create database ${databaseName}`);await maintenance.end();
  const clients=[];
  const connect=async()=>{const client=new Client(config(databaseName));await client.connect();client.exec=sql=>client.query(sql);clients.push(client);await client.query("set statement_timeout='15s'; set lock_timeout='5s'");return client;};
  t.after(async()=>{
    await Promise.all(clients.map(client=>client.end().catch(()=>{})));
    const cleanup=new Client(config('postgres'));await cleanup.connect();
    await cleanup.query('select pg_terminate_backend(pid) from pg_stat_activity where datname=$1',[databaseName]);
    await cleanup.query(`drop database if exists ${databaseName}`);await cleanup.end();
    // Cluster roles are shared by other concurrency suites; do not drop their roles.
  });
  const admin=await connect(),h=await setupRankingDatabase(admin);
  const waitForLock=async client=>{
    await h.asAdmin();
    for(let i=0;i<250;i++){
      if((await admin.query('select wait_event_type from pg_stat_activity where pid=$1',[client.processID])).rows[0]?.wait_event_type==='Lock')return;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.fail('second transaction did not encounter the expected held row/index lock');
  };
  const session=async()=>{const db=await connect(),fixture=createRankingHarness(db);await fixture.asUser();return fixture;};
  const approved=async label=>h.completedApplication(await h.seed(users.owner,label),Array(5).fill('meets'));
  const finalEntries=async f=>{await h.asUser();return h.shortlist(f,true);};
  const assertSingle=async f=>{
    await h.asAdmin();
    const r=(await admin.query('select count(*)::int as n from public.recruitment_shortlist_entries where application_id=$1 and removed_at is null',[f.application.id])).rows[0];assert.ok(r.n<=1);
    const analysis=(await admin.query('select overall_score from public.screening_analysis_versions where application_id=$1',[f.application.id])).rows;assert.ok(analysis.every(a=>a.overall_score===null));
    assert.equal((await admin.query('select status from public.applications where id=$1',[f.application.id])).rows[0].status,'new');
  };

  for(const change of ['review','document','position','completion'])for(const first of ['add','change']) {
    await t.test(`${first} obtains locks first: add versus ${change}`,async()=>{
      const f=await approved(`${change}-${first}`),original=await h.row(f);
      const adder=await session(),changer=await session();
      let newer,claimed;
      if(change==='completion'){newer=await h.start(f,{promptVersion:'ranking-next'});claimed=await h.claim(newer);}
      const mutate=async()=>{
        if(change==='review')return changer.review(f,f.analysis_id);
        if(change==='document')return changer.db.query("update public.candidate_documents set redacted_text=redacted_text||' changed' where id=$1",[f.document.id]);
        if(change==='position')return changer.db.query("update public.positions set title=title||' changed' where id=$1",[f.position.id]);
        return changer.finishClaim(newer,claimed,Array(5).fill('above'));
      };
      if(first==='add'){
        await adder.db.query('begin');const id=await adder.add(f,'manual',original,'Confirmed old result');
        if(change==='review'||change==='completion'){
          // R2 source RPCs lock the candidate NOWAIT before their original row locks.
          assertConflict(await outcome(mutate()));await adder.db.query('commit');
          const retried=await outcome(mutate());assert.equal(retried.ok,true,retried.message);
        }else{
          // Direct document/position UPDATE still waits on the row held by shortlist.
          const pending=outcome(mutate());await waitForLock(changer.db);await adder.db.query('commit');
          const result=await pending;assert.equal(result.ok,true,result.message);
        }
        const entries=await finalEntries(f);assert.equal(entries.length,1);assert.equal(entries[0].entry_id,id);assert.equal(entries[0].analysis_id,original.analysis_id);assert.equal(entries[0].review_id,original.review_id);assert.equal(entries[0].snapshot_current,false);assert.equal(Number(entries[0].raw_score_snapshot),50);
      }else{
        await changer.db.query('begin');await mutate();
        const result=await outcome(adder.add(f,'manual',original));assertConflict(result);await changer.db.query('commit');
        assert.equal((await finalEntries(f)).length,0);
      }
      await assertSingle(f);
    });
  }

  for(const winningSide of['left','right'])await t.test(`two adds: ${winningSide} owns uncommitted unique entry`,async()=>{
    const f=await approved(`two-add-${winningSide}`),expected=await h.row(f),left=await session(),right=await session();
    const winner=winningSide==='left'?left:right,loser=winningSide==='left'?right:left;
    await winner.db.query('begin');const id=await winner.add(f,'manual',expected);
    // The candidate guard rejects before the unique-index wait; after commit
    // the retry must still reject the already-created active snapshot.
    assertConflict(await outcome(loser.add(f,'manual',expected)));await winner.db.query('commit');
    assertConflict(await outcome(loser.add(f,'manual',expected))); const entries=await finalEntries(f);assert.equal(entries.length,1);assert.equal(entries[0].entry_id,id);assert.equal(entries[0].snapshot_current,true);await assertSingle(f);
  });

  for(const winningSide of['left','right'])await t.test(`two removes: ${winningSide} owns row lock and replay is idempotent`,async()=>{
    const f=await approved(`two-remove-${winningSide}`),id=await h.add(f),left=await session(),right=await session();
    const winner=winningSide==='left'?left:right,loser=winningSide==='left'?right:left;
    await winner.db.query('begin');assert.equal(await winner.remove(id),id);
    const pending=outcome(loser.remove(id));await waitForLock(loser.db);await winner.db.query('commit');
    const result=await pending;assert.equal(result.ok,true,result.message);assert.equal(result.value,id);
    const entries=await finalEntries(f);assert.equal(entries.length,1);assert.ok(entries[0].removed_at);assert.equal(entries[0].removed_by,users.owner);assert.equal(entries[0].snapshot_current,false);await assertSingle(f);
  });

  await t.test('remove first: concurrent add waits then creates a new immutable snapshot',async()=>{
    const f=await approved('remove-add'),expected=await h.row(f),oldId=await h.add(f),remover=await session(),adder=await session();
    await remover.db.query('begin');await remover.remove(oldId);
    // Depending on the read snapshot, an existing active row may reject immediately;
    // either PT409 or a post-commit insert is valid, but never a partial/duplicate row.
    const pending=outcome(adder.add(f,'manual',expected));
    const result=await Promise.race([pending,new Promise(resolve=>setTimeout(()=>resolve(null),50))]);
    await remover.db.query('commit');const settled=result??await pending;
    if(settled.ok)assert.notEqual(settled.value,oldId);else assertConflict(settled);
    let entries=await finalEntries(f);assert.ok(entries.find(e=>e.entry_id===oldId).removed_at);
    if(!settled.ok){await h.asUser();await h.add(f,'manual',expected);entries=await finalEntries(f);}
    assert.equal(entries.length,2);assert.equal(entries.filter(e=>e.removed_at===null).length,1);await assertSingle(f);
  });

  await t.test('add first: uncommitted entry is invisible to concurrent remove, then removable after commit',async()=>{
    const f=await approved('add-remove'),expected=await h.row(f),adder=await session(),remover=await session();
    await adder.db.query('begin');const id=await adder.add(f,'manual',expected);
    const concurrent=await outcome(remover.remove(id));
    assert.equal(concurrent.ok,false);assert.equal(concurrent.code,'42501',concurrent.message);
    await adder.db.query('commit');
    let entries=await finalEntries(f);assert.equal(entries.length,1);assert.equal(entries[0].entry_id,id);assert.equal(entries[0].snapshot_current,true);
    assert.equal(await remover.remove(id),id);
    entries=await finalEntries(f);assert.equal(entries.length,1);assert.ok(entries[0].removed_at);await assertSingle(f);
  });
});
