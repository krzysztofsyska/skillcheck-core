// Compose R6-1c (part 2): the SC-010-C interview permission receipts, the SC-019
// voice interview pool (no package, price, order or catalog) and the SC-010-C
// offline preparation tables as a real migration on top of the reviewed R18
// inventory and purge engine (20261119100000_r6_voice_plan_r18.sql).
// Offline only: no deployed catalog, no inferred signature, no activation flag.
//
// Sources are the reviewed isolated files (db/isolated/sc010c-interview-permission.sql,
// db/isolated/sc019-voice-entitlements.sql, db/isolated/sc010c-voice-preparation.sql)
// and the R4 voice erasure adapters (db/isolated/sc010-r4-voice-retention.sql),
// pinned by hash. Function bodies are copied byte for byte, except:
//  - the history/preparation/request guards take the R4 voice purge-aware form
//    (they admit only the manifest-checked purge, exactly as the R4 voice adapter);
//  - the voice pool drops the package dimension (FREE/PRESELEKCJA, the FREE-once
//    index, the trial/settlement flags) in favour of one operator-recorded
//    `grant_verified` evidence flag: packages and prices stay out of this step
//    (payment-path freeze);
//  - the redundant unique index on public.applications is not created (the chain
//    already has two identical unique indexes on those four columns).
//
// Usage: node scripts/r6-voice-permission-pool-compose.mjs          (write the migration)
//        node scripts/r6-voice-permission-pool-compose.mjs --check  (fail when out of date)
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
const pinned = (path, hash) => {
 const text = readFileSync(path,'utf8');
 if(sha(text)!==hash)throw Error('Review updated source before composing the voice permission/pool migration: '+path);
 return text;
};
const r18 = pinned('supabase/migrations/20261119100000_r6_voice_plan_r18.sql','551a7d84556b76801a04d04321a6779aa1d01ead2bb616683171f21b778a6dcf');
const permissionSource = pinned('db/isolated/sc010c-interview-permission.sql','ca98b51650f4fa118242637436d27877c0564d7a14b61610b8b81fe39a228f71');
const poolSource = pinned('db/isolated/sc019-voice-entitlements.sql','2318eaa52ff9bfe208f643e9085aa12795ba22815017fd34729a00f1d28794b9');
const preparationSource = pinned('db/isolated/sc010c-voice-preparation.sql','f39ab00d38e8617e7948a7e9157a36e96a953b87991f16f17b751c1ae3d80658');
const voiceRetention = pinned('db/isolated/sc010-r4-voice-retention.sql','c5dbf138405ed737332a70400f6017d983cd111f9be49180c1309b2d75ae0d5f');
const sourceSignature = 'd77384591cfa80a1a2f16d641b7af5e653a21ce49ccc1b7f2db2bbc2539aaebb';
const signature = 'c2a45d8684f605083170a4e1b15e5438228729099836b687bdbb362280c3db39';

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
// Isolated files are self-contained transactions; the migration owns the transaction.
const unwrapped = text => {
 let out = withoutHeader(text);
 out = once(out,'begin;\n','');
 if(!out.trimEnd().endsWith('commit;'))throw Error('Isolated source must end with commit');
 return out.trimEnd().slice(0,-'commit;'.length).trim();
};
// The R4 voice purge-aware guard replaces an isolated guard of the same name.
const purgeAware = name => {
 const text = fn(voiceRetention,name);
 if(!text.includes("current_user='erasure_purge_owner'"))throw Error('R4 voice guard changed: '+name);
 return text.replace('create or replace function','create function');
};

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
  raise exception 'voice_pool_source_function_unreviewed:${name}' using errcode='55000';end if;`;
};
const inventoryCheck = (baseline,label) => `select known_tables into known from private.${baseline} where singleton;
 select array_agg(n.nspname||'.'||c.relname order by (n.nspname||'.'||c.relname) collate "C") into actual
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f');
 if actual is distinct from (select array_agg(x order by x collate "C") from unnest(known) x) then
  raise exception '${label}' using errcode='55000';end if;`;

// Candidate-linked tables (purged with the candidate) and tenant-level
// configuration/quota tables (inventoried as known, never purged).
const candidateTables = ['private.voice_interview_permission_receipts','private.voice_interview_permission_revocations',
 'private.sc010c_voice_preparations','private.sc010c_voice_preparation_requests'];
const sharedTables = ['private.voice_interview_permission_policies','private.voice_interview_permission_issuers',
 'private.sc19_voice_entitlements'];
const newTables = [...candidateTables,...sharedTables];
const definers = ['private.voice_interview_permission_lock_revocation()','private.voice_interview_permission_status(uuid,uuid,uuid)',
 'private.ingest_voice_interview_permission_receipt(jsonb)','private.sc010c_lock_voice_contact(uuid,uuid,uuid,uuid)',
 'private.sc010c_preparation_current_guard()','private.erasure_voice_refund_deleted()','private.erasure_voice_lock_entitlements(uuid)',
 'private.erasure_row_candidates(text,jsonb)','private.erasure_inventory_rows(uuid,uuid[])'];
const newFunctions = ['private.voice_interview_permission_protect_history()','private.voice_interview_permission_protect_registry()',
 'private.sc19_voice_entitlement_eligible(private.sc19_voice_entitlements)','private.sc19_voice_entitlement_guard()',
 'private.sc010c_preparation_guard()','private.sc010c_request_guard()',...definers];
// Reviewed bodies that must stay byte-identical to the isolated sources.
const verbatim = [[permissionSource,'private.voice_interview_permission_protect_registry'],
 [permissionSource,'private.voice_interview_permission_lock_revocation'],[permissionSource,'private.voice_interview_permission_status'],
 [permissionSource,'private.ingest_voice_interview_permission_receipt'],[preparationSource,'private.sc010c_lock_voice_contact'],
 [preparationSource,'private.sc010c_preparation_current_guard'],[voiceRetention,'private.voice_interview_permission_protect_history'],
 [voiceRetention,'private.sc010c_preparation_guard'],[voiceRetention,'private.sc010c_request_guard'],
 [voiceRetention,'private.erasure_voice_refund_deleted'],[voiceRetention,'private.erasure_voice_lock_entitlements']];

// --- domain 1: SC-010-C interview permission (isolated source, purge-aware history guard) ---
let permission = unwrapped(permissionSource);
permission = once(permission,fn(permissionSource,'private.voice_interview_permission_protect_history'),
 purgeAware('private.voice_interview_permission_protect_history'));
permission = once(permission,`-- Monotonic receipt withdrawal, separate from a deny for the entire voice channel.
-- No direct grant or public API is introduced. This administrative-only fixture
-- record demonstrates revocation independently of notice or invitation consent.`,
`-- Monotonic receipt withdrawal, separate from a deny for the entire voice channel.
-- No direct grant or public API is introduced; only trusted server code inserts
-- a revocation, independently of notice or invitation consent.`);
permission = once(permission,`-- Immutable reviewed versions. Disabled is the default; synthetic administrative
-- fixtures explicitly insert approved versions.`,`-- Immutable reviewed versions. Disabled is the default and no version is seeded;
-- only a separately reviewed administrative step may insert an approved version.`);

// --- domain 2: SC-019 voice interview pool, without the package dimension ---
let pool = unwrapped(poolSource);
pool = once(pool,`  package text not null check (package in ('FREE', 'PRESELEKCJA')),\n`,'');
pool = once(pool,`  -- The opaque UUID refers to operator approval for FREE, or to independently
  -- verified external settlement for PRESELEKCJA. It is never a client request
  -- key, payment redirect, NIP, contact detail or new reference on each retry.`,
`  -- The opaque UUID refers to an independently verified operator grant record.
  -- It is never a client request key, payment redirect, NIP, contact detail,
  -- price, package or new reference on each retry.`);
pool = once(pool,`  free_trial_approved boolean not null default false,
  paid_settlement_verified boolean not null default false,\n`,`  grant_verified boolean not null default false,\n`);
pool = once(pool,`  check (package <> 'FREE' or total = 1),\n`,'');
pool = once(pool,`  check (package = 'FREE' or not free_trial_approved),
  check (package = 'PRESELEKCJA' or not paid_settlement_verified),\n`,'');
pool = once(pool,`-- The history row survives expiry, revocation, consumption and cancellation.
-- A new request/reference can never restart FREE for this company.
create unique index sc19_voice_free_once_per_company
  on private.sc19_voice_entitlements(company_id) where package = 'FREE';
