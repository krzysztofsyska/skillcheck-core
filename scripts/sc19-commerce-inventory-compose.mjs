// Offline composition of the four reviewed erasure readers; no live baseline learning.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const source=readFileSync('supabase/migrations/20261106130000_exercise_ai_proposals.sql','utf8');
const sha=s=>createHash('sha256').update(s).digest('hex');
if(sha(source)!=='fef548865fa8aa83ee8bcb2c07c13a2579ff222372b8d931d5c3b99d64a4a76d')throw Error('Review changed R14 source before composition');
const signature='1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44';
const prior='75eca00dc4b8bbf7959e18a144beda51a70b0377ab4cc306e59b2cef56402688';
const readers=['public.preview_candidate_erasure','private.prepare_erasure_purge_manifest','private.authorize_retention_suggestion','public.get_retention_schedule'];
const fn=name=>{const start=source.indexOf('create or replace function '+name+'(');if(start<0)throw Error(name);return source.slice(start,source.indexOf('$$;',start)+3);};
const marker='-- Generated R15 readers and immutable baseline.';
const path='supabase/migrations/20261107164252_sc019_catalog_orders.sql';
let domain=readFileSync(path,'utf8').split(marker)[0].replace(/commit;\s*$/,'');
const preflight=`do $commerce_preflight$ begin
 if private.erasure_schema_signature() is distinct from '${prior}' then raise exception 'commerce_source_schema_unreviewed' using errcode='55000';end if;
 ${readers.map(name=>`if not exists(select 1 from pg_proc where oid='${name}(${name.endsWith('preview_candidate_erasure')?'uuid,text,uuid':'uuid'})'::regprocedure and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='${sha(fn(name).split('$$')[1])}') then raise exception 'commerce_source_reader_unreviewed:${name}' using errcode='55000';end if;`).join('\n ')}
end $commerce_preflight$;`;
if(!domain.includes('$commerce_preflight$'))domain=domain.replace('begin;',`begin;\n${preflight}`);
const block=`${marker}
create table private.erasure_inventory_baseline_r15 (
 singleton boolean primary key default true check(singleton),schema_signature text not null,known_tables text[] not null
);
alter table private.erasure_inventory_baseline_r15 enable row level security;
create trigger immutable_history before update or delete on private.erasure_inventory_baseline_r15
 for each row execute function private.contact_immutable();
insert into private.erasure_inventory_baseline_r15 select true,'${signature}',known_tables||array['private.erasure_inventory_baseline_r15'] from private.erasure_inventory_baseline_r14 where singleton;
do $acl$ declare g record;begin
 revoke all on private.erasure_inventory_baseline_r15 from public;
 for g in select distinct r.rolname from pg_class c cross join lateral aclexplode(c.relacl) a join pg_roles r on r.oid=a.grantee where c.oid='private.erasure_inventory_baseline_r15'::regclass and a.grantee<>c.relowner loop execute format('revoke all on private.erasure_inventory_baseline_r15 from %I',g.rolname);end loop;
end $acl$;
${readers.map(name=>fn(name).replaceAll('erasure_inventory_baseline_r14','erasure_inventory_baseline_r15')).join('\n\n')}
do $commerce_postflight$ begin
 if private.erasure_schema_signature() is distinct from '${signature}' then raise exception 'commerce_final_schema_mismatch:%',private.erasure_schema_signature() using errcode='55000';end if;
end $commerce_postflight$;
commit;
`;
const result=domain+block;
if(process.argv.includes('--check')){if(result!==readFileSync(path,'utf8'))throw Error('Regenerate commerce R15');}else writeFileSync(path,result);
