// Compose R6-1c (part 5): the SC-011-B4 voice settlement as a real migration on top
// of the reviewed R20 dispatch ledger (20261119180000_r6_voice_dispatch_r20.sql),
// the R19 voice pool (20261119120000_r6_voice_permission_pool_r19.sql) and the
// R6-2 operator grant (20261119150000_r6_voice_pool_operator_grant.sql).
// Offline only: no provider transport, no webhook route, no activation flag.
//
// Source is the reviewed isolated file db/isolated/sc011b4-voice-settlement.sql,
// pinned by hash. Its two function bodies are copied byte for byte, except:
//  - the settlement also writes one row to a settlement ledger
//    (private.sc011b_voice_settlements, primary key = the preparation): a call is
//    settled against the voice pool at most once, and the R19 erasure refund knows
//    that a settled preparation no longer holds a reserved unit;
//  - the TODO about the contact preference source is resolved without changing
//    public.candidate_contact_preferences.source (the app reads it as the literal
//    'operator_recorded'): the provenance stays in the immutable call attempt
//    (dnc_requested), and a new guard keeps all three channels blocked for as long
//    as such an attempt exists, so a later preference edit cannot lift the
//    candidate's own request.
// The R19 erasure refund and quota reconciliation skip settled preparations.
// Not included (separate later parts): SC-011-B6 operator resolution of unknown
// dispatches, SC-011-B3 transcripts, SC-010 R4 retention.
//
// Usage: node scripts/r6-voice-settlement-compose.mjs          (write the migration)
//        node scripts/r6-voice-settlement-compose.mjs --check  (fail when out of date)
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
const pinned = (path, hash) => {
 const text = readFileSync(path,'utf8');
 if(sha(text)!==hash)throw Error('Review updated source before composing the voice settlement migration: '+path);
 return text;
};
const r18 = pinned('supabase/migrations/20261119100000_r6_voice_plan_r18.sql','551a7d84556b76801a04d04321a6779aa1d01ead2bb616683171f21b778a6dcf');
const r19 = pinned('supabase/migrations/20261119120000_r6_voice_permission_pool_r19.sql','425afb3e7d988c69072acf99280258d460714eccd38e9a8d1e18810812e8dc34');
pinned('supabase/migrations/20261119150000_r6_voice_pool_operator_grant.sql','3016d80dcfd0151564b10cbd02f3c9ae33b22997f2d69149524fd0ed1073bc00');
const r20 = pinned('supabase/migrations/20261119180000_r6_voice_dispatch_r20.sql','172abd9dd3e814ddfa831908753afa2cba626054ce7fd5008331f9a11c528236');
const settlementSource = pinned('db/isolated/sc011b4-voice-settlement.sql','1d36488c07a780d7234f880a7d626ddb2615429b48086e4ba97e81a722942b30');
const sourceSignature = '1a657cdd163107054029c177c44c66e44a05ad5615a374fb85466c30bc95b806';
const signature = '680f3eaa808e7280b545ad9aaabaa0d4144aafdf8c26f40d174d7670d4da7189';

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
if(!fn(r19,'private.sc010c_preparation_guard').includes(purgeLine))throw Error('R19 purge-aware guard form changed');

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
  raise exception 'voice_settlement_source_function_unreviewed:${name}' using errcode='55000';end if;`;
};
const inventoryCheck = (baseline,label) => `select known_tables into known from private.${baseline} where singleton;
 select array_agg(n.nspname||'.'||c.relname order by (n.nspname||'.'||c.relname) collate "C") into actual
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f');
 if actual is distinct from (select array_agg(x order by x collate "C") from unnest(known) x) then
  raise exception '${label}' using errcode='55000';end if;`;

const ledgerTable = 'private.sc011b_voice_settlements';
const settledFilter = alias => `${alias}.state='prepared_offline' and not exists(select 1 from ${ledgerTable} s
   where s.company_id=${alias}.company_id and s.preparation_id=${alias}.id)`;
const definers = ['private.sc011b_block_candidate_contact(uuid,uuid)','private.sc011b_attempt_settlement()',
 'private.sc011b_keep_candidate_block()','private.erasure_row_candidates(text,jsonb)','private.erasure_inventory_rows(uuid,uuid[])'];
const newFunctions = ['private.sc011b_settlement_guard()',...definers];
const verbatim = [[settlementSource,'private.sc011b_block_candidate_contact']];

// --- SC-011-B4 settlement (block body verbatim; settlement also writes the ledger) ---
let settlement = unwrapped(settlementSource);
settlement = once(settlement,`-- TODO(migration): add source 'candidate_requested'; the column only admits
-- 'operator_recorded' today. The attempt row keeps the provenance meanwhile.
`,`-- The preference source stays 'operator_recorded' (the only value the column and
-- the application admit). The provenance is the immutable call attempt with
-- dnc_requested, and private.sc011b_keep_candidate_block keeps the block in place.
`);
settlement = once(settlement,`  if not found then
   raise exception using errcode='PT409',message='VOICE_SETTLEMENT_UNAVAILABLE';
  end if;
