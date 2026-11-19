// Compose R6-1c (part 6): the SC-011-B6 operator resolution of `unknown` voice
// dispatches as a real migration on top of the reviewed R21 voice settlement
// (20261119210000_r6_voice_settlement_r21.sql) and the R20 dispatch ledger
// (20261119180000_r6_voice_dispatch_r20.sql).
// Offline only: no provider transport, no webhook route, no API grant, no app use.
//
// Source is the reviewed isolated file db/isolated/sc011b6-voice-dispatch-resolution.sql,
// pinned by hash. Its table and its two operator functions are copied byte for
// byte, except:
//  - the resolution guard runs as the caller (security invoker) and lets the
//    manifest-checked erasure purge delete a row, like every other voice guard;
//    it also refuses a row whose claim was not resolved by the operator function
//    (the claim must already be abandoned, or accepted with the recorded call);
//  - a candidate's do-not-call request found on an already finished call is
//    recorded on that call attempt (outcome 'dnc_requested', status kept) instead
//    of only blocking the contact preference, so the R21 guard
//    private.sc011b_keep_candidate_block keeps the block for good. The R21
//    settlement trigger applies the block and does not settle the pool again.
// Pool accounting needs no new code: an unknown claim keeps its reserved unit
// (its preparation stays prepared_offline and unsettled); `not_placed` cancels
// the preparation and releases the unit through the R20 dispatch_rejected
// trigger; `placed` finishes the attempt once and the R21 settlement trigger
// uses or releases the unit and writes the settlement ledger. The R19/R21
// erasure refund therefore returns a unit only while an unresolved claim still
// holds it, never twice.
// Erasure inventory R22 adds the resolutions table, purged before the dispatch
// claims it references.
// Not included (separate later parts): SC-011-B3 transcripts, SC-010 R4
// retention, any operator screen or API route.
//
// Usage: node scripts/r6-voice-resolution-compose.mjs          (write the migration)
//        node scripts/r6-voice-resolution-compose.mjs --check  (fail when out of date)
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
const pinned = (path, hash) => {
 const text = readFileSync(path,'utf8');
 if(sha(text)!==hash)throw Error('Review updated source before composing the voice resolution migration: '+path);
 return text;
};
const r20 = pinned('supabase/migrations/20261119180000_r6_voice_dispatch_r20.sql','172abd9dd3e814ddfa831908753afa2cba626054ce7fd5008331f9a11c528236');
const r21 = pinned('supabase/migrations/20261119210000_r6_voice_settlement_r21.sql','6ef119ae5badb7404e713b8a117af8db6db7b2f25744ecd3bbfbc149718610c5');
const resolutionSource = pinned('db/isolated/sc011b6-voice-dispatch-resolution.sql','0cc3dc92a8e147cdd9019b482f88d249aadf9997fc48a549c68922dd6100379d');
const sourceSignature = '680f3eaa808e7280b545ad9aaabaa0d4144aafdf8c26f40d174d7670d4da7189';
const signature = '3e6a9df7b8146c65fac9b7b04cbb60f68b1b47b98039461d077a252426e1adee';

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
if(!fn(r21,'private.sc011b_settlement_guard').includes(purgeLine))throw Error('R21 purge-aware guard form changed');

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
  raise exception 'voice_resolution_source_function_unreviewed:${name}' using errcode='55000';end if;`;
};
const inventoryCheck = (baseline,label) => `select known_tables into known from private.${baseline} where singleton;
 select array_agg(n.nspname||'.'||c.relname order by (n.nspname||'.'||c.relname) collate "C") into actual
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f');
 if actual is distinct from (select array_agg(x order by x collate "C") from unnest(known) x) then
  raise exception '${label}' using errcode='55000';end if;`;

const resolutionTable = 'private.sc011b_dispatch_resolutions';
const operatorFunctions = ['private.sc011b_list_unknown_dispatches(integer)',
 'private.sc011b_resolve_unknown_dispatch(uuid,uuid,text,text,text,text)'];
const definers = [...operatorFunctions,'private.erasure_row_candidates(text,jsonb)','private.erasure_inventory_rows(uuid,uuid[])'];
const newFunctions = ['private.sc011b_resolution_guard()',...definers];
const verbatim = [[resolutionSource,'private.sc011b_list_unknown_dispatches']];

// --- SC-011-B6 operator resolution (table and list function verbatim) ---
let resolution = unwrapped(resolutionSource);
resolution = once(resolution,`create function private.sc011b_resolution_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op<>'INSERT' then
  raise exception using errcode='42501',message='VOICE_DISPATCH_RESOLUTION_IMMUTABLE';
 end if;
