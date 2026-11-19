// Compose R6-1c (part 8): the last pieces of the SC-010-R4-VOICE isolated module
// (db/isolated/sc010-r4-voice-retention.sql) as a real migration on top of the
// reviewed R23 voice transcripts (20261120120000_r6_voice_transcripts_r23.sql).
// Offline only: no new table, no API grant, no app use, no scheduler.
//
// Most of the isolated module is already in the chain: R18 (voice plan tables)
// and R19 (interview permission, voice pool, preparations) copied its adapters,
// guards, purge order, refund and quota lock, and every later part extended the
// same adapters. This script proves that (each listed reviewed body is present
// in R18/R19) and composes only the two remaining differences, byte for byte:
//  - private.erasure_check_purge_scope: a voice plan request key whose result
//    cannot be resolved in its company blocks the purge manifest and the
//    retention authorization (fail closed), exactly as the erasure preview
//    already does since R18;
//  - private.retention_observe_candidate: an UPDATE that changes nothing (an
//    idempotent replay) no longer restarts a candidate's retention clock.
// The isolated literal baseline (erasure_inventory_baseline_r4_voice) is not
// created: inventories R18..R23 replaced it. Neither change touches a table,
// column, constraint or trigger, so the erasure schema signature and inventory
// stay R23.
//
// Usage: node scripts/r6-voice-retention-compose.mjs          (write the migration)
//        node scripts/r6-voice-retention-compose.mjs --check  (fail when out of date)
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
const pinned = (path, hash) => {
 const text = readFileSync(path,'utf8');
 if(sha(text)!==hash)throw Error('Review updated source before composing the voice retention migration: '+path);
 return text;
};
const scheduler = pinned('supabase/migrations/20261012031026_retention_scheduler_protocol.sql','4a4f82232eb02fde452cc86f83adadec6b1cd34083b44f9d60740ff5b85ed49f');
const r4 = pinned('supabase/migrations/20261012031039_retention_scheduler_inventory.sql','7106a7755a31b003975e8932bcbae7472a690b9df8f27e9bf27d759a52afb86e');
const r18 = pinned('supabase/migrations/20261119100000_r6_voice_plan_r18.sql','551a7d84556b76801a04d04321a6779aa1d01ead2bb616683171f21b778a6dcf');
const r19 = pinned('supabase/migrations/20261119120000_r6_voice_permission_pool_r19.sql','425afb3e7d988c69072acf99280258d460714eccd38e9a8d1e18810812e8dc34');
pinned('supabase/migrations/20261120120000_r6_voice_transcripts_r23.sql','4ad46edf717651f17b873607bb4bb4c670f9fd89481240f1e9bc45d2ed65d167');
const voiceRetention = pinned('db/isolated/sc010-r4-voice-retention.sql','c5dbf138405ed737332a70400f6017d983cd111f9be49180c1309b2d75ae0d5f');
const signature = '4dab3fae234c8233104d691381b62710570324bee0db8bd5df4be28f3d6702f7';

function fn(source,name){
 const start = source.search(new RegExp(`create (?:or replace )?function ${name.replaceAll('.','\\.')}\\(`));
 const end = source.indexOf('$$;',start);if(start<0||end<0)throw Error('Missing source '+name);
 return source.slice(start,end+3);
}
const bodyOf = (source,name) => fn(source,name).split('$$')[1];
const body = (source,name) => sha(bodyOf(source,name));
// Every line of `next` is `previous` plus exactly the listed inserted lines.
const onlyInserted = (previous,next,inserted,name) => {
 const a = previous.split('\n'), b = next.split('\n');
 const added = b.filter(line => !a.includes(line));
 if(JSON.stringify(added)!==JSON.stringify(inserted)||b.filter(line=>!inserted.includes(line)).join('\n')!==a.join('\n'))
  throw Error('Unexpected difference from the applied body: '+name);
};

// --- Coverage proof: the rest of the isolated module is already migrated ---
for(const [source,name] of [[r18,'private.erasure_voice_request_candidate'],[r18,'private.voice_plan_protect_history'],
 [r18,'private.erasure_voice_row_guard'],[r19,'private.voice_interview_permission_protect_history'],
 [r19,'private.sc010c_preparation_guard'],[r19,'private.sc010c_request_guard'],[r19,'private.erasure_voice_refund_deleted'],
 [r19,'private.erasure_voice_lock_entitlements']]){
 if(!source.includes(bodyOf(voiceRetention,name)))throw Error('Isolated voice retention body not migrated: '+name);
}
for(const [source,table] of [[r18,'public.voice_plan_versions'],[r18,'private.voice_plan_review_entries'],
 [r18,'private.voice_plan_release_entries'],[r18,'private.voice_plan_current_releases'],[r18,'private.voice_plan_request_keys'],
 [r19,'private.voice_interview_permission_receipts'],[r19,'private.voice_interview_permission_revocations'],
 [r19,'private.sc010c_voice_preparations'],[r19,'private.sc010c_voice_preparation_requests']]){
 for(const piece of [`create trigger zz_retention_observed after insert or update or delete on ${table}\n`,
  `create policy erasure_purge_delete on ${table} for delete to erasure_purge_owner`,
  `delete from ${table} t where `,`private.erasure_purge_allowed('${table}',to_jsonb(t))`])
  if(!source.includes(piece))throw Error(`Isolated voice retention wiring not migrated: ${table}: ${piece.trim().slice(0,60)}`);
}

