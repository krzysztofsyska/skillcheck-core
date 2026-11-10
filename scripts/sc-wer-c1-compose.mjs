// Offline composition of reviewed B2 code onto the CURRENT legacy R11 chain.
// No deployed catalog extraction, remote connection, or runtime signature learning.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const sources = {
  validation: 'db/isolated/sc014-b2-validation.sql',
  attempts: 'db/isolated/sc014-b2-attempts.sql',
  withdrawal: 'db/isolated/sc014-b2-withdrawal.sql',
  retention: 'db/isolated/sc014-b2-retention.sql',
  r11: 'supabase/migrations/20261103090100_sc_erasure_inventory_r11.sql',
  r9: 'supabase/migrations/20261101130100_cv_bulk_erasure_inventory_r9.sql',
  engine: 'supabase/migrations/20261012031039_retention_scheduler_inventory.sql',
  execution: 'supabase/migrations/20261010204840_erasure_execution_protocol.sql',
};
const pins = {
  "validation": "2ecf8426093be75a5bce954b87d746bbf8120bd31261cabaacd6a56be03e74eb",
  "attempts": "bfd6f771b9cdb6451efb3ed189ac3fd557dcca74054adc1dcec9fdd2fc1ab836",
  "withdrawal": "40e4c22da591322af16b0726d818d655d3945da7b198094920fe5754b7ac41bd",
  "retention": "586198c649858e07dc035e6335d22f05d0e6ba357618566aa182ba6c785cc978",
  "r11": "ed31ed820e0915cb6fe55ec6b6059e219d0ad12157a727948a52d3721b247dc7",
  "r9": "683b5bb6297ad4bf9a93f7e36e07822c0010125829e7eb47d5844b33f51dfac1",
  "engine": "7106a7755a31b003975e8932bcbae7472a690b9df8f27e9bf27d759a52afb86e",
  "execution": "d28e620930714d30f2e5b85e2c86f7fe88691611551d079d4563c85e0058f853"
};
const sha = value => createHash('sha256').update(value).digest('hex');
const text = Object.fromEntries(Object.entries(sources).map(([key, path]) => {
  const value = readFileSync(path, 'utf8');
  if (sha(value) !== pins[key]) throw new Error(`Review changed source: ${path}`);
  return [key, value];
}));
function fn(source, name) {
  const start = source.search(new RegExp(`create (?:or replace )?function ${name.replaceAll('.', '\\.')}\\(`));
  const end = source.indexOf('$$;', start);
  if (start < 0 || end < 0) throw new Error(`Missing source: ${name}`);
  return source.slice(start, end + 3);
}
function body(source, name) { return fn(source, name).split('$$')[1]; }
function replace(source, from, to) {
  if (!source.includes(from)) throw new Error(`Missing edit anchor: ${from}`);
  return source.replace(from, () => to);
}
const noTransaction = value => value.replace(/^begin;\s*$/m, '').replace(/^commit;\s*$/m, '');
const tables = ['private.competency_test_grants','private.competency_test_grant_events',
  'public.competency_test_attempts','private.competency_test_sessions','private.competency_test_drafts',
  'public.competency_test_review_entries','private.competency_test_cancellations'];
const readers = ['public.preview_candidate_erasure','private.prepare_erasure_purge_manifest',
  'private.authorize_retention_suggestion','public.get_retention_schedule'];
const baseline = 'private.erasure_inventory_baseline_r12';
const sourceSignature = '0d22eb7a547b1f8838298b034d3d257ca4cba9e81430f5c6b20b9212e4d88b84';
const signature = '48afc7b117acb3640b1521c9b8b2e525e89d653d9e2981edf2b1209f9515eaba';
const sourceFunctions = [
  ['r9','private.erasure_inventory_rows','uuid,uuid[]'],
  ['r9','private.erasure_row_candidates','text,jsonb'],
  ['engine','private.erasure_purge_engine','uuid,bigint,boolean'],
  ['execution','public.confirm_erasure_subject','uuid,uuid[],bigint,uuid'],
  ...readers.map((name, i) => ['r11', name, ['uuid,text,uuid','uuid','uuid','uuid'][i]]),
];
// Reuse the already-reviewed hosted creator protocol, including exact catalog
// restoration. ADMIN-only Supabase bootstrap membership is not SET/INHERIT.
const accessStart=text.engine.slice(text.engine.indexOf('-- PG16+ non-superuser creators'),text.engine.indexOf('set local role erasure_purge_owner;'));
const accessEnd=text.engine.slice(text.engine.indexOf('reset role;',text.engine.indexOf('create or replace function private.erasure_purge_engine')),
 text.engine.indexOf('\ngrant select,delete on private.retention_suggestions'));
