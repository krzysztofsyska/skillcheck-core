// Compose R6-1c (part 1): the SC-012-B voice plan tables and review/release RPCs
// as a real migration on top of the reviewed R17 inventory and purge engine.
// Offline only: no deployed catalog, no inferred signature, no activation flag.
//
// Sources are the reviewed isolated files (db/prototypes/sc012b-plan-schema.sql,
// db/isolated/sc012b-*.sql) and the R4 voice erasure adapters
// (db/isolated/sc010-r4-voice-retention.sql), pinned by hash. The RPC bodies are
// copied byte for byte; only installer comments, `drop trigger if exists` on
// brand-new tables and the history guard (which now admits the manifest-checked
// purge, exactly as the R4 voice adapter does) differ.
//
// Usage: node scripts/r6-voice-plan-compose.mjs          (write the migration)
//        node scripts/r6-voice-plan-compose.mjs --check  (fail when out of date)
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
const pinned = (path, hash) => {
 const text = readFileSync(path,'utf8');
 if(sha(text)!==hash)throw Error('Review updated source before composing the voice plan migration: '+path);
 return text;
};
const r17 = pinned('supabase/migrations/20261113090000_sc_process_followup_r17.sql','73eb3ee1f6724b34470b8943c026b248a8ed1752a5cc9d12637347f72e6f6807');
const r4 = pinned('supabase/migrations/20261012031039_retention_scheduler_inventory.sql','7106a7755a31b003975e8932bcbae7472a690b9df8f27e9bf27d759a52afb86e');
const planSchema = pinned('db/prototypes/sc012b-plan-schema.sql','4252d0e688782d88868efa81c3b68d9183d8b201a6b8ecabf98ec6ea24f80486');
const catalog = pinned('db/isolated/sc012b-template-catalog.sql','c11077a58f11180c02c5dcc6a69e4716f18911a6a0a52decd10bcb3d16f5bf43');
const review = pinned('db/isolated/sc012b-review-rpc.sql','f8b3bfa6c2498192823a9578e90dd20722cb4f94026a409f2e2b1d560348cffa');
const release = pinned('db/isolated/sc012b-release-rpc.sql','c22d114cb5277407b668a739038a05c16e02df97ffda539f760c5774925daded');
const voiceRetention = pinned('db/isolated/sc010-r4-voice-retention.sql','c5dbf138405ed737332a70400f6017d983cd111f9be49180c1309b2d75ae0d5f');
const sourceSignature = '8ad238e75d4d4ccb82e03b89f368ba06483580781494fe1f7f9306a3c9c7f73f';
const signature = 'd77384591cfa80a1a2f16d641b7af5e653a21ce49ccc1b7f2db2bbc2539aaebb';

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
// Drop the leading installer comment block of an isolated file (it says "not a migration").
const withoutHeader = text => text.replace(/^(?:--[^\n]*\n)+/,'');

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
  raise exception 'voice_plan_source_function_unreviewed:${name}' using errcode='55000';end if;`;
};
const inventoryCheck = (baseline,label) => `select known_tables into known from private.${baseline} where singleton;
 select array_agg(n.nspname||'.'||c.relname order by (n.nspname||'.'||c.relname) collate "C") into actual
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f');
 if actual is distinct from (select array_agg(x order by x collate "C") from unnest(known) x) then
  raise exception '${label}' using errcode='55000';end if;`;

// Candidate-linked voice plan tables in purge order (children first). The
// template catalog is tenant-neutral configuration: inventoried as known, never purged.
const candidateTables = ['private.voice_plan_request_keys','private.voice_plan_current_releases',
 'private.voice_plan_release_entries','private.voice_plan_review_entries','public.voice_plan_versions'];
const newTables = [...candidateTables,'private.voice_plan_template_catalog'];
const rpcs = ['private.sc012b_review_plan(uuid,bigint,text,text,text,uuid)','private.sc012b_release_plan(uuid,uuid,text,bigint,uuid,uuid)',
 'private.sc012b_current_release(uuid)'];
const privateFunctions = ['private.voice_plan_protect_history()','private.voice_plan_prototype_lineage_guard()',
 'private.sc012b_assert_fresh_write()','private.erasure_voice_request_candidate(uuid,text,uuid)','private.erasure_voice_row_guard()',
 'private.erasure_row_candidates(text,jsonb)','private.erasure_inventory_rows(uuid,uuid[])',...rpcs];
// Reviewed RPC/guard bodies that must stay byte-identical to the isolated sources.
const verbatim = [[planSchema,'private.voice_plan_prototype_lineage_guard'],[review,'private.sc012b_review_plan'],
 [review,'private.sc012b_assert_fresh_write'],[release,'private.sc012b_release_plan'],[release,'private.sc012b_current_release'],
 [voiceRetention,'private.erasure_voice_request_candidate']];

// --- domain: isolated sources with installer-only differences removed ---
const purgeAwareGuard = `create function private.voice_plan_protect_history()
returns trigger language plpgsql set search_path = '' as $$
begin
 if tg_op='DELETE' and current_user='erasure_purge_owner' and
  private.erasure_purge_allowed(tg_table_schema||'.'||tg_table_name,to_jsonb(old)) then return old;end if;
  raise exception using errcode='42501',message='VOICE_PLAN_HISTORY_IMMUTABLE';
