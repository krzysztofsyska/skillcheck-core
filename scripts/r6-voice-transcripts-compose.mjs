// Compose R6-1c (part 7): the SC-011-B3 voice interview transcripts as a real
// migration on top of the reviewed R22 operator resolution
// (20261120090000_r6_voice_resolution_r22.sql) and the R20 dispatch ledger
// (20261119180000_r6_voice_dispatch_r20.sql).
// Offline only: no provider transport, no webhook route, no API grant, no app
// use, no reader for recruiters, no report or screen.
//
// Source is the reviewed isolated file db/isolated/sc011b3-voice-transcripts.sql,
// pinned by hash. Its table, its recruitment closed_at stamp and its hardening
// are copied byte for byte, except:
//  - the transcript guard runs as the caller (security invoker) and lets the
//    manifest-checked erasure purge delete a row, like every other voice guard;
//  - a retention delete serializes on the candidate row and is refused while the
//    candidate is frozen for erasure (the erasure manifest already counts the
//    row), and the retention purge skips frozen candidates, so a scheduled run
//    never breaks a candidate erasure that is in progress.
// Erasure inventory R23 adds the transcripts table: a transcript belongs to every
// subject of its call attempt (and its own candidate) and is purged before the
// attempt it references. A candidate's erasure request therefore removes the
// transcript before the 90-day retention ends.
// Not included (separate later parts): SC-010 R4 retention, the trusted
// retention scheduler, any recruiter or SC-013 reader, operator screen or API route.
//
// Usage: node scripts/r6-voice-transcripts-compose.mjs          (write the migration)
//        node scripts/r6-voice-transcripts-compose.mjs --check  (fail when out of date)
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
const pinned = (path, hash) => {
 const text = readFileSync(path,'utf8');
 if(sha(text)!==hash)throw Error('Review updated source before composing the voice transcripts migration: '+path);
 return text;
};
const r20 = pinned('supabase/migrations/20261119180000_r6_voice_dispatch_r20.sql','172abd9dd3e814ddfa831908753afa2cba626054ce7fd5008331f9a11c528236');
const r22 = pinned('supabase/migrations/20261120090000_r6_voice_resolution_r22.sql','47bd32b95674c210a89f7c80cfd1682010a3520770ad9b13d6fd0cb0489929a6');
const transcriptSource = pinned('db/isolated/sc011b3-voice-transcripts.sql','b9236b9d473ec3439bc28281aa83e39e426bded8620817f71842e89b5c093a56');
const sourceSignature = '3e6a9df7b8146c65fac9b7b04cbb60f68b1b47b98039461d077a252426e1adee';
const signature = '4dab3fae234c8233104d691381b62710570324bee0db8bd5df4be28f3d6702f7';

function fn(source,name){
 const start = source.search(new RegExp(`create (?:or replace )?function ${name.replaceAll('.','\\.')}\\(`));
 const end = source.indexOf('$$;',start);if(start<0||end<0)throw Error('Missing source '+name);
 return source.slice(start,end+3);
}
const body = (source,name) => sha(fn(source,name).split('$$')[1]);
const once = (text,from,to) => {
 if(text.split(from).length!==2)throw Error('Expected exactly one occurrence: '+from.slice(0,80));
 return text.replace(from,()=>to);
};
const withoutHeader = text => text.replace(/^(?:--[^\n]*\n)+/,'');
const unwrapped = text => {
 let out = withoutHeader(text);
 out = once(out,'begin;\n','');
 if(!out.trimEnd().endsWith('commit;'))throw Error('Isolated source must end with commit');
 return out.trimEnd().slice(0,-'commit;'.length).trim();
};
const purgeLine = ` if tg_op='DELETE' and current_user='erasure_purge_owner' and
  private.erasure_purge_allowed(tg_table_schema||'.'||tg_table_name,to_jsonb(old)) then return old;end if;
`;
if(!fn(r22,'private.sc011b_resolution_guard').includes(purgeLine))throw Error('R22 purge-aware guard form changed');