const hostedMembership = `current_user='postgres' and current_setting('server_version_num')::integer/10000 in (16,17)
 and m.roleid=r.oid and exists(select 1 from pg_roles where oid=m.member and rolname='postgres'
 and not rolsuper and rolinherit and rolcreaterole and rolcreatedb and rolcanlogin and rolreplication and rolbypassrls)
 and exists(select 1 from pg_roles where oid=m.grantor and rolname='supabase_admin' and oid=10
 and rolsuper and rolinherit and rolcreaterole and rolcreatedb and rolcanlogin and rolreplication and rolbypassrls)
 and m.admin_option and not m.inherit_option and not m.set_option`;
const functionContext = name => {
 const owner = name.endsWith('.erasure_purge_engine') ? 'erasure_purge_owner' : 'postgres';
 const authenticated = ['public.preview_candidate_erasure','public.confirm_erasure_subject','public.get_retention_schedule'].includes(name);
 const config = ['public.confirm_erasure_subject','public.get_retention_schedule','private.erasure_row_candidates'].includes(name)
  ? `array['search_path=""']` : `array['search_path=""','TimeZone=UTC','DateStyle=ISO, YMD']`;
 const acl = `{${owner}=X/${owner}${authenticated ? ',authenticated=X/postgres' : ''}}`;
 return { owner, config, acl };
};
const output = [`-- SC-WER-001 C1: atomic active B2 and candidate erasure R12.
-- Generated offline by scripts/sc-wer-c1-compose.mjs. R11 history stays immutable.
-- Scope: candidate tests only; no voice variant, execution flags, or services enabled.
-- Seven candidate-linked tables each have inventory, manifest, guard and purge coverage.
begin;
do $preflight$
declare known text[]; actual text[];
begin
 if to_regclass('private.erasure_inventory_baseline_r11') is null then
  raise exception 'sc_wer_requires_r11' using errcode='55000';end if;
 if to_regclass('${baseline}') is not null then raise exception 'sc_wer_already_installed' using errcode='55000';end if;
 if not exists(select 1 from private.erasure_inventory_baseline_r11 where singleton and schema_signature='${sourceSignature}')
  or private.erasure_schema_signature() is distinct from '${sourceSignature}' then
  raise exception 'sc_wer_source_schema_unreviewed:%',private.erasure_schema_signature() using errcode='55000';end if;
 select known_tables into known from private.erasure_inventory_baseline_r11 where singleton;
 select array_agg(n.nspname||'.'||c.relname order by (n.nspname||'.'||c.relname) collate "C") into actual
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f');
 if actual is distinct from (select array_agg(x order by x collate "C") from unnest(known) x) then
  raise exception 'sc_wer_source_inventory_gap' using errcode='55000';end if;
 ${sourceFunctions.map(([key,name,args]) => `if (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc where oid='${name}(${args})'::regprocedure)
  is distinct from '${sha(body(text[key],name))}' then raise exception 'sc_wer_source_function_unreviewed:${name}' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='${name}(${args})'::regprocedure
  and pg_get_userbyid(proowner)='${functionContext(name).owner}' and prosecdef
  and proconfig=${functionContext(name).config} and proacl::text='${functionContext(name).acl}') then
  raise exception 'sc_wer_source_privileges_unreviewed:${name}' using errcode='55000';end if;`).join('\n ')}
 if to_regprocedure('private.erasure_inventory_rows_r11(uuid,uuid[])') is not null
 or to_regprocedure('private.erasure_row_candidates_r11(text,jsonb)') is not null then
  raise exception 'sc_wer_adapter_name_taken' using errcode='55000';end if;
 -- A clean pre-existing NOLOGIN role is valid (roles are cluster-wide), but
 -- ownership or explicit grants survive schema signatures and would become
 -- reachable as soon as this migration grants private USAGE. Never repair or
 -- silently revoke an unreviewed role: reject the whole transaction instead.
 if exists(select 1 from pg_shdepend d join pg_roles r on r.oid=d.refobjid
  where d.refclassid='pg_authid'::regclass
   and r.rolname in ('competency_test_gateway','competency_test_marker_writer')
   and d.deptype in ('o','a','i','r')) then
  raise exception 'sc_wer_source_role_privileges_unreviewed' using errcode='55000';end if;
end $preflight$;`];
output.push(noTransaction(text.validation));
let attempts = noTransaction(text.attempts).replace(/-- SC-014-B2[^\n]*\n/, '-- Active competency capability protocol.\n');
attempts = replace(attempts, `-- Installed only after the accepted voice + billing retention composition.\ndo $$begin\n if to_regclass('private.erasure_inventory_baseline_r5') is null then\n  raise exception 'SC-014 requires accepted SC-010 + voice + billing composition';end if;`, 'do $$begin');
attempts=replace(attempts,'or rolbypassrls or rolinherit or rolcanlogin','or rolbypassrls or rolinherit or rolcanlogin or rolreplication');
attempts=replace(attempts,"where r.rolname in ('competency_test_gateway','competency_test_marker_writer')) then",
 `where r.rolname in ('competency_test_gateway','competency_test_marker_writer') and not (${hostedMembership})) then`);
