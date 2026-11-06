// Compose AC onto the reviewed C1/R12 sources offline. No deployed catalog,
// inferred signature, activation flag or existing migration is changed.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
const c1Path = 'supabase/migrations/20261106063720_sc_wer_c1_inventory_r12.sql';
const c1 = readFileSync(c1Path,'utf8');
const c1Hash = 'e40de7245abe2d856c9c1ba19dd189cee64ed8204f25a50662c0e005d1c1ce4c';
if(sha(c1)!==c1Hash)throw Error('Review updated C1 source before composing AC');
const domain = readFileSync('db/components/sc-ac-paired-sheets.sql','utf8');
const sourceSignature = '48afc7b117acb3640b1521c9b8b2e525e89d653d9e2981edf2b1209f9515eaba';
const signature = 'de6b8172a272c6933ea39da4374a1206cb857ecabae218714c1d90d50d7d2889';
function fn(name){
 const start = c1.search(new RegExp(`create (?:or replace )?function ${name.replaceAll('.','\\.')}\\(`));
 const end = c1.indexOf('$$;',start);if(start<0||end<0)throw Error('Missing source '+name);
 return c1.slice(start,end+3);
}
const readers = [['public.preview_candidate_erasure','uuid,text,uuid'],['private.prepare_erasure_purge_manifest','uuid'],
 ['private.authorize_retention_suggestion','uuid'],['public.get_retention_schedule','uuid']];
const sources = [['private.erasure_inventory_rows','uuid,uuid[]'],['private.erasure_row_candidates','text,jsonb'],
 ['private.erasure_purge_engine','uuid,bigint,boolean'],['private.competency_authority','uuid,boolean'],...readers];
const expectedConfig = name => ['private.erasure_row_candidates','private.competency_authority','public.get_retention_schedule'].includes(name)
 ? `array['search_path=""']` : `array['search_path=""','TimeZone=UTC','DateStyle=ISO, YMD']`;