// --- The two remaining differences, verbatim from the isolated module ---
const scopeLine = ` if exists(select 1 from private.voice_plan_request_keys t where t.company_id=e.company_id and private.erasure_voice_request_candidate(t.company_id,t.operation,t.result_id) is null) then raise exception using errcode='PT409',message='Unknown voice request dependency';end if;`;
const observeLine = ` if tg_op='UPDATE' and to_jsonb(new)=to_jsonb(old) then return new;end if;`;
const scope = fn(voiceRetention,'private.erasure_check_purge_scope');
const observe = fn(voiceRetention,'private.retention_observe_candidate');
onlyInserted(bodyOf(r4,'private.erasure_check_purge_scope'),bodyOf(voiceRetention,'private.erasure_check_purge_scope'),[scopeLine],'erasure_check_purge_scope');
onlyInserted(bodyOf(scheduler,'private.retention_observe_candidate'),bodyOf(voiceRetention,'private.retention_observe_candidate'),[observeLine],'retention_observe_candidate');
if(!scope.startsWith('create or replace function private.erasure_check_purge_scope(target_request uuid) returns void\nlanguage plpgsql volatile security definer set search_path=\'\' as $$')
 ||!observe.startsWith("create or replace function private.retention_observe_candidate() returns trigger language plpgsql security definer set search_path='' as $$"))
 throw Error('Isolated function header changed');
if(fn(r4,'private.erasure_check_purge_scope').split('$$')[0].replace('create function','create or replace function')!==scope.split('$$')[0]
 ||fn(scheduler,'private.retention_observe_candidate').split('$$')[0].replace('create function','create or replace function')!==observe.split('$$')[0])
 throw Error('Applied function header differs from the isolated one');
{
 const code = (scope+observe).replace(/--[^\n]*/g,'');
 if(/\bdrop\b|\bgrant\b|\btruncate\b|package|PRESELEKCJA|price|pricing|order_id|http|net\./i.test(code))throw Error('Unexpected drop, grant, package, price or transport');
}

const targets = [['private.erasure_check_purge_scope','uuid',r4,voiceRetention],
 ['private.retention_observe_candidate','',scheduler,voiceRetention]];
const strict = (name,args,hash,label) => `if not exists(select 1 from pg_proc where oid='${name}(${args})'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='${hash}'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and provolatile='v' and proconfig=array['search_path=""']
  and proacl::text='{postgres=X/postgres}') then
  raise exception '${label}:${name}' using errcode='55000';end if;`;