const shortlist = `
 -- R1 is enforced on issue, rotation and EVERY capability use, including replay.
 -- A shared row lock serializes removal against capability work until COMMIT.
 perform 1 from public.recruitment_shortlist_entries e
 where e.company_id=a.company_id and e.recruitment_id=a.recruitment_id and e.application_id=a.id
 and e.removed_at is null for share nowait;
 if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;`;
attempts = replace(attempts, ' perform private.competency_validate_definition(d.definition);', shortlist + '\n perform private.competency_validate_definition(d.definition);');
attempts = replace(attempts, ' a:=private.competency_lock_application(target_application,true);',
 ' a:=private.competency_lock_application(target_application,true);\n d:=private.competency_eligible(a,target_definition);');
attempts = replace(attempts, ' g:=private.competency_staff_grant(target);\n if request_key',
 ` g:=private.competency_staff_grant(target);
 perform private.competency_eligible((select app from public.applications app where app.id=g.application_id),g.definition_entry_id);
 if request_key`);
attempts = replace(attempts, ' a:=private.competency_lock_application(g.application_id);',
 ' a:=private.competency_lock_application(g.application_id);\n perform private.competency_eligible(a,g.definition_entry_id);');
attempts = replace(attempts, ' return g;\nexception when lock_not_available then',
 ' perform private.competency_eligible(a,g.definition_entry_id);\n return g;\nexception when lock_not_available then');
