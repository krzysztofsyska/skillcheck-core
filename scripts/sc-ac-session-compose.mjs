// Compose SC-AC-SESSION (#276) onto the reviewed R13 engine and R15 readers offline.
// No deployed catalog, inferred signature, activation flag or existing migration is changed.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
const pinned = (path, hash) => {
 const text = readFileSync(path,'utf8');
 if(sha(text)!==hash)throw Error('Review updated source before composing AC session: '+path);
 return text;
};
// R13 still owns the inventory adapters, the purge engine and the pair engine; R15 owns the four readers.
const r13 = pinned('supabase/migrations/20261106120000_sc_ac_inventory_r13.sql','f6b5da2d2c6b2901932bd709402fe3f7328b8f211c6a3db57345b9ae88f96d90');
const r15 = pinned('supabase/migrations/20261107164252_sc019_catalog_orders.sql','38a70fb37c9e42bf60b3f333770b312a3199a9126360ea3642f55eac0868a08c');
const domain = readFileSync('db/components/sc-ac-session.sql','utf8');
const sourceSignature = '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44';
const signature = '8408d01335341053b516a379bb1ed1a5d14e059f69724e19230bba2fe713bd25';
function fn(source,name){
 const start = source.search(new RegExp(`create (?:or replace )?function ${name.replaceAll('.','\\.')}\\(`));
 const end = source.indexOf('$$;',start);if(start<0||end<0)throw Error('Missing source '+name);
 return source.slice(start,end+3);
}
const body = (source,name) => sha(fn(source,name).split('$$')[1]);
const readers = [['public.preview_candidate_erasure','uuid,text,uuid'],['private.prepare_erasure_purge_manifest','uuid'],
 ['private.authorize_retention_suggestion','uuid'],['public.get_retention_schedule','uuid']];
const adapters = [['private.erasure_inventory_rows','uuid,uuid[]'],['private.erasure_row_candidates','text,jsonb'],
 ['private.erasure_purge_engine','uuid,bigint,boolean']];
// The pair engine this module calls. Source-pinned only: an operational R13 rollback
// legitimately narrows its EXECUTE grants and must not block this migration.
const engine13 = [['private.ac_lock_application','uuid'],['public.ac_assign_pair','uuid,uuid,uuid,uuid'],
 ['public.ac_submit_sheet','uuid,jsonb'],['private.ac_sheet_guard','']];
const expectedConfig = name => ['private.erasure_row_candidates','public.get_retention_schedule'].includes(name)
 ? `array['search_path=""']` : `array['search_path=""','TimeZone=UTC','DateStyle=ISO, YMD']`;
// Candidate-linked tables in purge order: children first, the R13 pair rows after them.
const candidateTables = ['private.ac_session_entries','private.ac_reconciliations','private.ac_session_finalists'];
const newTables = ['private.ac_sessions','private.ac_session_stages',...[...candidateTables].reverse()];
const publicRpcs = ['public.ac_session_create(uuid,text,text[])','public.ac_session_add_stage(uuid,text,text,uuid,text)','public.ac_session_remove_last_stage(uuid)',
 'public.ac_session_add_finalist(uuid,uuid)','public.ac_session_set_status(uuid,text)',
 'public.ac_session_assign_pair(uuid,uuid,uuid,uuid,uuid)','public.ac_record_reconciliation(uuid,jsonb)',
 'public.ac_confirm_reconciliation(uuid,text,text)','public.ac_session_record_entry(uuid,uuid,uuid,text,jsonb)',
 'public.ac_session_find(uuid)','public.ac_session_read(uuid)'];
const privateFunctions = ['private.ac_competency_key(text)','private.ac_session_uncovered(uuid)','private.ac_session_config_guard()',
 'private.ac_session_row_guard()','private.ac_session_lock(uuid,boolean)','private.ac_session_lock_finalist(uuid,uuid)',
 'private.erasure_row_candidates(text,jsonb)','private.erasure_inventory_rows(uuid,uuid[])'];
const pinnedFunction = (source,[name,args],strict) => {
 const owner = name.endsWith('erasure_purge_engine')?'erasure_purge_owner':'postgres';
 const acl = `{${owner}=X/${owner}${name.startsWith('public.')?',authenticated=X/postgres':''}}`;
 return `if not exists(select 1 from pg_proc where oid='${name}(${args})'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='${body(source,name)}'${strict?`
  and pg_get_userbyid(proowner)='${owner}' and prosecdef and proconfig=${expectedConfig(name)} and proacl::text='${acl}'`:''}) then
  raise exception 'acs_source_function_unreviewed:${name}' using errcode='55000';end if;`;
};
const inventoryCheck = (baseline,label) => `select known_tables into known from private.${baseline} where singleton;
 select array_agg(n.nspname||'.'||c.relname order by (n.nspname||'.'||c.relname) collate "C") into actual
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f');
 if actual is distinct from (select array_agg(x order by x collate "C") from unnest(known) x) then
  raise exception '${label}' using errcode='55000';end if;`;