`,`  if not found then
   raise exception using errcode='PT409',message='VOICE_SETTLEMENT_UNAVAILABLE';
  end if;
  -- One settlement per prepared call (primary key): the pool is never settled twice.
  insert into ${ledgerTable}(company_id,preparation_id,entitlement_id,consumed)
   values(new.company_id,new.preparation_id,entitlement,new.status='completed');
`);
const ledger = `-- Settlement ledger: one row per prepared call settled against the voice pool
-- (consumed = the call took place and used one interview; otherwise the
-- reservation was released). It is candidate-linked through the preparation and
-- purged with the candidate after the preparation (no foreign key to it), so the
-- R19 erasure refund can see that a settled preparation holds no reserved unit.
create table ${ledgerTable} (
 company_id uuid not null,
 preparation_id uuid not null,
 entitlement_id uuid not null,
 consumed boolean not null,
 settled_at timestamptz not null default clock_timestamp(),
 primary key(company_id,preparation_id),
 foreign key(company_id,entitlement_id)
  references private.sc19_voice_entitlements(company_id,id) on delete restrict
);
alter table ${ledgerTable} enable row level security;
alter table ${ledgerTable} force row level security;

create function private.sc011b_settlement_guard() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
${purgeLine} if tg_op<>'INSERT' then
  raise exception using errcode='42501',message='VOICE_SETTLEMENT_IMMUTABLE';
 end if;
 -- Only the settlement of this preparation's finished call writes a row.
 if not exists(select 1 from private.sc011b_voice_attempts a
   join private.sc010c_voice_preparations p on p.company_id=a.company_id and p.id=a.preparation_id
   where a.company_id=new.company_id and a.preparation_id=new.preparation_id
    and a.status in ('completed','failed','cancelled') and p.entitlement_id=new.entitlement_id
    and new.consumed=(a.status='completed')) then
  raise exception using errcode='42501',message='VOICE_SETTLEMENT_INVALID';
 end if;
 new.settled_at:=clock_timestamp();
 return new;
end;$$;
create trigger sc011b_settlement_guard before insert or update or delete
 on ${ledgerTable} for each row execute function private.sc011b_settlement_guard();
create trigger sc011b_settlement_no_truncate before truncate
 on ${ledgerTable} for each statement execute function private.sc011b_settlement_guard();`;
const keepBlock = `-- A candidate who asked in a call not to be called again stays blocked on every
-- channel: a later preference edit may change windows or time zone, never lift it.
create function private.sc011b_keep_candidate_block() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if not (new.blocked_channels @> array['email','sms','voice']::text[])
  and exists(select 1 from private.sc011b_voice_attempts a
   where a.company_id=old.company_id and a.candidate_id=old.candidate_id and a.dnc_requested) then
  raise exception using errcode='PT409',message='CANDIDATE_REQUESTED_NO_CONTACT';
 end if;
 return new;
end;$$;
create trigger sc011b_keep_candidate_block before update on public.candidate_contact_preferences
 for each row execute function private.sc011b_keep_candidate_block();`;
for(const part of [settlement,ledger,keepBlock]){
 const code = part.replace(/--[^\n]*/g,'');
 if(/\bdrop\b/i.test(code))throw Error('Unexpected drop in voice settlement domain');
 if(/package|PRESELEKCJA|price|pricing|order_id|\bgrant\b/i.test(code))throw Error('Package, price or grant in voice settlement domain');
}

// --- R19 accounting: a settled preparation no longer holds a reserved unit ---
let refund = once(fn(r19,'private.erasure_voice_refund_deleted'),'create function','create or replace function');
refund = once(refund,` if old.state='prepared_offline' then`,` if ${settledFilter('old')} then`);
let lock = once(fn(r19,'private.erasure_voice_lock_entitlements'),'create function','create or replace function');
if(lock.split(`p.state='prepared_offline'`).length!==4)throw Error('R19 quota reconciliation changed');
lock = lock.replaceAll(`p.state='prepared_offline'`,settledFilter('p'));

// --- SC-010 R21 adapter for the settlement ledger ---
const purgeKey = once(fn(r20,'private.erasure_purge_key'),
 ` when adapter='private.sc011b_voice_dispatches' then data->>'company_id'||':'||(data->>'preparation_id')