create index sc19_voice_entitlements_company_idx
  on private.sc19_voice_entitlements(company_id, package, valid_from, id);`,
`-- The history row survives expiry, revocation, consumption and cancellation.
create index sc19_voice_entitlements_company_idx
  on private.sc19_voice_entitlements(company_id, valid_from, id);`);
pool = once(pool,`    and entitlement.company_verification_expires_at > clock_timestamp()
    and (
      (entitlement.package = 'FREE' and entitlement.total = 1
        and entitlement.free_trial_approved)
      or (entitlement.package = 'PRESELEKCJA' and entitlement.paid_settlement_verified)
    ),`,`    and entitlement.company_verification_expires_at > clock_timestamp()
    and entitlement.grant_verified,`);
pool = once(pool,`  -- A paid top-up is a new immutable grant with a different settlement reference.`,
`  -- A top-up is a new immutable grant with a different grant reference.`);
pool = once(pool,`  if row(new.id, new.company_id, new.resource, new.package, new.total,`,`  if row(new.id, new.company_id, new.resource, new.total,`);
pool = once(pool,`    row(old.id, old.company_id, old.resource, old.package, old.total,`,`    row(old.id, old.company_id, old.resource, old.total,`);
pool = once(pool,`        new.free_trial_approved, new.paid_settlement_verified)`,`        new.grant_verified)`);
pool = once(pool,`        old.free_trial_approved, old.paid_settlement_verified)`,`        old.grant_verified)`);
if(/package|FREE|PRESELEKCJA|price|settlement_verified|free_trial/i.test(pool.replace(/--[^\n]*/g,'')))
 throw Error('Package, price or settlement remains in the voice pool');

// --- domain 3: SC-010-C offline preparation (purge-aware guards, no duplicate index) ---
let preparation = unwrapped(preparationSource);
preparation = once(preparation,`create unique index sc010c_application_subject_uq
 on public.applications(company_id,recruitment_id,candidate_id,id);\n`,'');
preparation = once(preparation,fn(preparationSource,'private.sc010c_preparation_guard'),purgeAware('private.sc010c_preparation_guard'));
preparation = once(preparation,fn(preparationSource,'private.sc010c_request_guard'),purgeAware('private.sc010c_request_guard'));
for(const part of [permission,pool,preparation]) if(/\bdrop\b/i.test(part.replace(/--[^\n]*/g,'')))throw Error('Unexpected drop in voice domain');

// --- SC-010 R19 adapters for the four candidate-linked tables ---
const purgeKey = once(fn(r18,'private.erasure_purge_key'),
 ` when adapter='private.voice_plan_current_releases' then data->>'company_id'||':'||(data->>'application_id')
