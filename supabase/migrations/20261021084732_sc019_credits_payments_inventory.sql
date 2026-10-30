-- SC-019 #93/#91: credits, payment storage and immutable SC-010 R6.
-- Generated with Supabase CLI 2.121.0 migration new on 2026-10-21.
-- Architecture review: docs/sc19-migrations-design.md SHA256
-- 9f4b1241485bda7f5f195a39e960518f23f1e41989a11bd9fdf51b77a412381c.
-- Source contracts: integration bcc9a200a8a082c13fa3796e9375b37e4b520c8d;
-- legacy three-table storage: d34200d2e14302dda9685b79f4e2c59e9049d9b1.
-- Exact synthetic input provenance: tests/fixtures/sc19-migration-manifest.json.
-- This is one atomic FORWARD migration. No remote application is authorized.
-- Fresh policy stays empty; adopted policy is preserved. No offers are seeded.
-- Fresh-policy addendum review SHA256: b7ae99a4e8045e0b3c9cde320dfd30994a26260787c7a22c9572dd0169b2cb53.
-- Refuses unreviewed schema, unsafe access, conflicting orders and old signed
-- erasure recovery history. No deletion/settlement/credit repair is attempted.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';
set local timezone='UTC';
set local datestyle='ISO, YMD';
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('sc019-forward-r6-v1',0));

-- Hosted public defaults add exactly the reviewed EXECUTE/USAGE tuples below.
-- Remove only these tuples, then compare the ORIGINAL complete fingerprints.
-- Any other ACL, grant option, owner, routine or schema drift still rolls back.
-- Source evidence: tests/fixtures/sc19-hosted-acl-differences.json.
do $hosted_acl$
declare obj record;
begin
 if current_user='postgres' and exists(select 1 from pg_roles where rolname=current_user
   and not rolsuper and rolinherit and rolcreaterole and rolcreatedb and rolcanlogin and rolreplication and rolbypassrls)
   and exists(select 1 from pg_roles where oid=10 and rolname='supabase_admin'
     and rolsuper and rolinherit and rolcreaterole and rolcreatedb and rolcanlogin and rolreplication and rolbypassrls) then
   for obj in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     cross join lateral aclexplode(p.proacl) a
     where n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'=any(array[
       'private.cancel_candidate_erasure_local_r2(target_request uuid, expected_generation bigint, request_key uuid)',
       'public.add_recruitment_shortlist_entry(target_application uuid, entry_source text, expected_analysis_id uuid, expected_review_id uuid, expected_policy_version text, entry_note text, target_size integer)',
       'public.approve_candidate_communication(target_communication uuid, expected_version bigint, receipt_id uuid, request_key uuid)',
       'public.cancel_candidate_communication(target_id uuid, expected_version bigint, request_key uuid)',
       'public.cancel_candidate_erasure(target_request uuid, expected_generation bigint, request_key uuid)',
       'public.claim_sales_mail(target_lead uuid, request_id uuid, issued_at_ms bigint, request_signature text)',
       'public.claim_screening_attempt(target_attempt uuid)',
       'public.close_sales_lead(target_lead uuid)',
       'public.complete_screening_analysis(target_attempt uuid, provided_lease_token text, expected_input_fingerprint text, expected_analysis_contract_hash text, findings jsonb, new_provider_request_id text, new_provider_response_id text, new_input_tokens integer, new_output_tokens integer, new_cached_input_tokens integer, new_cost_amount numeric, new_cost_currency text)',
       'public.configure_candidate_retention_policy(target_company uuid, expected_revision bigint, policy_rules jsonb, request_key uuid)',
       'public.configure_retention_schedule(target_company uuid, expected_revision bigint, policy_revision bigint, execution_mode text, max_batch integer, request_key uuid)',
       'public.confirm_erasure_subject(target_candidate uuid, candidate_ids uuid[], expected_revision bigint, request_key uuid)',
       'public.create_company(company_name text)',
       'public.ensure_initial_company(company_name text)',
       'public.fail_screening_attempt(target_attempt uuid, provided_lease_token text, expected_input_fingerprint text, expected_analysis_contract_hash text, new_error_code text, new_error_message text, new_provider_request_id text, new_input_tokens integer, new_output_tokens integer, new_cached_input_tokens integer, new_cost_amount numeric, new_cost_currency text)',
       'public.find_sales_companies(search_text text)',
       'public.finish_sales_mail(target_lead uuid, request_id uuid, issued_at_ms bigint, outcome text, provider_id uuid, request_signature text)',
       'public.get_candidate_communication_history(target_id uuid, after_created_at timestamp with time zone, after_id uuid, page_size integer)',
       'public.get_candidate_communications(target_application uuid, after_created_at timestamp with time zone, after_id uuid, page_size integer)',
       'public.get_candidate_erasure_status(target_candidate uuid)',
       'public.get_candidate_retention_policy(target_company uuid)',
       'public.get_communication_approval_status(target_communication uuid)',
       'public.get_erasure_status(target_request uuid)',
       'public.get_erasure_subject_resolution(target_candidate uuid)',
       'public.get_recruitment_shortlist(target_recruitment uuid, include_removed boolean)',
       'public.get_retention_schedule(target_company uuid)',
       'public.get_retention_suggestions(target_company uuid, before_created_at timestamp with time zone, before_id uuid, page_size integer)',
       'public.get_screening_ranking(target_recruitment uuid, target_size integer)',
       'public.grant_platform_operator(target_user uuid)',
       'public.issue_candidate_erasure_preview(target_candidate uuid, scope_kind text, resolution_id uuid)',
       'public.list_candidate_erasure_requests(target_company uuid, before_created_at timestamp with time zone, before_id uuid, page_size integer)',
       'public.list_sales_leads(result_limit integer)',
       'public.list_sales_leads_inbox(result_limit integer)',
       'public.list_sales_pipeline(stage_filter text, due_filter text, page_offset integer, target_lead uuid)',
       'public.platform_operator_status()',
       'public.prepare_candidate_communication(target_application uuid, target_shortlist uuid, contact_channel text, request_key uuid)',
       'public.preview_candidate_erasure(target_candidate uuid, scope_kind text, resolution_id uuid)',
       'public.record_contact_permission(target_candidate uuid, target_recruitment uuid, contact_channel text, permission_state text, evidence_ref uuid, expected_revision bigint, request_key uuid)',
       'public.release_candidate_erasure_hold(target_hold uuid)',
       'public.remove_recruitment_shortlist_entry(target_entry uuid)',
       'public.request_candidate_erasure(preview_ticket_id uuid, request_key uuid)',
       'public.retry_screening_analysis(target_analysis uuid, request_idempotency_key uuid)',
       'public.review_candidate_document(document_id uuid, expected_version integer)',
       'public.review_screening_result(target_analysis uuid, expected_review_version integer, new_disposition text, new_review_note text, new_overrides jsonb)',
       'public.revoke_platform_operator(target_user uuid)',
       'public.revoke_retention_schedule(target_company uuid, expected_revision bigint, request_key uuid)',
       'public.sales_pipeline_history(target_lead uuid, before_version integer)',
       'public.save_behavior_assessment(target_application uuid, target_area text, new_rating text, new_evidence text, expected_version integer, expected_position_updated_at timestamp with time zone, expected_position_id uuid)',
       'public.save_exercise_definition(target_recruitment uuid, target_exercise uuid, new_definition jsonb, expected_version integer, expected_position_id uuid, expected_position_updated_at timestamp with time zone)',
       'public.save_exercise_observations(target_application uuid, target_definition uuid, expected_version integer, new_work_sample text, new_observations jsonb)',
       'public.save_sales_pipeline(target_lead uuid, expected_version integer, new_stage text, new_note text, next_contact date, linked_company uuid)',
       'public.set_candidate_erasure_hold(target_request uuid, reason text, review_at timestamp with time zone, expires_at timestamp with time zone, request_key uuid)',
       'public.set_contact_preferences(target_candidate uuid, contact_timezone text, weekday_windows jsonb, blocked_channels text[], expected_revision bigint, request_key uuid)',
       'public.start_screening_analysis(target_application uuid, expected_input_fingerprint text, expected_payload_schema_version integer, requested_result_schema_version integer, requested_prompt_version text, requested_provider text, requested_model text, requested_model_revision text, request_idempotency_key uuid, force_reanalysis boolean)',
       'public.submit_sales_lead(idempotency_key uuid, first_name text, company_name text, email text, phone text, needs text, source_ip text, issued_at_us bigint, request_signature text)'
     ]) and pg_get_userbyid(p.proowner)='postgres'
       and pg_get_userbyid(a.grantor)='postgres' and pg_get_userbyid(a.grantee)='service_role'
       and a.privilege_type='EXECUTE' and not a.is_grantable
   loop execute format('revoke execute on function %s from service_role',obj.oid::regprocedure); end loop;
   for obj in select pg_get_userbyid(a.grantee) grantee
     from pg_namespace n cross join lateral aclexplode(n.nspacl) a
     where n.nspname='public' and pg_get_userbyid(n.nspowner)='pg_database_owner'
       and pg_get_userbyid(a.grantor)='pg_database_owner'
       and pg_get_userbyid(a.grantee) in ('anon','authenticated','postgres','service_role')
       and a.privilege_type='USAGE' and not a.is_grantable
   loop execute format('revoke usage on schema public from %I',obj.grantee); end loop;
 end if;
end;$hosted_acl$;

-- Helpers live only in this session's temporary schema. They are trusted source,
-- not installed application functions or dynamically executed catalog code.

create function pg_temp.sc19_schema_signature() returns text language sql stable set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $catalog$

 with tracked as (select c.oid,n.nspname,c.relname,c.relkind,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname in ('public','private') and c.relkind in ('r','p','v','m','f')),
 objects as (
 select 'relation:'||nspname||'.'||relname key,jsonb_build_array(relkind,relrowsecurity) value from tracked
 union all select 'column:'||t.nspname||'.'||t.relname||'.'||a.attname,
 jsonb_build_array(a.attnum,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attgenerated,pg_get_expr(d.adbin,d.adrelid))
 from tracked t join pg_attribute a on a.attrelid=t.oid and a.attnum>0 and not a.attisdropped
 left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
 union all select 'constraint:'||n.nspname||'.'||c.relname||'.'||k.conname,to_jsonb(pg_get_constraintdef(k.oid,true))
 from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace
 -- PostgreSQL 18 additionally represents NOT NULL in pg_constraint; attnotnull above is the portable source.
 where k.contype<>'n' and (k.conrelid in(select oid from tracked) or k.confrelid in(select oid from tracked))
 union all select 'trigger:'||t.nspname||'.'||t.relname||'.'||g.tgname,to_jsonb(pg_get_triggerdef(g.oid,true))
 from tracked t join pg_trigger g on g.tgrelid=t.oid and not g.tgisinternal
 ) select encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(key,value) order by key),'[]'::jsonb)::text,'UTF8')),'hex') from objects

$catalog$;

create function pg_temp.sc19_routines_signature() returns text language sql stable set search_path='' as $catalog$
select fingerprint.digest from (
with objects as (
 select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' key,
 jsonb_build_array(pg_get_userbyid(p.proowner),pg_get_functiondef(p.oid)) value
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('public','private') and p.prokind in ('f','p')
 and not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')
 ) select encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(key,value) order by key collate "C"),'[]'::jsonb)::text,'UTF8')),'hex') digest,
 count(*)::int object_count,coalesce(jsonb_agg(jsonb_build_array(key,value) order by key collate "C"),'[]'::jsonb) manifest from objects
) fingerprint
$catalog$;

create function pg_temp.sc19_indexes_signature() returns text language sql stable set search_path='' as $catalog$
select fingerprint.digest from (
with objects as (
 select ns.nspname||'.'||ic.relname key,
 jsonb_build_array(tns.nspname||'.'||tc.relname,am.amname,i.indisunique,i.indisprimary,i.indisexclusion,
 i.indimmediate,i.indisvalid,i.indisready,i.indislive,i.indnullsnotdistinct,pg_get_indexdef(ic.oid)) value
 from pg_index i join pg_class ic on ic.oid=i.indexrelid join pg_namespace ns on ns.oid=ic.relnamespace
 join pg_class tc on tc.oid=i.indrelid join pg_namespace tns on tns.oid=tc.relnamespace join pg_am am on am.oid=ic.relam
 where tns.nspname in ('public','private') and not exists(select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=tc.oid and d.deptype='e')
 ) select encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(key,value) order by key collate "C"),'[]'::jsonb)::text,'UTF8')),'hex') digest,
 count(*)::int object_count,coalesce(jsonb_agg(jsonb_build_array(key,value) order by key collate "C"),'[]'::jsonb) manifest from objects
) fingerprint
$catalog$;

create function pg_temp.sc19_trigger_states_signature() returns text language sql stable set search_path='' as $catalog$
select fingerprint.digest from (
with objects as (
 select ns.nspname||'.'||c.relname||'.'||t.tgname key,
 jsonb_build_array(t.tgenabled,t.tgdeferrable,t.tginitdeferred,pg_get_triggerdef(t.oid,true)) value
 from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace ns on ns.oid=c.relnamespace
 where ns.nspname in ('public','private') and not t.tgisinternal
 ) select encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(key,value) order by key collate "C"),'[]'::jsonb)::text,'UTF8')),'hex') digest,
 count(*)::int object_count,coalesce(jsonb_agg(jsonb_build_array(key,value) order by key collate "C"),'[]'::jsonb) manifest from objects
) fingerprint
$catalog$;

create function pg_temp.sc19_relations_signature() returns text language sql stable set search_path='' as $catalog$
select fingerprint.digest from (
with objects as (
 select ns.nspname||'.'||c.relname key,
 jsonb_build_array(c.relkind,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner),c.relpersistence,
   (select coalesce(jsonb_agg(option order by option collate "C"),'[]'::jsonb) from unnest(c.reloptions) option)) value
 from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
 where ns.nspname in ('public','private') and c.relkind in ('r','p','v','m','f','S')
 and not exists(select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e')
 ) select encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(key,value) order by key collate "C"),'[]'::jsonb)::text,'UTF8')),'hex') digest,
 count(*)::int object_count,coalesce(jsonb_agg(jsonb_build_array(key,value) order by key collate "C"),'[]'::jsonb) manifest from objects
) fingerprint
$catalog$;

create function pg_temp.sc19_policies_signature() returns text language sql stable set search_path='' as $catalog$
select fingerprint.digest from (
with objects as (
 select n.nspname||'.'||c.relname||'.'||p.polname key,
 jsonb_build_array(p.polcmd,p.polpermissive,
 (select jsonb_agg(case when r=0 then 'PUBLIC' else pg_get_userbyid(r) end order by case when r=0 then 'PUBLIC' else pg_get_userbyid(r) end collate "C") from unnest(p.polroles) r),
 pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) value
 from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace
 where n.nspname in ('public','private')
 ) select encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(key,value) order by key collate "C"),'[]'::jsonb)::text,'UTF8')),'hex') digest,
 count(*)::int object_count,coalesce(jsonb_agg(jsonb_build_array(key,value) order by key collate "C"),'[]'::jsonb) manifest from objects
) fingerprint
$catalog$;