`,` when adapter in ('private.sc011b_voice_dispatches','${ledgerTable}') then data->>'company_id'||':'||(data->>'preparation_id')
`);
const wiring = `
-- Row key of the ledger (no id column); every other adapter keeps its key (this
-- function was last defined by 20261119180000, R20).
${purgeKey}

alter function private.erasure_inventory_rows(uuid,uuid[]) rename to erasure_inventory_rows_r20;
alter function private.erasure_row_candidates(text,jsonb) rename to erasure_row_candidates_r20;
create function private.erasure_row_candidates(adapter text,data jsonb) returns uuid[]
language plpgsql stable security definer set search_path='' as $$
begin
 -- A settlement belongs to every subject of its preparation, like its dispatch claim.
 if adapter='${ledgerTable}' then
  return private.erasure_row_candidates_r20('private.sc011b_voice_dispatches',data);
 end if;
 return private.erasure_row_candidates_r20(adapter,data);
end;$$;
create function private.erasure_inventory_rows(tenant uuid,subjects uuid[])
returns table(adapter text,row_key text,row_data jsonb) language sql stable security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
 select * from private.erasure_inventory_rows_r20(tenant,subjects)
 union all select '${ledgerTable}',private.erasure_purge_key('${ledgerTable}',to_jsonb(t)),to_jsonb(t) from ${ledgerTable} t where t.company_id=tenant and (private.erasure_row_candidates('${ledgerTable}',to_jsonb(t)) && subjects)
$$;
create table private.erasure_inventory_baseline_r21 (
 singleton boolean primary key default true check(singleton),schema_signature text not null,known_tables text[] not null
);
alter table private.erasure_inventory_baseline_r21 enable row level security;
create trigger immutable_history before update or delete on private.erasure_inventory_baseline_r21
 for each row execute function private.contact_immutable();
insert into private.erasure_inventory_baseline_r21 select true,'${signature}',
 known_tables||array['${ledgerTable}','private.erasure_inventory_baseline_r21']
 from private.erasure_inventory_baseline_r20 where singleton;

-- Normal ledger writes take the candidate lock and refuse frozen candidates (R18 voice guard).
create trigger erasure_voice_guard before insert or update or delete on ${ledgerTable}
 for each row execute function private.erasure_voice_row_guard();
create trigger zz_retention_observed after insert or update or delete on ${ledgerTable}
 for each row execute function private.retention_observe_candidate();