`,` when adapter='private.voice_plan_current_releases' then data->>'company_id'||':'||(data->>'application_id')
 when adapter='private.sc010c_voice_preparation_requests' then data->>'company_id'||':'||(data->>'actor_id')||':'||(data->>'request_key')
 when adapter='private.voice_interview_permission_revocations' then data->>'company_id'||':'||(data->>'receipt_id')
`);
// Candidate references of a receipt or preparation, copied from the R4 voice adapter.
const r4Candidates = fn(voiceRetention,'private.erasure_row_candidates');
const refsStart = r4Candidates.indexOf('  with refs as (');
const refsEnd = r4Candidates.indexOf('  return ids;\n end if;',refsStart);
if(refsStart<0||refsEnd<0)throw Error('R4 voice candidate references changed');
const refs = r4Candidates.slice(refsStart,refsEnd);
const inventoryLine = t => {
 const line = voiceRetention.split('\n').find(l=>l.startsWith(` union all select '${t}',`));
 if(!line)throw Error('Missing R4 voice inventory line '+t);
 return line;
};
const wiring = `
-- Row keys of the two new tables without an id column; every other adapter keeps
-- its key (this function was last defined by 20261119100000, R18).
${purgeKey}

alter function private.erasure_inventory_rows(uuid,uuid[]) rename to erasure_inventory_rows_r18;
alter function private.erasure_row_candidates(text,jsonb) rename to erasure_row_candidates_r18;
create function private.erasure_row_candidates(adapter text,data jsonb) returns uuid[]
language plpgsql stable security definer set search_path='' as $$
declare subject uuid;ids uuid[];
begin
 if adapter='private.sc010c_voice_preparation_requests' then
  select candidate_id into subject from private.sc010c_voice_preparations
   where company_id=(data->>'company_id')::uuid and id=(data->>'operation_id')::uuid;
  if subject is null then raise exception using errcode='PT409',message='Unknown voice preparation dependency';end if;
  return array[subject];
 end if;
 if adapter='private.voice_interview_permission_revocations' then
  select candidate_id into subject from private.voice_interview_permission_receipts
   where company_id=(data->>'company_id')::uuid and id=(data->>'receipt_id')::uuid;
  if subject is null then raise exception using errcode='PT409',message='Unknown voice permission dependency';end if;
  return array[subject];
 end if;
 if adapter in ('private.voice_interview_permission_receipts','private.sc010c_voice_preparations') then
  -- Every candidate referenced by the row (directly, through its application,
  -- plan/release, permission or contact evidence) is a subject of the row.