end;
$$;`;
if(!fn(voiceRetention,'private.voice_plan_protect_history').includes("current_user='erasure_purge_owner'"))
 throw Error('R4 voice guard changed');
let plan = withoutHeader(planSchema);
plan = once(plan,'create schema if not exists private;\n\n','');
plan = once(plan,`-- Composite provenance keys are necessary to stop same-tenant cross-application
-- and cross-position binding. These indexes are prototype-only, not a migration.`,
`-- Composite provenance keys are necessary to stop same-tenant cross-application
-- and cross-position binding. Every key ends with the primary key, so the new
-- unique indexes cannot conflict with existing rows.`);
plan = once(plan,fn(planSchema,'private.voice_plan_protect_history'),purgeAwareGuard);
plan = once(plan,`-- Prototype immutability guard: history is append-only even for privileged callers.
-- A future owner-authorized, narrowly scoped erasure path must be reviewed separately.`,
`-- History is append-only even for privileged callers. The only delete is the
-- manifest-checked candidate erasure (SC-010 R18 below), as in the R4 voice adapter.`);
plan = once(plan,`-- Prototype-only lineage guard; an authenticated write RPC will need to own
-- the same app advisory lock, actor authorization and complete source checks.`,
`-- Lineage guard (name kept from the reviewed SC-012-B source); any future write
-- RPC must own the same app advisory lock, actor authorization and source checks.`);
plan = plan.replaceAll('create or replace function private.','create function private.');
const cat = withoutHeader(catalog);
let rev = withoutHeader(review);
rev = once(rev,'drop trigger if exists sc012b_review_fresh_at_commit on private.voice_plan_review_entries;\n','');
rev = rev.replaceAll('create or replace function private.','create function private.');
let rel = withoutHeader(release);
rel = once(rel,'drop trigger if exists sc012b_release_fresh_at_commit on private.voice_plan_release_entries;\n','');
rel = once(rel,`-- delete back. This is isolated SQL, not a Supabase migration.`,`-- delete back.`);
rel = rel.replaceAll('create or replace function private.','create function private.');
for(const part of [plan,cat,rev,rel]) if(/\bdrop\b/i.test(part.replace(/--[^\n]*/g,'')))throw Error('Unexpected drop in voice plan domain');

// --- SC-010 R18 adapters for the five candidate-linked voice plan tables ---
const purgeKeySource = fn(r4,'private.erasure_purge_key');
const purgeKey = once(purgeKeySource,
 ` select case
`,` select case
 when adapter='private.voice_plan_request_keys' then data->>'company_id'||':'||(data->>'actor_id')||':'||(data->>'operation')||':'||(data->>'request_key')
 when adapter='private.voice_plan_current_releases' then data->>'company_id'||':'||(data->>'application_id')
`);
const planTables = candidateTables.filter(t=>t!=='private.voice_plan_request_keys');
const wiring = `
-- SC-010 R18: voice plan rows are candidate data. Resolve request results by
-- operation AND tenant, never by UUID text (reviewed R4 voice adapter).
${fn(voiceRetention,'private.erasure_voice_request_candidate')}