create function pg_temp.sc19_nonowned_acl_signature() returns text language sql stable set search_path='' as $catalog$
select fingerprint.digest from (
with acl_objects as (
  select (case when c.relkind='S' then 'sequence:' else 'table:' end)||n.nspname||'.'||c.relname as key,
    coalesce(c.relacl,acldefault(case when c.relkind='S' then 's'::"char" else 'r'::"char" end,c.relowner)) as acl
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in ('public','private') and c.relkind in ('r','p','v','m','f','S')
    and (n.nspname||'.'||c.relname) <> all(array['private.sc19_package_policy','private.sc19_balances','private.sc19_trial_nips','private.sc19_trial_approvals','private.sc19_analysis_spend','private.sc19_credit_journal','private.sc19_payment_offers','private.sc19_payment_orders','private.sc19_payment_requests','private.sc19_payment_grants','private.erasure_inventory_baseline_r5','private.erasure_inventory_baseline_r6'])
    and not exists(select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e')
  union all
  select 'column:'||n.nspname||'.'||c.relname||'.'||a.attname,a.attacl
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
  where n.nspname in ('public','private') and c.relkind in ('r','p','v','m','f')
    and (n.nspname||'.'||c.relname) <> all(array['private.sc19_package_policy','private.sc19_balances','private.sc19_trial_nips','private.sc19_trial_approvals','private.sc19_analysis_spend','private.sc19_credit_journal','private.sc19_payment_offers','private.sc19_payment_orders','private.sc19_payment_requests','private.sc19_payment_grants','private.erasure_inventory_baseline_r5','private.erasure_inventory_baseline_r6']) and cardinality(a.attacl)>0
    and not exists(select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e')
  union all
  select 'function:'||n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',
    coalesce(p.proacl,acldefault('f',p.proowner))
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in ('public','private') and p.prokind in ('f','p')
    and p.oid::regprocedure::text <> all(array['private.sc19_valid_nip(text)','private.sc19_lock_company(uuid)','private.sc19_lock_analysis_company()','private.sc19_grant_paid(uuid,text)','private.sc19_charge_analysis()','private.sc19_reconcile_analysis()','private.sc19_payment_immutable()','public.sc19_claim_trial(uuid,text)','public.sc19_package_sizes()','public.sc19_get_balance(uuid)'])
    and not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')
  union all
  select 'schema:'||n.nspname,coalesce(n.nspacl,acldefault('n',n.nspowner))
  from pg_namespace n where n.nspname in ('public','private')
    and not exists(select 1 from pg_depend d where d.classid='pg_namespace'::regclass and d.objid=n.oid and d.deptype='e')
), objects as (
  select o.key,coalesce((
    select jsonb_agg(jsonb_build_array(
      case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
      pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable
    ) order by
      (case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end) collate "C",
      pg_get_userbyid(a.grantor) collate "C",a.privilege_type collate "C",a.is_grantable)
    from aclexplode(o.acl) a
  ),'[]'::jsonb) as value from acl_objects o
)
select encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(key,value) order by key collate "C"),'[]'::jsonb)::text,'UTF8')),'hex') digest,
  count(*)::int object_count,
  coalesce(jsonb_agg(jsonb_build_array(key,value) order by key collate "C"),'[]'::jsonb) manifest
from objects
) fingerprint
$catalog$;

create function pg_temp.sc19_rewrites_signature() returns text language sql stable set search_path='' as $catalog$
select fingerprint.digest from (
with objects as (
 select n.nspname||'.'||c.relname||'.'||r.rulename key,
 jsonb_build_array(r.ev_type,r.is_instead,r.ev_enabled,pg_get_ruledef(r.oid,true),
   case when c.relkind in ('v','m') then pg_get_viewdef(c.oid,true) else null end) value
 from pg_rewrite r join pg_class c on c.oid=r.ev_class join pg_namespace n on n.oid=c.relnamespace
 where n.nspname in ('public','private')
 and not exists(select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e')
 ) select encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(key,value) order by key collate "C"),'[]'::jsonb)::text,'UTF8')),'hex') digest,
 count(*)::int object_count,coalesce(jsonb_agg(jsonb_build_array(key,value) order by key collate "C"),'[]'::jsonb) manifest from objects
) fingerprint
$catalog$;

create function pg_temp.sc19_catalog() returns jsonb language sql stable set search_path='' as $catalog$
select jsonb_build_object('sc010_signature',pg_temp.sc19_schema_signature(),'routines',pg_temp.sc19_routines_signature(),'indexes',pg_temp.sc19_indexes_signature(),'trigger_states',pg_temp.sc19_trigger_states_signature(),'relations',pg_temp.sc19_relations_signature(),'policies',pg_temp.sc19_policies_signature(),'nonowned_acl',pg_temp.sc19_nonowned_acl_signature(),'rewrites',pg_temp.sc19_rewrites_signature())
$catalog$;

create temporary table sc19_migration_state(source_state text primary key,voice boolean not null,reviewed_state text not null) on commit drop;

do $preflight$
declare observed jsonb; reviewed constant jsonb := '{"r4_legacy":{"pg16":{"sc010_signature":"d2e7725bd5051e15cb7e700a128026a3ad6f0d87f9d3bba3de8e1539c9d3eabd","routines":"94cd7648e37cb01a80ac2275c7d074d601d33a55d567fcc9bc42ce8565513c5f","indexes":"6914c23eb115e05186ed163a569f4e67d5677d56cf63c273d8861d3fcd7da38d","trigger_states":"89214d67680a0c2a6fb0d26c277783fb95fea921acbe9ef800b72234d5c4caff","relations":"e2a90771ec941a06b2d9b4797e6af72443cbe7f0c351dee29657e6470fafddf6","policies":"d7918648cf896d04731b18e4827399b4f9c0b21c243786f11aa2812fe18e8772","nonowned_acl":"80866fd7d14d5c596441703ac7f3ccc39dbc2ce9d6b9d0da1299e61b4c749a95","rewrites":"e9c6543bb90eae112800eec33f1bec5a733fc5e6194a92915f7ff1124fad897f"},"pg17":{"sc010_signature":"d2e7725bd5051e15cb7e700a128026a3ad6f0d87f9d3bba3de8e1539c9d3eabd","routines":"94cd7648e37cb01a80ac2275c7d074d601d33a55d567fcc9bc42ce8565513c5f","indexes":"6914c23eb115e05186ed163a569f4e67d5677d56cf63c273d8861d3fcd7da38d","trigger_states":"89214d67680a0c2a6fb0d26c277783fb95fea921acbe9ef800b72234d5c4caff","relations":"e2a90771ec941a06b2d9b4797e6af72443cbe7f0c351dee29657e6470fafddf6","policies":"d7918648cf896d04731b18e4827399b4f9c0b21c243786f11aa2812fe18e8772","nonowned_acl":"6428087b0877402ce4831d2c9998ad746f4d44155dc442bcb18997fdd3968b35","rewrites":"e9c6543bb90eae112800eec33f1bec5a733fc5e6194a92915f7ff1124fad897f"}},"r4_voice":{"pg16":{"sc010_signature":"70cdbf43562f147294c417639b76fe121154f4dc6e49799b9764232a4aedc444","routines":"ed6198a94bb18c64f30980d25f1fe8feed0b43905a62c1da6723a17dd3307f76","indexes":"7f31e2feb3d56f59bd5761d99564fdd322b219558dfdd550c3f12389fa3ddf4b","trigger_states":"93f58b25af9eee07fdcd98812a08f80074aa3fb29d4a6325a777734b01e1d66f","relations":"ed0cd753356afa244eff0541b63d0e1ba833c277bf4e3c1a3265f40b6f5dd4cc","policies":"5410709dbbb55712d829a6f6c1e01ac825f71a38473ec919d8c95030db0a6706","nonowned_acl":"7bd81fd322357484bcdda55d5bbecb0aae8c2bd0c020a4a441f8271d54c12059","rewrites":"e9c6543bb90eae112800eec33f1bec5a733fc5e6194a92915f7ff1124fad897f"},"pg17":{"sc010_signature":"70cdbf43562f147294c417639b76fe121154f4dc6e49799b9764232a4aedc444","routines":"ed6198a94bb18c64f30980d25f1fe8feed0b43905a62c1da6723a17dd3307f76","indexes":"7f31e2feb3d56f59bd5761d99564fdd322b219558dfdd550c3f12389fa3ddf4b","trigger_states":"93f58b25af9eee07fdcd98812a08f80074aa3fb29d4a6325a777734b01e1d66f","relations":"ed0cd753356afa244eff0541b63d0e1ba833c277bf4e3c1a3265f40b6f5dd4cc","policies":"5410709dbbb55712d829a6f6c1e01ac825f71a38473ec919d8c95030db0a6706","nonowned_acl":"64ad973471c4e5d668002d0220ea8210dbc72bcae188c90884f2648f17793a72","rewrites":"e9c6543bb90eae112800eec33f1bec5a733fc5e6194a92915f7ff1124fad897f"}},"r5_legacy":{"pg16":{"sc010_signature":"10358458d8802b1ed59a298b305752a89ce110d1019a11cde937f2a2311f79bc","routines":"d51b7e5e3a16bc6be5d364b1800bc4aab36b1148b6a0d5fad497f3e4ebba1837","indexes":"46f85e6eb33a1cf57c5f8413591f8efdba4719a05d698b97bb18a366a72cb6d4","trigger_states":"a371f473df135f28712553b8bff08441583052b52209141cba03c522986439c9","relations":"66a6db6ff9611f1c06db2f13eb5521e5800a7c37d8b6d68aa45e28efa710929d","policies":"d7918648cf896d04731b18e4827399b4f9c0b21c243786f11aa2812fe18e8772","nonowned_acl":"80866fd7d14d5c596441703ac7f3ccc39dbc2ce9d6b9d0da1299e61b4c749a95","rewrites":"e9c6543bb90eae112800eec33f1bec5a733fc5e6194a92915f7ff1124fad897f"},"pg17":{"sc010_signature":"10358458d8802b1ed59a298b305752a89ce110d1019a11cde937f2a2311f79bc","routines":"d51b7e5e3a16bc6be5d364b1800bc4aab36b1148b6a0d5fad497f3e4ebba1837","indexes":"46f85e6eb33a1cf57c5f8413591f8efdba4719a05d698b97bb18a366a72cb6d4","trigger_states":"a371f473df135f28712553b8bff08441583052b52209141cba03c522986439c9","relations":"66a6db6ff9611f1c06db2f13eb5521e5800a7c37d8b6d68aa45e28efa710929d","policies":"d7918648cf896d04731b18e4827399b4f9c0b21c243786f11aa2812fe18e8772","nonowned_acl":"6428087b0877402ce4831d2c9998ad746f4d44155dc442bcb18997fdd3968b35","rewrites":"e9c6543bb90eae112800eec33f1bec5a733fc5e6194a92915f7ff1124fad897f"}},"r5_voice":{"pg16":{"sc010_signature":"c989b84b9eec51fc48c361b8ad9e7404b4044268d56d106b6788fe56f3f1857d","routines":"bd792cc8a27a594920a785522ed738f950e053aba573ad5e2ca7d83596d88a38","indexes":"7c42f79c632912c67ce0acd34b566c08b887a7ab48fd5021cc95766baa1be6a1","trigger_states":"16ec952d94e1387937bba227daa8939d78350f5a64a73d50945ee75e53db6ee0","relations":"c4b529a6b06997e7375a9ed4d0caedd94beffb8f1480538c1537a9c33bfd5e99","policies":"5410709dbbb55712d829a6f6c1e01ac825f71a38473ec919d8c95030db0a6706","nonowned_acl":"7bd81fd322357484bcdda55d5bbecb0aae8c2bd0c020a4a441f8271d54c12059","rewrites":"e9c6543bb90eae112800eec33f1bec5a733fc5e6194a92915f7ff1124fad897f"},"pg17":{"sc010_signature":"c989b84b9eec51fc48c361b8ad9e7404b4044268d56d106b6788fe56f3f1857d","routines":"bd792cc8a27a594920a785522ed738f950e053aba573ad5e2ca7d83596d88a38","indexes":"7c42f79c632912c67ce0acd34b566c08b887a7ab48fd5021cc95766baa1be6a1","trigger_states":"16ec952d94e1387937bba227daa8939d78350f5a64a73d50945ee75e53db6ee0","relations":"c4b529a6b06997e7375a9ed4d0caedd94beffb8f1480538c1537a9c33bfd5e99","policies":"5410709dbbb55712d829a6f6c1e01ac825f71a38473ec919d8c95030db0a6706","nonowned_acl":"64ad973471c4e5d668002d0220ea8210dbc72bcae188c90884f2648f17793a72","rewrites":"e9c6543bb90eae112800eec33f1bec5a733fc5e6194a92915f7ff1124fad897f"}},"orders129_legacy":{"pg16":{"sc010_signature":"66868ec85c1eff74ffa91b10914023f5869edb3b55039c9c070de8b4ca6d5c5a","routines":"9440c475ae25b5b624f0ce42eea0a2dba95af45b89a894b3f32fc24c8f18d1a6","indexes":"2fb8d07fbfa72ba959585fa7695c1b1a2a4aa9f4bde9c279c6c9e1f8468242d1","trigger_states":"46e2f0d3f1935ce8f1ec6f467d5a11b6e03d26d5c961ea516f9a273d918c6a40","relations":"f9096086a619e3d07a5cdb256e06444641879079cf047ce01a2a50eef1ea7613","policies":"d7918648cf896d04731b18e4827399b4f9c0b21c243786f11aa2812fe18e8772","nonowned_acl":"80866fd7d14d5c596441703ac7f3ccc39dbc2ce9d6b9d0da1299e61b4c749a95","rewrites":"e9c6543bb90eae112800eec33f1bec5a733fc5e6194a92915f7ff1124fad897f"},"pg17":{"sc010_signature":"66868ec85c1eff74ffa91b10914023f5869edb3b55039c9c070de8b4ca6d5c5a","routines":"9440c475ae25b5b624f0ce42eea0a2dba95af45b89a894b3f32fc24c8f18d1a6","indexes":"2fb8d07fbfa72ba959585fa7695c1b1a2a4aa9f4bde9c279c6c9e1f8468242d1","trigger_states":"46e2f0d3f1935ce8f1ec6f467d5a11b6e03d26d5c961ea516f9a273d918c6a40","relations":"f9096086a619e3d07a5cdb256e06444641879079cf047ce01a2a50eef1ea7613","policies":"d7918648cf896d04731b18e4827399b4f9c0b21c243786f11aa2812fe18e8772","nonowned_acl":"6428087b0877402ce4831d2c9998ad746f4d44155dc442bcb18997fdd3968b35","rewrites":"e9c6543bb90eae112800eec33f1bec5a733fc5e6194a92915f7ff1124fad897f"}},"orders152_legacy":{"pg16":{"sc010_signature":"7055c0c3262ce1553944812929aa625857edbd3c1e353c3c52939ee5f1a64254","routines":"d571992052ecd526cd6c648085d87f01a4fedb3089417b0665b5495459d19a9b","indexes":"093ed79a24a982179f1a9de43ed060cfcf3d55ad36ac2f2fd47407ecee743caa","trigger_states":"34a96f7b185f2c04f651ba61a70ff284ce542862af1ce24556914b38fd1b0513","relations":"bd31002a7575712be5999c53591904849eb9f2aa10fa1e42607f67851a334501","policies":"d7918648cf896d04731b18e4827399b4f9c0b21c243786f11aa2812fe18e8772","nonowned_acl":"80866fd7d14d5c596441703ac7f3ccc39dbc2ce9d6b9d0da1299e61b4c749a95","rewrites":"e9c6543bb90eae112800eec33f1bec5a733fc5e6194a92915f7ff1124fad897f"},"pg17":{"sc010_signature":"7055c0c3262ce1553944812929aa625857edbd3c1e353c3c52939ee5f1a64254","routines":"d571992052ecd526cd6c648085d87f01a4fedb3089417b0665b5495459d19a9b","indexes":"093ed79a24a982179f1a9de43ed060cfcf3d55ad36ac2f2fd47407ecee743caa","trigger_states":"34a96f7b185f2c04f651ba61a70ff284ce542862af1ce24556914b38fd1b0513","relations":"bd31002a7575712be5999c53591904849eb9f2aa10fa1e42607f67851a334501","policies":"d7918648cf896d04731b18e4827399b4f9c0b21c243786f11aa2812fe18e8772","nonowned_acl":"6428087b0877402ce4831d2c9998ad746f4d44155dc442bcb18997fdd3968b35","rewrites":"e9c6543bb90eae112800eec33f1bec5a733fc5e6194a92915f7ff1124fad897f"}},"production_hosted_20261030":{"pg17":{"sc010_signature":"d2e7725bd5051e15cb7e700a128026a3ad6f0d87f9d3bba3de8e1539c9d3eabd","routines":"00a80249fa7ae58ee90bd25b8c5f29b3f9778dd1ed3de891abab14b198c557e7","indexes":"6914c23eb115e05186ed163a569f4e67d5677d56cf63c273d8861d3fcd7da38d","trigger_states":"89214d67680a0c2a6fb0d26c277783fb95fea921acbe9ef800b72234d5c4caff","relations":"e2a90771ec941a06b2d9b4797e6af72443cbe7f0c351dee29657e6470fafddf6","policies":"d7918648cf896d04731b18e4827399b4f9c0b21c243786f11aa2812fe18e8772","nonowned_acl":"6428087b0877402ce4831d2c9998ad746f4d44155dc442bcb18997fdd3968b35","rewrites":"e9c6543bb90eae112800eec33f1bec5a733fc5e6194a92915f7ff1124fad897f"}}}'::jsonb; chosen text; relation record; role_record record;
begin

  if current_setting('server_version_num')::integer / 10000 not in (16,17) then
    raise exception 'sc19_postgresql_major_unreviewed' using errcode='55000';
  end if;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private') and p.prokind not in ('f','p')
    and not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')) then
    raise exception 'sc19_routine_kind_unreviewed' using errcode='55000';
  end if;
  observed:=pg_temp.sc19_catalog();
  select entry.key into chosen from jsonb_each(reviewed) entry
    where entry.value->('pg'||(current_setting('server_version_num')::integer/10000)::text)=observed;
  if chosen is null then
    raise exception 'sc19_source_schema_unreviewed' using errcode='55000';
  end if;

  -- Company first, then a deterministic relation order. An offline drain window
  -- is required: timeout refuses concurrent work rather than racing its writes.
  lock table public.companies in access exclusive mode;
  for relation in select n.nspname,c.relname from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','private') and c.relkind in ('r','p')
      and c.oid<>'public.companies'::regclass
    order by n.nspname collate "C",c.relname collate "C"
  loop
    execute format('lock table %I.%I in access exclusive mode',relation.nspname,relation.relname);
  end loop;
  if pg_temp.sc19_catalog() is distinct from observed then
    raise exception 'sc19_source_changed_during_lock' using errcode='55000';
  end if;

  -- Internal FK trigger names contain OIDs and are not fingerprinted. Their
  -- enabled/validated state must still enforce the reviewed tenant references.
  if exists(select 1 from pg_constraint c
    join pg_class r on r.oid=c.conrelid join pg_namespace n on n.oid=r.relnamespace
    where c.contype='f' and (n.nspname in ('public','private') or c.confrelid in
      (select r2.oid from pg_class r2 join pg_namespace n2 on n2.oid=r2.relnamespace where n2.nspname in ('public','private'))) and not c.convalidated)
    or exists(select 1 from pg_trigger t join pg_constraint c on c.oid=t.tgconstraint
      join pg_class r on r.oid=c.conrelid join pg_namespace n on n.oid=r.relnamespace
      where t.tgisinternal and c.contype='f' and (n.nspname in ('public','private') or c.confrelid in
        (select r2.oid from pg_class r2 join pg_namespace n2 on n2.oid=r2.relnamespace where n2.nspname in ('public','private'))) and t.tgenabled<>'O') then
    raise exception 'sc19_foreign_key_enforcement_unreviewed' using errcode='55000';
  end if;

  -- Never promote a login/BYPASSRLS/inheriting worker, or a membership that
  -- would expose its privileged routines. postgres SET ROLE worker (no inherit)
  -- is the one reviewed operational membership accepted for screening_worker.
  for role_record in select * from pg_roles where rolname in
    ('screening_worker','contact_verifier','erasure_worker','erasure_ledger_attestor',
     'erasure_restore_attestor','erasure_purge_owner','erasure_scheduler')
  loop
    if role_record.rolcanlogin or role_record.rolsuper or role_record.rolinherit
      or role_record.rolcreatedb or role_record.rolcreaterole
      or role_record.rolreplication or role_record.rolbypassrls
      or exists(select 1 from pg_auth_members m where
        (m.roleid=role_record.oid or m.member=role_record.oid)
        and not ((role_record.rolname='screening_worker' and m.roleid=role_record.oid
          and pg_get_userbyid(m.member)='postgres' and pg_get_userbyid(m.grantor)='postgres'
          and not m.admin_option and not m.inherit_option and m.set_option) or (current_user='postgres' and current_setting('server_version_num')::integer/10000 in (16,17)
          and m.roleid=role_record.oid and exists(select 1 from pg_roles where oid=m.member and rolname='postgres' and not rolsuper and rolinherit and rolcreaterole and rolcreatedb and rolcanlogin and rolreplication and rolbypassrls)
          and exists(select 1 from pg_roles where oid=m.grantor and rolname='supabase_admin' and oid=10 and rolsuper and rolinherit and rolcreaterole and rolcreatedb and rolcanlogin and rolreplication and rolbypassrls)
          and m.admin_option and not m.inherit_option and not m.set_option))) then
      raise exception 'sc19_unsafe_worker_role:%',role_record.rolname using errcode='42501';
    end if;
  end loop;
  if (select count(*) from pg_roles where rolname in
    ('screening_worker','contact_verifier','erasure_worker','erasure_ledger_attestor',
     'erasure_restore_attestor','erasure_purge_owner','erasure_scheduler'))<>7 then
    raise exception 'sc19_required_role_missing' using errcode='55000';
  end if;

  -- Browser roles must not bypass the unchanged RLS/tenant boundary. INHERIT
  -- itself is allowed; privileged worker memberships are checked above.
  for role_record in select * from pg_roles where rolname in ('anon','authenticated') loop
    if role_record.rolcanlogin or role_record.rolsuper or role_record.rolcreatedb
      or role_record.rolcreaterole or role_record.rolreplication or role_record.rolbypassrls
      or exists(select 1 from pg_auth_members m where m.member=role_record.oid) then
      raise exception 'sc19_unsafe_browser_role:%',role_record.rolname using errcode='42501';
    end if;
  end loop;
  if (select count(*) from pg_roles where rolname in ('anon','authenticated'))<>2 then
    raise exception 'sc19_required_browser_role_missing' using errcode='55000';
  end if;

  -- The old restore protocol binds signed history to its old schema. v1 does
  -- not migrate those obligations, even when the execution is terminal.
  if exists(select 1 from private.erasure_executions)
    or exists(select 1 from private.erasure_verified_ledger_events)
    or exists(select 1 from private.erasure_receipts)
    or exists(select 1 from private.retired_candidate_ids)
    or exists(select 1 from private.erasure_restore_checkpoint)
    or exists(select 1 from private.erasure_requests)
    or exists(select 1 from private.erasure_candidate_lifecycle)
    or exists(select 1 from private.erasure_purge_manifest)
    or exists(select 1 from private.erasure_purge_context)
    or exists(select 1 from private.erasure_purge_context_rows)
    or exists(select 1 from private.retention_authorizations) then
    raise exception 'sc19_signed_erasure_history_transition_required' using errcode='55000';
  end if;
  -- production_hosted_20261030 is r4_legacy as deployed on production (PG17): identical except
  -- that 13 functions created from 2026-10-01..04 sources carry CRLF line endings. Read-only
  -- inspect run 41021636267; reproduced by tests/sc-019-migrations-production-hosted-state.test.mjs.
  insert into pg_temp.sc19_migration_state values(case chosen when 'production_hosted_20261030' then 'r4_legacy' else chosen end,chosen like '%_voice',chosen);