create policy erasure_purge_select on ${ledgerTable} for select to erasure_purge_owner using (private.erasure_purge_visible('${ledgerTable}',to_jsonb(sc011b_voice_settlements)));
create policy erasure_purge_delete on ${ledgerTable} for delete to erasure_purge_owner using (private.erasure_purge_allowed('${ledgerTable}',to_jsonb(sc011b_voice_settlements)));
`;

const output = [`-- R6-1c (part 5): voice settlement (SC-011-B4) as a real migration.
-- Generated offline by scripts/r6-voice-settlement-compose.mjs from the reviewed
-- isolated source and the R20 erasure inventory.
--  1. A candidate's in-call request not to be called again blocks every contact
--     channel, and the block cannot be lifted by a later preference edit.
--  2. Only a call that took place uses an interview from the voice pool; an
--     unanswered, busy, voicemail or failed call releases its reservation. Each
--     prepared call is settled once (settlement ledger, erasure inventory R21).
--
-- Nothing is used by the application yet and nothing is customer-visible: no
-- table or function is granted to anon, authenticated or service_role, nothing is
-- seeded, no provider is called, no webhook route exists and no package, price or
-- order state is touched. The operator resolution (SC-011-B6) and transcripts
-- (SC-011-B3) are not part of this step.
begin;
do $preflight$
declare known text[];actual text[];
begin
 if to_regclass('private.erasure_inventory_baseline_r20') is null or to_regclass('private.sc011b_voice_attempts') is null
  or to_regclass('private.sc19_voice_entitlements') is null then
  raise exception 'voice_settlement_requires_r20' using errcode='55000';end if;
 if to_regprocedure('private.sc19_voice_interview_balance(uuid)') is null then
  raise exception 'voice_settlement_requires_operator_grant' using errcode='55000';end if;
 if to_regclass('private.erasure_inventory_baseline_r21') is not null or to_regclass('${ledgerTable}') is not null
  or to_regprocedure('private.sc011b_attempt_settlement()') is not null then
  raise exception 'voice_settlement_already_installed' using errcode='55000';end if;
 if not exists(select 1 from private.erasure_inventory_baseline_r20 where singleton and schema_signature='${sourceSignature}')
  or private.erasure_schema_signature() is distinct from '${sourceSignature}' then
  raise exception 'voice_settlement_source_schema_unreviewed:%',private.erasure_schema_signature() using errcode='55000';end if;
 ${inventoryCheck('erasure_inventory_baseline_r20','voice_settlement_source_inventory_gap')}
 ${adapters.map(item=>pinnedFunction(r20,item,true)).join('\n ')}
 ${readers.map(item=>pinnedFunction(r20,item,true)).join('\n ')}
 ${pinnedFunction(r20,['private.erasure_purge_key','text,jsonb'],false)}
 ${pinnedFunction(r20,['private.sc011b_attempt_guard',''],false)}
 ${pinnedFunction(r18,['private.erasure_voice_row_guard',''],false)}
 ${pinnedFunction(r19,['private.erasure_voice_refund_deleted',''],false)}
 ${pinnedFunction(r19,['private.erasure_voice_lock_entitlements','uuid'],false)}
 ${pinnedFunction(r19,['private.sc19_voice_entitlement_guard',''],false)}
 if to_regprocedure('private.erasure_inventory_rows_r20(uuid,uuid[])') is not null
  or to_regprocedure('private.erasure_row_candidates_r20(text,jsonb)') is not null then
  raise exception 'voice_settlement_adapter_name_taken' using errcode='55000';end if;
 if to_regprocedure('private.retention_observe_candidate()') is null or to_regprocedure('private.contact_immutable()') is null
  or to_regprocedure('private.erasure_purge_allowed(text,jsonb,text)') is null
  or to_regprocedure('private.erasure_purge_visible(text,jsonb)') is null or to_regrole('erasure_purge_owner') is null
  or to_regclass('public.candidate_contact_preferences') is null then
  raise exception 'voice_settlement_dependency_missing' using errcode='55000';end if;