const output = `-- R6-1c (part 8): the last pieces of SC-010-R4-VOICE (voice erasure and
-- retention) as a real migration. Generated offline by
-- scripts/r6-voice-retention-compose.mjs from the reviewed isolated source
-- db/isolated/sc010-r4-voice-retention.sql on top of R23.
-- R18 and R19 already installed the module's voice adapters, guards, purge
-- order, refund and quota lock. This step adds the two remaining differences,
-- byte for byte from the isolated source:
--  - the purge manifest and the retention authorization refuse a tenant with a
--    voice plan request key whose result cannot be resolved in that company
--    (PT409 'Unknown voice request dependency'), as the erasure preview already
--    does;
--  - an UPDATE that changes nothing no longer restarts a candidate's retention
--    clock (an idempotent replay keeps data no longer than before).
-- No table, column, constraint, trigger, row or grant changes: the erasure
-- schema signature and inventory stay R23. Nothing is deleted by this migration,
-- nothing is used by the application, nothing is granted to anon,
-- authenticated or service_role, and no package, price or order state is touched.
begin;
do $preflight$
declare known text[];actual text[];
begin
 if to_regclass('private.erasure_inventory_baseline_r23') is null or to_regclass('private.sc011b_voice_transcripts') is null
  or to_regclass('private.voice_plan_request_keys') is null then
  raise exception 'voice_retention_requires_r23' using errcode='55000';end if;
 -- A second run finds the reviewed bodies already installed and stops.
 if exists(select 1 from pg_proc where oid in ('private.erasure_check_purge_scope(uuid)'::regprocedure,'private.retention_observe_candidate()'::regprocedure)
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex') in ('${body(voiceRetention,'private.erasure_check_purge_scope')}','${body(voiceRetention,'private.retention_observe_candidate')}')) then
  raise exception 'voice_retention_already_installed' using errcode='55000';end if;
 if not exists(select 1 from private.erasure_inventory_baseline_r23 where singleton and schema_signature='${signature}')
  or private.erasure_schema_signature() is distinct from '${signature}' then
  raise exception 'voice_retention_source_schema_unreviewed:%',private.erasure_schema_signature() using errcode='55000';end if;
 select known_tables into known from private.erasure_inventory_baseline_r23 where singleton;
 select array_agg(n.nspname||'.'||c.relname order by (n.nspname||'.'||c.relname) collate "C") into actual
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f');
 if actual is distinct from (select array_agg(x order by x collate "C") from unnest(known) x) then
  raise exception 'voice_retention_source_inventory_gap' using errcode='55000';end if;
 ${targets.map(([name,args,source])=>strict(name,args,body(source,name),'voice_retention_source_function_unreviewed')).join('\n ')}
 if not exists(select 1 from pg_proc where oid='private.erasure_voice_request_candidate(uuid,text,uuid)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='${body(r18,'private.erasure_voice_request_candidate')}'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""']
  and not has_function_privilege('public','private.erasure_voice_request_candidate(uuid,text,uuid)'::regprocedure,'execute')) then
  raise exception 'voice_retention_source_function_unreviewed:private.erasure_voice_request_candidate' using errcode='55000';end if;
 -- Remember how many triggers observe retention; the postflight requires the same.
 perform set_config('r6_voice_retention.observers',(select count(*)::text from pg_trigger
  where tgfoid='private.retention_observe_candidate()'::regprocedure and not tgisinternal),true);
end $preflight$;

-- SC-010-R4-VOICE purge scope (source: db/isolated/sc010-r4-voice-retention.sql).
${scope}

-- SC-010-R4-VOICE retention observer (source: db/isolated/sc010-r4-voice-retention.sql).
${observe}

-- create or replace keeps the owner and the owner-only ACL; re-assert that no
-- other role can execute either function.
do $acl$
declare o record;g record;
begin
 for o in select oid,proowner from pg_proc where oid=any(array[
  'private.erasure_check_purge_scope(uuid)','private.retention_observe_candidate()']::regprocedure[]) loop
  execute format('revoke all on function %s from public',o.oid::regprocedure);
  for g in select distinct a.grantee,r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee
   where p.oid=o.oid and a.grantee<>o.proowner loop execute format('revoke all on function %s from %I',o.oid::regprocedure,g.rolname);end loop;
 end loop;
end $acl$;
do $postflight$
declare known text[];actual text[];
begin
 if private.erasure_schema_signature() is distinct from '${signature}' then
  raise exception 'voice_retention_final_schema_mismatch:%',private.erasure_schema_signature() using errcode='55000';end if;
 select known_tables into known from private.erasure_inventory_baseline_r23 where singleton;
 select array_agg(n.nspname||'.'||c.relname order by (n.nspname||'.'||c.relname) collate "C") into actual
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f');
 if actual is distinct from (select array_agg(x order by x collate "C") from unnest(known) x) then
  raise exception 'voice_retention_final_inventory_gap' using errcode='55000';end if;
 ${targets.map(([name,args,,source])=>strict(name,args,body(source,name),'voice_retention_final_function_mismatch')).join('\n ')}
 if (select count(*)::text from pg_trigger where tgfoid='private.retention_observe_candidate()'::regprocedure and not tgisinternal)
  is distinct from current_setting('r6_voice_retention.observers',true) then
  raise exception 'voice_retention_observers_changed' using errcode='55000';end if;
 -- Deny by default: no API role can execute either function.
 if exists(select 1 from pg_proc p cross join (select rolname from pg_roles where rolname in ('anon','authenticated','service_role')) r
  where p.oid=any(array['private.erasure_check_purge_scope(uuid)','private.retention_observe_candidate()']::regprocedure[])
  and has_function_privilege(r.rolname,p.oid,'execute')) then
  raise exception 'voice_retention_function_exposed' using errcode='55000';end if;
end $postflight$;
commit;
`;
// The two installed bodies are the reviewed isolated bodies, byte for byte.
for(const name of ['private.erasure_check_purge_scope','private.retention_observe_candidate'])
 if(!output.includes(fn(voiceRetention,name)))throw Error('Reviewed body changed while composing: '+name);
const path='supabase/migrations/20261120150000_r6_voice_retention.sql';
if(process.argv.includes('--check')){if(readFileSync(path,'utf8')!==output)throw Error('Regenerate the R6 voice retention migration');}
else writeFileSync(path,output);