end
$preflight$;

-- Static object-list comparisons use C order on both sides, independent of database locale.

do $baseline_data$ begin
if (select schema_signature from private.erasure_inventory_baseline_r4 where singleton) is distinct from 'd2e7725bd5051e15cb7e700a128026a3ad6f0d87f9d3bba3de8e1539c9d3eabd'
 or (select array_agg(x order by x collate "C") from private.erasure_inventory_baseline_r4 b,unnest(b.known_tables) x where singleton)
 is distinct from array['private.candidate_retention_policies','private.candidate_verified_contact_points','private.candidate_verified_contact_receipts','private.contact_audit','private.contact_policy_templates','private.contact_requests','private.contact_trusted_issuers','private.erasure_candidate_lifecycle','private.erasure_configuration_requests','private.erasure_denial_context','private.erasure_execution_config','private.erasure_executions','private.erasure_holds','private.erasure_inventory_baseline','private.erasure_inventory_baseline_r2','private.erasure_inventory_baseline_r3','private.erasure_inventory_baseline_r4','private.erasure_lifecycle_commands','private.erasure_lifecycle_events','private.erasure_preview_tickets','private.erasure_purge_context','private.erasure_purge_context_rows','private.erasure_purge_manifest','private.erasure_receipts','private.erasure_requests','private.erasure_restore_checkpoint','private.erasure_subject_resolutions','private.erasure_verified_ledger_events','private.retention_authorizations','private.retention_candidate_clocks','private.retention_delegations','private.retention_schedule_commands','private.retention_suggestions','private.retention_ticks','private.retired_candidate_ids','private.sales_lead_attempts','private.sales_lead_closures','private.sales_lead_replay_state','private.sales_lead_settings','private.sales_mail_outbox','private.sales_mail_settings','private.sales_pipeline','private.sales_pipeline_events','private.screening_ranking_policies','public.applications','public.assessment_stages','public.behavior_assessment_entries','public.candidate_assessments','public.candidate_communication_approvals','public.candidate_communication_events','public.candidate_communications','public.candidate_contact_permissions','public.candidate_contact_preferences','public.candidate_documents','public.candidates','public.companies','public.company_members','public.company_profiles','public.exercise_definition_entries','public.exercise_observation_entries','public.platform_operators','public.positions','public.recruitment_shortlist_entries','public.recruitments','public.sales_leads','public.screening_analysis_attempts','public.screening_analysis_versions','public.screening_criterion_results','public.screening_criterion_review_overrides','public.screening_result_reviews'] then
raise exception 'sc19_existing_erasure_inventory_baseline_r4_data_unreviewed' using errcode='55000';
end if;
end $baseline_data$;

do $baseline_data$ begin
if (select voice from pg_temp.sc19_migration_state) then
if (select schema_signature from private.erasure_inventory_baseline_r4_voice where singleton) is distinct from '70cdbf43562f147294c417639b76fe121154f4dc6e49799b9764232a4aedc444'
 or (select array_agg(x order by x collate "C") from private.erasure_inventory_baseline_r4_voice b,unnest(b.known_tables) x where singleton)
 is distinct from array['private.candidate_retention_policies','private.candidate_verified_contact_points','private.candidate_verified_contact_receipts','private.contact_audit','private.contact_policy_templates','private.contact_requests','private.contact_trusted_issuers','private.erasure_candidate_lifecycle','private.erasure_configuration_requests','private.erasure_denial_context','private.erasure_execution_config','private.erasure_executions','private.erasure_holds','private.erasure_inventory_baseline','private.erasure_inventory_baseline_r2','private.erasure_inventory_baseline_r3','private.erasure_inventory_baseline_r4','private.erasure_inventory_baseline_r4_voice','private.erasure_lifecycle_commands','private.erasure_lifecycle_events','private.erasure_preview_tickets','private.erasure_purge_context','private.erasure_purge_context_rows','private.erasure_purge_manifest','private.erasure_receipts','private.erasure_requests','private.erasure_restore_checkpoint','private.erasure_subject_resolutions','private.erasure_verified_ledger_events','private.retention_authorizations','private.retention_candidate_clocks','private.retention_delegations','private.retention_schedule_commands','private.retention_suggestions','private.retention_ticks','private.retired_candidate_ids','private.sales_lead_attempts','private.sales_lead_closures','private.sales_lead_replay_state','private.sales_lead_settings','private.sales_mail_outbox','private.sales_mail_settings','private.sales_pipeline','private.sales_pipeline_events','private.sc010c_voice_preparation_requests','private.sc010c_voice_preparations','private.sc19_voice_entitlements','private.screening_ranking_policies','private.voice_interview_permission_issuers','private.voice_interview_permission_policies','private.voice_interview_permission_receipts','private.voice_interview_permission_revocations','private.voice_plan_current_releases','private.voice_plan_release_entries','private.voice_plan_request_keys','private.voice_plan_review_entries','private.voice_plan_template_catalog','public.applications','public.assessment_stages','public.behavior_assessment_entries','public.candidate_assessments','public.candidate_communication_approvals','public.candidate_communication_events','public.candidate_communications','public.candidate_contact_permissions','public.candidate_contact_preferences','public.candidate_documents','public.candidates','public.companies','public.company_members','public.company_profiles','public.exercise_definition_entries','public.exercise_observation_entries','public.platform_operators','public.positions','public.recruitment_shortlist_entries','public.recruitments','public.sales_leads','public.screening_analysis_attempts','public.screening_analysis_versions','public.screening_criterion_results','public.screening_criterion_review_overrides','public.screening_result_reviews','public.voice_plan_versions'] then
raise exception 'sc19_existing_erasure_inventory_baseline_r4_voice_data_unreviewed' using errcode='55000';
end if;
end if;
end $baseline_data$;

-- Existing accounting policy/data are adopted, never re-seeded or recomputed.
do $payment_data_preflight$
begin
  if to_regclass('private.sc19_package_policy') is not null then
    if (select array_agg(plan order by plan collate "C") from private.sc19_package_policy)
       is distinct from array['FREE','PRESELEKCJA'] then
      raise exception 'sc19_package_policy_incomplete' using errcode='55000';
    end if;
  end if;
  if to_regclass('private.sc19_payment_orders') is not null then
    if exists(select 1 from private.sc19_payment_orders where status='awaiting_payment'
      group by company_id having count(*)>1) then
      raise exception 'sc19_duplicate_unresolved_orders' using errcode='55000';
    end if;
    if exists(select 1 from private.sc19_payment_orders o
      left join private.sc19_payment_grants g on g.order_id=o.id
      where (o.status='paid' and g.order_id is null)
         or (o.status='awaiting_payment' and g.order_id is not null))
      or exists(select 1 from private.sc19_payment_grants g
        join private.sc19_payment_orders o on o.id=g.order_id
        left join private.sc19_credit_journal j on
          j.reference='settlement:sc19:'||encode(sha256(convert_to(g.payment_key,'UTF8')),'hex')
        where g.payment_key is distinct from
          '['||to_json(o.provider)::text||','||to_json(o.account)::text||','||to_json(o.mode)::text||','||to_json(o.payment_id)::text||']'
          or j.id is null or j.company_id<>o.company_id
          or j.reason<>'paid_grant' or j.delta<>o.credits) then
      raise exception 'sc19_payment_accounting_inconsistent' using errcode='55000';
    end if;
  end if;
end
$payment_data_preflight$;

do $credit_tables$ begin
if to_regclass('private.sc19_balances') is null then
-- Operator-controlled quota policy. Fresh installs remain unconfigured;
-- the later approved policy is a separate operation, not a migration default.
create table private.sc19_package_policy (
  plan text primary key check(plan in ('FREE','PRESELEKCJA')),
  credits integer not null check(credits between 1 and 100000),
  updated_at timestamptz not null default now()
);
revoke all on private.sc19_package_policy from public,anon,authenticated;
alter table private.sc19_package_policy enable row level security;

-- Audit clock for operator credit changes. Uses private.touch_updated_at()
-- from 20260930000100_skillcheck_core.sql and does not redefine it.
-- A caller-supplied updated_at is overwritten, so the stamp cannot be backdated.
do $$
begin
  if to_regprocedure('private.touch_updated_at()') is null then
    raise exception 'sc19_missing_touch_updated_at' using errcode = '55000';
  end if;
end
$$;
create trigger touch_updated_at
  before update on private.sc19_package_policy
  for each row execute function private.touch_updated_at();

create table private.sc19_balances (
  company_id uuid primary key references public.companies(id) on delete restrict,
  plan text not null check(plan in ('FREE','PRESELEKCJA')),
  available integer not null default 0 check (available >= 0),
  free_claimed boolean not null default false,
  updated_at timestamptz not null default now()
);
create table private.sc19_trial_nips (
  company_id uuid primary key references public.companies(id) on delete restrict,
  nip text not null unique check(nip ~ '^[0-9]{10}$'),
  claimed_at timestamptz not null default now()
);