${refs}  return ids;
 end if;
 return private.erasure_row_candidates_r18(adapter,data);
end;$$;
create function private.erasure_inventory_rows(tenant uuid,subjects uuid[])
returns table(adapter text,row_key text,row_data jsonb) language sql stable security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
 select * from private.erasure_inventory_rows_r18(tenant,subjects)
${candidateTables.map(inventoryLine).join('\n')}
$$;
create table private.erasure_inventory_baseline_r19 (
 singleton boolean primary key default true check(singleton),schema_signature text not null,known_tables text[] not null
);
alter table private.erasure_inventory_baseline_r19 enable row level security;
create trigger immutable_history before update or delete on private.erasure_inventory_baseline_r19
 for each row execute function private.contact_immutable();
insert into private.erasure_inventory_baseline_r19 select true,'${signature}',
 known_tables||array[${newTables.map(t=>`'${t}'`).join(',')},'private.erasure_inventory_baseline_r19']
 from private.erasure_inventory_baseline_r18 where singleton;

-- Normal writes take the candidate lock and refuse frozen candidates (R18 voice
-- guard). A revocation stays possible during a freeze: it only removes authority
-- and its own trigger serializes it on the candidate row (R4 voice adapter).
${candidateTables.map(t=>{const n=t.split('.')[1];return `${t==='private.voice_interview_permission_revocations'?'':`create trigger erasure_voice_guard before insert or update or delete on ${t}
 for each row execute function private.erasure_voice_row_guard();
`}create trigger zz_retention_observed after insert or update or delete on ${t}
 for each row execute function private.retention_observe_candidate();
create policy erasure_purge_select on ${t} for select to erasure_purge_owner using (private.erasure_purge_visible('${t}',to_jsonb(${n})));
create policy erasure_purge_delete on ${t} for delete to erasure_purge_owner using (private.erasure_purge_allowed('${t}',to_jsonb(${n})));`;}).join('\n')}

-- A purged prepared_offline operation returns its held pool unit exactly once;
-- quotas are locked in a deterministic order and reconciled first (R4 voice).
${fn(voiceRetention,'private.erasure_voice_refund_deleted')}
create trigger erasure_voice_refund after delete on private.sc010c_voice_preparations
 for each row execute function private.erasure_voice_refund_deleted();