const output = [`-- SC-AC-001: active paired observer assessment + erasure inventory R13.
-- Generated offline by scripts/sc-ac-compose.mjs, pinned to reviewed R12/C1.
-- One candidate-linked table. No service, preview flag or production activation.
begin;
do $preflight$
declare known text[];actual text[];
begin
 if to_regclass('private.erasure_inventory_baseline_r12') is null then raise exception 'ac_requires_r12' using errcode='55000';end if;
 if to_regclass('private.erasure_inventory_baseline_r13') is not null or to_regclass('private.ac_paired_sheets') is not null then
  raise exception 'ac_already_installed' using errcode='55000';end if;
 if not exists(select 1 from private.erasure_inventory_baseline_r12 where singleton and schema_signature='${sourceSignature}')
  or private.erasure_schema_signature() is distinct from '${sourceSignature}' then
  raise exception 'ac_source_schema_unreviewed:%',private.erasure_schema_signature() using errcode='55000';end if;
 select known_tables into known from private.erasure_inventory_baseline_r12 where singleton;
 select array_agg(n.nspname||'.'||c.relname order by (n.nspname||'.'||c.relname) collate "C") into actual
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f');
 if actual is distinct from (select array_agg(x order by x collate "C") from unnest(known) x) then
  raise exception 'ac_source_inventory_gap' using errcode='55000';end if;
 ${sources.map(([name,args])=>{
 const owner = name.endsWith('erasure_purge_engine')?'erasure_purge_owner':'postgres';
 const acl = `{${owner}=X/${owner}${name.startsWith('public.')?',authenticated=X/postgres':''}}`;
 return `if not exists(select 1 from pg_proc where oid='${name}(${args})'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='${sha(fn(name).split('$$')[1])}'
  and pg_get_userbyid(proowner)='${owner}' and prosecdef and proconfig=${expectedConfig(name)} and proacl::text='${acl}') then
  raise exception 'ac_source_function_unreviewed:${name}' using errcode='55000';end if;`;
 }).join('\n ')}
 if to_regprocedure('private.erasure_inventory_rows_r12(uuid,uuid[])') is not null
  or to_regprocedure('private.erasure_row_candidates_r12(text,jsonb)') is not null then
  raise exception 'ac_adapter_name_taken' using errcode='55000';end if;
end $preflight$;`,domain,`
alter function private.erasure_inventory_rows(uuid,uuid[]) rename to erasure_inventory_rows_r12;
alter function private.erasure_row_candidates(text,jsonb) rename to erasure_row_candidates_r12;
create function private.erasure_row_candidates(adapter text,data jsonb) returns uuid[]
language plpgsql stable security definer set search_path='' as $$
declare subject uuid;
begin
 if adapter='private.ac_paired_sheets' then
  select a.candidate_id into subject from public.applications a where a.id=(data->>'application_id')::uuid
   and a.company_id=(data->>'company_id')::uuid and a.recruitment_id=(data->>'recruitment_id')::uuid;
  if subject is null then raise exception using errcode='PT409',message='Unknown AC candidate dependency';end if;
  return array[subject];
 end if;
 return private.erasure_row_candidates_r12(adapter,data);
end;$$;
create function private.erasure_inventory_rows(tenant uuid,subjects uuid[])
returns table(adapter text,row_key text,row_data jsonb) language sql stable security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
 select * from private.erasure_inventory_rows_r12(tenant,subjects)
 union all
 select 'private.ac_paired_sheets',t.id::text,to_jsonb(t) from private.ac_paired_sheets t
 join public.applications a on a.id=t.application_id and a.company_id=t.company_id and a.recruitment_id=t.recruitment_id
 where t.company_id=tenant and a.candidate_id=any(subjects)
$$;
create table private.erasure_inventory_baseline_r13 (
 singleton boolean primary key default true check(singleton),schema_signature text not null,known_tables text[] not null
);
alter table private.erasure_inventory_baseline_r13 enable row level security;
create trigger immutable_history before update or delete on private.erasure_inventory_baseline_r13
 for each row execute function private.contact_immutable();
insert into private.erasure_inventory_baseline_r13 select true,'${signature}',
 known_tables||array['private.ac_paired_sheets','private.erasure_inventory_baseline_r13']
 from private.erasure_inventory_baseline_r12 where singleton;
`];
for(const [name] of readers)output.push(fn(name).replaceAll('private.erasure_inventory_baseline_r12','private.erasure_inventory_baseline_r13'));
// Reuse the exact hosted creator protocol from C1, restoring memberships/ACLs.
const accessStart=c1.slice(c1.indexOf('-- PG16+ non-superuser creators',c1.indexOf('create trigger erasure_competency_guard')),c1.indexOf('set local role erasure_purge_owner;'));
if(!accessStart.includes('sc010_purge_migration_access'))throw Error('Missing purge owner protocol');
const engineStart=c1.indexOf('create or replace function private.erasure_purge_engine');
const restoreEnd=c1.slice(c1.indexOf('reset role;',engineStart),c1.indexOf('-- Strip hostile default grants',engineStart));
const anchor=" update private.erasure_purge_context set mode='delete' where txid=txid_current();";
let engine=fn('private.erasure_purge_engine');
if(!engine.includes(anchor))throw Error('Missing validated purge boundary');
engine=engine.replace(anchor,anchor+`
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.ac_paired_sheets';
 delete from private.ac_paired_sheets t where private.erasure_purge_allowed('private.ac_paired_sheets',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('private.ac_paired_sheets',deleted_count);`);