const output = [`-- SC-AC-SESSION (#276): AC session, coverage plan, finalists, reconciliation, second attempt
-- + erasure inventory R16. Generated offline by scripts/sc-ac-session-compose.mjs, pinned to
-- reviewed R13 (pair engine, adapters, purge engine) and R15 (readers).
-- Three candidate-linked tables, two configuration tables. No service, preview flag or production activation.
begin;
do $preflight$
declare known text[];actual text[];
begin
 if to_regclass('private.erasure_inventory_baseline_r15') is null then raise exception 'acs_requires_r15' using errcode='55000';end if;
 if to_regclass('private.erasure_inventory_baseline_r16') is not null or to_regclass('private.ac_sessions') is not null then
  raise exception 'acs_already_installed' using errcode='55000';end if;
 if not exists(select 1 from private.erasure_inventory_baseline_r15 where singleton and schema_signature='${sourceSignature}')
  or private.erasure_schema_signature() is distinct from '${sourceSignature}' then
  raise exception 'acs_source_schema_unreviewed:%',private.erasure_schema_signature() using errcode='55000';end if;
 ${inventoryCheck('erasure_inventory_baseline_r15','acs_source_inventory_gap')}
 ${adapters.map(item=>pinnedFunction(r13,item,true)).join('\n ')}
 ${readers.map(item=>pinnedFunction(r15,item,true)).join('\n ')}
 ${engine13.map(item=>pinnedFunction(r13,item,false)).join('\n ')}
 if to_regprocedure('private.erasure_inventory_rows_r15(uuid,uuid[])') is not null
  or to_regprocedure('private.erasure_row_candidates_r15(text,jsonb)') is not null then
  raise exception 'acs_adapter_name_taken' using errcode='55000';end if;
end $preflight$;`,domain,`
alter function private.erasure_inventory_rows(uuid,uuid[]) rename to erasure_inventory_rows_r15;
alter function private.erasure_row_candidates(text,jsonb) rename to erasure_row_candidates_r15;
create function private.erasure_row_candidates(adapter text,data jsonb) returns uuid[]
language plpgsql security definer set search_path='' as $$
declare subject uuid;
begin
 if adapter in (${candidateTables.map(t=>`'${t}'`).join(',')}) then
  select a.candidate_id into subject from public.applications a where a.id=(data->>'application_id')::uuid
   and a.company_id=(data->>'company_id')::uuid and a.recruitment_id=(data->>'recruitment_id')::uuid;
  if subject is null then raise exception using errcode='PT409',message='Unknown AC session candidate dependency';end if;
  return array[subject];
 end if;
 return private.erasure_row_candidates_r15(adapter,data);
end;$$;
create function private.erasure_inventory_rows(tenant uuid,subjects uuid[])
returns table(adapter text,row_key text,row_data jsonb) language sql stable security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
 select * from private.erasure_inventory_rows_r15(tenant,subjects)${candidateTables.map(t=>`
 union all
 select '${t}',t.id::text,to_jsonb(t) from ${t} t
 join public.applications a on a.id=t.application_id and a.company_id=t.company_id and a.recruitment_id=t.recruitment_id
 where t.company_id=tenant and a.candidate_id=any(subjects)`).join('')}
$$;
create table private.erasure_inventory_baseline_r16 (
 singleton boolean primary key default true check(singleton),schema_signature text not null,known_tables text[] not null
);
alter table private.erasure_inventory_baseline_r16 enable row level security;
create trigger immutable_history before update or delete on private.erasure_inventory_baseline_r16
 for each row execute function private.contact_immutable();
insert into private.erasure_inventory_baseline_r16 select true,'${signature}',
 known_tables||array[${newTables.map(t=>`'${t}'`).join(',')},'private.erasure_inventory_baseline_r16']
 from private.erasure_inventory_baseline_r15 where singleton;
`];
for(const [name] of readers){
 const source=fn(r15,name);
 if(!source.includes('erasure_inventory_baseline_r15'))throw Error('Reader has no baseline reference: '+name);
 output.push(source.replaceAll('erasure_inventory_baseline_r15','erasure_inventory_baseline_r16'));
}
// Reuse the exact hosted creator protocol reviewed in R13, restoring memberships/ACLs.
const accessStart=r13.slice(r13.indexOf('-- PG16+ non-superuser creators'),r13.indexOf('set local role erasure_purge_owner;'));
if(!accessStart.includes('sc010_purge_migration_access'))throw Error('Missing purge owner protocol');
const engineStart=r13.indexOf('create or replace function private.erasure_purge_engine');
const restoreEnd=r13.slice(r13.indexOf('reset role;',engineStart),r13.indexOf('-- Remove hostile default ACLs',engineStart));
if(!restoreEnd.includes('Purge migration privileges not restored'))throw Error('Missing purge owner restore');
const anchor=" update private.erasure_purge_context set mode='delete' where txid=txid_current();";
let engine=fn(r13,'private.erasure_purge_engine');
if(engine.split(anchor).length!==2)throw Error('Missing validated purge boundary');
// New rows reference the R13 pair rows and the finalist row, so they are deleted first.
engine=engine.replace(anchor,anchor+candidateTables.map(t=>`
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='${t}';
 delete from ${t} t where private.erasure_purge_allowed('${t}',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('${t}',deleted_count);`).join(''));