`,`create function private.sc011b_resolution_guard() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
${purgeLine} if tg_op<>'INSERT' then
  raise exception using errcode='42501',message='VOICE_DISPATCH_RESOLUTION_IMMUTABLE';
 end if;
 -- Only the operator resolution writes a row: its claim has already left
 -- 'unknown' for the resolved state, and a placed call has its attempt.
 if not exists(select 1 from private.sc011b_voice_dispatches d
   where d.company_id=new.company_id and d.preparation_id=new.preparation_id
    and d.state=case new.resolution when 'not_placed' then 'abandoned' else 'accepted' end)
  or (new.resolution='placed' and not exists(select 1 from private.sc011b_voice_attempts a
   where a.company_id=new.company_id and a.preparation_id=new.preparation_id
    and a.provider_call_id=new.provider_call_id)) then
  raise exception using errcode='42501',message='VOICE_DISPATCH_RESOLUTION_UNBOUND';
 end if;
`);
const lateDncFrom = `  elsif target_outcome='dnc_requested' and not existing.dnc_requested then
   -- The pool was already settled, but a candidate's request not to be
   -- called again must never be dropped.
   perform private.sc011b_block_candidate_contact(target_company,existing.candidate_id);
  end if;
`;
const lateDncTo = `  elsif target_outcome='dnc_requested' and not existing.dnc_requested then
   -- The pool was already settled, but a candidate's request not to be
   -- called again must never be dropped. Recorded on the finished attempt
   -- (status kept): the R21 settlement trigger blocks every channel without
   -- settling again, and the R21 keep-block guard keeps the block for good.
   update private.sc011b_voice_attempts set outcome='dnc_requested', dnc_requested=true
    where company_id=target_company and id=attempt;
  end if;
`;
resolution = once(resolution,lateDncFrom,lateDncTo);
{
 const code = resolution.replace(/--[^\n]*/g,'');
 if(/\bdrop\b/i.test(code))throw Error('Unexpected drop in voice resolution domain');
 if(/package|PRESELEKCJA|price|pricing|order_id|\bgrant\b|http|net\./i.test(code))throw Error('Package, price, grant or transport in voice resolution domain');
}

// --- SC-010 R22 adapter for the resolutions table ---
const purgeKey = once(fn(r21,'private.erasure_purge_key'),
 ` when adapter in ('private.sc011b_voice_dispatches','private.sc011b_voice_settlements') then data->>'company_id'||':'||(data->>'preparation_id')
`,` when adapter in ('private.sc011b_voice_dispatches','private.sc011b_voice_settlements','${resolutionTable}') then data->>'company_id'||':'||(data->>'preparation_id')
`);
const wiring = `
-- Row key of the resolutions table (no id column); every other adapter keeps its
-- key (this function was last defined by 20261119210000, R21).
${purgeKey}

alter function private.erasure_inventory_rows(uuid,uuid[]) rename to erasure_inventory_rows_r21;
alter function private.erasure_row_candidates(text,jsonb) rename to erasure_row_candidates_r21;
create function private.erasure_row_candidates(adapter text,data jsonb) returns uuid[]
language plpgsql stable security definer set search_path='' as $$
begin
 -- A resolution belongs to every subject of its preparation, like its dispatch
 -- claim; the operator in resolved_by is not a subject.
 if adapter='${resolutionTable}' then
  return private.erasure_row_candidates_r21('private.sc011b_voice_dispatches',data);
 end if;
 return private.erasure_row_candidates_r21(adapter,data);