${fn(voiceRetention,'private.erasure_voice_lock_entitlements')}
`;

const output = [`-- R6-1c (part 2): voice interview permission receipts (SC-010-C), the voice
-- interview pool (SC-019, no package/price/order/catalog) and offline voice
-- preparations (SC-010-C) as a real migration.
-- Generated offline by scripts/r6-voice-permission-pool-compose.mjs from the
-- reviewed isolated sources and the R18 erasure inventory; erasure inventory R19
-- adds the four candidate-linked tables (R4 voice adapter, reduced to these
-- tables) and refunds a held pool unit when its preparation is purged.
--
-- Nothing is used by the application yet and nothing is customer-visible: no
-- table or function is granted to anon, authenticated or service_role, no issuer,
-- policy or pool grant is seeded, no provider is called and no package, price or
-- order state is touched. Receipt ingestion is executable only by the nologin
-- role voice_permission_verifier (no members); everything else only by its owner.
begin;
do $preflight$
declare known text[];actual text[];
begin
 if to_regclass('private.erasure_inventory_baseline_r18') is null then raise exception 'voice_pool_requires_r18' using errcode='55000';end if;
 if to_regclass('private.erasure_inventory_baseline_r19') is not null${newTables.map(t=>`
  or to_regclass('${t}') is not null`).join('')} then
  raise exception 'voice_pool_already_installed' using errcode='55000';end if;
 if not exists(select 1 from private.erasure_inventory_baseline_r18 where singleton and schema_signature='${sourceSignature}')
  or private.erasure_schema_signature() is distinct from '${sourceSignature}' then
  raise exception 'voice_pool_source_schema_unreviewed:%',private.erasure_schema_signature() using errcode='55000';end if;
 ${inventoryCheck('erasure_inventory_baseline_r18','voice_pool_source_inventory_gap')}
 ${adapters.map(item=>pinnedFunction(r18,item,true)).join('\n ')}
 ${readers.map(item=>pinnedFunction(r18,item,true)).join('\n ')}
 ${pinnedFunction(r18,['private.erasure_purge_key','text,jsonb'],false)}
 ${pinnedFunction(r18,['private.erasure_voice_row_guard',''],false)}
 if to_regprocedure('private.erasure_inventory_rows_r18(uuid,uuid[])') is not null
  or to_regprocedure('private.erasure_row_candidates_r18(text,jsonb)') is not null then
  raise exception 'voice_pool_adapter_name_taken' using errcode='55000';end if;
 if to_regprocedure('private.erasure_lock_candidate(uuid)') is null or to_regprocedure('private.erasure_candidate_frozen(uuid)') is null
  or to_regprocedure('private.contact_lock_candidate(uuid)') is null or to_regprocedure('private.contact_receipt_status(uuid,uuid)') is null
  or not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname='contact_receipt_permission_reason')
  or to_regclass('private.candidate_verified_contact_receipts') is null or to_regclass('private.candidate_verified_contact_points') is null
  or to_regclass('private.contact_trusted_issuers') is null or to_regclass('private.contact_policy_templates') is null
  or to_regclass('public.candidate_contact_preferences') is null or to_regclass('private.erasure_execution_config') is null
  or to_regprocedure('private.retention_observe_candidate()') is null or to_regprocedure('private.contact_immutable()') is null
  or to_regrole('erasure_purge_owner') is null then
  raise exception 'voice_pool_dependency_missing' using errcode='55000';end if;
 -- The preparation's composite foreign key needs an existing unique index on these
 -- four application columns; the isolated duplicate index is not created.
 if not exists(select 1 from pg_index i where i.indrelid='public.applications'::regclass and i.indisunique and i.indpred is null
  and (select array_agg(a.attname::text order by k.ord) from unnest(i.indkey) with ordinality k(attnum,ord)
   join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum)=array['company_id','recruitment_id','candidate_id','id']) then
  raise exception 'voice_pool_application_key_missing' using errcode='55000';end if;