-- An owner-selected checksum-valid NIP does not prove legal representation.
-- FREE activation is blocked until the operator verifies the company/NIP
-- relationship and inserts an approval using privileged, audited SQL.
create table private.sc19_trial_approvals (
  company_id uuid primary key references public.companies(id) on delete restrict,
  nip text not null unique check(nip ~ '^[0-9]{10}$'),
  proof_reference text not null unique check(length(btrim(proof_reference)) between 8 and 160),
  approved_at timestamptz not null default now()
);
create table private.sc19_analysis_spend (
  analysis_id uuid primary key,
  company_id uuid not null references public.companies(id) on delete restrict,
  state text not null check(state in ('reserved','released')),
  updated_at timestamptz not null default now()
);
create table private.sc19_credit_journal (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  analysis_id uuid,
  reason text not null check(reason in ('trial','paid_grant','analysis_reserve','analysis_release','analysis_retry')),
  delta integer not null check(delta <> 0),
  reference text,
  created_at timestamptz not null default now(),
  unique (reference)
);

-- Only SQL operator privileges can grant a paid pack. No user-facing direct
-- balance/journal CRUD. NIP is never included in public balance responses.
revoke all on private.sc19_balances, private.sc19_trial_nips,
  private.sc19_trial_approvals, private.sc19_analysis_spend,
  private.sc19_credit_journal from public, anon, authenticated;
alter table private.sc19_balances enable row level security;
alter table private.sc19_trial_nips enable row level security;
alter table private.sc19_trial_approvals enable row level security;
alter table private.sc19_analysis_spend enable row level security;
alter table private.sc19_credit_journal enable row level security;


end if;
end $credit_tables$;

create or replace function private.sc19_valid_nip(value text)
returns boolean language sql immutable set search_path = '' as $$
  -- CASE ensures only digit strings reach integer casts, including in PG16.
  select case when value ~ '^[0-9]{10}$' then
    (
      (substring(value,1,1)::int*6 + substring(value,2,1)::int*5
      + substring(value,3,1)::int*7 + substring(value,4,1)::int*2
      + substring(value,5,1)::int*3 + substring(value,6,1)::int*4
      + substring(value,7,1)::int*5 + substring(value,8,1)::int*6
      + substring(value,9,1)::int*7) % 11
    ) = substring(value,10,1)::int
  else false end;
$$;
revoke all on function private.sc19_valid_nip(text) from public, anon, authenticated;