-- Row keys of the two voice tables without an id column; every other adapter
-- keeps its R4 key (this function was last defined by 20261012031039).
${purgeKey}

alter function private.erasure_inventory_rows(uuid,uuid[]) rename to erasure_inventory_rows_r17;
alter function private.erasure_row_candidates(text,jsonb) rename to erasure_row_candidates_r17;
create function private.erasure_row_candidates(adapter text,data jsonb) returns uuid[]
language plpgsql stable security definer set search_path='' as $$
declare subject uuid;ids uuid[];
begin
 if adapter='private.voice_plan_request_keys' then
  subject:=private.erasure_voice_request_candidate((data->>'company_id')::uuid,data->>'operation',(data->>'result_id')::uuid);
  if subject is null then raise exception using errcode='PT409',message='Unknown voice request dependency';end if;
  return array[subject];
 end if;
 if adapter in (${planTables.map(t=>`'${t}'`).join(',')}) then
  -- Composite foreign keys bind every plan, review, release and pointer to one
  -- (company, application); referenced plan/review/release ids are resolved too.
  select array_agg(distinct a.candidate_id order by a.candidate_id) into ids from public.applications a
  where a.company_id=(data->>'company_id')::uuid and (a.id=(data->>'application_id')::uuid or a.id in (
   select p.application_id from public.voice_plan_versions p where p.company_id=a.company_id
    and p.id in ((data->>'plan_id')::uuid,(data->>'supersedes_plan_id')::uuid)
   union select r.application_id from private.voice_plan_review_entries r where r.company_id=a.company_id
    and r.id in ((data->>'corrects_review_id')::uuid,(data->>'approved_review_id')::uuid)
   union select r.application_id from private.voice_plan_release_entries r where r.company_id=a.company_id
    and r.id=(data->>'release_entry_id')::uuid));
  if coalesce(cardinality(ids),0)=0 then raise exception using errcode='PT409',message='Unknown voice candidate dependency';end if;
  return ids;
 end if;
 return private.erasure_row_candidates_r17(adapter,data);
end;$$;
create function private.erasure_inventory_rows(tenant uuid,subjects uuid[])
returns table(adapter text,row_key text,row_data jsonb) language sql stable security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
 select * from private.erasure_inventory_rows_r17(tenant,subjects)${planTables.map(t=>`
 union all
 select '${t}',private.erasure_purge_key('${t}',to_jsonb(t)),to_jsonb(t) from ${t} t
 join public.applications a on a.id=t.application_id and a.company_id=t.company_id
 where t.company_id=tenant and a.candidate_id=any(subjects)`).join('')}
 union all
 select 'private.voice_plan_request_keys',private.erasure_purge_key('private.voice_plan_request_keys',to_jsonb(t)),to_jsonb(t) from private.voice_plan_request_keys t
 where t.company_id=tenant and private.erasure_voice_request_candidate(t.company_id,t.operation,t.result_id)=any(subjects)
$$;
create table private.erasure_inventory_baseline_r18 (
 singleton boolean primary key default true check(singleton),schema_signature text not null,known_tables text[] not null
);
alter table private.erasure_inventory_baseline_r18 enable row level security;
create trigger immutable_history before update or delete on private.erasure_inventory_baseline_r18
 for each row execute function private.contact_immutable();
insert into private.erasure_inventory_baseline_r18 select true,'${signature}',
 known_tables||array[${newTables.map(t=>`'${t}'`).join(',')},'private.erasure_inventory_baseline_r18']
 from private.erasure_inventory_baseline_r17 where singleton;

