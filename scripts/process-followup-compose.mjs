// Compose SC-PROCESS part B (#277) onto the reviewed R16 inventory and engine offline.
// No deployed catalog, inferred signature, activation flag or existing migration is changed.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
const pinned = (path, hash) => {
 const text = readFileSync(path,'utf8');
 if(sha(text)!==hash)throw Error('Review updated source before composing process follow-up: '+path);
 return text;
};
const r16 = pinned('supabase/migrations/20261112120000_sc_ac_session_inventory_r16.sql','67c904dbe8d5b42dc7cda842914ca12505d387a556d403005efb1293c71200b5');
const domain = readFileSync('db/components/process-followup.sql','utf8');
const sourceSignature = 'e958cb168fc311a1e908b374cfc1bfee6524945b56f00e9639899ad72f75aea8';
const signature = '8ad238e75d4d4ccb82e03b89f368ba06483580781494fe1f7f9306a3c9c7f73f';
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
const expectedConfig = name => ['private.erasure_row_candidates','public.get_retention_schedule'].includes(name)
 ? `array['search_path=""']` : `array['search_path=""','TimeZone=UTC','DateStyle=ISO, YMD']`;
// Candidate-linked tables in purge order: observations and grants before cases.
const candidateTables = ['private.process_followup_observations','private.process_followup_grants','private.process_followup_cases'];
const newTables = candidateTables;
const publicRpcs = ['public.process_followup_create(uuid,text,date,text,text)','public.process_followup_grant(uuid,uuid,boolean)','public.process_followup_record(uuid,integer,jsonb)','public.process_followup_read(uuid)','public.process_followup_recruitment_metrics(uuid,uuid,integer)'];
const privateFunctions = ['private.process_followup_application(uuid)','private.process_followup_access(uuid,boolean)','private.process_followup_row_guard()', 'private.erasure_row_candidates(text,jsonb)','private.erasure_inventory_rows(uuid,uuid[])'];
const pinnedFunction = (source,[name,args],strict) => {
 const owner = name.endsWith('erasure_purge_engine')?'erasure_purge_owner':'postgres';
 const acl = `{${owner}=X/${owner}${name.startsWith('public.')?',authenticated=X/postgres':''}}`;
 return `if not exists(select 1 from pg_proc where oid='${name}(${args})'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='${body(source,name)}'${strict?`
  and pg_get_userbyid(proowner)='${owner}' and prosecdef and proconfig=${expectedConfig(name)} and proacl::text='${acl}'`:''}) then
  raise exception 'followup_source_function_unreviewed:${name}' using errcode='55000';end if;`;
};
const inventoryCheck = (baseline,label) => `select known_tables into known from private.${baseline} where singleton;
 select array_agg(n.nspname||'.'||c.relname order by (n.nspname||'.'||c.relname) collate "C") into actual
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f');
 if actual is distinct from (select array_agg(x order by x collate "C") from unnest(known) x) then
  raise exception '${label}' using errcode='55000';end if;`;