-- Every billing write locks the company row before the balance, spend, or journal
-- row. Analysis inserts also take a foreign-key key-share lock on the company,
-- so the opposite order deadlocks with sc19_grant_paid.
create or replace function private.sc19_lock_company(target_company uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if target_company is null then
    raise exception 'sc19_company_missing' using errcode='22023';
  end if;
  perform 1 from public.companies where id=target_company for update;
  if not found then raise exception 'sc19_company_missing' using errcode='22023'; end if;
end;
$$;
revoke all on function private.sc19_lock_company(uuid) from public, anon, authenticated;

-- The analysis insert's foreign key takes a key-share lock on the company row
-- before an AFTER trigger runs. Taking the stronger company lock there deadlocks
-- two concurrent inserts. Lock first, while the insert is still BEFORE.
create or replace function private.sc19_lock_analysis_company()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.sc19_lock_company(new.company_id);
  return new;
end;
$$;
revoke all on function private.sc19_lock_analysis_company() from public, anon, authenticated;

create or replace function public.sc19_claim_trial(target_company uuid, supplied_nip text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  normalized text := replace(replace(btrim(coalesce(supplied_nip,'')), '-', ''), ' ', '');
  existing_nip text;
  current_credits integer;
  trial_credits integer;
begin
  if (select auth.uid()) is null or not private.is_company_owner(target_company) then
    raise exception 'sc19_company_forbidden' using errcode = '42501';
  end if;
  if not private.sc19_valid_nip(normalized) then
    raise exception 'sc19_invalid_nip' using errcode = '22023';
  end if;
  -- Serialize per company and use a globally UNIQUE NIP across all owners.
  perform private.sc19_lock_company(target_company);
  select nip into existing_nip from private.sc19_trial_nips where company_id=target_company;
  if existing_nip is not null then
    if existing_nip <> normalized then
      raise exception 'sc19_trial_already_claimed' using errcode = '23505';
    end if;
    select available into current_credits from private.sc19_balances where company_id=target_company;
    return current_credits; -- same company, same NIP = idempotent, no extra grant
  end if;
  if not exists (
    select 1 from private.sc19_trial_approvals approval
    where approval.company_id=target_company and approval.nip=normalized
  ) then
    raise exception 'sc19_trial_requires_verified_company' using errcode='42501';
  end if;
  -- FREE is only the pre-payment trial. A paid pack must not receive a late bonus.
  if exists (
    select 1 from private.sc19_balances
    where company_id=target_company and plan='PRESELEKCJA'
  ) then
    raise exception 'sc19_trial_after_payment' using errcode='23505';
  end if;
  select credits into trial_credits from private.sc19_package_policy where plan='FREE';
  if trial_credits is null then raise exception 'sc19_missing_free_policy' using errcode='55000'; end if;
  insert into private.sc19_trial_nips(company_id,nip) values (target_company,normalized);
  insert into private.sc19_balances(company_id,plan,available,free_claimed)
    values(target_company,'FREE',trial_credits,true)
    on conflict(company_id) do update
      set available=private.sc19_balances.available+trial_credits,free_claimed=true,updated_at=now()
      where not private.sc19_balances.free_claimed
        and private.sc19_balances.plan<>'PRESELEKCJA';
  if not found then raise exception 'sc19_trial_already_claimed' using errcode='23505'; end if;
  insert into private.sc19_credit_journal(company_id,reason,delta,reference)
    values(target_company,'trial',trial_credits,'trial:'||normalized);
  select available into current_credits from private.sc19_balances where company_id=target_company;
  return current_credits;
end;
$$;
revoke all on function public.sc19_claim_trial(uuid,text) from public, anon, authenticated;
grant execute on function public.sc19_claim_trial(uuid,text) to authenticated;

create or replace function public.sc19_get_balance(target_company uuid)
returns table(plan text,available integer,free_claimed boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or not private.has_company_access(target_company, false) then
    raise exception 'sc19_company_forbidden' using errcode='42501';
  end if;
  return query select b.plan,b.available,b.free_claimed
    from private.sc19_balances b where b.company_id=target_company;
end;
$$;
revoke all on function public.sc19_get_balance(uuid) from public, anon, authenticated;
grant execute on function public.sc19_get_balance(uuid) to authenticated;

-- Canonical customer-facing package sizes. Plan and credits only: no balances,
-- NIP, journal, settlement references, or proof data. The private table stays
-- revoked. anon serves the public offer; authenticated serves the billing panel.
create or replace function public.sc19_package_sizes()
returns table(plan text, credits integer)
language sql stable security definer set search_path = '' as $$
  select policy.plan, policy.credits
  from private.sc19_package_policy policy
  order by policy.plan;
$$;
revoke all on function public.sc19_package_sizes() from public, anon, authenticated;
grant execute on function public.sc19_package_sizes() to anon, authenticated;


-- MANUAL PAID FULFILLMENT ONLY: call from trusted admin SQL after confirming
-- bank settlement / external processor settlement. Never GRANT to authenticated.
create or replace function private.sc19_grant_paid(target_company uuid, settlement_reference text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  prior_company uuid;
  credits integer;
  paid_credits integer;
begin
  if length(btrim(coalesce(settlement_reference,''))) not between 8 and 160 then
    raise exception 'sc19_invalid_settlement' using errcode='22023';
  end if;
  perform private.sc19_lock_company(target_company);
  select company_id into prior_company from private.sc19_credit_journal
    where reference='settlement:'||btrim(settlement_reference);
  if prior_company is not null then
    if prior_company <> target_company then
      raise exception 'sc19_reference_conflict' using errcode='23505';
    end if;
    select available into credits from private.sc19_balances where company_id=target_company;
    return credits; -- same payment, no second grant
  end if;
  select p.credits into paid_credits from private.sc19_package_policy p where p.plan='PRESELEKCJA';
  if paid_credits is null then raise exception 'sc19_missing_paid_policy' using errcode='55000'; end if;
  insert into private.sc19_balances(company_id,plan,available)
    values(target_company,'PRESELEKCJA',paid_credits)
    on conflict(company_id) do update
      set plan='PRESELEKCJA',available=private.sc19_balances.available+paid_credits,updated_at=now();
  insert into private.sc19_credit_journal(company_id,reason,delta,reference)
    values(target_company,'paid_grant',paid_credits,'settlement:'||btrim(settlement_reference));
  select available into credits from private.sc19_balances where company_id=target_company;
  return credits;
end;
$$;
revoke all on function private.sc19_grant_paid(uuid,text) from public, anon, authenticated;

-- DB TRIGGER, not frontend check: all entrypoints including legacy screening RPC
-- are billed on a newly INSERTed logical analysis. Completed reuse does not INSERT.
-- The company row is locked before the balance so a paid grant cannot deadlock.
create or replace function private.sc19_charge_analysis()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.sc19_lock_company(new.company_id);
  update private.sc19_balances
    set available=available-1,updated_at=now()
    where company_id=new.company_id and available>0;
  if not found then raise exception 'sc19_quota_exhausted' using errcode='PT402'; end if;
  insert into private.sc19_analysis_spend(analysis_id,company_id,state)
    values(new.id,new.company_id,'reserved');
  insert into private.sc19_credit_journal(company_id,analysis_id,reason,delta)
    values(new.company_id,new.id,'analysis_reserve',-1);
  return null;
end;
$$;
revoke all on function private.sc19_charge_analysis() from public, anon, authenticated;

-- Fail/cancel refunds exactly once; same-analysis retry re-reserves exactly once.
-- Staling a pending or processing analysis abandons its active attempt, cancels
-- the analysis, and releases its reservation. A completed analysis that later
-- becomes stale keeps the credit already consumed.
create or replace function private.sc19_reconcile_analysis()
returns trigger language plpgsql security definer set search_path = '' as $$
declare previous_state text;
begin
  perform private.sc19_lock_company(new.company_id);
  if old.stale_at is null and new.stale_at is not null
     and new.execution_status in ('pending','processing') then
    -- Same reconciliation as claim_screening_attempt: a pending or processing
    -- attempt cannot stay active after this cancellation, or the worker can
    -- no longer record token and cost metadata for the refunded credit.
    -- The analysis row is already locked by the statement that set stale_at.
    -- The company row is locked above, and the attempt row is locked here.
    -- claim_screening_attempt uses that same order when it is installed.
    -- The isolated billing fixture has no attempts table.
    if to_regclass('public.screening_analysis_attempts') is not null then
      update public.screening_analysis_attempts
        set status='abandoned', finished_at=clock_timestamp()
        where company_id=new.company_id and analysis_id=new.id
          and status in ('pending','processing');
    end if;
    update public.screening_analysis_versions
      set execution_status='cancelled'
      where id=new.id and company_id=new.company_id
        and execution_status in ('pending','processing');
    return null;
  end if;
  if old.execution_status is not distinct from new.execution_status then return null; end if;
  -- Terminal analyses cannot be resurrected or reclassified to obtain a free
  -- refund. Only a failed/cancelled analysis may re-enter 'pending', and that
  -- transition must reserve another credit atomically below.
  if old.execution_status in ('completed', 'failed', 'cancelled')
    and not (old.execution_status in ('failed', 'cancelled')
      and new.execution_status = 'pending') then
    raise exception 'sc19_invalid_terminal_transition' using errcode = '55000';
  end if;
  select state into previous_state from private.sc19_analysis_spend
    where analysis_id=new.id and company_id=new.company_id for update;
  if previous_state is null then raise exception 'sc19_spend_missing' using errcode='23503'; end if;
  if new.execution_status in ('failed','cancelled') and previous_state='reserved' then
    update private.sc19_balances set available=available+1,updated_at=now()
      where company_id=new.company_id;
    update private.sc19_analysis_spend set state='released',updated_at=now() where analysis_id=new.id;
    insert into private.sc19_credit_journal(company_id,analysis_id,reason,delta)
      values(new.company_id,new.id,'analysis_release',1);
  elsif new.execution_status='pending' and old.execution_status in ('failed','cancelled')
    and previous_state='released' then
    update private.sc19_balances set available=available-1,updated_at=now()
      where company_id=new.company_id and available>0;
    if not found then raise exception 'sc19_quota_exhausted' using errcode='PT402'; end if;
    update private.sc19_analysis_spend set state='reserved',updated_at=now() where analysis_id=new.id;
    insert into private.sc19_credit_journal(company_id,analysis_id,reason,delta)
      values(new.company_id,new.id,'analysis_retry',-1);
  end if;
  return null;
end;
$$;
revoke all on function private.sc19_reconcile_analysis() from public, anon, authenticated;

-- Refuse to arm billing while an in-flight or failed analysis has no reservation.
-- Those rows are reachable from the legacy start/retry RPC without a new INSERT,
-- so installing the trigger around them would either skip the debit or fail closed
-- mid-retry. Completed history is left unbilled and cannot be refunded.
-- SHARE ROW EXCLUSIVE waits for an open insert and then blocks new writes until
-- this transaction commits, so a pending analysis cannot land between the check
-- and trigger creation.
do $sc19_preexisting$
begin
  lock table public.screening_analysis_versions in share row exclusive mode;
  if exists (
    select 1 from public.screening_analysis_versions analysis
    where analysis.execution_status is distinct from 'completed'
      and not exists (
        select 1 from private.sc19_analysis_spend spend
        where spend.analysis_id=analysis.id
      )
  ) then
    raise exception 'sc19_preexisting_unbilled_analysis' using errcode='55000';
  end if;
end
$sc19_preexisting$;

do $credit_triggers$ begin
if (select source_state from pg_temp.sc19_migration_state) in ('r4_legacy','r4_voice') then
create trigger sc19_analysis_lock before insert on public.screening_analysis_versions
  for each row execute function private.sc19_lock_analysis_company();
create trigger sc19_analysis_bill after insert on public.screening_analysis_versions
  for each row execute function private.sc19_charge_analysis();
create trigger sc19_analysis_reconcile after update of execution_status, stale_at
  on public.screening_analysis_versions
  for each row execute function private.sc19_reconcile_analysis();
end if;
end $credit_triggers$;

-- The write-blocking lock from the check above is still held. Recheck after the
-- triggers exist so an analysis that committed while trigger creation waited
-- cannot remain unbilled.
do $sc19_preexisting_recheck$
begin
  if exists (
    select 1 from public.screening_analysis_versions analysis
    where analysis.execution_status is distinct from 'completed'
      and not exists (
        select 1 from private.sc19_analysis_spend spend
        where spend.analysis_id=analysis.id
      )
  ) then
    raise exception 'sc19_preexisting_unbilled_analysis' using errcode='55000';
  end if;
end
$sc19_preexisting_recheck$;

-- Claim, completion and failure must take the same row locks. A stale update
-- already holds the analysis row before its erasure guard locks the candidate,
-- then this rewrite locks the company and the attempt. Completion and failure
-- used to lock the attempt first, which deadlocks a reclaim of an expired
-- lease. The candidate lock, when SC-010 installed it, is taken immediately
-- after the analysis row and before the advisory lock. Taking it earlier makes
-- the stale update fail with PT409, because that update already holds the
-- analysis row and then uses NOWAIT. Taking it after the advisory lock makes
-- start or retry, which hold the candidate and wait for the advisory lock,
-- fail the finalizer the same way. A database that has the worker functions
-- but not erasure_lock_candidate still receives this rewrite; only the
-- candidate call is skipped. The minimal billing fixture has none of these
-- functions, so this step does nothing there.
do $sc19_claim_lock$
begin
  if to_regprocedure('public.claim_screening_attempt(uuid)') is null
     or to_regprocedure('public.complete_screening_analysis(uuid,text,text,text,jsonb,text,text,integer,integer,integer,numeric,text)') is null
     or to_regprocedure('public.fail_screening_attempt(uuid,text,text,text,text,text,text,integer,integer,integer,numeric,text)') is null then
    return;
  end if;
create or replace function public.claim_screening_attempt(target_attempt uuid)
returns table (
  analysis_id uuid,
  attempt_id uuid,
  lease_token text,
  lease_expires_at timestamptz,
  input_fingerprint text,
  analysis_contract_hash text,
  payload_schema_version integer,
  result_schema_version integer,
  prompt_version text,
  provider text,
  model text,
  model_revision text,
  input_cv_text_snapshot text,
  criteria_snapshot jsonb
) language plpgsql security definer set search_path = '' as $$
declare
  attempt public.screening_analysis_attempts%rowtype;
  analysis public.screening_analysis_versions%rowtype;
  stale_reason text;
  raw_token text;
  expires_at timestamptz;
  target_analysis uuid;
  target_company uuid;
  target_candidate uuid;
begin
  -- Reviewed claim body. The analysis row, the company, and then the attempt
  -- match a stale cancellation. The candidate lock follows the analysis row:
  -- the stale update already holds that row before its NOWAIT candidate guard.
  -- Locking the attempt first deadlocks with sc19_reconcile_analysis.
  -- The return column analysis_id is in scope, so this lookup is dynamic SQL.
  execute $claim_locate$
    select t.analysis_id, t.company_id, a.candidate_id
    from public.screening_analysis_attempts t
    join public.screening_analysis_versions v
      on v.id = t.analysis_id and v.company_id = t.company_id
    join public.applications a
      on a.id = v.application_id and a.company_id = v.company_id
    where t.id = $1
  $claim_locate$
  into target_analysis, target_company, target_candidate
  using target_attempt;
  if target_analysis is null or target_company is null or target_candidate is null then
    raise exception 'Attempt unavailable' using errcode = '42501';
  end if;
  select * into analysis from public.screening_analysis_versions
    where id = target_analysis and company_id = target_company for update;
  if not found then raise exception 'Analysis unavailable' using errcode = '42501'; end if;
  if to_regprocedure('private.erasure_lock_candidate(uuid)') is not null then
    perform private.erasure_lock_candidate(target_candidate);
  end if;
  perform private.sc19_lock_company(target_company);
  select * into attempt from public.screening_analysis_attempts
    where id = target_attempt for update;
  if not found
     or attempt.analysis_id is distinct from target_analysis
     or attempt.company_id is distinct from target_company then
    raise exception 'Attempt unavailable' using errcode = '42501';
  end if;
  if attempt.status <> 'pending'
    and not (attempt.status = 'processing' and attempt.lease_expires_at <= clock_timestamp())
    then raise exception 'Attempt is not claimable' using errcode = '55000'; end if;

  stale_reason := private.screening_stale_reason(analysis.id);
  if stale_reason is not null then
    update public.screening_analysis_attempts
      set status = 'abandoned', finished_at = clock_timestamp()
      where id = attempt.id;
    update public.screening_analysis_versions
      set execution_status = 'cancelled',
        stale_at = coalesce(stale_at, clock_timestamp()),
        stale_reason = coalesce(screening_analysis_versions.stale_reason, stale_reason),
        updated_at = clock_timestamp()
      where id = analysis.id;
    return;
  end if;

  raw_token := replace(gen_random_uuid()::text, '-', '')
    || replace(gen_random_uuid()::text, '-', '');
  expires_at := clock_timestamp() + interval '5 minutes';
  update public.screening_analysis_attempts
    set status = 'processing',
      lease_token_hash = private.screening_hash(raw_token),
      lease_expires_at = expires_at,
      started_at = coalesce(started_at, clock_timestamp())
    where id = attempt.id;
  update public.screening_analysis_versions
    set execution_status = 'processing',
      processing_started_at = coalesce(processing_started_at, clock_timestamp()),
      updated_at = clock_timestamp()
    where id = analysis.id;
  return query select
    analysis.id,
    attempt.id,
    raw_token,
    expires_at,
    analysis.input_fingerprint,
    analysis.analysis_contract_hash,
    analysis.payload_schema_version,
    analysis.result_schema_version,
    analysis.prompt_version,
    analysis.provider,
    analysis.model,
    analysis.model_revision,
    analysis.input_cv_text_snapshot,
    analysis.criteria_snapshot;
end;
$$;
create or replace function public.complete_screening_analysis(
  target_attempt uuid,
  provided_lease_token text,
  expected_input_fingerprint text,
  expected_analysis_contract_hash text,
  findings jsonb,
  new_provider_request_id text default null,
  new_provider_response_id text default null,
  new_input_tokens integer default null,
  new_output_tokens integer default null,
  new_cached_input_tokens integer default null,
  new_cost_amount numeric default null,
  new_cost_currency text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  attempt public.screening_analysis_attempts%rowtype;
  analysis public.screening_analysis_versions%rowtype;
  expected_criterion jsonb;
  finding jsonb;
  item_order bigint;
  rating text;
  evidence jsonb;
  explanation text;
  confidence numeric;
  computed_finalization_hash text;
  detected_stale_reason text;
  target_analysis uuid;
  target_company uuid;
  target_application uuid;
  target_candidate uuid;
  observed_attempt_status text;
  observed_lease_expires_at timestamptz;
begin
  if provided_lease_token is null or length(provided_lease_token) < 32
    or expected_input_fingerprint !~ '^[0-9a-f]{64}$'
    or expected_analysis_contract_hash !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(findings) is distinct from 'array'
    or new_input_tokens < 0 or new_output_tokens < 0 or new_cached_input_tokens < 0
    or new_cost_amount < 0
    or (new_cost_currency is not null and new_cost_currency !~ '^[A-Z]{3}$')
    or length(coalesce(new_provider_request_id, '')) > 500
    or length(coalesce(new_provider_response_id, '')) > 500
    then raise exception 'Invalid completion metadata' using errcode = '22023'; end if;
  computed_finalization_hash := private.screening_hash(jsonb_build_object(
    'findings', findings,
    'provider_request_id', new_provider_request_id,
    'provider_response_id', new_provider_response_id,
    'input_tokens', new_input_tokens,
    'output_tokens', new_output_tokens,
    'cached_input_tokens', new_cached_input_tokens,
    'cost_amount', new_cost_amount,
    'cost_currency', new_cost_currency
  )::text);

  -- A finalizer already has a provider result. Wait for its candidate before
  -- holding any advisory, analysis, company or attempt lock, so a concurrent
  -- start/retry/stale mutation can finish without discarding that result.
  select attempts.analysis_id, attempts.company_id, versions.application_id, applications.candidate_id,
    attempts.status, attempts.lease_expires_at
    into target_analysis, target_company, target_application, target_candidate,
      observed_attempt_status, observed_lease_expires_at
  from public.screening_analysis_attempts attempts
  join public.screening_analysis_versions versions
    on versions.id = attempts.analysis_id and versions.company_id = attempts.company_id
  join public.applications applications
    on applications.id = versions.application_id and applications.company_id = versions.company_id
  where attempts.id = target_attempt;
  if not found then raise exception 'Attempt unavailable' using errcode = '42501'; end if;
  -- An already expired finalizer must not make a valid reclaim fail its
  -- candidate NOWAIT guard. This is only an early rejection: the authoritative
  -- lease/token/binding checks remain below, after all locks and any wait.
  if observed_attempt_status = 'processing' and observed_lease_expires_at <= clock_timestamp() then
    raise exception 'Invalid or expired lease' using errcode = '42501';
  end if;
  if to_regprocedure('private.erasure_lock_candidate(uuid)') is not null then
    perform 1 from public.candidates
      where id = target_candidate and company_id = target_company for update;
    if not found then raise exception 'Resource unavailable' using errcode = 'PT404'; end if;
    -- Keep this a separate statement after waiting: the existing guard must
    -- recheck read-committed isolation, restore isolation and erasure freezes.
    perform private.erasure_lock_candidate(target_candidate);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('screening:' || target_application::text, 0));
  select * into analysis from public.screening_analysis_versions
    where id = target_analysis and company_id = target_company for update;
  if not found then raise exception 'Analysis unavailable' using errcode = '42501'; end if;
  perform private.sc19_lock_company(target_company);
  select * into attempt from public.screening_analysis_attempts
    where id = target_attempt for update;
  if not found
     or attempt.analysis_id is distinct from target_analysis
     or attempt.company_id is distinct from target_company then
    raise exception 'Attempt unavailable' using errcode = '42501';
  end if;

  if attempt.status = 'completed' then
    if attempt.lease_token_hash = private.screening_hash(provided_lease_token)
      and attempt.finalization_hash = computed_finalization_hash
      then return analysis.id; end if;
    raise exception 'Conflicting completion' using errcode = 'PT409';
  end if;
  if attempt.status <> 'processing'
    or attempt.lease_expires_at <= clock_timestamp()
    or attempt.lease_token_hash <> private.screening_hash(provided_lease_token)
    then raise exception 'Invalid or expired lease' using errcode = '42501'; end if;
  if analysis.execution_status <> 'processing'
    or analysis.input_fingerprint <> expected_input_fingerprint
    or analysis.analysis_contract_hash <> expected_analysis_contract_hash
    then raise exception 'Analysis binding changed' using errcode = 'PT409'; end if;
  if jsonb_array_length(findings) <> jsonb_array_length(analysis.criteria_snapshot)
    then raise exception 'Incomplete criterion set' using errcode = '22023'; end if;

  for expected_criterion, item_order in
    select value, ordinality
    from jsonb_array_elements(analysis.criteria_snapshot) with ordinality
  loop
    select value into finding
    from jsonb_array_elements(findings)
    where value->>'criterion_id' = expected_criterion->>'id';
    if not found or (
      select count(*) from jsonb_array_elements(findings)
      where value->>'criterion_id' = expected_criterion->>'id'
    ) <> 1 then raise exception 'Invalid criterion set' using errcode = '22023'; end if;
    if jsonb_typeof(finding) is distinct from 'object'
      or exists (
        select 1 from jsonb_object_keys(finding) key
        where key not in ('criterion_id', 'rating', 'evidence', 'explanation', 'confidence')
      )
      or jsonb_typeof(finding->'criterion_id') is distinct from 'string'
      or jsonb_typeof(finding->'rating') is distinct from 'string'
      or jsonb_typeof(finding->'evidence') is distinct from 'array'
      or (finding ? 'explanation'
        and jsonb_typeof(finding->'explanation') not in ('string', 'null'))
      or (finding ? 'confidence'
        and jsonb_typeof(finding->'confidence') not in ('number', 'null'))
      then raise exception 'Invalid criterion result' using errcode = '22023'; end if;
    rating := finding->>'rating';
    evidence := finding->'evidence';
    explanation := finding->>'explanation';
    confidence := case when jsonb_typeof(finding->'confidence') = 'number'
      then (finding->>'confidence')::numeric else null end;
    if rating not in ('insufficient_data', 'below', 'meets', 'above')
      or length(coalesce(explanation, '')) > 4000
      or confidence < 0 or confidence > 1
      or not private.screening_valid_evidence(
        analysis.input_cv_text_snapshot, evidence, rating <> 'insufficient_data'
      ) then raise exception 'Invalid evidence' using errcode = '22023'; end if;

    insert into public.screening_criterion_results(
      company_id, analysis_id, criterion_id, criterion_kind, criterion_order,
      criterion_text_snapshot, rating, evidence, explanation, confidence
    ) values (
      analysis.company_id, analysis.id, expected_criterion->>'id',
      expected_criterion->>'kind', item_order, expected_criterion->>'text',
      rating, evidence, explanation, confidence
    );
  end loop;

  detected_stale_reason := private.screening_stale_reason(analysis.id);
  if detected_stale_reason is null and exists (
    select 1 from public.screening_analysis_versions newer
    where newer.company_id = analysis.company_id
      and newer.application_id = analysis.application_id
      and newer.analysis_version > analysis.analysis_version
  ) then detected_stale_reason := 'manual_invalidation'; end if;
  if detected_stale_reason is null and analysis.stale_at is null then
    update public.screening_analysis_versions previous
    set stale_at = clock_timestamp(),
      stale_reason = case
        when previous.input_fingerprint <> analysis.input_fingerprint
          then coalesce(private.screening_stale_reason(previous.id), 'manual_invalidation')
        when previous.analysis_contract_hash <> analysis.analysis_contract_hash
          then 'screening_contract_changed'
        else 'manual_invalidation'
      end,
      superseded_by_analysis_id = analysis.id,
      updated_at = clock_timestamp()
    where previous.company_id = analysis.company_id
      and previous.application_id = analysis.application_id
      and previous.id <> analysis.id
      and previous.execution_status = 'completed'
      and previous.stale_at is null;
  end if;

  update public.screening_analysis_attempts
  set status = 'completed',
    provider_request_id = new_provider_request_id,
    provider_response_id = new_provider_response_id,
    input_tokens = new_input_tokens,
    output_tokens = new_output_tokens,
    cached_input_tokens = new_cached_input_tokens,
    cost_amount = new_cost_amount,
    cost_currency = new_cost_currency,
    finalization_hash = computed_finalization_hash,
    finished_at = clock_timestamp()
  where id = attempt.id;
  update public.screening_analysis_versions
  set execution_status = 'completed',
    completed_at = clock_timestamp(),
    failed_at = null,
    failure_code = null,
    failure_message = null,
    stale_at = case when detected_stale_reason is not null or stale_at is not null
      then coalesce(stale_at, clock_timestamp()) else null end,
    stale_reason = case when detected_stale_reason is not null or stale_at is not null
      then case when detected_stale_reason = 'manual_invalidation' then 'manual_invalidation' else 'input_changed_during_processing' end else null end,
    overall_score = null,
    updated_at = clock_timestamp()
  where id = analysis.id;
  return analysis.id;
exception
  when check_violation or invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Invalid completion payload' using errcode = '22023';
end;
$$;
create or replace function public.fail_screening_attempt(
  target_attempt uuid,
  provided_lease_token text,
  expected_input_fingerprint text,
  expected_analysis_contract_hash text,
  new_error_code text,
  new_error_message text default null,
  new_provider_request_id text default null,
  new_input_tokens integer default null,
  new_output_tokens integer default null,
  new_cached_input_tokens integer default null,
  new_cost_amount numeric default null,
  new_cost_currency text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  attempt public.screening_analysis_attempts%rowtype;
  analysis public.screening_analysis_versions%rowtype;
  computed_finalization_hash text;
  target_analysis uuid;
  target_company uuid;
  target_candidate uuid;
  observed_attempt_status text;
  observed_lease_expires_at timestamptz;
begin
  if provided_lease_token is null or length(provided_lease_token) < 32
    or expected_input_fingerprint !~ '^[0-9a-f]{64}$'
    or expected_analysis_contract_hash !~ '^[0-9a-f]{64}$'
    or new_error_code is null or new_error_code !~ '^[a-z0-9_:-]{1,100}$'
    or length(coalesce(new_error_message, '')) > 2000
    or length(coalesce(new_provider_request_id, '')) > 500
    or new_input_tokens < 0 or new_output_tokens < 0 or new_cached_input_tokens < 0
    or new_cost_amount < 0
    or (new_cost_currency is not null and new_cost_currency !~ '^[A-Z]{3}$')
    then raise exception 'Invalid failure metadata' using errcode = '22023'; end if;
  computed_finalization_hash := private.screening_hash(jsonb_build_object(
    'error_code', new_error_code,
    'error_message', new_error_message,
    'provider_request_id', new_provider_request_id,
    'input_tokens', new_input_tokens,
    'output_tokens', new_output_tokens,
    'cached_input_tokens', new_cached_input_tokens,
    'cost_amount', new_cost_amount,
    'cost_currency', new_cost_currency
  )::text);

  -- Like completion, wait for the candidate before holding other locks.
  -- Failure takes no advisory lock; analysis still precedes company/attempt.
  select attempts.analysis_id, attempts.company_id, applications.candidate_id,
    attempts.status, attempts.lease_expires_at
    into target_analysis, target_company, target_candidate,
      observed_attempt_status, observed_lease_expires_at
  from public.screening_analysis_attempts attempts
  join public.screening_analysis_versions versions
    on versions.id = attempts.analysis_id and versions.company_id = attempts.company_id
  join public.applications applications
    on applications.id = versions.application_id and applications.company_id = versions.company_id
  where attempts.id = target_attempt;
  if not found then raise exception 'Attempt unavailable' using errcode = '42501'; end if;
  if observed_attempt_status = 'processing' and observed_lease_expires_at <= clock_timestamp() then
    raise exception 'Invalid or expired lease' using errcode = '42501';
  end if;
  if to_regprocedure('private.erasure_lock_candidate(uuid)') is not null then
    perform 1 from public.candidates
      where id = target_candidate and company_id = target_company for update;
    if not found then raise exception 'Resource unavailable' using errcode = 'PT404'; end if;
    perform private.erasure_lock_candidate(target_candidate);
  end if;
  select * into analysis from public.screening_analysis_versions
    where id = target_analysis and company_id = target_company for update;
  if not found then raise exception 'Analysis unavailable' using errcode = '42501'; end if;
  perform private.sc19_lock_company(target_company);
  select * into attempt from public.screening_analysis_attempts
    where id = target_attempt for update;
  if not found
     or attempt.analysis_id is distinct from target_analysis
     or attempt.company_id is distinct from target_company then
    raise exception 'Attempt unavailable' using errcode = '42501';
  end if;
  if attempt.status = 'failed' then
    if attempt.lease_token_hash = private.screening_hash(provided_lease_token)
      and attempt.finalization_hash = computed_finalization_hash
      then return analysis.id; end if;
    raise exception 'Conflicting failure' using errcode = 'PT409';
  end if;
  if attempt.status <> 'processing'
    or attempt.lease_expires_at <= clock_timestamp()
    or attempt.lease_token_hash <> private.screening_hash(provided_lease_token)
    then raise exception 'Invalid or expired lease' using errcode = '42501'; end if;
  if analysis.execution_status <> 'processing'
    or analysis.input_fingerprint <> expected_input_fingerprint
    or analysis.analysis_contract_hash <> expected_analysis_contract_hash
    then raise exception 'Analysis binding changed' using errcode = 'PT409'; end if;

  update public.screening_analysis_attempts
  set status = 'failed',
    provider_request_id = new_provider_request_id,
    input_tokens = new_input_tokens,
    output_tokens = new_output_tokens,
    cached_input_tokens = new_cached_input_tokens,
    cost_amount = new_cost_amount,
    cost_currency = new_cost_currency,
    error_code = new_error_code,
    finalization_hash = computed_finalization_hash,
    finished_at = clock_timestamp()
  where id = attempt.id;
  update public.screening_analysis_versions
  set execution_status = 'failed',
    failure_code = new_error_code,
    failure_message = new_error_message,
    failed_at = clock_timestamp(),
    completed_at = null,
    updated_at = clock_timestamp()
  where id = analysis.id;
  return analysis.id;
end;
$$;
end
$sc19_claim_lock$;

do $payment_tables$ begin
if to_regclass('private.sc19_payment_orders') is null then
create table private.sc19_payment_offers (
  id text primary key,
  revision text not null,
  plan text not null check(plan='PRESELEKCJA'),
  active boolean not null default false,
  approved boolean not null default false,
  amount_minor integer not null check(amount_minor between 1 and 100000000),
  currency text not null check(currency='PLN'),
  credits integer not null check(credits between 1 and 100000),
  terms_revision text not null,
  terms_text text not null check(length(terms_text) between 1 and 20000),
  valid_until_ms bigint not null check(valid_until_ms > 0),
  created_at timestamptz not null default now()
);
-- No seed: neither a price, a quota, nor terms have commercial approval.
create table private.sc19_payment_orders (
  id uuid primary key,
  company_id uuid not null references public.companies(id) on delete restrict,
  buyer_id uuid not null,
  request_id uuid not null,
  offer_id text not null references private.sc19_payment_offers(id) on delete restrict,
  offer_revision text not null,
  terms_revision text not null,
  amount_minor integer not null check(amount_minor between 1 and 100000000),
  currency text not null check(currency='PLN'),
  credits integer not null check(credits between 1 and 100000),
  provider text not null,
  account text not null,
  mode text not null check(mode in ('test','live')),
  status text not null check(status in ('awaiting_payment','paid')),
  session_id text,
  checkout_url text,
  payment_id text,
  checkout_deadline_ms bigint not null check(checkout_deadline_ms > 0),
  created_at timestamptz not null default now(),
  unique(company_id, request_id),
  unique(company_id, id),
  unique(provider, account, mode, session_id),
  check((session_id is null) = (checkout_url is null)),
  check((status='paid') = (payment_id is not null)),
  check(status<>'paid' or session_id is not null)
);
create index sc19_payment_orders_company_idx on private.sc19_payment_orders(company_id,created_at desc);
-- Company-wide, deliberately NOT per request, offer, provider/account or mode.
-- Only verified settlement to paid releases this slot. Timeouts/expiry do not.
create unique index sc19_payment_one_unresolved on private.sc19_payment_orders(company_id)
  where status='awaiting_payment';
create table private.sc19_payment_requests (
  company_id uuid not null,
  request_id uuid not null,
  order_id uuid not null,
  created_at timestamptz not null default now(),
  primary key(company_id,request_id),
  foreign key(company_id,order_id) references private.sc19_payment_orders(company_id,id) on delete restrict
);
-- All aliases survive settlement, so a late retry cannot become a new purchase.
create index sc19_payment_requests_order_idx on private.sc19_payment_requests(company_id,order_id);
create table private.sc19_payment_grants (
  payment_key text primary key check(length(payment_key) between 1 and 1024),
  order_id uuid not null unique references private.sc19_payment_orders(id) on delete restrict,
  created_at timestamptz not null default now()
);

elsif (select source_state from pg_temp.sc19_migration_state)='orders129_legacy' then

  -- Exact #129 predecessor lacks the composite key and immutable request aliases.
  alter table private.sc19_payment_orders add unique(company_id,id);
  create unique index sc19_payment_one_unresolved on private.sc19_payment_orders(company_id)
    where status='awaiting_payment';
create table private.sc19_payment_requests (
  company_id uuid not null,
  request_id uuid not null,
  order_id uuid not null,
  created_at timestamptz not null default now(),
  primary key(company_id,request_id),
  foreign key(company_id,order_id) references private.sc19_payment_orders(company_id,id) on delete restrict
);
-- All aliases survive settlement, so a late retry cannot become a new purchase.
create index sc19_payment_requests_order_idx on private.sc19_payment_requests(company_id,order_id);
end if;
end $payment_tables$;

create or replace function private.sc19_payment_immutable()
returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' or tg_table_name in ('sc19_payment_grants','sc19_payment_requests') then raise exception 'sc19_payment_immutable' using errcode='55000'; end if;
  if tg_table_name='sc19_payment_offers' then
    if (to_jsonb(new)-array['active','approved']) is distinct from
       (to_jsonb(old)-array['active','approved']) then
      raise exception 'sc19_offer_revision_immutable' using errcode='55000';
    end if;
  elsif (to_jsonb(new)-array['status','session_id','checkout_url','payment_id']) is distinct from
        (to_jsonb(old)-array['status','session_id','checkout_url','payment_id'])
    or (old.session_id is not null and (new.session_id is distinct from old.session_id
        or new.checkout_url is distinct from old.checkout_url))
    or (old.status='paid' and to_jsonb(new) is distinct from to_jsonb(old)) then
      raise exception 'sc19_order_immutable' using errcode='55000';
  end if;
  return new;
end $$;
revoke all on function private.sc19_payment_immutable() from public,anon,authenticated;

do $payment_triggers$ begin
if (select source_state from pg_temp.sc19_migration_state) not in ('orders129_legacy','orders152_legacy') then
create trigger sc19_offer_immutable before update or delete on private.sc19_payment_offers
  for each row execute function private.sc19_payment_immutable();
create trigger sc19_order_immutable before update or delete on private.sc19_payment_orders
  for each row execute function private.sc19_payment_immutable();
create trigger sc19_grant_immutable before update or delete on private.sc19_payment_grants
  for each row execute function private.sc19_payment_immutable();

end if;
if (select source_state from pg_temp.sc19_migration_state)<>'orders152_legacy' then
create trigger sc19_request_immutable before update or delete on private.sc19_payment_requests
  for each row execute function private.sc19_payment_immutable();

end if;
end $payment_triggers$;

alter table private.sc19_payment_offers enable row level security;
alter table private.sc19_payment_orders enable row level security;
alter table private.sc19_payment_grants enable row level security;
alter table private.sc19_payment_requests enable row level security;
revoke all on private.sc19_payment_offers,private.sc19_payment_orders,private.sc19_payment_grants,private.sc19_payment_requests
  from public,anon,authenticated;

-- Preserve legal extra recovery aliases. Only a collision with an ORIGINAL
-- request key is invalid. Every original key is backfilled with the order's time.
do $request_backfill$ begin
  if exists(select 1 from private.sc19_payment_orders o
    join private.sc19_payment_requests r on r.company_id=o.company_id and r.request_id=o.request_id
    where r.order_id<>o.id) then
    raise exception 'sc19_original_request_alias_conflict' using errcode='55000';
  end if;
  insert into private.sc19_payment_requests(company_id,request_id,order_id,created_at)
    select o.company_id,o.request_id,o.id,o.created_at from private.sc19_payment_orders o
    where not exists(select 1 from private.sc19_payment_requests r
      where r.company_id=o.company_id and r.request_id=o.request_id);
end $request_backfill$;

-- Create immutable historical R5 only when absent in an admitted precursor.
-- Its literal describes the reviewed credit-only history; no intermediate state
-- commits and no product RPC runs until final R6 postflight succeeds.
do $inventory$ declare voice boolean; prior text; prior_tables text[];
begin
  select s.voice into voice from pg_temp.sc19_migration_state s;
  prior:=case when voice then 'c989b84b9eec51fc48c361b8ad9e7404b4044268d56d106b6788fe56f3f1857d'
    else '10358458d8802b1ed59a298b305752a89ce110d1019a11cde937f2a2311f79bc' end;
  prior_tables:=array['private.candidate_retention_policies','private.candidate_verified_contact_points','private.candidate_verified_contact_receipts','private.contact_audit','private.contact_policy_templates','private.contact_requests','private.contact_trusted_issuers','private.erasure_configuration_requests','private.erasure_inventory_baseline','private.erasure_subject_resolutions','private.sales_lead_attempts','private.sales_lead_closures','private.sales_lead_replay_state','private.sales_lead_settings','private.sales_mail_outbox','private.sales_mail_settings','private.sales_pipeline','private.sales_pipeline_events','private.screening_ranking_policies','public.applications','public.assessment_stages','public.behavior_assessment_entries','public.candidate_assessments','public.candidate_communication_approvals','public.candidate_communication_events','public.candidate_communications','public.candidate_contact_permissions','public.candidate_contact_preferences','public.candidate_documents','public.candidates','public.companies','public.company_members','public.company_profiles','public.exercise_definition_entries','public.exercise_observation_entries','public.platform_operators','public.positions','public.recruitment_shortlist_entries','public.recruitments','public.sales_leads','public.screening_analysis_attempts','public.screening_analysis_versions','public.screening_criterion_results','public.screening_criterion_review_overrides','public.screening_result_reviews','private.erasure_inventory_baseline_r2','private.erasure_inventory_baseline_r3','private.erasure_inventory_baseline_r4','private.erasure_preview_tickets','private.erasure_requests','private.erasure_candidate_lifecycle','private.erasure_lifecycle_events','private.erasure_lifecycle_commands','private.erasure_denial_context','private.erasure_execution_config','private.erasure_executions','private.erasure_verified_ledger_events','private.erasure_restore_checkpoint','private.erasure_holds','private.erasure_purge_manifest','private.erasure_purge_context','private.erasure_purge_context_rows','private.retired_candidate_ids','private.erasure_receipts','private.retention_delegations','private.retention_schedule_commands','private.retention_candidate_clocks','private.retention_suggestions','private.retention_authorizations','private.retention_ticks','private.sc19_package_policy','private.sc19_balances','private.sc19_trial_nips','private.sc19_trial_approvals','private.sc19_analysis_spend','private.sc19_credit_journal','private.erasure_inventory_baseline_r5'];
  if voice then prior_tables:=prior_tables||array['public.voice_plan_versions','private.voice_plan_review_entries','private.voice_plan_release_entries','private.voice_plan_current_releases','private.voice_plan_request_keys','private.voice_interview_permission_receipts','private.voice_interview_permission_revocations','private.sc010c_voice_preparations','private.sc010c_voice_preparation_requests','private.voice_plan_template_catalog','private.voice_interview_permission_policies','private.voice_interview_permission_issuers','private.sc19_voice_entitlements','private.erasure_inventory_baseline_r4_voice']; end if;

  if to_regclass('private.erasure_inventory_baseline_r5') is null then
    create table private.erasure_inventory_baseline_r5 (
      singleton boolean primary key default true check(singleton),
      schema_signature text not null,known_tables text[] not null
    );
    alter table private.erasure_inventory_baseline_r5 enable row level security;
    create trigger immutable_history before update or delete on private.erasure_inventory_baseline_r5
      for each row execute function private.contact_immutable();
    insert into private.erasure_inventory_baseline_r5 values(true,prior,prior_tables);
  elsif (select schema_signature from private.erasure_inventory_baseline_r5 where singleton) is distinct from prior
    or (select array_agg(x order by x collate "C") from private.erasure_inventory_baseline_r5 b,unnest(b.known_tables) x where singleton)
       is distinct from (select array_agg(x order by x collate "C") from unnest(prior_tables) x) then
    raise exception 'sc19_existing_r5_baseline_unreviewed' using errcode='55000';
  end if;
  create table private.erasure_inventory_baseline_r6 (
    singleton boolean primary key default true check(singleton),
    schema_signature text not null,known_tables text[] not null
  );
  alter table private.erasure_inventory_baseline_r6 enable row level security;
  create trigger immutable_history before update or delete on private.erasure_inventory_baseline_r6
    for each row execute function private.contact_immutable();
  insert into private.erasure_inventory_baseline_r6 values (true,
    case when voice then '6fd4900f85f0a1b6f4aad11a9246722cf79e857ea6bc999f7249151f20871061' else 'e99342b97cf10c9f19c5351f423d30ff4dadaa18294465ff976d926d2cc6a07b' end,
    case when voice then array['private.candidate_retention_policies','private.candidate_verified_contact_points','private.candidate_verified_contact_receipts','private.contact_audit','private.contact_policy_templates','private.contact_requests','private.contact_trusted_issuers','private.erasure_candidate_lifecycle','private.erasure_configuration_requests','private.erasure_denial_context','private.erasure_execution_config','private.erasure_executions','private.erasure_holds','private.erasure_inventory_baseline','private.erasure_inventory_baseline_r2','private.erasure_inventory_baseline_r3','private.erasure_inventory_baseline_r4','private.erasure_inventory_baseline_r4_voice','private.erasure_inventory_baseline_r5','private.erasure_inventory_baseline_r6','private.erasure_lifecycle_commands','private.erasure_lifecycle_events','private.erasure_preview_tickets','private.erasure_purge_context','private.erasure_purge_context_rows','private.erasure_purge_manifest','private.erasure_receipts','private.erasure_requests','private.erasure_restore_checkpoint','private.erasure_subject_resolutions','private.erasure_verified_ledger_events','private.retention_authorizations','private.retention_candidate_clocks','private.retention_delegations','private.retention_schedule_commands','private.retention_suggestions','private.retention_ticks','private.retired_candidate_ids','private.sales_lead_attempts','private.sales_lead_closures','private.sales_lead_replay_state','private.sales_lead_settings','private.sales_mail_outbox','private.sales_mail_settings','private.sales_pipeline','private.sales_pipeline_events','private.sc010c_voice_preparation_requests','private.sc010c_voice_preparations','private.sc19_analysis_spend','private.sc19_balances','private.sc19_credit_journal','private.sc19_package_policy','private.sc19_payment_grants','private.sc19_payment_offers','private.sc19_payment_orders','private.sc19_payment_requests','private.sc19_trial_approvals','private.sc19_trial_nips','private.sc19_voice_entitlements','private.screening_ranking_policies','private.voice_interview_permission_issuers','private.voice_interview_permission_policies','private.voice_interview_permission_receipts','private.voice_interview_permission_revocations','private.voice_plan_current_releases','private.voice_plan_release_entries','private.voice_plan_request_keys','private.voice_plan_review_entries','private.voice_plan_template_catalog','public.applications','public.assessment_stages','public.behavior_assessment_entries','public.candidate_assessments','public.candidate_communication_approvals','public.candidate_communication_events','public.candidate_communications','public.candidate_contact_permissions','public.candidate_contact_preferences','public.candidate_documents','public.candidates','public.companies','public.company_members','public.company_profiles','public.exercise_definition_entries','public.exercise_observation_entries','public.platform_operators','public.positions','public.recruitment_shortlist_entries','public.recruitments','public.sales_leads','public.screening_analysis_attempts','public.screening_analysis_versions','public.screening_criterion_results','public.screening_criterion_review_overrides','public.screening_result_reviews','public.voice_plan_versions'] else array['private.candidate_retention_policies','private.candidate_verified_contact_points','private.candidate_verified_contact_receipts','private.contact_audit','private.contact_policy_templates','private.contact_requests','private.contact_trusted_issuers','private.erasure_candidate_lifecycle','private.erasure_configuration_requests','private.erasure_denial_context','private.erasure_execution_config','private.erasure_executions','private.erasure_holds','private.erasure_inventory_baseline','private.erasure_inventory_baseline_r2','private.erasure_inventory_baseline_r3','private.erasure_inventory_baseline_r4','private.erasure_inventory_baseline_r5','private.erasure_inventory_baseline_r6','private.erasure_lifecycle_commands','private.erasure_lifecycle_events','private.erasure_preview_tickets','private.erasure_purge_context','private.erasure_purge_context_rows','private.erasure_purge_manifest','private.erasure_receipts','private.erasure_requests','private.erasure_restore_checkpoint','private.erasure_subject_resolutions','private.erasure_verified_ledger_events','private.retention_authorizations','private.retention_candidate_clocks','private.retention_delegations','private.retention_schedule_commands','private.retention_suggestions','private.retention_ticks','private.retired_candidate_ids','private.sales_lead_attempts','private.sales_lead_closures','private.sales_lead_replay_state','private.sales_lead_settings','private.sales_mail_outbox','private.sales_mail_settings','private.sales_pipeline','private.sales_pipeline_events','private.sc19_analysis_spend','private.sc19_balances','private.sc19_credit_journal','private.sc19_package_policy','private.sc19_payment_grants','private.sc19_payment_offers','private.sc19_payment_orders','private.sc19_payment_requests','private.sc19_trial_approvals','private.sc19_trial_nips','private.screening_ranking_policies','public.applications','public.assessment_stages','public.behavior_assessment_entries','public.candidate_assessments','public.candidate_communication_approvals','public.candidate_communication_events','public.candidate_communications','public.candidate_contact_permissions','public.candidate_contact_preferences','public.candidate_documents','public.candidates','public.companies','public.company_members','public.company_profiles','public.exercise_definition_entries','public.exercise_observation_entries','public.platform_operators','public.positions','public.recruitment_shortlist_entries','public.recruitments','public.sales_leads','public.screening_analysis_attempts','public.screening_analysis_versions','public.screening_criterion_results','public.screening_criterion_review_overrides','public.screening_result_reviews'] end);
end $inventory$;

-- Exact reviewed source bodies, retargeted to R6 at source level. No installed
-- pg_get_functiondef text is executed. Existing worker/erasure ACLs are preserved.
create or replace function public.preview_candidate_erasure(target_candidate uuid,scope_kind text default 'candidate_record',resolution_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
declare tenant uuid;subjects uuid[];p private.candidate_retention_policies;r private.erasure_subject_resolutions;
 baseline private.erasure_inventory_baseline_r6;signature text;counts jsonb:='{}';manifest text;row_digest jsonb:='[]';
 blockers text[]:=array['execution_not_provisioned','external_inventory_unverified','backup_policy_unverified','administrative_inventory_pending_execution'];generated timestamptz:=statement_timestamp();
begin
 select company_id into tenant from public.candidates where id=target_candidate;perform private.erasure_owner(tenant);
 if scope_kind is null or scope_kind not in ('candidate_record','confirmed_subject')
 or (scope_kind='candidate_record' and resolution_id is not null) or (scope_kind='confirmed_subject' and resolution_id is null)
 then raise exception using errcode='PT422',message='Invalid preview scope';end if;
 subjects:=array[target_candidate];
 if scope_kind='confirmed_subject' then
  select * into r from private.erasure_subject_resolutions where id=resolution_id and company_id=tenant and anchor_candidate_id=target_candidate;
  if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
  subjects:=r.candidate_ids;
  if r.revision<>(select max(revision) from private.erasure_subject_resolutions where company_id=tenant and anchor_candidate_id=target_candidate)
   or r.confirmed_by<>auth.uid() then blockers:=array_append(blockers,'subject_resolution_changed');end if;
  if cardinality(subjects)<>(select count(*) from public.candidates where company_id=tenant and id=any(subjects)) then
   blockers:=array_append(blockers,'subject_resolution_changed');end if;
 else blockers:=array_append(blockers,'subject_resolution_required');end if;
 select * into p from private.candidate_retention_policies where company_id=tenant order by revision desc limit 1;
 if p.id is null then blockers:=array_append(blockers,'retention_policy_required');
 elsif jsonb_array_length(p.rules)<8 then blockers:=array_append(blockers,'retention_policy_incomplete');end if;
 if p.id is not null and p.approved_by<>auth.uid() then blockers:=array_append(blockers,'policy_owner_changed');end if;
 select * into baseline from private.erasure_inventory_baseline_r6 where singleton;
 signature:=private.erasure_schema_signature();
 if baseline.singleton is null or baseline.known_tables is null or signature is distinct from baseline.schema_signature or exists(
  select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f')
  and not (n.nspname||'.'||c.relname)=any(baseline.known_tables)) then
  blockers:=array_append(blockers,'schema_dependency_unknown');
 else
  -- Preserve the R4-VOICE preview denial as well as its purge/restore adapters.
  -- The legacy R4 fixture has no voice module; SQL in this branch is planned
  -- only when the reviewed voice helper exists.
  if to_regprocedure('private.erasure_voice_request_candidate(uuid,text,uuid)') is not null then
    if exists(select 1 from private.voice_plan_request_keys t where t.company_id=tenant
      and private.erasure_voice_request_candidate(t.company_id,t.operation,t.result_id) is null)
    then blockers:=array_append(blockers,'voice_request_adapter_unknown');end if;
  end if;
  if exists(select 1 from private.contact_requests t where t.company_id=tenant
   and private.erasure_contact_request_candidate(t.company_id,t.operation,t.payload,t.result_id) is null) then blockers:=array_append(blockers,'contact_request_adapter_unknown');end if;
  if exists(select 1 from public.screening_analysis_versions a join public.applications ap on ap.company_id=a.company_id and ap.id=a.application_id
   where ap.company_id=tenant and ap.candidate_id=any(subjects) and a.execution_status in ('pending','processing')) then blockers:=array_append(blockers,'active_screening');end if;
  if exists(select 1 from private.erasure_subject_resolutions sr where sr.company_id=tenant and sr.candidate_ids && subjects and not sr.candidate_ids <@ subjects)
   then blockers:=array_append(blockers,'shared_resolution_requires_adapter');end if;
  with rows as materialized(select * from private.erasure_inventory_rows(tenant,subjects)),
  grouped as(select adapter,count(*) n from rows group by adapter)
  select coalesce((select jsonb_object_agg(adapter,n) from grouped),'{}'::jsonb),
   coalesce((select jsonb_agg(jsonb_build_array(adapter,row_key,private.erasure_hash(row_data)) order by adapter,row_key) from rows),'[]'::jsonb)
  into counts,row_digest;
 end if;
 manifest:=private.erasure_hash(jsonb_build_object('contract','sc010-r1-v1','tenant',tenant,'owner',auth.uid(),'scope',scope_kind,'subjects',subjects,
 'resolution',to_jsonb(r),'current_resolution_revision',(select coalesce(max(revision),0) from private.erasure_subject_resolutions where company_id=tenant and anchor_candidate_id=target_candidate),
 'policy',to_jsonb(p),'schema',signature,'rows',row_digest,'blockers',blockers));
 return jsonb_build_object('scope_kind',scope_kind,'candidate_count',cardinality(subjects),'counts',counts,'blockers',to_jsonb(blockers),
 'policy_revision',coalesce(p.revision,0),'resolution_revision',coalesce(r.revision,0),'manifest_hash',manifest,'schema_signature',signature,
 'generated_at',generated,'expires_at',generated+interval '5 minutes','execution_enabled',false);
end;$$;
create or replace function private.prepare_erasure_purge_manifest(target_request uuid) returns jsonb
language plpgsql volatile security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
declare e private.erasure_executions;digest text;signature text;counts jsonb;baseline text;
begin
 perform private.erasure_check_purge_scope(target_request);
 select * into e from private.erasure_executions where request_id=target_request;
 signature:=private.erasure_schema_signature();
 -- R4 final reviewed baseline is installed by the final migration, never learned at runtime.
 select schema_signature into baseline from private.erasure_inventory_baseline_r6 where singleton;
 if signature is distinct from baseline then raise exception using errcode='PT409',message='Unknown schema dependency';end if;
 select private.erasure_hash(coalesce(jsonb_agg(jsonb_build_array(adapter,row_key,private.erasure_hash(row_data)) order by adapter,row_key),'[]'::jsonb)) into digest from private.erasure_purge_rows(e.company_id,e.candidate_ids);
 insert into private.erasure_purge_manifest
 select target_request,digest,adapter,row_key,private.erasure_hash(row_data) from private.erasure_purge_rows(e.company_id,e.candidate_ids) on conflict do nothing;
 select coalesce(jsonb_object_agg(adapter,n),'{}'::jsonb) into counts from(select adapter,count(*) n from private.erasure_purge_rows(e.company_id,e.candidate_ids) group by adapter)c;
 return jsonb_build_object('manifest_hash',digest,'schema_signature',signature,'counts',counts);
end;$$;
create or replace function private.authorize_retention_suggestion(target_suggestion uuid) returns uuid
language plpgsql volatile security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
declare s private.retention_suggestions;d private.retention_delegations;r private.erasure_subject_resolutions;p jsonb;ticket uuid;result uuid;issued timestamptz;authz jsonb;
begin
 select * into s from private.retention_suggestions where id=target_suggestion for update nowait;
 select * into d from private.retention_delegations where id=s.delegation_id;
 if d.execution_mode<>'automatic' then raise exception using errcode='PT409',message='Automatic delegation required';end if;
 perform private.erasure_execution_gate(false);
 if private.erasure_schema_signature() is distinct from (select schema_signature from private.erasure_inventory_baseline_r6 where singleton) then raise exception using errcode='PT409',message='Unknown schema dependency';end if;
 p:=private.evaluate_retention_subject(s.resolution_id,d.id);
 if p->'blockers'<>'[]'::jsonb or p->>'evidence_hash'<>s.evidence_hash then raise exception using errcode='PT409',message='Retention eligibility changed';end if;
 if exists(select 1 from unnest(s.candidate_ids) x(id) where private.erasure_candidate_frozen(x.id)) then raise exception using errcode='PT409',message='Candidate workflow frozen';end if;
 select * into r from private.erasure_subject_resolutions where id=s.resolution_id;
 -- Fixed graph checks, with unknown schema/JSON/dependencies rejected by the R3 adapter before commit.
 if exists(select 1 from private.contact_requests c where c.company_id=s.company_id and private.erasure_contact_request_candidate(c.company_id,c.operation,c.payload,c.result_id) is null) then raise exception using errcode='PT409',message='Unknown candidate dependency';end if;
 issued:=clock_timestamp();
 insert into private.erasure_preview_tickets(company_id,actor_id,anchor_candidate_id,scope_kind,resolution_id,candidate_ids,manifest_hash,generations,created_at,expires_at)
 values(s.company_id,d.owner_id,r.anchor_candidate_id,'confirmed_subject',r.id,s.candidate_ids,s.evidence_hash,private.erasure_generation_snapshot(s.candidate_ids),issued,issued+interval '5 minutes') returning id into ticket;
 insert into private.erasure_requests(company_id,actor_id,anchor_candidate_id,candidate_ids,scope_kind,preview_ticket_id,manifest_hash,policy_revision,resolution_revision,status,generation)
 values(s.company_id,d.owner_id,r.anchor_candidate_id,s.candidate_ids,'confirmed_subject',ticket,s.evidence_hash,d.policy_revision,r.revision,'authorized',1) returning id into result;
 insert into private.erasure_candidate_lifecycle(candidate_id,company_id,generation,status,request_id)
 select id,s.company_id,1,'frozen',result from unnest(s.candidate_ids) x(id)
 on conflict(candidate_id) do update set generation=erasure_candidate_lifecycle.generation+1,status='frozen',request_id=excluded.request_id;
 authz:=jsonb_build_object('kind','retention_policy','actor_id',d.owner_id,'delegation_id',d.id,'activation_revision',d.revision,'policy_revision',d.policy_revision,'due_generation',s.due_generation,'due_at',s.due_at,'evidence_hash',s.evidence_hash);
 insert into private.retention_authorizations(request_id,authorization_json) values(result,authz);
 update private.retention_suggestions set status='authorized',request_id=result,blockers='[]'::jsonb where id=s.id;
 insert into private.erasure_lifecycle_events(company_id,request_id,actor_id,event,generation) values(s.company_id,result,d.owner_id,'authorized',1);
 -- Reuse the complete reviewed R3 scope validator inside this transaction. This
 -- temporary non-exportable execution never receives a reservation or ledger ACK.
 insert into private.erasure_executions(request_id,company_id,candidate_ids,scope_kind,owner_id,policy_copy,resolution_revision,generation,phase,recovery_retain_until)
 select result,s.company_id,s.candidate_ids,'confirmed_subject',d.owner_id,jsonb_build_object('revision',p2.revision,'rules',p2.rules),r.revision,1,'authorized',clock_timestamp()+interval '1 second'
 from private.candidate_retention_policies p2 where p2.id=d.policy_id;
 perform private.erasure_check_purge_scope(result);
 delete from private.erasure_executions where request_id=result;
 return result;
end;$$;
create or replace function public.get_retention_schedule(target_company uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare d private.retention_delegations;t private.retention_ticks;c private.erasure_execution_config;p private.candidate_retention_policies;schema_ok boolean;begin
 perform private.erasure_owner(target_company);
 select * into d from private.retention_delegations where company_id=target_company order by revision desc limit 1;
 select * into t from private.retention_ticks where company_id=target_company order by created_at desc,id desc limit 1;
 select * into c from private.erasure_execution_config where singleton;
 select * into p from private.candidate_retention_policies where company_id=target_company order by revision desc limit 1;
 schema_ok:=private.erasure_schema_signature() is not distinct from (select schema_signature from private.erasure_inventory_baseline_r6 where singleton);
 return jsonb_build_object('revision',coalesce(d.revision,0),'delegation_id',d.id,'policy_revision',d.policy_revision,'execution_mode',coalesce(d.execution_mode,'suggest_only'),
 'max_batch',coalesce(d.max_batch,25),'revoked',coalesce(d.revoked,true),'owner_current',d.owner_id is not distinct from auth.uid(),
 'authorization_enabled',coalesce(schema_ok and not d.revoked and d.execution_mode='automatic' and d.owner_id=auth.uid() and d.policy_id=p.id and d.policy_revision=p.revision and p.approved_by=auth.uid()
  and c.enabled and c.external_inventory_verified and c.backup_horizon_days is not null and c.artifact_horizon_days is not null and c.retention_margin_days is not null and not c.restore_isolated,false),
 'production_ready',false,
 'blockers',case when c.enabled and c.external_inventory_verified and c.backup_horizon_days is not null and c.artifact_horizon_days is not null and c.retention_margin_days is not null and not c.restore_isolated then '[]'::jsonb else jsonb_build_array('execution_not_provisioned') end || case when schema_ok then '[]'::jsonb else jsonb_build_array('schema_dependency_unknown') end,
 'oldest_pending_at',(select min(created_at) from (select created_at from private.erasure_executions where company_id=target_company and phase in ('authorized','erasing') union all select r.created_at from private.erasure_requests r where r.company_id=target_company and r.status='authorized' and not exists(select 1 from private.erasure_executions e where e.request_id=r.id)) pending),
 'expired_leases',(select count(*) from private.erasure_executions where company_id=target_company and (pending_phase is not null or (phase='erasing' and not local_purged)) and lease_until<clock_timestamp()),
 'last_tick_at',t.created_at,'lag_seconds',case when t.id is null then null else greatest(0,floor(extract(epoch from statement_timestamp()-t.created_at))) end,
 'suggestions',(select count(*) from private.retention_suggestions where company_id=target_company and status='suggested'),
 'authorized',(select count(*) from private.retention_suggestions where company_id=target_company and status='authorized'),
 'blocked',(select count(*) from private.retention_suggestions where company_id=target_company and status='blocked'),
 'holds',(select count(*) from private.erasure_holds where company_id=target_company and released_at is null));
end;$$;

-- Reset actual grantees, including grant options and TRUNCATE inherited from
-- hostile default privileges. Leave unrelated grants and global defaults intact.
do $sc19_acl$ declare obj record; grantee record;
begin
  for obj in select c.oid,c.relowner from pg_class c where c.oid=any(array['private.sc19_package_policy','private.sc19_balances','private.sc19_trial_nips','private.sc19_trial_approvals','private.sc19_analysis_spend','private.sc19_credit_journal','private.erasure_inventory_baseline_r5','private.erasure_inventory_baseline_r6','private.sc19_payment_offers','private.sc19_payment_orders','private.sc19_payment_requests','private.sc19_payment_grants']::regclass[]) loop
    for grantee in select distinct acl.grantee,role.rolname from pg_class c
      cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
      left join pg_roles role on role.oid=acl.grantee where c.oid=obj.oid and acl.grantee<>obj.relowner
    loop
      if grantee.grantee=0 then execute format('revoke all on table %s from public',obj.oid::regclass);
      else execute format('revoke all on table %s from %I',obj.oid::regclass,grantee.rolname);end if;
    end loop;
  end loop;
  -- Column ACLs may be independent of table ACLs; enumerate actual grantees.
  for obj in select c.oid,c.relowner,a.attname,a.attacl from pg_class c
    join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
    where c.oid=any(array['private.sc19_package_policy','private.sc19_balances','private.sc19_trial_nips','private.sc19_trial_approvals','private.sc19_analysis_spend','private.sc19_credit_journal','private.erasure_inventory_baseline_r5','private.erasure_inventory_baseline_r6','private.sc19_payment_offers','private.sc19_payment_orders','private.sc19_payment_requests','private.sc19_payment_grants']::regclass[]) and a.attacl is not null loop
    for grantee in select distinct acl.grantee,role.rolname from aclexplode(obj.attacl) acl
      left join pg_roles role on role.oid=acl.grantee where acl.grantee<>obj.relowner
    loop
      if grantee.grantee=0 then execute format('revoke all (%I) on table %s from public',obj.attname,obj.oid::regclass);
      else execute format('revoke all (%I) on table %s from %I',obj.attname,obj.oid::regclass,grantee.rolname);end if;
    end loop;
  end loop;
  for obj in select p.oid,p.proowner from pg_proc p where p.oid=any(array['private.sc19_valid_nip(text)','private.sc19_lock_company(uuid)','private.sc19_lock_analysis_company()','public.sc19_claim_trial(uuid,text)','public.sc19_package_sizes()','public.sc19_get_balance(uuid)','private.sc19_grant_paid(uuid,text)','private.sc19_charge_analysis()','private.sc19_reconcile_analysis()','private.sc19_payment_immutable()']::regprocedure[]) loop
    for grantee in select distinct acl.grantee,role.rolname from pg_proc p
      cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      left join pg_roles role on role.oid=acl.grantee where p.oid=obj.oid and acl.grantee<>obj.proowner
    loop
      if grantee.grantee=0 then execute format('revoke all on function %s from public',obj.oid::regprocedure);
      else execute format('revoke all on function %s from %I',obj.oid::regprocedure,grantee.rolname);end if;
    end loop;
  end loop;
end $sc19_acl$;
grant execute on function public.sc19_claim_trial(uuid,text),public.sc19_get_balance(uuid) to authenticated;
grant execute on function public.sc19_package_sizes() to anon,authenticated;

-- Verify the exact resulting owned ACL, including column grants/options.
-- Catalog fingerprints separately preserve every non-owned privilege.
do $owned_acl_postflight$ begin
  if exists(select 1 from pg_class c
    cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
    where c.oid=any(array['private.sc19_package_policy','private.sc19_balances','private.sc19_trial_nips','private.sc19_trial_approvals','private.sc19_analysis_spend','private.sc19_credit_journal','private.erasure_inventory_baseline_r5','private.erasure_inventory_baseline_r6','private.sc19_payment_offers','private.sc19_payment_orders','private.sc19_payment_requests','private.sc19_payment_grants']::regclass[]) and acl.grantee<>c.relowner)
    or exists(select 1 from pg_class c join pg_attribute a on a.attrelid=c.oid
      cross join lateral aclexplode(a.attacl) acl
      where c.oid=any(array['private.sc19_package_policy','private.sc19_balances','private.sc19_trial_nips','private.sc19_trial_approvals','private.sc19_analysis_spend','private.sc19_credit_journal','private.erasure_inventory_baseline_r5','private.erasure_inventory_baseline_r6','private.sc19_payment_offers','private.sc19_payment_orders','private.sc19_payment_requests','private.sc19_payment_grants']::regclass[]) and acl.grantee<>c.relowner)
    or exists(select 1 from pg_proc p
      cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      where p.oid=any(array['private.sc19_valid_nip(text)','private.sc19_lock_company(uuid)','private.sc19_lock_analysis_company()','public.sc19_claim_trial(uuid,text)','public.sc19_package_sizes()','public.sc19_get_balance(uuid)','private.sc19_grant_paid(uuid,text)','private.sc19_charge_analysis()','private.sc19_reconcile_analysis()','private.sc19_payment_immutable()']::regprocedure[]) and acl.grantee<>p.proowner
      and not (acl.privilege_type='EXECUTE' and not acl.is_grantable and (
        (p.oid='public.sc19_package_sizes()'::regprocedure and pg_get_userbyid(acl.grantee) in ('anon','authenticated'))
        or (p.oid in ('public.sc19_claim_trial(uuid,text)'::regprocedure,'public.sc19_get_balance(uuid)'::regprocedure)
          and pg_get_userbyid(acl.grantee)='authenticated')))) then
    raise exception 'sc19_owned_acl_unreviewed' using errcode='42501';
  end if;
end $owned_acl_postflight$;

-- FINAL POSTFLIGHT: these are reviewed literals, never learned from the target.
do $postflight$ declare expected text; known text[]; actual_tables text[]; actual text; source_voice boolean; output_variant text;
begin
  -- Internal FK trigger names contain OIDs and are not fingerprinted. Their
  -- enabled/validated state must still enforce the reviewed tenant references.
  if exists(select 1 from pg_constraint c
    join pg_class r on r.oid=c.conrelid join pg_namespace n on n.oid=r.relnamespace
    where c.contype='f' and (n.nspname in ('public','private') or c.confrelid in
      (select r2.oid from pg_class r2 join pg_namespace n2 on n2.oid=r2.relnamespace where n2.nspname in ('public','private'))) and not c.convalidated)
    or exists(select 1 from pg_trigger t join pg_constraint c on c.oid=t.tgconstraint
      join pg_class r on r.oid=c.conrelid join pg_namespace n on n.oid=r.relnamespace
      where t.tgisinternal and c.contype='f' and (n.nspname in ('public','private') or c.confrelid in
        (select r2.oid from pg_class r2 join pg_namespace n2 on n2.oid=r2.relnamespace where n2.nspname in ('public','private'))) and t.tgenabled<>'O') then
    raise exception 'sc19_foreign_key_enforcement_unreviewed' using errcode='55000';
  end if;

  select voice,case when reviewed_state='production_hosted_20261030' then 'legacy_production_hosted_20261030'
    when voice then 'voice' else 'legacy' end into source_voice,output_variant from pg_temp.sc19_migration_state;
  select schema_signature,known_tables into expected,known from private.erasure_inventory_baseline_r6 where singleton;
  actual:=pg_temp.sc19_schema_signature();
  if actual is distinct from expected or private.erasure_schema_signature() is distinct from expected then
    raise exception 'sc19_final_schema_signature_mismatch:%',actual using errcode='55000';
  end if;
  select array_agg(n.nspname||'.'||c.relname order by (n.nspname||'.'||c.relname) collate "C") into actual_tables
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','private') and c.relkind in ('r','p','f');
  if actual_tables is distinct from (select array_agg(x order by x collate "C") from unnest(known) x) then
    raise exception 'sc19_final_inventory_gap' using errcode='55000';
  end if;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private')
      and (p.prosrc like '%erasure_inventory_baseline_r4%' or p.prosrc like '%erasure_inventory_baseline_r5%')) then
    raise exception 'sc19_stale_inventory_reference' using errcode='55000';
  end if;
  if exists(select 1 from private.sc19_payment_orders o left join private.sc19_payment_requests r
    on r.company_id=o.company_id and r.request_id=o.request_id and r.order_id=o.id where r.order_id is null) then
    raise exception 'sc19_original_request_alias_missing' using errcode='55000';
  end if;

if pg_temp.sc19_catalog() is distinct from ('{"legacy":{"pg16":{"sc010_signature":"e99342b97cf10c9f19c5351f423d30ff4dadaa18294465ff976d926d2cc6a07b","routines":"7c0a089b85f2b9aed7b461cc940d5de1b0b80892ccef88d9348f40fd93a04a93","indexes":"9ded7dff9d05049d48d530c82fb5a464ff08e1c2d69160e8571688c5ac173f61","trigger_states":"74938b9b4455fa49ecc5582bb385386f37033a4e7e12881a345f4accca411fe1","relations":"5b1c3c8bc0ae0b1e9d2f04a9fb85f8c03c3d3dcbe174070d3c1a7166afb22f25","policies":"d7918648cf896d04731b18e4827399b4f9c0b21c243786f11aa2812fe18e8772","nonowned_acl":"80866fd7d14d5c596441703ac7f3ccc39dbc2ce9d6b9d0da1299e61b4c749a95","rewrites":"e9c6543bb90eae112800eec33f1bec5a733fc5e6194a92915f7ff1124fad897f"},"pg17":{"sc010_signature":"e99342b97cf10c9f19c5351f423d30ff4dadaa18294465ff976d926d2cc6a07b","routines":"7c0a089b85f2b9aed7b461cc940d5de1b0b80892ccef88d9348f40fd93a04a93","indexes":"9ded7dff9d05049d48d530c82fb5a464ff08e1c2d69160e8571688c5ac173f61","trigger_states":"74938b9b4455fa49ecc5582bb385386f37033a4e7e12881a345f4accca411fe1","relations":"5b1c3c8bc0ae0b1e9d2f04a9fb85f8c03c3d3dcbe174070d3c1a7166afb22f25","policies":"d7918648cf896d04731b18e4827399b4f9c0b21c243786f11aa2812fe18e8772","nonowned_acl":"6428087b0877402ce4831d2c9998ad746f4d44155dc442bcb18997fdd3968b35","rewrites":"e9c6543bb90eae112800eec33f1bec5a733fc5e6194a92915f7ff1124fad897f"}},"voice":{"pg16":{"sc010_signature":"6fd4900f85f0a1b6f4aad11a9246722cf79e857ea6bc999f7249151f20871061","routines":"a3f2ceb6949bbd0b7d6a7ba0d4e8a55c1eddbd48e68c6f41cdcb791b2bfd40c4","indexes":"061d475f12d98ad172f8134bcde5d4cae60bd88a6a2c6b3a8bc665401b5dead7","trigger_states":"e979fe2604d1a8631bd747fcf4e63c4539ef4a12d3b7b4d22ee360b9061090c2","relations":"7d9060e49c07bdb5ec0d16288be681fe0e8a60512dbd81e56385df372d601deb","policies":"5410709dbbb55712d829a6f6c1e01ac825f71a38473ec919d8c95030db0a6706","nonowned_acl":"7bd81fd322357484bcdda55d5bbecb0aae8c2bd0c020a4a441f8271d54c12059","rewrites":"e9c6543bb90eae112800eec33f1bec5a733fc5e6194a92915f7ff1124fad897f"},"pg17":{"sc010_signature":"6fd4900f85f0a1b6f4aad11a9246722cf79e857ea6bc999f7249151f20871061","routines":"a3f2ceb6949bbd0b7d6a7ba0d4e8a55c1eddbd48e68c6f41cdcb791b2bfd40c4","indexes":"061d475f12d98ad172f8134bcde5d4cae60bd88a6a2c6b3a8bc665401b5dead7","trigger_states":"e979fe2604d1a8631bd747fcf4e63c4539ef4a12d3b7b4d22ee360b9061090c2","relations":"7d9060e49c07bdb5ec0d16288be681fe0e8a60512dbd81e56385df372d601deb","policies":"5410709dbbb55712d829a6f6c1e01ac825f71a38473ec919d8c95030db0a6706","nonowned_acl":"64ad973471c4e5d668002d0220ea8210dbc72bcae188c90884f2648f17793a72","rewrites":"e9c6543bb90eae112800eec33f1bec5a733fc5e6194a92915f7ff1124fad897f"}},"legacy_production_hosted_20261030":{"pg17":{"sc010_signature":"e99342b97cf10c9f19c5351f423d30ff4dadaa18294465ff976d926d2cc6a07b","routines":"a1146ac71d0d3bef0915db216b1ca49291f0044651f4bed629569307f252d5ed","indexes":"9ded7dff9d05049d48d530c82fb5a464ff08e1c2d69160e8571688c5ac173f61","trigger_states":"74938b9b4455fa49ecc5582bb385386f37033a4e7e12881a345f4accca411fe1","relations":"5b1c3c8bc0ae0b1e9d2f04a9fb85f8c03c3d3dcbe174070d3c1a7166afb22f25","policies":"d7918648cf896d04731b18e4827399b4f9c0b21c243786f11aa2812fe18e8772","nonowned_acl":"6428087b0877402ce4831d2c9998ad746f4d44155dc442bcb18997fdd3968b35","rewrites":"e9c6543bb90eae112800eec33f1bec5a733fc5e6194a92915f7ff1124fad897f"}}}'::jsonb -> output_variant -> ('pg'||(current_setting('server_version_num')::integer/10000)::text)) then
    raise exception 'sc19_final_catalog_mismatch' using errcode='55000';
  end if;

end $postflight$;

-- Helpers are not part of the application schema and are removed before commit.

drop function pg_temp.sc19_catalog();

drop function pg_temp.sc19_schema_signature();

drop function pg_temp.sc19_routines_signature();

drop function pg_temp.sc19_indexes_signature();

drop function pg_temp.sc19_trigger_states_signature();

drop function pg_temp.sc19_relations_signature();

drop function pg_temp.sc19_policies_signature();

drop function pg_temp.sc19_nonowned_acl_signature();

drop function pg_temp.sc19_rewrites_signature();

commit;