end $preflight$;`,
`-- SC-010-C interview permission (source: db/isolated/sc010c-interview-permission.sql).`,permission,
`-- SC-019 voice interview pool (source: db/isolated/sc019-voice-entitlements.sql, without packages).`,pool,
`-- SC-010-C offline preparation (source: db/isolated/sc010c-voice-preparation.sql).`,preparation,
wiring.trim()];
for(const [name] of readers){
 const source=fn(r18,name);
 if(!source.includes('erasure_inventory_baseline_r18'))throw Error('Reader has no baseline reference: '+name);
 output.push(source.replaceAll('erasure_inventory_baseline_r18','erasure_inventory_baseline_r19'));
}
// Reuse the exact hosted creator protocol reviewed in R16-R18, restoring memberships/ACLs.
const accessStart=r18.slice(r18.indexOf('-- PG16+ non-superuser creators'),r18.indexOf('set local role erasure_purge_owner;'));
if(!accessStart.includes('sc010_purge_migration_access'))throw Error('Missing purge owner protocol');
const engineStart=r18.indexOf('create or replace function private.erasure_purge_engine');
const restoreEnd=r18.slice(r18.indexOf('reset role;',engineStart),r18.indexOf('-- Remove hostile default ACLs',engineStart));
if(!restoreEnd.includes('Purge migration privileges not restored'))throw Error('Missing purge owner restore');
const anchor=" update private.erasure_purge_context set mode='delete' where txid=txid_current();";
let engine=fn(r18,'private.erasure_purge_engine');
if(engine.split(anchor).length!==2)throw Error('Missing validated purge boundary');
// Preparations reference plan releases, permission receipts and contact evidence,
// so they go first (requests, then operations with their refund), then
// revocations and receipts; R18 voice plan rows and the older chain follow.
const countedDelete = t => `
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='${t}';
 delete from ${t} t where private.erasure_purge_allowed('${t}',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('${t}',deleted_count);`;
engine=engine.replace(anchor,anchor+`
 -- Lock shared voice pool quotas in a deterministic order before per-row refunds.
 perform private.erasure_voice_lock_entitlements(e.company_id);`+['private.sc010c_voice_preparation_requests','private.sc010c_voice_preparations',
 'private.voice_interview_permission_revocations','private.voice_interview_permission_receipts'].map(countedDelete).join(''));
output.push(accessStart+'\nset local role erasure_purge_owner;\n'+engine+'\n'+restoreEnd);
output.push(`-- Remove hostile default ACLs on every new table and function, then grant only
-- the existing manifest-checked purge role and the nologin receipt verifier.
-- No API role receives anything.
do $acl$
declare o record;g record;
begin
 for o in select oid,relowner from pg_class where oid in (${[...newTables,'private.erasure_inventory_baseline_r19'].map(t=>`'${t}'::regclass`).join(',')}) loop
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
grant select,delete on ${candidateTables.join(',')} to erasure_purge_owner;
grant execute on function private.erasure_voice_lock_entitlements(uuid) to erasure_purge_owner;
grant execute on function private.ingest_voice_interview_permission_receipt(jsonb) to voice_permission_verifier;
do $postflight$
declare known text[];actual text[];
begin
 if private.erasure_schema_signature() is distinct from '${signature}' then
  raise exception 'voice_pool_final_schema_mismatch:%',private.erasure_schema_signature() using errcode='55000';end if;
 ${inventoryCheck('erasure_inventory_baseline_r19','voice_pool_final_inventory_gap')}
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('public','private') and p.prosrc ~ 'erasure_inventory_baseline_r([4-9]|1[0-8])([^0-9]|$)') then
  raise exception 'voice_pool_stale_inventory_reference' using errcode='55000';end if;
 if (select count(*) from pg_proc p where p.prosrc like '%erasure_inventory_baseline_r19%'
  and p.proname in ('preview_candidate_erasure','prepare_erasure_purge_manifest','authorize_retention_suggestion','get_retention_schedule'))<>4 then
  raise exception 'voice_pool_inventory_reference_missing' using errcode='55000';end if;
 if exists(select 1 from (values
  ('private.erasure_inventory_rows(uuid,uuid[])'::regprocedure,'private.erasure_inventory_rows_r18(uuid,uuid[])'::regprocedure),
  ('private.erasure_row_candidates(text,jsonb)'::regprocedure,'private.erasure_row_candidates_r18(text,jsonb)'::regprocedure)) v(wrapper,base)
 join pg_proc w on w.oid=v.wrapper join pg_proc b on b.oid=v.base
 where w.proowner<>b.proowner or not w.prosecdef or w.proacl::text is distinct from b.proacl::text) then
  raise exception 'voice_pool_wrapper_acl_mismatch' using errcode='55000';end if;
 -- Deny by default: no API role holds any privilege on a new table or function.
 if exists(select 1 from pg_class c cross join (select rolname from pg_roles where rolname in ('anon','authenticated','service_role')) r
  where c.oid in (${newTables.map(t=>`'${t}'::regclass`).join(',')})
  and (not c.relrowsecurity or not c.relforcerowsecurity or has_table_privilege(r.rolname,c.oid,'select,insert,update,delete,truncate,references,trigger'))) then
  raise exception 'voice_pool_table_exposed' using errcode='55000';end if;
 if exists(select 1 from pg_proc p cross join (select rolname from pg_roles where rolname in ('anon','authenticated','service_role')) r
  where p.oid=any(array[${newFunctions.map(f=>`'${f}'`).join(',')}]::regprocedure[])
  and has_function_privilege(r.rolname,p.oid,'execute')) then
  raise exception 'voice_pool_function_exposed' using errcode='55000';end if;
 -- The receipt verifier is an isolated nologin role: one entry point, no table access.
 if exists(select 1 from pg_roles where rolname='voice_permission_verifier'
  and (rolcanlogin or rolinherit or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls))
  or exists(select 1 from pg_auth_members m where m.roleid='voice_permission_verifier'::regrole and m.member<>(select oid from pg_roles where rolname=current_user))
  or exists(select 1 from pg_auth_members m where m.member='voice_permission_verifier'::regrole)
  or exists(select 1 from pg_class c where c.oid in (${[...newTables,'private.erasure_inventory_baseline_r19'].map(t=>`'${t}'::regclass`).join(',')})
   and has_table_privilege('voice_permission_verifier',c.oid,'select,insert,update,delete,truncate,references,trigger'))
  or exists(select 1 from pg_proc p where p.oid=any(array[${newFunctions.filter(f=>!f.startsWith('private.ingest_')).map(f=>`'${f}'`).join(',')}]::regprocedure[])
   and has_function_privilege('voice_permission_verifier',p.oid,'execute'))
  or not has_function_privilege('voice_permission_verifier','private.ingest_voice_interview_permission_receipt(jsonb)','execute') then
  raise exception 'voice_pool_verifier_not_isolated' using errcode='55000';end if;
 if exists(select 1 from pg_proc where oid=any(array[${definers.map(f=>`'${f}'`).join(',')}]::regprocedure[]) and not prosecdef)
  or exists(select 1 from pg_proc where oid=any(array[${newFunctions.map(f=>`'${f}'`).join(',')}]::regprocedure[])
   and (proconfig is null or proconfig[1] is distinct from 'search_path=""')) then
  raise exception 'voice_pool_definer_search_path' using errcode='55000';end if;
 if exists(select 1 from pg_attribute where attrelid='private.sc19_voice_entitlements'::regclass and attnum>0 and not attisdropped
  and attname in ('package','price','amount','currency','order_id','free_trial_approved','paid_settlement_verified')) then
  raise exception 'voice_pool_commerce_column' using errcode='55000';end if;
end $postflight$;
commit;`);
const artifact=output.join('\n\n')+'\n';
for(const [source,name] of verbatim){
 if(!artifact.includes(fn(source,name).split('$$')[1]))throw Error('Reviewed body changed while composing: '+name);
}
const path='supabase/migrations/20261119120000_r6_voice_permission_pool_r19.sql';
if(process.argv.includes('--check')){if(readFileSync(path,'utf8')!==artifact)throw Error('Regenerate the R6 voice permission/pool migration');}
else writeFileSync(path,artifact);