const output = [`-- SC-PROCESS part B (#277): explicit-purpose cases, grants and 30/90/180 observations.
-- Erasure inventory R17, generated offline by scripts/process-followup-compose.mjs
-- from the reviewed R16 adapters, readers and purge engine. All three tables are
-- candidate-linked. No production activation and no automatic personnel decision.
begin;
do $preflight$
declare known text[];actual text[];
begin
 if to_regclass('private.erasure_inventory_baseline_r16') is null then raise exception 'followup_requires_r16' using errcode='55000';end if;
 if to_regclass('private.erasure_inventory_baseline_r17') is not null or to_regclass('private.process_followup_cases') is not null then
  raise exception 'followup_already_installed' using errcode='55000';end if;
 if not exists(select 1 from private.erasure_inventory_baseline_r16 where singleton and schema_signature='${sourceSignature}')
  or private.erasure_schema_signature() is distinct from '${sourceSignature}' then
  raise exception 'followup_source_schema_unreviewed:%',private.erasure_schema_signature() using errcode='55000';end if;
 ${inventoryCheck('erasure_inventory_baseline_r16','followup_source_inventory_gap')}
 ${adapters.map(item=>pinnedFunction(r16,item,true)).join('\n ')}
 ${readers.map(item=>pinnedFunction(r16,item,true)).join('\n ')}
 if to_regprocedure('private.erasure_inventory_rows_r16(uuid,uuid[])') is not null
  or to_regprocedure('private.erasure_row_candidates_r16(text,jsonb)') is not null then
  raise exception 'followup_adapter_name_taken' using errcode='55000';end if;
end $preflight$;`,domain,`
alter function private.erasure_inventory_rows(uuid,uuid[]) rename to erasure_inventory_rows_r16;
alter function private.erasure_row_candidates(text,jsonb) rename to erasure_row_candidates_r16;
create function private.erasure_row_candidates(adapter text,data jsonb) returns uuid[]
language plpgsql stable security definer set search_path='' as $$
declare subject uuid;
begin
 if adapter in (${candidateTables.map(t=>`'${t}'`).join(',')}) then
  select a.candidate_id into subject from public.applications a where a.id=(data->>'application_id')::uuid
   and a.company_id=(data->>'company_id')::uuid and a.recruitment_id=(data->>'recruitment_id')::uuid;
  if subject is null then raise exception using errcode='PT409',message='Unknown follow-up candidate dependency';end if;
  return array[subject];
 end if;
 return private.erasure_row_candidates_r16(adapter,data);
end;$$;
create function private.erasure_inventory_rows(tenant uuid,subjects uuid[])
returns table(adapter text,row_key text,row_data jsonb) language sql stable security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
 select * from private.erasure_inventory_rows_r16(tenant,subjects)${candidateTables.map(t=>`
 union all
 select '${t}',t.id::text,to_jsonb(t) from ${t} t
 join public.applications a on a.id=t.application_id and a.company_id=t.company_id and a.recruitment_id=t.recruitment_id
 where t.company_id=tenant and a.candidate_id=any(subjects)`).join('')}
$$;
create table private.erasure_inventory_baseline_r17 (
 singleton boolean primary key default true check(singleton),schema_signature text not null,known_tables text[] not null
);
alter table private.erasure_inventory_baseline_r17 enable row level security;
create trigger immutable_history before update or delete on private.erasure_inventory_baseline_r17
 for each row execute function private.contact_immutable();
insert into private.erasure_inventory_baseline_r17 select true,'${signature}',
 known_tables||array[${newTables.map(t=>`'${t}'`).join(',')},'private.erasure_inventory_baseline_r17']
 from private.erasure_inventory_baseline_r16 where singleton;
`];
for(const [name] of readers){
 const source=fn(r16,name);
 if(!source.includes('erasure_inventory_baseline_r16'))throw Error('Reader has no baseline reference: '+name);
 output.push(source.replaceAll('erasure_inventory_baseline_r16','erasure_inventory_baseline_r17'));
}
// Reuse the exact hosted creator protocol reviewed in R16, restoring memberships/ACLs.
const accessStart=r16.slice(r16.indexOf('-- PG16+ non-superuser creators'),r16.indexOf('set local role erasure_purge_owner;'));
if(!accessStart.includes('sc010_purge_migration_access'))throw Error('Missing purge owner protocol');
const engineStart=r16.indexOf('create or replace function private.erasure_purge_engine');
const restoreEnd=r16.slice(r16.indexOf('reset role;',engineStart),r16.indexOf('-- Remove hostile default ACLs',engineStart));
if(!restoreEnd.includes('Purge migration privileges not restored'))throw Error('Missing purge owner restore');
const anchor=" update private.erasure_purge_context set mode='delete' where txid=txid_current();";
let engine=fn(r16,'private.erasure_purge_engine');
if(engine.split(anchor).length!==2)throw Error('Missing validated purge boundary');
// Remove follow-up rows before the original application and candidate rows.
engine=engine.replace(anchor,anchor+candidateTables.map(t=>`
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='${t}';
 delete from ${t} t where private.erasure_purge_allowed('${t}',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('${t}',deleted_count);`).join(''));