end $preflight$;`,
`-- SC-011-B4 settlement (source: db/isolated/sc011b4-voice-settlement.sql).`,ledger,settlement,keepBlock,
`-- R19 voice pool accounting: a purged preparation returns its held unit only
-- while it still holds one (not after its call was settled), and the quota
-- reconciliation counts only those (this function was last defined by R19).`,refund,lock,
wiring.trim()];
for(const [name] of readers){
 const source=fn(r20,name);
 if(!source.includes('erasure_inventory_baseline_r20'))throw Error('Reader has no baseline reference: '+name);
 output.push(source.replaceAll('erasure_inventory_baseline_r20','erasure_inventory_baseline_r21'));
}
const accessStart=r20.slice(r20.indexOf('-- PG16+ non-superuser creators'),r20.indexOf('set local role erasure_purge_owner;'));
if(!accessStart.includes('sc010_purge_migration_access'))throw Error('Missing purge owner protocol');
const engineStart=r20.indexOf('create or replace function private.erasure_purge_engine');
const restoreEnd=r20.slice(r20.indexOf('reset role;',engineStart),r20.indexOf('-- Remove hostile default ACLs',engineStart));
if(!restoreEnd.includes('Purge migration privileges not restored'))throw Error('Missing purge owner restore');
// The ledger is purged right after the preparations, so their refund sees it.
const anchor=" deleted_counts:=deleted_counts||jsonb_build_object('private.sc010c_voice_preparations',deleted_count);";
const engine=once(fn(r20,'private.erasure_purge_engine'),anchor,anchor+`
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='${ledgerTable}';
 delete from ${ledgerTable} t where private.erasure_purge_allowed('${ledgerTable}',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('${ledgerTable}',deleted_count);`);
output.push(accessStart+'\nset local role erasure_purge_owner;\n'+engine+'\n'+restoreEnd);
output.push(`-- Remove hostile default ACLs on every new table and function, then grant only
-- the existing manifest-checked purge role. No API role receives anything.
do $acl$
declare o record;g record;
begin
 for o in select oid,relowner from pg_class where oid in ('${ledgerTable}'::regclass,'private.erasure_inventory_baseline_r21'::regclass) loop
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
grant select,delete on ${ledgerTable} to erasure_purge_owner;
do $postflight$
declare known text[];actual text[];
begin
 if private.erasure_schema_signature() is distinct from '${signature}' then
  raise exception 'voice_settlement_final_schema_mismatch:%',private.erasure_schema_signature() using errcode='55000';end if;
 ${inventoryCheck('erasure_inventory_baseline_r21','voice_settlement_final_inventory_gap')}
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('public','private') and p.prosrc ~ 'erasure_inventory_baseline_r([4-9]|1[0-9]|20)([^0-9]|$)') then
  raise exception 'voice_settlement_stale_inventory_reference' using errcode='55000';end if;
 if (select count(*) from pg_proc p where p.prosrc like '%erasure_inventory_baseline_r21%'
  and p.proname in ('preview_candidate_erasure','prepare_erasure_purge_manifest','authorize_retention_suggestion','get_retention_schedule'))<>4 then
  raise exception 'voice_settlement_inventory_reference_missing' using errcode='55000';end if;
 if exists(select 1 from (values
  ('private.erasure_inventory_rows(uuid,uuid[])'::regprocedure,'private.erasure_inventory_rows_r20(uuid,uuid[])'::regprocedure),
  ('private.erasure_row_candidates(text,jsonb)'::regprocedure,'private.erasure_row_candidates_r20(text,jsonb)'::regprocedure)) v(wrapper,base)
 join pg_proc w on w.oid=v.wrapper join pg_proc b on b.oid=v.base
 where w.proowner<>b.proowner or not w.prosecdef or w.proacl::text is distinct from b.proacl::text) then
  raise exception 'voice_settlement_wrapper_acl_mismatch' using errcode='55000';end if;
 -- Deny by default: no API role holds any privilege on the new table or function.
 if exists(select 1 from pg_class c cross join (select rolname from pg_roles where rolname in ('anon','authenticated','service_role')) r
  where c.oid='${ledgerTable}'::regclass
  and (not c.relrowsecurity or not c.relforcerowsecurity or has_table_privilege(r.rolname,c.oid,'select,insert,update,delete,truncate,references,trigger'))) then
  raise exception 'voice_settlement_table_exposed' using errcode='55000';end if;
 if exists(select 1 from pg_proc p cross join (select rolname from pg_roles where rolname in ('anon','authenticated','service_role')) r
  where p.oid=any(array[${[...newFunctions,'private.erasure_voice_refund_deleted()','private.erasure_voice_lock_entitlements(uuid)'].map(f=>`'${f}'`).join(',')}]::regprocedure[])
  and has_function_privilege(r.rolname,p.oid,'execute')) then
  raise exception 'voice_settlement_function_exposed' using errcode='55000';end if;
 if exists(select 1 from pg_proc where oid=any(array[${[...definers,'private.erasure_voice_refund_deleted()','private.erasure_voice_lock_entitlements(uuid)'].map(f=>`'${f}'`).join(',')}]::regprocedure[]) and not prosecdef)
  or exists(select 1 from pg_proc where oid=any(array[${newFunctions.map(f=>`'${f}'`).join(',')}]::regprocedure[])
   and (proconfig is null or proconfig[1] is distinct from 'search_path=""')) then
  raise exception 'voice_settlement_definer_search_path' using errcode='55000';end if;
 -- The purge-aware ledger guard runs as the caller, never as its owner.
 if (select prosecdef from pg_proc where oid='private.sc011b_settlement_guard()'::regprocedure) then
  raise exception 'voice_settlement_guard_definer' using errcode='55000';end if;
end $postflight$;
commit;`);
const artifact=output.join('\n\n')+'\n';
for(const [source,name] of verbatim){
 if(!artifact.includes(fn(source,name).split('$$')[1]))throw Error('Reviewed body changed while composing: '+name);
}
// The settlement keeps the whole isolated body around the one ledger insert.
for(const piece of fn(settlementSource,'private.sc011b_attempt_settlement').split('$$')[1].split(`  end if;
 end if;
 return null;`)){
 if(!artifact.includes(piece))throw Error('Reviewed settlement body changed while composing');
}
const path='supabase/migrations/20261119210000_r6_voice_settlement_r21.sql';
if(process.argv.includes('--check')){if(readFileSync(path,'utf8')!==artifact)throw Error('Regenerate the R6 voice settlement migration');}
else writeFileSync(path,artifact);