end;$$;
create function private.erasure_inventory_rows(tenant uuid,subjects uuid[])
returns table(adapter text,row_key text,row_data jsonb) language sql stable security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
 select * from private.erasure_inventory_rows_r21(tenant,subjects)
 union all select '${resolutionTable}',private.erasure_purge_key('${resolutionTable}',to_jsonb(t)),to_jsonb(t) from ${resolutionTable} t where t.company_id=tenant and (private.erasure_row_candidates('${resolutionTable}',to_jsonb(t)) && subjects)
$$;
create table private.erasure_inventory_baseline_r22 (
 singleton boolean primary key default true check(singleton),schema_signature text not null,known_tables text[] not null
);
alter table private.erasure_inventory_baseline_r22 enable row level security;
create trigger immutable_history before update or delete on private.erasure_inventory_baseline_r22
 for each row execute function private.contact_immutable();
insert into private.erasure_inventory_baseline_r22 select true,'${signature}',
 known_tables||array['${resolutionTable}','private.erasure_inventory_baseline_r22']
 from private.erasure_inventory_baseline_r21 where singleton;

-- Normal resolution writes take the candidate lock and refuse frozen candidates (R18 voice guard).
create trigger erasure_voice_guard before insert or update or delete on ${resolutionTable}
 for each row execute function private.erasure_voice_row_guard();
create trigger zz_retention_observed after insert or update or delete on ${resolutionTable}
 for each row execute function private.retention_observe_candidate();
create policy erasure_purge_select on ${resolutionTable} for select to erasure_purge_owner using (private.erasure_purge_visible('${resolutionTable}',to_jsonb(sc011b_dispatch_resolutions)));
create policy erasure_purge_delete on ${resolutionTable} for delete to erasure_purge_owner using (private.erasure_purge_allowed('${resolutionTable}',to_jsonb(sc011b_dispatch_resolutions)));
`;

const pinnedR20 = ['private.sc011b_dispatch_guard','private.sc011b_dispatch_rejected','private.sc011b_attempt_guard',
 'private.sc011b_block_cancel_after_dispatch','private.sc011b_block_cancel_while_dispatching'];
const pinnedR21 = [['private.sc011b_attempt_settlement',''],['private.sc011b_block_candidate_contact','uuid,uuid'],
 ['private.sc011b_keep_candidate_block',''],['private.sc011b_settlement_guard',''],
 ['private.erasure_voice_refund_deleted',''],['private.erasure_voice_lock_entitlements','uuid'],['private.erasure_purge_key','text,jsonb']];
const output = [`-- R6-1c (part 6): operator resolution of unknown voice dispatches (SC-011-B6)
-- as a real migration. Generated offline by scripts/r6-voice-resolution-compose.mjs
-- from the reviewed isolated source and the R21 erasure inventory.
-- A dispatch claim becomes 'unknown' when the provider's deduplication window
-- passed without a known result; the worker never redials. A platform operator
-- checks the provider dashboard and records what happened, once:
--  - not_placed: the call never left; the preparation is cancelled and its
--    reserved interview returns to the pool (R20 dispatch_rejected);
--  - placed: the call is recorded with its final outcome and settled once
--    against the pool by the R21 settlement (ledger), with the do-not-call block.
-- Until then the claim keeps its reserved unit, and erasure refunds it only while
-- it is still held (inventory R22 purges resolutions before their dispatch claim).
--
-- Nothing is used by the application yet and nothing is customer-visible: the
-- operator functions are owner-only (no table or function is granted to anon,
-- authenticated or service_role), nothing is seeded, no provider is called, no
-- webhook route exists and no package, price or order state is touched.
-- Transcripts (SC-011-B3) are not part of this step.
begin;
do $preflight$
declare known text[];actual text[];
begin
 if to_regclass('private.erasure_inventory_baseline_r21') is null or to_regclass('private.sc011b_voice_settlements') is null
  or to_regclass('private.sc011b_voice_dispatches') is null then
  raise exception 'voice_resolution_requires_r21' using errcode='55000';end if;
 if to_regclass('private.erasure_inventory_baseline_r22') is not null or to_regclass('${resolutionTable}') is not null
  or to_regprocedure('private.sc011b_resolve_unknown_dispatch(uuid,uuid,text,text,text,text)') is not null
  or to_regprocedure('private.sc011b_list_unknown_dispatches(integer)') is not null
  or to_regprocedure('private.sc011b_resolution_guard()') is not null then
  raise exception 'voice_resolution_already_installed' using errcode='55000';end if;
 if not exists(select 1 from private.erasure_inventory_baseline_r21 where singleton and schema_signature='${sourceSignature}')
  or private.erasure_schema_signature() is distinct from '${sourceSignature}' then
  raise exception 'voice_resolution_source_schema_unreviewed:%',private.erasure_schema_signature() using errcode='55000';end if;
 ${inventoryCheck('erasure_inventory_baseline_r21','voice_resolution_source_inventory_gap')}
 ${adapters.map(item=>pinnedFunction(r21,item,true)).join('\n ')}
 ${readers.map(item=>pinnedFunction(r21,item,true)).join('\n ')}
 ${pinnedR21.map(item=>pinnedFunction(r21,item,false)).join('\n ')}
 ${pinnedR20.map(name=>pinnedFunction(r20,[name,''],false)).join('\n ')}
 if to_regprocedure('private.erasure_inventory_rows_r21(uuid,uuid[])') is not null
  or to_regprocedure('private.erasure_row_candidates_r21(text,jsonb)') is not null then
  raise exception 'voice_resolution_adapter_name_taken' using errcode='55000';end if;
 if to_regprocedure('private.retention_observe_candidate()') is null or to_regprocedure('private.contact_immutable()') is null
  or to_regprocedure('private.erasure_purge_allowed(text,jsonb,text)') is null
  or to_regprocedure('private.erasure_purge_visible(text,jsonb)') is null or to_regrole('erasure_purge_owner') is null
  or to_regprocedure('private.is_platform_operator(uuid)') is null or to_regprocedure('auth.uid()') is null then
  raise exception 'voice_resolution_dependency_missing' using errcode='55000';end if;