output.push(accessStart+'\nset local role erasure_purge_owner;\n'+engine+'\n'+restoreEnd);
output.push(`-- Remove hostile default ACLs on every new table and function, then grant
-- only the public session RPCs and the existing manifest-checked purge role.
do $acl$
declare o record;g record;
begin
 for o in select oid,relowner from pg_class where oid in ('private.ac_paired_sheets'::regclass,'private.erasure_inventory_baseline_r13'::regclass) loop
  execute format('revoke all on table %s from public',o.oid::regclass);
  for g in select distinct a.grantee,r.rolname from pg_class c cross join lateral aclexplode(c.relacl) a join pg_roles r on r.oid=a.grantee
   where c.oid=o.oid and a.grantee<>o.relowner loop execute format('revoke all on table %s from %I',o.oid::regclass,g.rolname);end loop;
 end loop;
 for o in select oid,proowner from pg_proc where oid=any(array[
  'private.ac_lock_application(uuid)','private.ac_sheet_guard()',
  'public.ac_assign_pair(uuid,uuid,uuid,uuid)','public.ac_submit_sheet(uuid,jsonb)',
  'public.ac_read_pair(uuid)','public.ac_find_pair(uuid,uuid)',
  'private.erasure_row_candidates(text,jsonb)','private.erasure_inventory_rows(uuid,uuid[])']::regprocedure[]) loop
  execute format('revoke all on function %s from public',o.oid::regprocedure);
  for g in select distinct a.grantee,r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee
   where p.oid=o.oid and a.grantee<>o.proowner loop execute format('revoke all on function %s from %I',o.oid::regprocedure,g.rolname);end loop;
 end loop;
end $acl$;
grant execute on function public.ac_assign_pair(uuid,uuid,uuid,uuid),public.ac_submit_sheet(uuid,jsonb),public.ac_read_pair(uuid),public.ac_find_pair(uuid,uuid) to authenticated;
grant select,delete on private.ac_paired_sheets to erasure_purge_owner;
do $postflight$
declare known text[];actual text[];
begin
 if private.erasure_schema_signature() is distinct from '${signature}' then
  raise exception 'ac_final_schema_mismatch:%',private.erasure_schema_signature() using errcode='55000';end if;
 select known_tables into known from private.erasure_inventory_baseline_r13 where singleton;
 select array_agg(n.nspname||'.'||c.relname order by (n.nspname||'.'||c.relname) collate "C") into actual
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f');
 if actual is distinct from (select array_agg(x order by x collate "C") from unnest(known) x) then
  raise exception 'ac_final_inventory_gap' using errcode='55000';end if;
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('public','private') and p.prosrc ~ 'erasure_inventory_baseline_r([4-9]|1[012])([^0-9]|$)') then
  raise exception 'ac_stale_inventory_reference' using errcode='55000';end if;
 if (select count(*) from pg_proc p where p.prosrc like '%erasure_inventory_baseline_r13%'
  and p.proname in ('preview_candidate_erasure','prepare_erasure_purge_manifest','authorize_retention_suggestion','get_retention_schedule'))<>4 then
  raise exception 'ac_inventory_reference_missing' using errcode='55000';end if;
 if exists(select 1 from (values
  ('private.erasure_inventory_rows(uuid,uuid[])'::regprocedure,'private.erasure_inventory_rows_r12(uuid,uuid[])'::regprocedure),
  ('private.erasure_row_candidates(text,jsonb)'::regprocedure,'private.erasure_row_candidates_r12(text,jsonb)'::regprocedure)) v(wrapper,base)
 join pg_proc w on w.oid=v.wrapper join pg_proc b on b.oid=v.base
 where w.proowner<>b.proowner or not w.prosecdef or w.proacl::text is distinct from b.proacl::text) then
  raise exception 'ac_wrapper_acl_mismatch' using errcode='55000';end if;
end $postflight$;
commit;`);
const path='supabase/migrations/20261106120000_sc_ac_inventory_r13.sql';
const artifact=output.join('\n\n')+'\n';
if(process.argv.includes('--check')){if(readFileSync(path,'utf8')!==artifact)throw Error('Regenerate AC migration');}
else writeFileSync(path,artifact);