const readers = [['public.preview_candidate_erasure','uuid,text,uuid'],['private.prepare_erasure_purge_manifest','uuid'],
 ['private.authorize_retention_suggestion','uuid'],['public.get_retention_schedule','uuid']];
const adapters = [['private.erasure_inventory_rows','uuid,uuid[]'],['private.erasure_row_candidates','text,jsonb'],
 ['private.erasure_purge_engine','uuid,bigint,boolean']];
const expectedConfig = name => ['private.erasure_row_candidates','public.get_retention_schedule'].includes(name)
 ? `array['search_path=""']` : `array['search_path=""','TimeZone=UTC','DateStyle=ISO, YMD']`;
const pinnedFunction = (source,[name,args],strict) => {
 const owner = name.endsWith('erasure_purge_engine')?'erasure_purge_owner':'postgres';
 const acl = `{${owner}=X/${owner}${name.startsWith('public.')?',authenticated=X/postgres':''}}`;
 return `if not exists(select 1 from pg_proc where oid='${name}(${args})'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='${body(source,name)}'${strict?`
  and pg_get_userbyid(proowner)='${owner}' and prosecdef and proconfig=${expectedConfig(name)} and proacl::text='${acl}'`:''}) then
  raise exception 'voice_transcripts_source_function_unreviewed:${name}' using errcode='55000';end if;`;
};
const inventoryCheck = (baseline,label) => `select known_tables into known from private.${baseline} where singleton;
 select array_agg(n.nspname||'.'||c.relname order by (n.nspname||'.'||c.relname) collate "C") into actual
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f');
 if actual is distinct from (select array_agg(x order by x collate "C") from unnest(known) x) then
  raise exception '${label}' using errcode='55000';end if;`;

const transcriptTable = 'private.sc011b_voice_transcripts';
const domainFunctions = ['private.sc011b_purge_voice_transcripts()','private.sc011b_recruitment_closed_at()'];
const definers = [...domainFunctions,'private.erasure_row_candidates(text,jsonb)','private.erasure_inventory_rows(uuid,uuid[])'];
const newFunctions = ['private.sc011b_transcript_guard()',...definers];
const verbatim = [[transcriptSource,'private.sc011b_recruitment_closed_at']];

// --- SC-011-B3 transcripts (table, closed_at stamp and hardening verbatim) ---
let transcripts = unwrapped(transcriptSource);
const guardFrom = `create function private.sc011b_transcript_guard() returns trigger
language plpgsql security definer set search_path='' as $$
declare a private.sc011b_voice_attempts; prep private.sc010c_voice_preparations;
begin
 if tg_op='TRUNCATE' or tg_op='UPDATE' then`;
transcripts = once(transcripts,guardFrom,`create function private.sc011b_transcript_guard() returns trigger
language plpgsql security invoker set search_path='' as $$
declare a private.sc011b_voice_attempts; prep private.sc010c_voice_preparations;
begin
${purgeLine} if tg_op='TRUNCATE' or tg_op='UPDATE' then`);
const retentionDeleteFrom = `   raise exception using errcode='42501',message='VOICE_TRANSCRIPT_IMMUTABLE';
  end if;
  return old;
 end if;
`;
const retentionDeleteTo = `   raise exception using errcode='42501',message='VOICE_TRANSCRIPT_IMMUTABLE';
  end if;
  -- A retention delete serializes on the candidate row and never removes a
  -- row of a candidate frozen for erasure (its manifest already counts it).
  perform private.erasure_lock_candidate(old.candidate_id);
  return old;
 end if;
`;
transcripts = once(transcripts,retentionDeleteFrom,retentionDeleteTo);
const purgeFilterFrom = `   and r.closed_at <= pg_catalog.clock_timestamp() - interval '90 days';
`;
const purgeFilterTo = `   and r.closed_at <= pg_catalog.clock_timestamp() - interval '90 days'
   -- A candidate frozen for erasure is left to the erasure purge.
   and not private.erasure_candidate_frozen(t.candidate_id);
`;
transcripts = once(transcripts,purgeFilterFrom,purgeFilterTo);
{
 const code = transcripts.replace(/--[^\n]*/g,'');
 if(/\bdrop\b/i.test(code))throw Error('Unexpected drop in voice transcripts domain');
 if(/package|PRESELEKCJA|price|pricing|order_id|\bgrant\b|http|net\./i.test(code))throw Error('Package, price, grant or transport in voice transcripts domain');
}

