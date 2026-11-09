// Compose C6 onto the reviewed AC/R13 sources offline. No deployed catalog,
// inferred signature, activation flag or existing migration is changed.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
const sourcePath = 'supabase/migrations/20261106120000_sc_ac_inventory_r13.sql';
const c1 = readFileSync(sourcePath,'utf8');
const sourceHash = 'f6b5da2d2c6b2901932bd709402fe3f7328b8f211c6a3db57345b9ae88f96d90';
if(sha(c1)!==sourceHash)throw Error('Review updated R13 source before composing C6');
const domain = readFileSync('db/components/exercise-ai-proposals.sql','utf8');
const sourceSignature = 'de6b8172a272c6933ea39da4374a1206cb857ecabae218714c1d90d50d7d2889';
const signature = '75eca00dc4b8bbf7959e18a144beda51a70b0377ab4cc306e59b2cef56402688';
function fn(name){
 const start = c1.search(new RegExp(`create (?:or replace )?function ${name.replaceAll('.','\\.')}\\(`));
 const end = c1.indexOf('$$;',start);if(start<0||end<0)throw Error('Missing source '+name);
 return c1.slice(start,end+3);
}
const readers = [['public.preview_candidate_erasure','uuid,text,uuid'],['private.prepare_erasure_purge_manifest','uuid'],
 ['private.authorize_retention_suggestion','uuid'],['public.get_retention_schedule','uuid']];
const sources = [['private.erasure_inventory_rows','uuid,uuid[]'],['private.erasure_row_candidates','text,jsonb'],
 ['private.erasure_purge_engine','uuid,bigint,boolean'],...readers];
const expectedConfig = name => ['private.erasure_row_candidates','private.competency_authority','public.get_retention_schedule'].includes(name)
 ? `array['search_path=""']` : `array['search_path=""','TimeZone=UTC','DateStyle=ISO, YMD']`;
