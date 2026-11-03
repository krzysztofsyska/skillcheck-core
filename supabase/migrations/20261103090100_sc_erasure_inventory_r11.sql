-- SC-FREE-AUTO-001 / SC-CONSENT-001 / SC-010 R11: reviewed erasure inventory
-- revision for the five tables added by
-- 20261103090000_sc19_auto_trial_marketing_consent.sql.
--
-- Order is mandatory: R10 (20261101130300) -> auto trial + consent
-- (20261103090000) -> this migration. Without R11 those five tables make every
-- erasure preview/purge fail closed with schema_dependency_unknown / PT409.
--
-- Inventory classification of what the previous migration added:
--   private.marketing_consent_events: company-level consent history (company id,
--     the wording shown, its version, the acting user id, the time granted and
--     the time withdrawn). NO candidate data: a consent is a statement by the
--     company's own owner about the company's own contact details, so it is not
--     reachable from public.candidates and gets no candidate adapter.
--     Its recorded_seq column (a bigint identity giving the write order, which
--     is what decides the consent in force) is NOT personal data and needs no
--     inventory entry of its own: this inventory enumerates RELATIONS, not
--     columns, and a counter says nothing about any person. It is still inside
--     the reviewed signatures below, because private.erasure_schema_signature()
--     hashes every column of every tracked relation; the two literals in the
--     preflight were therefore recomputed when the column was added, by running
--     that function against the full chain on PostgreSQL 16. The identity
--     SEQUENCE the column creates is relkind 'S', which neither the signature
--     nor the known_tables allowlist tracks, so it adds no inventory surface.
--   private.sc19_trial_auto_checks: audit of the automatic FREE verification
--     (company id, NIP, what the Ministry of Finance registry answered). NIP and
--     company name are company data, the same class as the already inventoried
--     private.sc19_trial_approvals / private.sc19_trial_nips; no candidate data
--     and therefore no adapter.
--   private.sc19_trial_nip_releases: which trial NIP an operator released, for
--     which company, by whom and why. Company data, no candidate data. The
--     company id carries no foreign key, so a release row never blocks anything.
--   private.sc19_trial_auto_settings: one row holding the operator switch and the
--     request secret. No personal data.
--   private.sc19_trial_auto_nonces: signed request ids for replay protection,
--     deleted after three minutes. No personal data.
--
-- HOW THESE ROWS ARE REMOVED — precisely. The two audit tables and the consent
-- ledger are APPEND-ONLY: private.contact_immutable() refuses every UPDATE and
-- DELETE except a DELETE by erasure_purge_owner that the purge manifest allows,
-- and these tables are granted no privilege and no policy for that role. Their
-- rows are therefore not deletable at all today, and because their company_id
-- references public.companies ON DELETE RESTRICT, a company that has such a row
-- cannot be deleted either.
--
-- That is deliberate and is not a regression:
--   * SC-010 erasure is CANDIDATE-scoped. The purge manifest and
--     private.erasure_purge_allowed() enumerate candidate-linked rows; none of
--     these five tables holds candidate data, so none of them is reachable by a
--     data-subject erasure request and nothing a candidate can ask for is
--     blocked. Granting erasure_purge_owner access to company-level accounting
--     and consent tables would widen the purge surface without a reviewed
--     manifest entry — a separate change with its own review, not a comment fix.
--   * Company deletion is already restricted, before this migration, by
--     private.sc19_trial_approvals, private.sc19_trial_nips,
--     private.sc19_credit_journal and the other SC-019 accounting tables, which
--     reference public.companies ON DELETE RESTRICT and likewise have no purge
--     policy. The product has no company-deletion path, and public.companies
--     itself has no purge grant. These tables add no new block.
--   * Keeping a consent ledger that cannot be rewritten is the point: under
--     art. 7(1) GDPR the grant and the withdrawal must stay demonstrable.
-- An earlier version of this comment claimed the rows are "removed with the
-- company by the restrict-FK order already used for the SC-019 accounting
-- tables". They are not removed at all, and unlike those tables these three
-- also carry the immutability trigger; the wording above is the accurate one.
--
-- No adapter changes: none of the five tables is candidate-linked, so the R10
-- adapters already list every candidate-linked row. Only the four baseline
-- readers move from R10 to R11, byte-identical apart from the baseline table
-- name. Signatures are reviewed literals, never learned from the target
-- database. No remote application is authorized from an agent session.
begin;

do $r11_preflight$
declare
  r10_signature text; r10_tables text[]; source text; expected text;
  new_tables text[]:=array['private.marketing_consent_events','private.sc19_trial_auto_checks',
    'private.sc19_trial_auto_nonces','private.sc19_trial_auto_settings',
    'private.sc19_trial_nip_releases'];
  actual_tables text[];
