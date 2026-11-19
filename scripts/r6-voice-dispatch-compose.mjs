// Compose R6-1c (part 4): the SC-011-B2 voice dispatch ledger (provider call
// attempts and webhook receipts) and the SC-011-B5 once-only dispatch claims as a
// real migration on top of the reviewed R19 inventory and purge engine
// (20261119120000_r6_voice_permission_pool_r19.sql) and the R6-2 operator grant
// (20261119150000_r6_voice_pool_operator_grant.sql).
// Offline only: no provider transport, no webhook route, no deployed catalog, no
// inferred signature, no activation flag.
//
// Sources are the reviewed isolated files (db/isolated/sc011b2-voice-dispatch.sql,
// db/isolated/sc011b5-voice-dispatch-worker.sql), pinned by hash. Function bodies
// are copied byte for byte, except:
//  - the attempt, webhook receipt and dispatch guards take the R4 voice
//    purge-aware form (security invoker; they admit only the manifest-checked
//    purge, exactly like the R19 preparation guards);
//  - a correlated webhook receipt takes the candidate lock (it is candidate data
//    and is refused while the candidate is frozen for erasure).
// Not included (separate later parts): SC-011-B3 transcripts, SC-011-B4 settlement
// (pool use on a finished call, contact block on a do-not-call request) and the
// SC-011-B6 operator resolution, which calls the B4 contact block.
//
// Usage: node scripts/r6-voice-dispatch-compose.mjs          (write the migration)
//        node scripts/r6-voice-dispatch-compose.mjs --check  (fail when out of date)
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
const pinned = (path, hash) => {
 const text = readFileSync(path,'utf8');
 if(sha(text)!==hash)throw Error('Review updated source before composing the voice dispatch migration: '+path);
 return text;
};
const r18 = pinned('supabase/migrations/20261119100000_r6_voice_plan_r18.sql','551a7d84556b76801a04d04321a6779aa1d01ead2bb616683171f21b778a6dcf');
const r19 = pinned('supabase/migrations/20261119120000_r6_voice_permission_pool_r19.sql','425afb3e7d988c69072acf99280258d460714eccd38e9a8d1e18810812e8dc34');
pinned('supabase/migrations/20261119150000_r6_voice_pool_operator_grant.sql','3016d80dcfd0151564b10cbd02f3c9ae33b22997f2d69149524fd0ed1073bc00');
const ledgerSource = pinned('db/isolated/sc011b2-voice-dispatch.sql','846042d614e3752fcf79926af6f5071eff41fc9f9e27ba7f7513aecec617b355');
const workerSource = pinned('db/isolated/sc011b5-voice-dispatch-worker.sql','d7c2aee459f0a46c539b20c94c6d6561aca0f5e4ffd3402d2951a5862bb98073');
const sourceSignature = 'c2a45d8684f605083170a4e1b15e5438228729099836b687bdbb362280c3db39';
const signature = '1a657cdd163107054029c177c44c66e44a05ad5615a374fb85466c30bc95b806';

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
// The R4 voice purge-aware form (see private.sc010c_preparation_guard in R19):
// security invoker, and a DELETE passes only for the purge owner on a row of the
// validated manifest. TRUNCATE and every other DELETE keep the isolated refusal.
const purgeLine = ` if tg_op='DELETE' and current_user='erasure_purge_owner' and
  private.erasure_purge_allowed(tg_table_schema||'.'||tg_table_name,to_jsonb(old)) then return old;end if;
`;
if(!fn(r19,'private.sc010c_preparation_guard').includes(purgeLine))throw Error('R19 purge-aware guard form changed');
const purgeAware = (source,name) => {
 let text = fn(source,name);
 text = once(text,"language plpgsql security definer set search_path='' as $$","language plpgsql security invoker set search_path='' as $$");
 return once(text,'\nbegin\n','\nbegin\n'+purgeLine);
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
  raise exception 'voice_dispatch_source_function_unreviewed:${name}' using errcode='55000';end if;`;
};
const inventoryCheck = (baseline,label) => `select known_tables into known from private.${baseline} where singleton;
 select array_agg(n.nspname||'.'||c.relname order by (n.nspname||'.'||c.relname) collate "C") into actual
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f');
 if actual is distinct from (select array_agg(x order by x collate "C") from unnest(known) x) then
  raise exception '${label}' using errcode='55000';end if;`;

// All three tables are candidate-linked (through the preparation) and purged with the candidate.
const candidateTables = ['private.sc011b_voice_attempts','private.sc011b_voice_webhook_receipts','private.sc011b_voice_dispatches'];
const definers = ['private.sc011b_block_cancel_after_dispatch()','private.sc011b_dispatch_rejected()',
 'private.sc011b_block_cancel_while_dispatching()','private.erasure_row_candidates(text,jsonb)','private.erasure_inventory_rows(uuid,uuid[])'];
const newFunctions = ['private.sc011b_attempt_guard()','private.sc011b_receipt_guard()','private.sc011b_dispatch_guard()',...definers];
// Reviewed bodies that must stay byte-identical to the isolated sources.
const verbatim = [[ledgerSource,'private.sc011b_block_cancel_after_dispatch'],[workerSource,'private.sc011b_dispatch_rejected'],
 [workerSource,'private.sc011b_block_cancel_while_dispatching']];

// --- domain 1: SC-011-B2 dispatch ledger (purge-aware guards, locked receipts) ---
let ledger = unwrapped(ledgerSource);
ledger = once(ledger,fn(ledgerSource,'private.sc011b_attempt_guard'),purgeAware(ledgerSource,'private.sc011b_attempt_guard'));
let receiptGuard = purgeAware(ledgerSource,'private.sc011b_receipt_guard');
receiptGuard = once(receiptGuard,` end if;
 return new;
end;$$;`,` end if;
 -- A correlated receipt is candidate data: serialize it on the candidate row and
 -- refuse it while the candidate is frozen for erasure, like its attempt.
 if new.attempt_id is not null then
  perform private.erasure_lock_candidate((select a.candidate_id from private.sc011b_voice_attempts a
   where a.company_id=new.company_id and a.id=new.attempt_id));
 end if;
 return new;
end;$$;`);
ledger = once(ledger,fn(ledgerSource,'private.sc011b_receipt_guard'),receiptGuard);

// --- domain 2: SC-011-B5 once-only dispatch claims (purge-aware guard) ---
let worker = unwrapped(workerSource);
worker = once(worker,fn(workerSource,'private.sc011b_dispatch_guard'),purgeAware(workerSource,'private.sc011b_dispatch_guard'));
for(const part of [ledger,worker]){
 const code = part.replace(/--[^\n]*/g,'');
 if(/\bdrop\b/i.test(code))throw Error('Unexpected drop in voice dispatch domain');
 if(/package|PRESELEKCJA|price|pricing|order_id|\bgrant\b/i.test(code))throw Error('Package, price or grant in voice dispatch domain');
}

// --- SC-010 R20 adapters for the three candidate-linked tables ---
const purgeKey = once(fn(r19,'private.erasure_purge_key'),
 ` when adapter='private.voice_interview_permission_revocations' then data->>'company_id'||':'||(data->>'receipt_id')
`,` when adapter='private.voice_interview_permission_revocations' then data->>'company_id'||':'||(data->>'receipt_id')
 when adapter='private.sc011b_voice_dispatches' then data->>'company_id'||':'||(data->>'preparation_id')
 when adapter='private.sc011b_voice_webhook_receipts' then data->>'receipt_id'
`);
const inventoryLine = t => ` union all select '${t}',private.erasure_purge_key('${t}',to_jsonb(t)),to_jsonb(t) from ${t} t where t.company_id=tenant and (private.erasure_row_candidates('${t}',to_jsonb(t)) && subjects)`;
const wiring = `
-- Row keys of the two new tables without an id column; every other adapter keeps
-- its key (this function was last defined by 20261119120000, R19).
${purgeKey}

alter function private.erasure_inventory_rows(uuid,uuid[]) rename to erasure_inventory_rows_r19;
alter function private.erasure_row_candidates(text,jsonb) rename to erasure_row_candidates_r19;
create function private.erasure_row_candidates(adapter text,data jsonb) returns uuid[]
language plpgsql stable security definer set search_path='' as $$
declare ids uuid[];prep jsonb;attempt jsonb;
begin
 if adapter in ('private.sc011b_voice_attempts','private.sc011b_voice_dispatches') then
  -- A call attempt or dispatch claim belongs to every subject of its preparation
  -- (purging any of them deletes the preparation, which these rows reference).
  select to_jsonb(p) into prep from private.sc010c_voice_preparations p
   where p.company_id=(data->>'company_id')::uuid and p.id=(data->>'preparation_id')::uuid;
  if prep is null then raise exception using errcode='PT409',message='Unknown voice dispatch dependency';end if;
  select array_agg(distinct id order by id) into ids from unnest(
   private.erasure_row_candidates('private.sc010c_voice_preparations',prep)||array[(data->>'candidate_id')::uuid]) id
   where id is not null;
  return ids;
 end if;
 if adapter='private.sc011b_voice_webhook_receipts' then
  -- An ignored or uncorrelated delivery carries no tenant and no candidate.
  if data->>'attempt_id' is null then return '{}'::uuid[];end if;
  select to_jsonb(a) into attempt from private.sc011b_voice_attempts a
   where a.company_id=(data->>'company_id')::uuid and a.id=(data->>'attempt_id')::uuid;
  if attempt is null then raise exception using errcode='PT409',message='Unknown voice dispatch dependency';end if;
  return private.erasure_row_candidates('private.sc011b_voice_attempts',attempt);
 end if;
 return private.erasure_row_candidates_r19(adapter,data);
end;$$;
create function private.erasure_inventory_rows(tenant uuid,subjects uuid[])
returns table(adapter text,row_key text,row_data jsonb) language sql stable security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
 select * from private.erasure_inventory_rows_r19(tenant,subjects)
${candidateTables.map(inventoryLine).join('\n')}
$$;
create table private.erasure_inventory_baseline_r20 (
 singleton boolean primary key default true check(singleton),schema_signature text not null,known_tables text[] not null
);
alter table private.erasure_inventory_baseline_r20 enable row level security;
create trigger immutable_history before update or delete on private.erasure_inventory_baseline_r20
 for each row execute function private.contact_immutable();
insert into private.erasure_inventory_baseline_r20 select true,'${signature}',
 known_tables||array[${candidateTables.map(t=>`'${t}'`).join(',')},'private.erasure_inventory_baseline_r20']
 from private.erasure_inventory_baseline_r19 where singleton;

-- Normal writes of attempts and claims take the candidate lock and refuse frozen
-- candidates (R18 voice guard). A webhook receipt has no candidate column and may
-- carry no tenant; its own guard takes the candidate lock when it is correlated.
${candidateTables.map(t=>{const n=t.split('.')[1];return `${t==='private.sc011b_voice_webhook_receipts'?'':`create trigger erasure_voice_guard before insert or update or delete on ${t}
 for each row execute function private.erasure_voice_row_guard();
`}create trigger zz_retention_observed after insert or update or delete on ${t}
 for each row execute function private.retention_observe_candidate();
create policy erasure_purge_select on ${t} for select to erasure_purge_owner using (private.erasure_purge_visible('${t}',to_jsonb(${n})));
create policy erasure_purge_delete on ${t} for delete to erasure_purge_owner using (private.erasure_purge_allowed('${t}',to_jsonb(${n})));`;}).join('\n')}
`;

const output = [`-- R6-1c (part 4): voice dispatch ledger (SC-011-B2: provider call attempts and
-- webhook receipts) and once-only dispatch claims (SC-011-B5) as a real migration.
-- Generated offline by scripts/r6-voice-dispatch-compose.mjs from the reviewed
-- isolated sources and the R19 erasure inventory; erasure inventory R20 adds the
-- three candidate-linked tables and purges them before the preparations they
-- reference.
--
-- Nothing is used by the application yet and nothing is customer-visible: no
-- table or function is granted to anon, authenticated or service_role, nothing is
-- seeded, no provider is called, no webhook route exists and no package, price or
-- order state is touched. Settlement (SC-011-B4), transcripts (SC-011-B3) and the
-- operator resolution (SC-011-B6) are not part of this step.
begin;
do $preflight$
declare known text[];actual text[];
begin
 if to_regclass('private.erasure_inventory_baseline_r19') is null or to_regclass('private.sc010c_voice_preparations') is null
  or to_regclass('private.sc19_voice_entitlements') is null then
  raise exception 'voice_dispatch_requires_r19' using errcode='55000';end if;
 -- R6-2 operator grant (20261119150000) is installed and left the R19 schema unchanged.
 if to_regprocedure('private.sc19_voice_grant_interviews(uuid,text,integer,uuid,timestamptz,uuid,timestamptz)') is null
  or to_regprocedure('private.sc19_voice_interview_balance(uuid)') is null
  or to_regprocedure('private.sc19_voice_trial_reference(uuid)') is null then
  raise exception 'voice_dispatch_requires_operator_grant' using errcode='55000';end if;
 if to_regclass('private.erasure_inventory_baseline_r20') is not null${candidateTables.map(t=>`
  or to_regclass('${t}') is not null`).join('')} then
  raise exception 'voice_dispatch_already_installed' using errcode='55000';end if;
 if not exists(select 1 from private.erasure_inventory_baseline_r19 where singleton and schema_signature='${sourceSignature}')
  or private.erasure_schema_signature() is distinct from '${sourceSignature}' then
  raise exception 'voice_dispatch_source_schema_unreviewed:%',private.erasure_schema_signature() using errcode='55000';end if;
 ${inventoryCheck('erasure_inventory_baseline_r19','voice_dispatch_source_inventory_gap')}
 ${adapters.map(item=>pinnedFunction(r19,item,true)).join('\n ')}
 ${readers.map(item=>pinnedFunction(r19,item,true)).join('\n ')}
 ${pinnedFunction(r19,['private.erasure_purge_key','text,jsonb'],false)}
 ${pinnedFunction(r18,['private.erasure_voice_row_guard',''],false)}
 ${pinnedFunction(r19,['private.sc010c_preparation_guard',''],false)}
 ${pinnedFunction(r19,['private.erasure_voice_refund_deleted',''],false)}
 if to_regprocedure('private.erasure_inventory_rows_r19(uuid,uuid[])') is not null
  or to_regprocedure('private.erasure_row_candidates_r19(text,jsonb)') is not null then
  raise exception 'voice_dispatch_adapter_name_taken' using errcode='55000';end if;
 if to_regprocedure('private.erasure_lock_candidate(uuid)') is null or to_regprocedure('private.retention_observe_candidate()') is null
  or to_regprocedure('private.contact_immutable()') is null or to_regprocedure('private.erasure_purge_allowed(text,jsonb,text)') is null
  or to_regprocedure('private.erasure_purge_visible(text,jsonb)') is null or to_regrole('erasure_purge_owner') is null then
  raise exception 'voice_dispatch_dependency_missing' using errcode='55000';end if;
 -- The ledger references a preparation by (company_id,id) and compares its provider key digest.
 if not exists(select 1 from pg_constraint where conrelid='private.sc010c_voice_preparations'::regclass and contype='u'
   and (select array_agg(a.attname::text order by k.ord) from unnest(conkey) with ordinality k(attnum,ord)
    join pg_attribute a on a.attrelid=conrelid and a.attnum=k.attnum)=array['company_id','id'])
  or not exists(select 1 from pg_attribute where attrelid='private.sc010c_voice_preparations'::regclass
   and attname='provider_key_digest' and not attisdropped) then
  raise exception 'voice_dispatch_preparation_key_missing' using errcode='55000';end if;
end $preflight$;`,
`-- SC-011-B2 dispatch ledger (source: db/isolated/sc011b2-voice-dispatch.sql).`,ledger,
`-- SC-011-B5 once-only dispatch claims (source: db/isolated/sc011b5-voice-dispatch-worker.sql).`,worker,
wiring.trim()];
for(const [name] of readers){
 const source=fn(r19,name);
 if(!source.includes('erasure_inventory_baseline_r19'))throw Error('Reader has no baseline reference: '+name);
 output.push(source.replaceAll('erasure_inventory_baseline_r19','erasure_inventory_baseline_r20'));
}
// Reuse the exact hosted creator protocol reviewed in R16-R19, restoring memberships/ACLs.
const accessStart=r19.slice(r19.indexOf('-- PG16+ non-superuser creators'),r19.indexOf('set local role erasure_purge_owner;'));
if(!accessStart.includes('sc010_purge_migration_access'))throw Error('Missing purge owner protocol');
const engineStart=r19.indexOf('create or replace function private.erasure_purge_engine');
const restoreEnd=r19.slice(r19.indexOf('reset role;',engineStart),r19.indexOf('-- Remove hostile default ACLs',engineStart));
if(!restoreEnd.includes('Purge migration privileges not restored'))throw Error('Missing purge owner restore');
const anchor=" update private.erasure_purge_context set mode='delete' where txid=txid_current();";
let engine=fn(r19,'private.erasure_purge_engine');
if(engine.split(anchor).length!==2)throw Error('Missing validated purge boundary');
// Receipts reference attempts; attempts and claims reference the preparation, so
// all three go first. The R19 voice rows (with the held-unit refund) follow.
const countedDelete = t => `
 select count(*) into expected_count from private.erasure_purge_context_rows where txid=txid_current() and adapter='${t}';
 delete from ${t} t where private.erasure_purge_allowed('${t}',to_jsonb(t));
 get diagnostics deleted_count=row_count;
 if deleted_count<>expected_count then raise exception using errcode='PT409',message='Purge manifest row count changed';end if;
 deleted_counts:=deleted_counts||jsonb_build_object('${t}',deleted_count);`;
engine=engine.replace(anchor,anchor+['private.sc011b_voice_webhook_receipts','private.sc011b_voice_attempts',
 'private.sc011b_voice_dispatches'].map(countedDelete).join(''));
output.push(accessStart+'\nset local role erasure_purge_owner;\n'+engine+'\n'+restoreEnd);
output.push(`-- Remove hostile default ACLs on every new table and function, then grant only
-- the existing manifest-checked purge role. No API role receives anything.
do $acl$
declare o record;g record;
begin
 for o in select oid,relowner from pg_class where oid in (${[...candidateTables,'private.erasure_inventory_baseline_r20'].map(t=>`'${t}'::regclass`).join(',')}) loop
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
do $postflight$
declare known text[];actual text[];
begin
 if private.erasure_schema_signature() is distinct from '${signature}' then
  raise exception 'voice_dispatch_final_schema_mismatch:%',private.erasure_schema_signature() using errcode='55000';end if;
 ${inventoryCheck('erasure_inventory_baseline_r20','voice_dispatch_final_inventory_gap')}
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('public','private') and p.prosrc ~ 'erasure_inventory_baseline_r([4-9]|1[0-9])([^0-9]|$)') then
  raise exception 'voice_dispatch_stale_inventory_reference' using errcode='55000';end if;
 if (select count(*) from pg_proc p where p.prosrc like '%erasure_inventory_baseline_r20%'
  and p.proname in ('preview_candidate_erasure','prepare_erasure_purge_manifest','authorize_retention_suggestion','get_retention_schedule'))<>4 then
  raise exception 'voice_dispatch_inventory_reference_missing' using errcode='55000';end if;
 if exists(select 1 from (values
  ('private.erasure_inventory_rows(uuid,uuid[])'::regprocedure,'private.erasure_inventory_rows_r19(uuid,uuid[])'::regprocedure),
  ('private.erasure_row_candidates(text,jsonb)'::regprocedure,'private.erasure_row_candidates_r19(text,jsonb)'::regprocedure)) v(wrapper,base)
 join pg_proc w on w.oid=v.wrapper join pg_proc b on b.oid=v.base
 where w.proowner<>b.proowner or not w.prosecdef or w.proacl::text is distinct from b.proacl::text) then
  raise exception 'voice_dispatch_wrapper_acl_mismatch' using errcode='55000';end if;
 -- Deny by default: no API role holds any privilege on a new table or function.
 if exists(select 1 from pg_class c cross join (select rolname from pg_roles where rolname in ('anon','authenticated','service_role')) r
  where c.oid in (${candidateTables.map(t=>`'${t}'::regclass`).join(',')})
  and (not c.relrowsecurity or not c.relforcerowsecurity or has_table_privilege(r.rolname,c.oid,'select,insert,update,delete,truncate,references,trigger'))) then
  raise exception 'voice_dispatch_table_exposed' using errcode='55000';end if;
 if exists(select 1 from pg_proc p cross join (select rolname from pg_roles where rolname in ('anon','authenticated','service_role')) r
  where p.oid=any(array[${newFunctions.map(f=>`'${f}'`).join(',')}]::regprocedure[])
  and has_function_privilege(r.rolname,p.oid,'execute')) then
  raise exception 'voice_dispatch_function_exposed' using errcode='55000';end if;
 if exists(select 1 from pg_proc where oid=any(array[${definers.map(f=>`'${f}'`).join(',')}]::regprocedure[]) and not prosecdef)
  or exists(select 1 from pg_proc where oid=any(array[${newFunctions.map(f=>`'${f}'`).join(',')}]::regprocedure[])
   and (proconfig is null or proconfig[1] is distinct from 'search_path=""')) then
  raise exception 'voice_dispatch_definer_search_path' using errcode='55000';end if;
 -- Purge-aware guards run as the caller, never as their owner.
 if exists(select 1 from pg_proc where oid=any(array['private.sc011b_attempt_guard()','private.sc011b_receipt_guard()',
  'private.sc011b_dispatch_guard()']::regprocedure[]) and prosecdef) then
  raise exception 'voice_dispatch_guard_definer' using errcode='55000';end if;
end $postflight$;
commit;`);
const artifact=output.join('\n\n')+'\n';
for(const [source,name] of verbatim){
 if(!artifact.includes(fn(source,name).split('$$')[1]))throw Error('Reviewed body changed while composing: '+name);
}
// Each purge-aware guard keeps the whole isolated body after its first line.
for(const [source,name] of [[ledgerSource,'private.sc011b_attempt_guard'],[ledgerSource,'private.sc011b_receipt_guard'],
 [workerSource,'private.sc011b_dispatch_guard']]){
 const original=fn(source,name).split('$$')[1].split('\nbegin\n')[1].split(' return new;\nend;')[0];
 if(!artifact.includes(original))throw Error('Reviewed guard body changed while composing: '+name);
}
const path='supabase/migrations/20261119180000_r6_voice_dispatch_r20.sql';
if(process.argv.includes('--check')){if(readFileSync(path,'utf8')!==artifact)throw Error('Regenerate the R6 voice dispatch migration');}
else writeFileSync(path,artifact);