-- Normal writes take the candidate lock and refuse frozen candidates; deletes are
-- only the manifest-checked purge, except the app-scoped current-release pointer
-- that sc012b_current_release clears when its source went stale (R4 voice guard).
create function private.erasure_voice_row_guard() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if tg_op='DELETE' then
  if current_user='erasure_purge_owner' and private.erasure_purge_allowed(tg_table_schema||'.'||tg_table_name,to_jsonb(old)) then return old;end if;
  if tg_table_name<>'voice_plan_current_releases' then
   raise exception using errcode='42501',message='Controlled voice erasure required';end if;
 end if;
 if tg_table_name='voice_plan_request_keys' and tg_op='UPDATE' then
  raise exception using errcode='42501',message='Immutable voice request';end if;
 perform private.erasure_normal_row_guard(tg_op,tg_table_schema,tg_table_name,
  case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
  case when tg_op<>'DELETE' then to_jsonb(new) end);
 if tg_op='DELETE' then return old;end if;
 return new;
end;$$;
${candidateTables.map(t=>{const [s,n]=t.split('.');return `create trigger erasure_voice_guard before insert or update or delete on ${t}
 for each row execute function private.erasure_voice_row_guard();
create trigger zz_retention_observed after insert or update or delete on ${t}
 for each row execute function private.retention_observe_candidate();
create policy erasure_purge_select on ${t} for select to erasure_purge_owner using (private.erasure_purge_visible('${t}',to_jsonb(${n})));
create policy erasure_purge_delete on ${t} for delete to erasure_purge_owner using (private.erasure_purge_allowed('${t}',to_jsonb(${n})));`;}).join('\n')}
`;

const output = [`-- R6-1c (part 1): voice interview plan tables (SC-012-B) as a real migration.
-- Generated offline by scripts/r6-voice-plan-compose.mjs from the reviewed isolated
-- sources and the R17 erasure inventory; erasure inventory R18 adds the five
-- candidate-linked voice plan tables (R4 voice adapter, reduced to the plan tables).
--
-- Nothing is used by the application yet and nothing is customer-visible: no table
-- or function is granted to anon, authenticated or service_role, no template
-- version is seeded (private.voice_plan_template_catalog stays empty), no provider,
-- package, price or order state is touched. The review/release RPCs are executable
-- only by their owner (trusted server code, a later reviewed step).
begin;
do $preflight$
declare known text[];actual text[];
begin
 if to_regclass('private.erasure_inventory_baseline_r17') is null then raise exception 'voice_plan_requires_r17' using errcode='55000';end if;
 if to_regclass('private.erasure_inventory_baseline_r18') is not null or to_regclass('public.voice_plan_versions') is not null
  or to_regclass('private.voice_plan_template_catalog') is not null then
  raise exception 'voice_plan_already_installed' using errcode='55000';end if;
 if not exists(select 1 from private.erasure_inventory_baseline_r17 where singleton and schema_signature='${sourceSignature}')
  or private.erasure_schema_signature() is distinct from '${sourceSignature}' then
  raise exception 'voice_plan_source_schema_unreviewed:%',private.erasure_schema_signature() using errcode='55000';end if;
 ${inventoryCheck('erasure_inventory_baseline_r17','voice_plan_source_inventory_gap')}
 ${adapters.map(item=>pinnedFunction(r17,item,true)).join('\n ')}
 ${readers.map(item=>pinnedFunction(r17,item,true)).join('\n ')}
 ${pinnedFunction(r4,['private.erasure_purge_key','text,jsonb'],false)}
 if to_regprocedure('private.erasure_inventory_rows_r17(uuid,uuid[])') is not null
  or to_regprocedure('private.erasure_row_candidates_r17(text,jsonb)') is not null then
  raise exception 'voice_plan_adapter_name_taken' using errcode='55000';end if;
 if to_regprocedure('private.has_company_access(uuid,boolean)') is null or to_regprocedure('private.erasure_lock_candidate(uuid)') is null
  or to_regprocedure('private.screening_material(uuid,boolean)') is null or to_regclass('private.erasure_execution_config') is null
  or to_regprocedure('private.erasure_normal_row_guard(text,text,text,jsonb,jsonb)') is null
  or to_regprocedure('private.retention_observe_candidate()') is null or to_regrole('erasure_purge_owner') is null then
  raise exception 'voice_plan_dependency_missing' using errcode='55000';end if;