let withdrawal=noTransaction(text.withdrawal).replace(/-- SC-014-B2[^\n]*\n--[^\n]*\n/, '-- Controlled withdrawal and immutable markers.\n');
const writer='private.competency_write_markers(uuid,uuid[],uuid[],text,boolean,boolean)';
const markerStart=accessStart.replaceAll('erasure_purge_owner','competency_test_marker_writer').replaceAll('sc010_purge_migration_access','sc_wer_marker_migration_access');
const markerEnd=accessEnd.replaceAll('erasure_purge_owner','competency_test_marker_writer').replaceAll('sc010_purge_migration_access','sc_wer_marker_migration_access');
withdrawal=replace(withdrawal,`alter function ${writer} owner to competency_test_marker_writer;\nrevoke all on function ${writer} from public,anon,authenticated;`,
 `${markerStart}\nalter function ${writer} owner to competency_test_marker_writer;
set local role competency_test_marker_writer;
-- Only trusted postgres-owned domain functions may invoke the marker writer.
do $$declare g record;begin
 for g in select distinct a.grantee,r.rolname from pg_proc p
 cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
 left join pg_roles r on r.oid=a.grantee where p.oid='${writer}'::regprocedure and a.grantee<>p.proowner loop
 if g.grantee=0 then revoke all on function ${writer} from public;
 else execute format('revoke all on function ${writer} from %I',g.rolname);end if;
 end loop;
end;$$;
grant execute on function ${writer} to postgres;
${markerEnd}`);
withdrawal=replace(withdrawal,"('competency_marker_guard','competency_write_markers',","('competency_marker_guard',");
output.push(attempts,withdrawal);
const layer = `alter function private.erasure_inventory_rows(uuid,uuid[]) rename to erasure_inventory_rows_r11;
alter function private.erasure_row_candidates(text,jsonb) rename to erasure_row_candidates_r11;
create function private.erasure_inventory_rows(tenant uuid,subjects uuid[])
returns table(adapter text,row_key text,row_data jsonb) language sql stable security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
 select * from private.erasure_inventory_rows_r11(tenant,subjects)
 ${tables.map(table => `union all select '${table}',t.id::text,to_jsonb(t) from ${table} t
 where t.company_id=tenant and (${table.endsWith('cancellations') ? `private.erasure_row_candidates('${table}',to_jsonb(t)) && subjects` : 't.candidate_id=any(subjects)'})`).join('\n ')}
$$;
create function private.erasure_row_candidates(adapter text,data jsonb) returns uuid[]
language plpgsql stable security definer set search_path='' as $$
declare ids uuid[];
begin
 if adapter in (${tables.slice(0,6).map(t => `'${t}'`).join(',')}) then return array[(data->>'candidate_id')::uuid];end if;
 if adapter='private.competency_test_cancellations' then
  with refs as (
   select value::uuid id from jsonb_array_elements_text(data->'candidate_ids')
   union select a.candidate_id from public.applications a
    where a.company_id=(data->>'company_id')::uuid and a.id=(data->>'application_id')::uuid
  ) select array_agg(distinct id order by id) into ids from refs;
  if coalesce(cardinality(ids),0)=0 or array_position(ids,null) is not null then
   raise exception using errcode='PT409',message='Unknown competency cancellation dependency';end if;
  return ids;
 end if;
 return private.erasure_row_candidates_r11(adapter,data);
end;$$;
revoke all on function private.erasure_inventory_rows(uuid,uuid[]),private.erasure_row_candidates(text,jsonb) from public,anon,authenticated;
create table ${baseline} (
 singleton boolean primary key default true check(singleton),schema_signature text not null,known_tables text[] not null
);
alter table ${baseline} enable row level security;
create trigger immutable_history before update or delete on ${baseline} for each row execute function private.contact_immutable();
insert into ${baseline} select true,'${signature}',known_tables||array[${[...tables,baseline].map(t=>`'${t}'`).join(',')}]
 from private.erasure_inventory_baseline_r11 where singleton;`;
// Publish the row resolver before the SQL inventory function references it.
const rowStart = layer.indexOf('create function private.erasure_row_candidates(');
const inventoryStart = layer.indexOf('create function private.erasure_inventory_rows(');
const rowEnd = layer.indexOf('revoke all on function', rowStart);
output.push(layer.slice(0,inventoryStart)+layer.slice(rowStart,rowEnd)+layer.slice(inventoryStart,rowStart)+layer.slice(rowEnd));

for (const name of readers) {
 let code = fn(text.r11,name).replaceAll('private.erasure_inventory_baseline_r11',baseline);
 if (name === 'public.preview_candidate_erasure') code = replace(code, '  with rows as materialized',
 `  if exists(select 1 from private.competency_test_cancellations c where c.company_id=tenant
   and private.erasure_row_candidates('private.competency_test_cancellations',to_jsonb(c)) && subjects
   and not private.erasure_row_candidates('private.competency_test_cancellations',to_jsonb(c)) <@ subjects)
   then blockers:=array_append(blockers,'shared_competency_cancellation_requires_adapter');end if;
  with rows as materialized`);
 output.push(code);
}
output.push(fn(text.retention, 'private.erasure_competency_row_guard'));
for (const table of tables) output.push(`create trigger erasure_competency_guard before insert or update or delete on ${table}
 for each row execute function private.erasure_competency_row_guard();
grant select,delete on ${table} to erasure_purge_owner;
create policy erasure_purge_select on ${table} for select to erasure_purge_owner
 using (private.erasure_purge_visible('${table}',to_jsonb(${table.split('.')[1]})));
create policy erasure_purge_delete on ${table} for delete to erasure_purge_owner
 using (private.erasure_purge_allowed('${table}',to_jsonb(${table.split('.')[1]})));
create trigger zz_retention_observed after insert or update or delete on ${table}
 for each row execute function private.retention_observe_candidate();`);