// --- SC-010 R23 adapter for the transcripts table ---
const keyAnchor = ` when adapter='private.sc011b_voice_webhook_receipts' then data->>'receipt_id'
`;
const purgeKey = once(fn(r22,'private.erasure_purge_key'),keyAnchor,
 ` when adapter='${transcriptTable}' then data->>'company_id'||':'||(data->>'attempt_id')
`+keyAnchor);
const wiring = `
-- Row key of the transcripts table (no id column); every other adapter keeps its
-- key (this function was last defined by 20261120090000, R22).
${purgeKey}

alter function private.erasure_inventory_rows(uuid,uuid[]) rename to erasure_inventory_rows_r22;
alter function private.erasure_row_candidates(text,jsonb) rename to erasure_row_candidates_r22;
create function private.erasure_row_candidates(adapter text,data jsonb) returns uuid[]
language plpgsql stable security definer set search_path='' as $$
declare ids uuid[];attempt jsonb;
begin
 -- A transcript belongs to every subject of its call attempt (and so of its
 -- preparation) and to its own candidate.
 if adapter='${transcriptTable}' then
  select to_jsonb(a) into attempt from private.sc011b_voice_attempts a
   where a.company_id=(data->>'company_id')::uuid and a.id=(data->>'attempt_id')::uuid;
  if attempt is null then raise exception using errcode='PT409',message='Unknown voice dispatch dependency';end if;
  select array_agg(distinct id order by id) into ids from unnest(
   private.erasure_row_candidates_r22('private.sc011b_voice_attempts',attempt)||array[(data->>'candidate_id')::uuid]) id
   where id is not null;
  return ids;
 end if;
 return private.erasure_row_candidates_r22(adapter,data);
end;$$;
create function private.erasure_inventory_rows(tenant uuid,subjects uuid[])
returns table(adapter text,row_key text,row_data jsonb) language sql stable security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
 select * from private.erasure_inventory_rows_r22(tenant,subjects)
 union all select '${transcriptTable}',private.erasure_purge_key('${transcriptTable}',to_jsonb(t)),to_jsonb(t) from ${transcriptTable} t where t.company_id=tenant and (private.erasure_row_candidates('${transcriptTable}',to_jsonb(t)) && subjects)
$$;
create table private.erasure_inventory_baseline_r23 (
 singleton boolean primary key default true check(singleton),schema_signature text not null,known_tables text[] not null
);
alter table private.erasure_inventory_baseline_r23 enable row level security;
create trigger immutable_history before update or delete on private.erasure_inventory_baseline_r23
 for each row execute function private.contact_immutable();
insert into private.erasure_inventory_baseline_r23 select true,'${signature}',
 known_tables||array['${transcriptTable}','private.erasure_inventory_baseline_r23']
 from private.erasure_inventory_baseline_r22 where singleton;

-- The transcript guard takes the candidate lock and refuses frozen candidates on
-- insert and on a retention delete (the R18 voice guard would refuse the
-- retention delete). A new transcript restarts the candidate's retention clock;
-- a retention delete does not.
create trigger zz_retention_observed after insert on ${transcriptTable}
 for each row execute function private.retention_observe_candidate();
create policy erasure_purge_select on ${transcriptTable} for select to erasure_purge_owner using (private.erasure_purge_visible('${transcriptTable}',to_jsonb(sc011b_voice_transcripts)));
create policy erasure_purge_delete on ${transcriptTable} for delete to erasure_purge_owner using (private.erasure_purge_allowed('${transcriptTable}',to_jsonb(sc011b_voice_transcripts)));
`;