end $preflight$;`,
`-- SC-012-B plan tables (source: db/prototypes/sc012b-plan-schema.sql).`,plan.trim(),
`-- SC-012-B template catalog (source: db/isolated/sc012b-template-catalog.sql).`,cat.trim(),
`-- SC-012-B review RPC (source: db/isolated/sc012b-review-rpc.sql).`,rev.trim(),
`-- SC-012-B release RPC (source: db/isolated/sc012b-release-rpc.sql).`,rel.trim(),
wiring.trim()];
for(const [name] of readers){
 const source=fn(r17,name);
 if(!source.includes('erasure_inventory_baseline_r17'))throw Error('Reader has no baseline reference: '+name);
 output.push(source.replaceAll('erasure_inventory_baseline_r17','erasure_inventory_baseline_r18'));
}
// Reuse the exact hosted creator protocol reviewed in R16/R17, restoring memberships/ACLs.
const accessStart=r17.slice(r17.indexOf('-- PG16+ non-superuser creators'),r17.indexOf('set local role erasure_purge_owner;'));
if(!accessStart.includes('sc010_purge_migration_access'))throw Error('Missing purge owner protocol');
const engineStart=r17.indexOf('create or replace function private.erasure_purge_engine');
const restoreEnd=r17.slice(r17.indexOf('reset role;',engineStart),r17.indexOf('-- Remove hostile default ACLs',engineStart));
if(!restoreEnd.includes('Purge migration privileges not restored'))throw Error('Missing purge owner restore');
const anchor=" update private.erasure_purge_context set mode='delete' where txid=txid_current();";
let engine=fn(r17,'private.erasure_purge_engine');
if(engine.split(anchor).length!==2)throw Error('Missing validated purge boundary');
// Voice plan rows go before shortlist, screening and application rows. RESTRICT
// lineage: each newest plan's reviews, then that plan, then its predecessor.
const countedDelete = t => `
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='${t}';
 delete from ${t} t where private.erasure_purge_allowed('${t}',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('${t}',deleted_count);`;
engine=engine.replace(anchor,anchor+['private.voice_plan_request_keys','private.voice_plan_current_releases','private.voice_plan_release_entries'].map(countedDelete).join('')+`
 for c in select * from public.voice_plan_versions order by company_id,application_id,plan_version desc loop
  delete from private.voice_plan_review_entries t where t.company_id=c.company_id and t.plan_id=c.id
   and private.erasure_purge_allowed('private.voice_plan_review_entries',to_jsonb(t));
  get diagnostics deleted_count=row_count;
  deleted_counts:=jsonb_set(deleted_counts,'{private.voice_plan_review_entries}',to_jsonb(coalesce((deleted_counts->>'private.voice_plan_review_entries')::bigint,0)+deleted_count));
  delete from public.voice_plan_versions t where t.id=c.id and private.erasure_purge_allowed('public.voice_plan_versions',to_jsonb(t));
  get diagnostics deleted_count=row_count;
  if deleted_count<>1 then raise exception using errcode='PT409',message='Purge plan manifest changed';end if;
  deleted_counts:=jsonb_set(deleted_counts,'{public.voice_plan_versions}',to_jsonb(coalesce((deleted_counts->>'public.voice_plan_versions')::bigint,0)+deleted_count));
 end loop;
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='public.voice_plan_versions';
 if coalesce((deleted_counts->>'public.voice_plan_versions')::bigint,0)<>expected_count then raise exception using errcode='PT409',message='Purge plan count changed';end if;
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='private.voice_plan_review_entries';
 if coalesce((deleted_counts->>'private.voice_plan_review_entries')::bigint,0)<>expected_count then raise exception using errcode='PT409',message='Purge review count changed';end if;`);
output.push(accessStart+'\nset local role erasure_purge_owner;\n'+engine+'\n'+restoreEnd);
output.push(`-- Remove hostile default ACLs on every new table and function, then grant only
-- the existing manifest-checked purge role. No API role receives anything.
do $acl$
declare o record;g record;
begin
 for o in select oid,relowner from pg_class where oid in (${[...newTables,'private.erasure_inventory_baseline_r18'].map(t=>`'${t}'::regclass`).join(',')}) loop
  execute format('revoke all on table %s from public',o.oid::regclass);
  for g in select distinct a.grantee,r.rolname from pg_class c cross join lateral aclexplode(c.relacl) a join pg_roles r on r.oid=a.grantee
   where c.oid=o.oid and a.grantee<>o.relowner loop execute format('revoke all on table %s from %I',o.oid::regclass,g.rolname);end loop;
 end loop;
 for o in select oid,proowner from pg_proc where oid=any(array[
  ${privateFunctions.map(f=>`'${f}'`).join(',\n  ')}]::regprocedure[]) loop
  execute format('revoke all on function %s from public',o.oid::regprocedure);
  for g in select distinct a.grantee,r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee
   where p.oid=o.oid and a.grantee<>o.proowner loop execute format('revoke all on function %s from %I',o.oid::regprocedure,g.rolname);end loop;
 end loop;
end $acl$;
grant select,delete on ${candidateTables.join(',')} to erasure_purge_owner;
do $postflight$
declare known text[];actual text[];
begin
 if private.erasure_schema_signature() is distinct from '${signature}' then
  raise exception 'voice_plan_final_schema_mismatch:%',private.erasure_schema_signature() using errcode='55000';end if;
 ${inventoryCheck('erasure_inventory_baseline_r18','voice_plan_final_inventory_gap')}
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('public','private') and p.prosrc ~ 'erasure_inventory_baseline_r([4-9]|1[0-7])([^0-9]|$)') then
  raise exception 'voice_plan_stale_inventory_reference' using errcode='55000';end if;
 if (select count(*) from pg_proc p where p.prosrc like '%erasure_inventory_baseline_r18%'
  and p.proname in ('preview_candidate_erasure','prepare_erasure_purge_manifest','authorize_retention_suggestion','get_retention_schedule'))<>4 then
  raise exception 'voice_plan_inventory_reference_missing' using errcode='55000';end if;
 if exists(select 1 from (values
  ('private.erasure_inventory_rows(uuid,uuid[])'::regprocedure,'private.erasure_inventory_rows_r17(uuid,uuid[])'::regprocedure),
  ('private.erasure_row_candidates(text,jsonb)'::regprocedure,'private.erasure_row_candidates_r17(text,jsonb)'::regprocedure)) v(wrapper,base)
 join pg_proc w on w.oid=v.wrapper join pg_proc b on b.oid=v.base
 where w.proowner<>b.proowner or not w.prosecdef or w.proacl::text is distinct from b.proacl::text) then
  raise exception 'voice_plan_wrapper_acl_mismatch' using errcode='55000';end if;
 -- Deny by default: no API role holds any privilege on a new table or function.
 if exists(select 1 from pg_class c cross join (select rolname from pg_roles where rolname in ('anon','authenticated','service_role')) r
  where c.oid in (${newTables.map(t=>`'${t}'::regclass`).join(',')})
  and (not c.relrowsecurity or has_table_privilege(r.rolname,c.oid,'select,insert,update,delete,truncate,references,trigger'))) then
  raise exception 'voice_plan_table_exposed' using errcode='55000';end if;
 if exists(select 1 from pg_proc p cross join (select rolname from pg_roles where rolname in ('anon','authenticated','service_role')) r
  where p.oid=any(array[${privateFunctions.map(f=>`'${f}'`).join(',')}]::regprocedure[])
  and has_function_privilege(r.rolname,p.oid,'execute')) then
  raise exception 'voice_plan_function_exposed' using errcode='55000';end if;
 if exists(select 1 from pg_proc where oid=any(array[${rpcs.map(f=>`'${f}'`).join(',')}]::regprocedure[])
  and (not prosecdef or proconfig is distinct from array['search_path=""'])) then
  raise exception 'voice_plan_definer_search_path' using errcode='55000';end if;
end $postflight$;
commit;`);
const artifact=output.join('\n\n')+'\n';
for(const [source,name] of verbatim){
 if(!artifact.includes(fn(source,name).split('$$')[1]))throw Error('Reviewed body changed while composing: '+name);
}
const path='supabase/migrations/20261119100000_r6_voice_plan_r18.sql';
if(process.argv.includes('--check')){if(readFileSync(path,'utf8')!==artifact)throw Error('Regenerate the R6 voice plan migration');}
else writeFileSync(path,artifact);