const output = [`-- SC-014-C6: proposal lifecycle foreign keys + erasure inventory R14.
-- Generated offline by scripts/sc-c6-compose.mjs, pinned to reviewed R13/AC.
-- No candidate-linked tables. No service, preview flag or production activation.
begin;
do $preflight$
declare known text[];actual text[];
begin
 if to_regclass('private.erasure_inventory_baseline_r13') is null then raise exception 'c6_requires_r13' using errcode='55000';end if;
 if to_regclass('private.erasure_inventory_baseline_r14') is not null or to_regnamespace('exercise_ai') is not null then
  raise exception 'c6_already_installed' using errcode='55000';end if;
 if not exists(select 1 from private.erasure_inventory_baseline_r13 where singleton and schema_signature='${sourceSignature}')
  or private.erasure_schema_signature() is distinct from '${sourceSignature}' then
  raise exception 'c6_source_schema_unreviewed:%',private.erasure_schema_signature() using errcode='55000';end if;
 select known_tables into known from private.erasure_inventory_baseline_r13 where singleton;
 select array_agg(n.nspname||'.'||c.relname order by (n.nspname||'.'||c.relname) collate "C") into actual
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f');
 if actual is distinct from (select array_agg(x order by x collate "C") from unnest(known) x) then
  raise exception 'c6_source_inventory_gap' using errcode='55000';end if;
 ${sources.map(([name,args])=>{
 const owner = name.endsWith('erasure_purge_engine')?'erasure_purge_owner':'postgres';
 const acl = `{${owner}=X/${owner}${name.startsWith('public.')?',authenticated=X/postgres':''}}`;
 return `if not exists(select 1 from pg_proc where oid='${name}(${args})'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='${sha(fn(name).split('$$')[1])}'
  and pg_get_userbyid(proowner)='${owner}' and prosecdef and proconfig=${expectedConfig(name)} and proacl::text='${acl}') then
  raise exception 'c6_source_function_unreviewed:${name}' using errcode='55000';end if;`;
 }).join('\n ')}
end $preflight$;`,domain,`
create table private.erasure_inventory_baseline_r14 (
 singleton boolean primary key default true check(singleton),schema_signature text not null,known_tables text[] not null
);
alter table private.erasure_inventory_baseline_r14 enable row level security;
create trigger immutable_history before update or delete on private.erasure_inventory_baseline_r14
 for each row execute function private.contact_immutable();
insert into private.erasure_inventory_baseline_r14 select true,'${signature}',
 known_tables||array['private.erasure_inventory_baseline_r14'] from private.erasure_inventory_baseline_r13 where singleton;
`];
for(const [name] of readers)output.push(fn(name).replaceAll('private.erasure_inventory_baseline_r13','private.erasure_inventory_baseline_r14'));
output.push(`
-- The baseline is internal even when the migration creator has hostile defaults.
do $acl$
declare g record;o record;
begin
 for o in select c.oid,c.relowner from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='exercise_ai' and c.relkind='r' loop
  execute format('revoke all on table %s from public',o.oid::regclass);
  for g in select distinct r.rolname from pg_class c cross join lateral aclexplode(c.relacl) a join pg_roles r on r.oid=a.grantee
   where c.oid=o.oid and a.grantee<>o.relowner loop execute format('revoke all on table %s from %I',o.oid::regclass,g.rolname);end loop;
 end loop;
 for o in select p.oid,p.proowner from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exercise_ai' loop
  execute format('revoke all on function %s from public',o.oid::regprocedure);
  for g in select distinct r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee
   where p.oid=o.oid and a.grantee<>o.proowner loop execute format('revoke all on function %s from %I',o.oid::regprocedure,g.rolname);end loop;
 end loop;
 revoke all on private.erasure_inventory_baseline_r14 from public;
 for g in select distinct r.rolname from pg_class c cross join lateral aclexplode(c.relacl) a
 join pg_roles r on r.oid=a.grantee where c.oid='private.erasure_inventory_baseline_r14'::regclass
 and a.grantee<>c.relowner loop
 execute format('revoke all on private.erasure_inventory_baseline_r14 from %I',g.rolname);
 end loop;
end $acl$;
grant select on exercise_ai.proposals,exercise_ai.recruitment_settings to authenticated;
grant execute on function exercise_ai.approve_proposal(uuid),exercise_ai.record_proposal(uuid,uuid,jsonb,integer),
 exercise_ai.set_auto_release(uuid,boolean) to authenticated;
do $postflight$
declare known text[];actual text[];
begin
 if private.erasure_schema_signature() is distinct from '${signature}' then
  raise exception 'c6_final_schema_mismatch:%',private.erasure_schema_signature() using errcode='55000';end if;
 select known_tables into known from private.erasure_inventory_baseline_r14 where singleton;
 select array_agg(n.nspname||'.'||c.relname order by (n.nspname||'.'||c.relname) collate "C") into actual
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f');
 if actual is distinct from (select array_agg(x order by x collate "C") from unnest(known) x) then
  raise exception 'c6_final_inventory_gap' using errcode='55000';end if;
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('public','private') and p.prosrc ~ 'erasure_inventory_baseline_r([4-9]|1[0123])([^0-9]|$)') then
  raise exception 'c6_stale_inventory_reference' using errcode='55000';end if;
 if (select count(*) from pg_proc p where p.prosrc like '%erasure_inventory_baseline_r14%'
  and p.proname in ('preview_candidate_erasure','prepare_erasure_purge_manifest','authorize_retention_suggestion','get_retention_schedule'))<>4 then
  raise exception 'c6_inventory_reference_missing' using errcode='55000';end if;
end $postflight$;
commit;`);
const path='supabase/migrations/20261106130000_exercise_ai_proposals.sql';
const artifact=output.join('\n\n')+'\n';
if(process.argv.includes('--check')){if(readFileSync(path,'utf8')!==artifact)throw Error('Regenerate C6 migration');}
else writeFileSync(path,artifact);