const order=[tables[4],tables[5],tables[3],tables[1],tables[2],tables[0],tables[6]];
const deletes=order.map(table=>` select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='${table}';
 delete from ${table} t where private.erasure_purge_allowed('${table}',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('${table}',deleted_count);`).join('\n');
output.push(accessStart+'\nset local role erasure_purge_owner;\n'+replace(fn(text.engine,'private.erasure_purge_engine'),
 " update private.erasure_purge_context set mode='delete' where txid=txid_current();",
 " update private.erasure_purge_context set mode='delete' where txid=txid_current();\n" + deletes)+'\n'+accessEnd);
// Preserve the existing purge owner and grants; CREATE OR REPLACE does that.
// Remove hostile default ACLs on all newly created inventory objects.
output.push(text.retention.slice(text.retention.indexOf('-- Strip hostile default grants'), text.retention.lastIndexOf('commit;'))
 .replaceAll('private.erasure_inventory_baseline_sc014_b2_v1',baseline));
output.push(`do $postflight$
declare known text[]; actual text[];
begin
 if private.erasure_schema_signature() is distinct from '${signature}' then
  raise exception 'sc_wer_final_schema_mismatch:%',private.erasure_schema_signature() using errcode='55000';end if;
 select known_tables into known from ${baseline} where singleton;
 select array_agg(n.nspname||'.'||c.relname order by (n.nspname||'.'||c.relname) collate "C") into actual
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f');
 if actual is distinct from (select array_agg(x order by x collate "C") from unnest(known) x) then
  raise exception 'sc_wer_final_inventory_gap' using errcode='55000';end if;
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('public','private') and p.prosrc ~ 'erasure_inventory_baseline_r([4-9]|10|11)([^0-9]|$)') then
  raise exception 'sc_wer_stale_inventory_reference' using errcode='55000';end if;
 if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('public','private') and p.prosrc like '%erasure_inventory_baseline_r12%'
 and p.proname in ('preview_candidate_erasure','prepare_erasure_purge_manifest','authorize_retention_suggestion','get_retention_schedule'))<>4 then
  raise exception 'sc_wer_inventory_reference_missing' using errcode='55000';end if;
 if exists(select 1 from (values
  ('private.erasure_inventory_rows(uuid,uuid[])'::regprocedure,'private.erasure_inventory_rows_r11(uuid,uuid[])'::regprocedure),
  ('private.erasure_row_candidates(text,jsonb)'::regprocedure,'private.erasure_row_candidates_r11(text,jsonb)'::regprocedure)) v(wrapper,base)
 join pg_proc w on w.oid=v.wrapper join pg_proc b on b.oid=v.base
 where w.proowner<>b.proowner or not w.prosecdef or w.proacl::text is distinct from b.proacl::text) then
  raise exception 'sc_wer_wrapper_acl_mismatch' using errcode='55000';end if;
end $postflight$;
commit;`);
const path = 'supabase/migrations/20261106063720_sc_wer_c1_inventory_r12.sql';
const artifact = output.join('\n\n') + '\n';
if (process.argv.includes('--check')) {
 if (readFileSync(path,'utf8') !== artifact) throw new Error('Regenerate C1 migration');
} else writeFileSync(path, artifact);