const pinnedR20 = ['private.sc011b_attempt_guard','private.sc011b_receipt_guard'];
const pinnedR22 = [['private.sc011b_resolution_guard',''],['private.erasure_purge_key','text,jsonb']];
const output = [`-- R6-1c (part 7): voice interview transcripts (SC-011-B3) as a real migration.
-- Generated offline by scripts/r6-voice-transcripts-compose.mjs from the
-- reviewed isolated source and the R22 erasure inventory.
-- One minimized transcript per completed call attempt ([{speaker, text}], at
-- most 400 utterances and 256 KiB, no numbers, recordings or AI analysis).
-- Company, candidate and recruitment always come from the call attempt. A row
-- is never changed; it is removed only by:
--  - retention (owner decision 2026-10-30): 90 days after its recruitment is
--    closed (reopening pauses it), by private.sc011b_purge_voice_transcripts();
--  - a candidate erasure (inventory R23), earlier than retention, purged before
--    the call attempt it references.
-- Closing a recruitment by its status alone now stamps closed_at.
--
-- Nothing is used by the application yet and nothing is customer-visible: no
-- table or function is granted to anon, authenticated or service_role, nothing
-- is seeded, no reader, report or screen shows a transcript, no scheduler runs
-- the retention purge yet, no provider is called, no webhook route exists and no
-- package, price or order state is touched.
begin;
do $preflight$
declare known text[];actual text[];
begin
 if to_regclass('private.erasure_inventory_baseline_r22') is null or to_regclass('private.sc011b_dispatch_resolutions') is null
  or to_regclass('private.sc011b_voice_attempts') is null then
  raise exception 'voice_transcripts_requires_r22' using errcode='55000';end if;
 if to_regclass('private.erasure_inventory_baseline_r23') is not null or to_regclass('${transcriptTable}') is not null
  or to_regprocedure('private.sc011b_transcript_guard()') is not null
  or to_regprocedure('private.sc011b_purge_voice_transcripts()') is not null
  or to_regprocedure('private.sc011b_recruitment_closed_at()') is not null
  or exists(select 1 from pg_trigger where tgrelid='public.recruitments'::regclass and tgname='sc011b_recruitment_closed_at') then
  raise exception 'voice_transcripts_already_installed' using errcode='55000';end if;
 if not exists(select 1 from private.erasure_inventory_baseline_r22 where singleton and schema_signature='${sourceSignature}')
  or private.erasure_schema_signature() is distinct from '${sourceSignature}' then
  raise exception 'voice_transcripts_source_schema_unreviewed:%',private.erasure_schema_signature() using errcode='55000';end if;
 ${inventoryCheck('erasure_inventory_baseline_r22','voice_transcripts_source_inventory_gap')}
 ${adapters.map(item=>pinnedFunction(r22,item,true)).join('\n ')}
 ${readers.map(item=>pinnedFunction(r22,item,true)).join('\n ')}
 ${pinnedR22.map(item=>pinnedFunction(r22,item,false)).join('\n ')}
 ${pinnedR20.map(name=>pinnedFunction(r20,[name,''],false)).join('\n ')}
 if to_regprocedure('private.erasure_inventory_rows_r22(uuid,uuid[])') is not null
  or to_regprocedure('private.erasure_row_candidates_r22(text,jsonb)') is not null then
  raise exception 'voice_transcripts_adapter_name_taken' using errcode='55000';end if;
 if to_regprocedure('private.retention_observe_candidate()') is null or to_regprocedure('private.contact_immutable()') is null
  or to_regprocedure('private.erasure_purge_allowed(text,jsonb,text)') is null
  or to_regprocedure('private.erasure_purge_visible(text,jsonb)') is null or to_regrole('erasure_purge_owner') is null
  or to_regprocedure('private.erasure_lock_candidate(uuid)') is null
  or to_regprocedure('private.erasure_candidate_frozen(uuid)') is null
  or not exists(select 1 from pg_attribute where attrelid='public.recruitments'::regclass and attname='closed_at'
   and atttypid='timestamptz'::regtype and not attisdropped) then
  raise exception 'voice_transcripts_dependency_missing' using errcode='55000';end if;
end $preflight$;`,
`-- SC-011-B3 voice transcripts (source: db/isolated/sc011b3-voice-transcripts.sql).`,transcripts,
wiring.trim()];
for(const [name] of readers){
 const source=fn(r22,name);
 if(!source.includes('erasure_inventory_baseline_r22'))throw Error('Reader has no baseline reference: '+name);
 output.push(source.replaceAll('erasure_inventory_baseline_r22','erasure_inventory_baseline_r23'));
}
const accessStart=r22.slice(r22.indexOf('-- PG16+ non-superuser creators'),r22.indexOf('set local role erasure_purge_owner;'));
if(!accessStart.includes('sc010_purge_migration_access'))throw Error('Missing purge owner protocol');
const engineStart=r22.indexOf('create or replace function private.erasure_purge_engine');
const restoreEnd=r22.slice(r22.indexOf('reset role;',engineStart),r22.indexOf('-- Remove hostile default ACLs',engineStart));
if(!restoreEnd.includes('Purge migration privileges not restored'))throw Error('Missing purge owner restore');
// Transcripts reference their call attempt: purge them right before the attempts.
const anchor=" select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.sc011b_voice_attempts';";
const engine=once(fn(r22,'private.erasure_purge_engine'),anchor,` select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='${transcriptTable}';
 delete from ${transcriptTable} t where private.erasure_purge_allowed('${transcriptTable}',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('${transcriptTable}',deleted_count);
`+anchor);
output.push(accessStart+'\nset local role erasure_purge_owner;\n'+engine+'\n'+restoreEnd);
output.push(`-- Remove hostile default ACLs on every new table and function, then grant only
-- the existing manifest-checked purge role. No API role receives anything; the
-- retention purge stays owner-only until a trusted scheduler is reviewed.
do $acl$
declare o record;g record;
begin
 for o in select oid,relowner from pg_class where oid in ('${transcriptTable}'::regclass,'private.erasure_inventory_baseline_r23'::regclass) loop
  execute format('revoke all on table %s from public',o.oid::regclass);
  for g in select distinct a.grantee,r.rolname from pg_class c cross join lateral aclexplode(c.relacl) a join pg_roles r on r.oid=a.grantee
   where c.oid=o.oid and a.grantee<>o.relowner loop execute format('revoke all on table %s from %I',o.oid::regclass,g.rolname);end loop;
 end loop;
 for o in select oid,proowner from pg_proc where oid=any(array[
  ${newFunctions.map(f=>`'${f}'`).join(',\n  ')}]::regprocedure[]) loop
  execute format('revoke all on function %s from public',o.oid::regprocedure);
  for g in select distinct a.grantee,r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee
   where p.oid=o.oid and a.grantee<>o.proowner loop execute format('revoke all on function %s from %I',o.oid::regprocedure,g.rolname);end loop;
 end loop;
end $acl$;
grant select,delete on ${transcriptTable} to erasure_purge_owner;
do $postflight$
declare known text[];actual text[];
begin
 if private.erasure_schema_signature() is distinct from '${signature}' then
  raise exception 'voice_transcripts_final_schema_mismatch:%',private.erasure_schema_signature() using errcode='55000';end if;
 ${inventoryCheck('erasure_inventory_baseline_r23','voice_transcripts_final_inventory_gap')}
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('public','private') and p.prosrc ~ 'erasure_inventory_baseline_r([4-9]|1[0-9]|2[0-2])([^0-9]|$)') then
  raise exception 'voice_transcripts_stale_inventory_reference' using errcode='55000';end if;
 if (select count(*) from pg_proc p where p.prosrc like '%erasure_inventory_baseline_r23%'
  and p.proname in ('preview_candidate_erasure','prepare_erasure_purge_manifest','authorize_retention_suggestion','get_retention_schedule'))<>4 then
  raise exception 'voice_transcripts_inventory_reference_missing' using errcode='55000';end if;
 if exists(select 1 from (values
  ('private.erasure_inventory_rows(uuid,uuid[])'::regprocedure,'private.erasure_inventory_rows_r22(uuid,uuid[])'::regprocedure),
  ('private.erasure_row_candidates(text,jsonb)'::regprocedure,'private.erasure_row_candidates_r22(text,jsonb)'::regprocedure)) v(wrapper,base)
 join pg_proc w on w.oid=v.wrapper join pg_proc b on b.oid=v.base
 where w.proowner<>b.proowner or not w.prosecdef or w.proacl::text is distinct from b.proacl::text) then
  raise exception 'voice_transcripts_wrapper_acl_mismatch' using errcode='55000';end if;
 -- Deny by default: no API role holds any privilege on the new table or function.
 if exists(select 1 from pg_class c cross join (select rolname from pg_roles where rolname in ('anon','authenticated','service_role')) r
  where c.oid='${transcriptTable}'::regclass
  and (not c.relrowsecurity or not c.relforcerowsecurity or has_table_privilege(r.rolname,c.oid,'select,insert,update,delete,truncate,references,trigger'))) then
  raise exception 'voice_transcripts_table_exposed' using errcode='55000';end if;
 if exists(select 1 from pg_proc p cross join (select rolname from pg_roles where rolname in ('anon','authenticated','service_role')) r
  where p.oid=any(array[${newFunctions.map(f=>`'${f}'`).join(',')}]::regprocedure[])
  and has_function_privilege(r.rolname,p.oid,'execute')) then
  raise exception 'voice_transcripts_function_exposed' using errcode='55000';end if;
 if exists(select 1 from pg_proc where oid=any(array[${definers.map(f=>`'${f}'`).join(',')}]::regprocedure[]) and not prosecdef)
  or exists(select 1 from pg_proc where oid=any(array[${newFunctions.map(f=>`'${f}'`).join(',')}]::regprocedure[])
   and (proconfig is null or proconfig[1] is distinct from 'search_path=""')) then
  raise exception 'voice_transcripts_definer_search_path' using errcode='55000';end if;
 -- The purge-aware transcript guard runs as the caller, never as its owner.
 if (select prosecdef from pg_proc where oid='private.sc011b_transcript_guard()'::regprocedure) then
  raise exception 'voice_transcripts_guard_definer' using errcode='55000';end if;
end $postflight$;
commit;`);
const artifact=output.join('\n\n')+'\n';
for(const [source,name] of verbatim){
 if(!artifact.includes(fn(source,name).split('$$')[1]))throw Error('Reviewed body changed while composing: '+name);
}
// The guard and the retention purge keep the whole isolated body around their listed changes.
for(const [name,cuts] of [['private.sc011b_transcript_guard',[guardFrom.split('$$')[1],retentionDeleteFrom]],
 ['private.sc011b_purge_voice_transcripts',[purgeFilterFrom]]]){
 let pieces=[fn(transcriptSource,name).split('$$')[1]];
 for(const cut of cuts)pieces=pieces.flatMap(piece=>piece.split(cut));
 for(const piece of pieces)if(!artifact.includes(piece))throw Error('Reviewed body changed while composing: '+name);
}
// The table definition and the hardening block are copied byte for byte.
const tableStart=transcriptSource.indexOf(`create table ${transcriptTable} (`);
const tableDef=transcriptSource.slice(tableStart,transcriptSource.indexOf(');\n',tableStart)+2);
if(tableStart<0||!artifact.includes(tableDef))throw Error('Reviewed transcripts table changed while composing');
const hardening=transcriptSource.slice(transcriptSource.indexOf('alter table private.sc011b_voice_transcripts enable'),transcriptSource.lastIndexOf('commit;'));
if(!hardening.includes('revoke all on table')||!artifact.includes(hardening.trim()))throw Error('Reviewed transcripts hardening changed while composing');
const path='supabase/migrations/20261120120000_r6_voice_transcripts_r23.sql';
if(process.argv.includes('--check')){if(readFileSync(path,'utf8')!==artifact)throw Error('Regenerate the R6 voice transcripts migration');}
else writeFileSync(path,artifact);