end $preflight$;`,
`-- SC-011-B6 operator resolution (source: db/isolated/sc011b6-voice-dispatch-resolution.sql).`,resolution,
wiring.trim()];
for(const [name] of readers){
 const source=fn(r21,name);
 if(!source.includes('erasure_inventory_baseline_r21'))throw Error('Reader has no baseline reference: '+name);
 output.push(source.replaceAll('erasure_inventory_baseline_r21','erasure_inventory_baseline_r22'));
}
const accessStart=r21.slice(r21.indexOf('-- PG16+ non-superuser creators'),r21.indexOf('set local role erasure_purge_owner;'));
if(!accessStart.includes('sc010_purge_migration_access'))throw Error('Missing purge owner protocol');
const engineStart=r21.indexOf('create or replace function private.erasure_purge_engine');
const restoreEnd=r21.slice(r21.indexOf('reset role;',engineStart),r21.indexOf('-- Remove hostile default ACLs',engineStart));
if(!restoreEnd.includes('Purge migration privileges not restored'))throw Error('Missing purge owner restore');
// Resolutions reference their dispatch claim: purge them right before the claims.
const anchor=" select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.sc011b_voice_dispatches';";
const engine=once(fn(r21,'private.erasure_purge_engine'),anchor,` select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='${resolutionTable}';
 delete from ${resolutionTable} t where private.erasure_purge_allowed('${resolutionTable}',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('${resolutionTable}',deleted_count);
`+anchor);
output.push(accessStart+'\nset local role erasure_purge_owner;\n'+engine+'\n'+restoreEnd);
output.push(`-- Remove hostile default ACLs on every new table and function, then grant only
-- the existing manifest-checked purge role. No API role receives anything; the
-- operator functions stay owner-only (a trusted server connection sets the
-- operator's identity).
do $acl$
declare o record;g record;
begin
 for o in select oid,relowner from pg_class where oid in ('${resolutionTable}'::regclass,'private.erasure_inventory_baseline_r22'::regclass) loop
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
grant select,delete on ${resolutionTable} to erasure_purge_owner;
do $postflight$
declare known text[];actual text[];
begin
 if private.erasure_schema_signature() is distinct from '${signature}' then
  raise exception 'voice_resolution_final_schema_mismatch:%',private.erasure_schema_signature() using errcode='55000';end if;
 ${inventoryCheck('erasure_inventory_baseline_r22','voice_resolution_final_inventory_gap')}
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('public','private') and p.prosrc ~ 'erasure_inventory_baseline_r([4-9]|1[0-9]|2[01])([^0-9]|$)') then
  raise exception 'voice_resolution_stale_inventory_reference' using errcode='55000';end if;
 if (select count(*) from pg_proc p where p.prosrc like '%erasure_inventory_baseline_r22%'
  and p.proname in ('preview_candidate_erasure','prepare_erasure_purge_manifest','authorize_retention_suggestion','get_retention_schedule'))<>4 then
  raise exception 'voice_resolution_inventory_reference_missing' using errcode='55000';end if;
 if exists(select 1 from (values
  ('private.erasure_inventory_rows(uuid,uuid[])'::regprocedure,'private.erasure_inventory_rows_r21(uuid,uuid[])'::regprocedure),
  ('private.erasure_row_candidates(text,jsonb)'::regprocedure,'private.erasure_row_candidates_r21(text,jsonb)'::regprocedure)) v(wrapper,base)
 join pg_proc w on w.oid=v.wrapper join pg_proc b on b.oid=v.base
 where w.proowner<>b.proowner or not w.prosecdef or w.proacl::text is distinct from b.proacl::text) then
  raise exception 'voice_resolution_wrapper_acl_mismatch' using errcode='55000';end if;
 -- Deny by default: no API role holds any privilege on the new table or function.
 if exists(select 1 from pg_class c cross join (select rolname from pg_roles where rolname in ('anon','authenticated','service_role')) r
  where c.oid='${resolutionTable}'::regclass
  and (not c.relrowsecurity or not c.relforcerowsecurity or has_table_privilege(r.rolname,c.oid,'select,insert,update,delete,truncate,references,trigger'))) then
  raise exception 'voice_resolution_table_exposed' using errcode='55000';end if;
 if exists(select 1 from pg_proc p cross join (select rolname from pg_roles where rolname in ('anon','authenticated','service_role')) r
  where p.oid=any(array[${newFunctions.map(f=>`'${f}'`).join(',')}]::regprocedure[])
  and has_function_privilege(r.rolname,p.oid,'execute')) then
  raise exception 'voice_resolution_function_exposed' using errcode='55000';end if;
 if exists(select 1 from pg_proc where oid=any(array[${definers.map(f=>`'${f}'`).join(',')}]::regprocedure[]) and not prosecdef)
  or exists(select 1 from pg_proc where oid=any(array[${newFunctions.map(f=>`'${f}'`).join(',')}]::regprocedure[])
   and (proconfig is null or proconfig[1] is distinct from 'search_path=""')) then
  raise exception 'voice_resolution_definer_search_path' using errcode='55000';end if;
 -- The purge-aware resolution guard runs as the caller, never as its owner.
 if (select prosecdef from pg_proc where oid='private.sc011b_resolution_guard()'::regprocedure) then
  raise exception 'voice_resolution_guard_definer' using errcode='55000';end if;
end $postflight$;
commit;`);
const artifact=output.join('\n\n')+'\n';
for(const [source,name] of verbatim){
 if(!artifact.includes(fn(source,name).split('$$')[1]))throw Error('Reviewed body changed while composing: '+name);
}
// The resolve function keeps the whole isolated body around the one late-DNC change.
for(const piece of fn(resolutionSource,'private.sc011b_resolve_unknown_dispatch').split('$$')[1].split(lateDncFrom)){
 if(!artifact.includes(piece))throw Error('Reviewed resolve body changed while composing');
}
// The table definition is copied byte for byte.
const tableStart=resolutionSource.indexOf(`create table ${resolutionTable} (`);
const tableDef=resolutionSource.slice(tableStart,resolutionSource.indexOf(');',tableStart)+2);
if(tableStart<0||!artifact.includes(tableDef))throw Error('Reviewed resolution table changed while composing');
const path='supabase/migrations/20261120090000_r6_voice_resolution_r22.sql';
if(process.argv.includes('--check')){if(readFileSync(path,'utf8')!==artifact)throw Error('Regenerate the R6 voice resolution migration');}
else writeFileSync(path,artifact);