output.push(accessStart+'\nset local role erasure_purge_owner;\n'+engine+'\n'+restoreEnd);
output.push(`-- Remove hostile default ACLs on every new table and function, then grant
-- only the public follow-up RPCs and the existing manifest-checked purge role.
do $acl$
declare o record;g record;
begin
 for o in select oid,relowner from pg_class where oid in (${[...newTables,'private.erasure_inventory_baseline_r17'].map(t=>`'${t}'::regclass`).join(',')}) loop
  execute format('revoke all on table %s from public',o.oid::regclass);
  for g in select distinct a.grantee,r.rolname from pg_class c cross join lateral aclexplode(c.relacl) a join pg_roles r on r.oid=a.grantee
   where c.oid=o.oid and a.grantee<>o.relowner loop execute format('revoke all on table %s from %I',o.oid::regclass,g.rolname);end loop;
 end loop;
 for o in select c.oid,c.relowner from pg_class c where c.oid=pg_get_serial_sequence('private.process_followup_grants','sequence')::regclass loop
  execute format('revoke all on sequence %s from public',o.oid::regclass);
  for g in select distinct a.grantee,r.rolname from pg_class c cross join lateral aclexplode(c.relacl) a join pg_roles r on r.oid=a.grantee
   where c.oid=o.oid and a.grantee<>o.relowner loop execute format('revoke all on sequence %s from %I',o.oid::regclass,g.rolname);end loop;
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
  raise exception 'followup_final_schema_mismatch:%',private.erasure_schema_signature() using errcode='55000';end if;
 ${inventoryCheck('erasure_inventory_baseline_r17','followup_final_inventory_gap')}
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('public','private') and p.prosrc ~ 'erasure_inventory_baseline_r([4-9]|1[0-6])([^0-9]|$)') then
  raise exception 'followup_stale_inventory_reference' using errcode='55000';end if;
 if (select count(*) from pg_proc p where p.prosrc like '%erasure_inventory_baseline_r17%'
  and p.proname in ('preview_candidate_erasure','prepare_erasure_purge_manifest','authorize_retention_suggestion','get_retention_schedule'))<>4 then
  raise exception 'followup_inventory_reference_missing' using errcode='55000';end if;
 if exists(select 1 from (values
  ('private.erasure_inventory_rows(uuid,uuid[])'::regprocedure,'private.erasure_inventory_rows_r16(uuid,uuid[])'::regprocedure),
  ('private.erasure_row_candidates(text,jsonb)'::regprocedure,'private.erasure_row_candidates_r16(text,jsonb)'::regprocedure)) v(wrapper,base)
 join pg_proc w on w.oid=v.wrapper join pg_proc b on b.oid=v.base
 where w.proowner<>b.proowner or not w.prosecdef or w.proacl::text is distinct from b.proacl::text) then
  raise exception 'followup_wrapper_acl_mismatch' using errcode='55000';end if;
 -- Deny by default: no API role holds any privilege on a new table.
 if exists(select 1 from pg_class c cross join (values('anon'),('authenticated')) r(name)
  where c.oid in (${newTables.map(t=>`'${t}'::regclass`).join(',')})
  and (not c.relrowsecurity or has_table_privilege(r.name,c.oid,'select,insert,update,delete'))) then
  raise exception 'followup_table_exposed' using errcode='55000';end if;
end $postflight$;
commit;`);
const path='supabase/migrations/20261113090000_sc_process_followup_r17.sql';
const artifact=output.join('\n\n')+'\n';
if(process.argv.includes('--check')){if(readFileSync(path,'utf8')!==artifact)throw Error('Regenerate process follow-up migration');}
else writeFileSync(path,artifact);