const newFunctions = [...new Set(['validation','attempts','withdrawal'].flatMap(key =>
 [...text[key].matchAll(/create (?:or replace )?function ((?:public|private)\.\w+)\(/g)].map(m=>m[1])))]
 .filter(name=>name!=='public.confirm_erasure_subject');
const rollback = `-- SC-WER C1 rollback, only before any competency data/markers exist.
-- No role, execution configuration or historical R11 row is removed.
-- Refuses after C2 or any source drift; used only under reviewed Preview change control.
begin;
do $$declare target text; occupied boolean;begin
 if private.erasure_schema_signature() is distinct from '${signature}'
  or to_regclass('competency_runtime.rate_window') is not null then
  raise exception 'sc_wer_rollback_schema_unreviewed' using errcode='55000';end if;
 foreach target in array array[${tables.map(t=>`'${t}'`).join(',')}] loop
  execute format('select exists(select 1 from %s)',target) into occupied;
  if occupied then raise exception 'sc_wer_rollback_data_present:%',target using errcode='55000';end if;
 end loop;
 if exists(select 1 from public.candidates where competency_access_cancelled_at is not null)
 or exists(select 1 from public.applications where competency_access_cancelled_at is not null) then
  raise exception 'sc_wer_rollback_markers_present' using errcode='55000';end if;
end;$$;
${readers.map(name=>fn(text.r11,name)).join('\n')}
${fn(text.execution,'public.confirm_erasure_subject')}
${accessStart}
set local role erasure_purge_owner;
${fn(text.engine,'private.erasure_purge_engine')}
${accessEnd}
drop trigger competency_candidate_marker_guard on public.candidates;
drop trigger competency_application_marker_guard on public.applications;
drop trigger competency_resolution_insert_guard on private.erasure_subject_resolutions;
drop policy competency_marker_read on public.candidates;
drop policy competency_marker_write on public.candidates;
drop policy competency_marker_read on public.applications;
drop policy competency_marker_write on public.applications;
revoke select,update on public.candidates,public.applications from competency_test_marker_writer;
revoke update(competency_access_cancelled_at,competency_access_cancel_reason) on public.candidates from competency_test_marker_writer;
revoke update(status,competency_access_cancelled_at,competency_access_cancel_reason) on public.applications from competency_test_marker_writer;
${markerStart}
set local role competency_test_marker_writer;
drop function ${writer};
${markerEnd}
-- Signatures are materialized BEFORE any drop: a lazy regprocedure cast prints a bare OID once an earlier
-- \`drop ... cascade\` in the same loop has removed a dependent function (syntax error at "19476").
do $$declare sigs text[];s text;begin
 select array_agg(p.oid::regprocedure::text) into sigs from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname||'.'||p.proname=any(array[${[...newFunctions,'private.erasure_competency_row_guard'].map(t=>`'${t}'`).join(',')}]);
 foreach s in array coalesce(sigs,'{}'::text[]) loop
  execute format('drop function if exists %s cascade',s);
 end loop;
end;$$;
${order.map(table=>`drop table ${table} cascade;`).join('\n')}
alter table public.candidates drop column competency_access_cancelled_at,drop column competency_access_cancel_reason;
alter table public.applications drop column competency_access_cancelled_at,drop column competency_access_cancel_reason,
 drop constraint competency_application_pair,drop constraint competency_application_binding;
drop function private.erasure_inventory_rows(uuid,uuid[]);
drop function private.erasure_row_candidates(text,jsonb);
alter function private.erasure_inventory_rows_r11(uuid,uuid[]) rename to erasure_inventory_rows;
alter function private.erasure_row_candidates_r11(text,jsonb) rename to erasure_row_candidates;
drop table ${baseline};
revoke execute on function private.erasure_normal_row_guard(text,text,text,jsonb,jsonb) from competency_test_marker_writer;
revoke usage on schema private from competency_test_gateway,competency_test_marker_writer;
revoke usage on schema public from competency_test_marker_writer;
do $$begin
 if private.erasure_schema_signature() is distinct from '${sourceSignature}' then
  raise exception 'sc_wer_rollback_signature_mismatch' using errcode='55000';end if;
end;$$;
commit;
`;
const rollbackPath='supabase/rollbacks/20261106063720_sc_wer_c1_inventory_r12_down.sql';
if(process.argv.includes('--check')) {
 if(readFileSync(rollbackPath,'utf8')!==rollback) throw new Error('Regenerate C1 rollback');
} else writeFileSync(rollbackPath,rollback);