begin
  if to_regclass('private.erasure_inventory_baseline_r10') is null then
    raise exception 'sc_r11_requires_r10_inventory' using errcode='55000';
  end if;
  if to_regclass('private.erasure_inventory_baseline_r11') is not null then
    raise exception 'sc_r11_already_installed' using errcode='55000';
  end if;
  if to_regclass('private.marketing_consent_events') is null
    or to_regclass('private.sc19_trial_auto_checks') is null
    or to_regclass('private.sc19_trial_nip_releases') is null
    or to_regprocedure('public.sc19_auto_claim_trial(uuid,text,text,text,text,uuid,bigint,text)') is null
    or to_regprocedure('public.sc19_operator_release_trial_nip(text,text,uuid)') is null
    or to_regprocedure('private.rotate_sc19_trial_auto_secret(text)') is null
    or to_regprocedure('private.marketing_consent_text(text)') is null then
    raise exception 'sc_r11_requires_auto_trial_consent' using errcode='55000';
  end if;
  execute 'select schema_signature,known_tables from private.erasure_inventory_baseline_r10 where singleton'
    into r10_signature,r10_tables;
  case r10_signature
    when '60ce9006204013feeadfea4c169d19896638d43f3e82705ad8a4a59d1df5f8e9' then
      source:='5b12803271c827e54bdfae5e3380b353349c60e7572c64a4d148e6457b560fa0';
      expected:='0d22eb7a547b1f8838298b034d3d257ca4cba9e81430f5c6b20b9212e4d88b84';
    when '689349876329b99935081f1ebcb015104d126558290171662b23ccd67f671837' then
      -- The voice-module variant of R10. No reviewed signature pair exists for it
      -- yet: the current migration chain installs the legacy variant, and the
      -- voice variant is reached only by the historical R6 fixtures, which stop
      -- long before R10. Refusing here is deliberate and fail-closed; a database
      -- in that state needs its own reviewed revision rather than a guess.
      raise exception 'sc_r11_voice_variant_unreviewed' using errcode='55000';
    else raise exception 'sc_r11_r10_baseline_unreviewed' using errcode='55000';
  end case;
  if private.erasure_schema_signature() is distinct from source then
    raise exception 'sc_r11_source_schema_unreviewed:%',private.erasure_schema_signature() using errcode='55000';
  end if;
  select array_agg(n.nspname||'.'||c.relname order by (n.nspname||'.'||c.relname) collate "C") into actual_tables
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','private') and c.relkind in ('r','p','f');
  if actual_tables is distinct from (select array_agg(x order by x collate "C") from unnest(r10_tables||new_tables) x) then
    raise exception 'sc_r11_inventory_gap' using errcode='55000';
  end if;

  create table private.erasure_inventory_baseline_r11 (
    singleton boolean primary key default true check(singleton),
    schema_signature text not null,known_tables text[] not null
  );
  alter table private.erasure_inventory_baseline_r11 enable row level security;
  create trigger immutable_history before update or delete on private.erasure_inventory_baseline_r11
    for each row execute function private.contact_immutable();
  insert into private.erasure_inventory_baseline_r11 values (true,expected,
    r10_tables||new_tables||array['private.erasure_inventory_baseline_r11']);
end $r11_preflight$;

-- Exact reviewed R10 source bodies, retargeted from R10 to R11 at source level
-- (only the baseline table name differs). CREATE OR REPLACE keeps existing ACLs.
create or replace function public.preview_candidate_erasure(target_candidate uuid,scope_kind text default 'candidate_record',resolution_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
declare tenant uuid;subjects uuid[];p private.candidate_retention_policies;r private.erasure_subject_resolutions;
 baseline private.erasure_inventory_baseline_r11;signature text;counts jsonb:='{}';manifest text;row_digest jsonb:='[]';
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
 select * into baseline from private.erasure_inventory_baseline_r11 where singleton;
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
 select schema_signature into baseline from private.erasure_inventory_baseline_r11 where singleton;
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
 if private.erasure_schema_signature() is distinct from (select schema_signature from private.erasure_inventory_baseline_r11 where singleton) then raise exception using errcode='PT409',message='Unknown schema dependency';end if;
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
 schema_ok:=private.erasure_schema_signature() is not distinct from (select schema_signature from private.erasure_inventory_baseline_r11 where singleton);
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

do $r11_postflight$
declare expected text; known text[]; actual_tables text[];
begin
  select schema_signature,known_tables into expected,known from private.erasure_inventory_baseline_r11 where singleton;
  if private.erasure_schema_signature() is distinct from expected then
    raise exception 'sc_r11_final_schema_signature_mismatch:%',private.erasure_schema_signature() using errcode='55000';
  end if;
  select array_agg(n.nspname||'.'||c.relname order by (n.nspname||'.'||c.relname) collate "C") into actual_tables
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','private') and c.relkind in ('r','p','f');
  if actual_tables is distinct from (select array_agg(x order by x collate "C") from unnest(known) x) then
    raise exception 'sc_r11_final_inventory_gap' using errcode='55000';
  end if;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private') and p.prosrc ~ 'erasure_inventory_baseline_r([456789]|10)([^0-9]|$)') then
    raise exception 'sc_r11_stale_inventory_reference' using errcode='55000';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private') and p.prosrc like '%erasure_inventory_baseline_r11%'
      and p.proname in ('preview_candidate_erasure','prepare_erasure_purge_manifest','authorize_retention_suggestion','get_retention_schedule')) <> 4 then
    raise exception 'sc_r11_inventory_reference_missing' using errcode='55000';
  end if;
  -- Erasure of bulk rows still relies on exactly these cascades and the slot release.
  if (select count(*) from pg_constraint where conrelid='private.cv_bulk_items'::regclass and contype='f'
      and confrelid in ('public.applications'::regclass,'public.candidates'::regclass) and confdeltype='c') <> 3
    or not exists(select 1 from pg_trigger where tgrelid='private.cv_bulk_items'::regclass and tgname='release_held_slot'
      and tgfoid='private.cv_bulk_item_release_on_delete()'::regprocedure and tgenabled='O')
    or not exists(select 1 from pg_trigger where tgrelid='private.application_preselection_group_events'::regclass
      and tgname='aa_erasure_cascade_guard' and tgfoid='private.erasure_step4_cascade_guard()'::regprocedure and tgenabled='O') then
    raise exception 'sc_r11_cascade_contract_changed' using errcode='55000';
  end if;
end $r11_postflight$;
commit;