output.push(accessStart+'\nset local role erasure_purge_owner;\n'+engine+'\n'+restoreEnd);
output.push(`-- Remove hostile default ACLs on every new table and function, then grant
-- only the public session RPCs and the existing manifest-checked purge role.
do $acl$
declare o record;g record;
begin
 for o in select oid,relowner from pg_class where oid in (${[...newTables,'private.erasure_inventory_baseline_r16'].map(t=>`'${t}'::regclass`).join(',')}) loop
  execute format('revoke all on table %s from public',o.oid::regclass);
  for g in select distinct a.grantee,r.rolname from pg_class c cross join lateral aclexplode(c.relacl) a join pg_roles r on r.oid=a.grantee
   where c.oid=o.oid and a.grantee<>o.relowner loop execute format('revoke all on table %s from %I',o.oid::regclass,g.rolname);end loop;
 end loop;
 for o in select oid,proowner from pg_proc where oid=any(array[
  ${[...privateFunctions,...publicRpcs].map(f=>`'${f}'`).join(',\n  ')}]::regprocedure[]) loop
  execute format('revoke all on function %s from public',o.oid::regprocedure);
  for g in select distinct a.grantee,r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee
   where p.oid=o.oid and a.grantee<>o.proowner loop execute format('revoke all on function %s from %I',o.oid::regprocedure,g.rolname);end loop;
 end loop;
end $acl$;
grant execute on function ${publicRpcs.join(',\n ')} to authenticated;
grant select,delete on ${candidateTables.join(',')} to erasure_purge_owner;
do $postflight$
declare known text[];actual text[];
begin
 if private.erasure_schema_signature() is distinct from '${signature}' then
  raise exception 'acs_final_schema_mismatch:%',private.erasure_schema_signature() using errcode='55000';end if;
 ${inventoryCheck('erasure_inventory_baseline_r16','acs_final_inventory_gap')}
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('public','private') and p.prosrc ~ 'erasure_inventory_baseline_r([4-9]|1[0-5])([^0-9]|$)') then
  raise exception 'acs_stale_inventory_reference' using errcode='55000';end if;
 if (select count(*) from pg_proc p where p.prosrc like '%erasure_inventory_baseline_r16%'
  and p.proname in ('preview_candidate_erasure','prepare_erasure_purge_manifest','authorize_retention_suggestion','get_retention_schedule'))<>4 then
  raise exception 'acs_inventory_reference_missing' using errcode='55000';end if;
 if exists(select 1 from (values
  ('private.erasure_inventory_rows(uuid,uuid[])'::regprocedure,'private.erasure_inventory_rows_r15(uuid,uuid[])'::regprocedure),
  ('private.erasure_row_candidates(text,jsonb)'::regprocedure,'private.erasure_row_candidates_r15(text,jsonb)'::regprocedure)) v(wrapper,base)
 join pg_proc w on w.oid=v.wrapper join pg_proc b on b.oid=v.base
 where w.proowner<>b.proowner or not w.prosecdef or w.proacl::text is distinct from b.proacl::text) then
  raise exception 'acs_wrapper_acl_mismatch' using errcode='55000';end if;
 -- Deny by default: no API role holds any privilege on a new table.
 if exists(select 1 from pg_class c cross join (values('anon'),('authenticated')) r(name)
  where c.oid in (${newTables.map(t=>`'${t}'::regclass`).join(',')})
  and (not c.relrowsecurity or has_table_privilege(r.name,c.oid,'select,insert,update,delete'))) then
  raise exception 'acs_table_exposed' using errcode='55000';end if;
end $postflight$;
commit;`);
const path='supabase/migrations/20261112120000_sc_ac_session_inventory_r16.sql';
const artifact=output.join('\n\n')+'\n';
if(process.argv.includes('--check')){if(readFileSync(path,'utf8')!==artifact)throw Error('Regenerate AC session migration');}
else writeFileSync(path,artifact);
