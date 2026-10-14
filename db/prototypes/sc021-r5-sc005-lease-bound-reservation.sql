-- SC-021/SC-005 restricted screening claim -> metered reservation bridge.
-- OFFLINE PROTOTYPE ONLY, outside supabase/migrations. Does not modify
-- claim_screening_attempt or the Production SC-005 worker.
begin;

-- One screening attempt may authorize one physical provider reservation.
-- The request key is the attempt's own idempotency key, never a UUID
-- chosen by screening_worker on each call.
create table private.ai_gateway_screening_attempt_reservations (
  company_id uuid not null,
  attempt_id uuid not null primary key
    references public.screening_analysis_attempts(id),
  request_key uuid not null,
  usage_id uuid not null,
  unique (company_id, request_key),
  foreign key (company_id, usage_id)
    references public.ai_gateway_usage(company_id, id)
);
alter table private.ai_gateway_screening_attempt_reservations enable row level security;
revoke all on private.ai_gateway_screening_attempt_reservations
  from public,anon,authenticated,screening_worker,ai_meter_worker,erasure_purge_owner;

create function public.ai_gateway_reserve_screening_attempt(
 target_attempt uuid,
 target_lease_token text,
 target_input_fingerprint text,
 expected_provider text,
 expected_model text,
 expected_policy_version text,
 expected_price_version text,
 expected_micro_usd bigint
)
returns table(usage_id uuid,created boolean,warning boolean,
 company_id uuid,request_key uuid)
language plpgsql security definer set search_path = '' as $bridge$
declare
 claim record;
 check_after record;
 reservation record;
 binding private.ai_gateway_screening_attempt_reservations%rowtype;
begin
 if target_attempt is null or target_lease_token is null
    or length(target_lease_token)<>64 or target_input_fingerprint is null
    or expected_provider is null or expected_model is null
    or expected_policy_version is null or expected_price_version is null
    or expected_micro_usd is null
 then raise exception 'SC021_SCREENING_CLAIM_INVALID' using errcode='42501';end if;

 -- Lock the attempt before any budget work so a second call with the same
 -- live lease cannot pass the pre-check and insert another usage row.
 -- Company and candidate come from the screening -> application chain.
 select att.status,att.lease_token_hash,att.lease_expires_at,
        att.idempotency_key,
        a.id as operation_id,a.company_id as tenant,a.execution_status,
        a.provider,a.model,a.input_fingerprint,
        a.application_id,a.position_id,
        app.company_id as application_tenant,app.candidate_id,
        app.recruitment_id as process_id
 into claim
 from public.screening_analysis_attempts att
 join public.screening_analysis_versions a
   on a.id=att.analysis_id and a.company_id=att.company_id
 join public.applications app
   on app.id=a.application_id and app.company_id=a.company_id
 where att.id=target_attempt
 for update of att;
 if not found or claim.status is distinct from 'processing'
    or claim.execution_status is distinct from 'processing'
    or claim.lease_expires_at <= clock_timestamp()
    or claim.lease_token_hash is distinct from
      private.screening_hash(target_lease_token)
    or claim.input_fingerprint is distinct from target_input_fingerprint
    or claim.provider is distinct from expected_provider
    or claim.model is distinct from expected_model
    or claim.tenant is distinct from claim.application_tenant
    or claim.idempotency_key is null
    or private.screening_stale_reason(claim.operation_id) is not null
 then raise exception 'SC021_SCREENING_CLAIM_INVALID' using errcode='42501';end if;

 -- Candidate is locked by the bound reservation function first. The ledger
 -- key is the attempt idempotency key, so the worker cannot mint another one.
 select * into reservation from private.ai_gateway_reserve_candidate(
  claim.tenant,claim.candidate_id,claim.idempotency_key,
  claim.operation_id,claim.process_id,'cv_screening',
  expected_provider,expected_model,expected_policy_version,
  expected_price_version,expected_micro_usd
 );

 -- Hold the rows whose changes mark an analysis stale, then the analysis
 -- itself. A concurrent CV/application update either committed before these
 -- locks, and is visible to screening_stale_reason, or waits until this
 -- transaction ends. Failure rolls the reservation back.
 perform 1 from public.applications application_row
  where application_row.id=claim.application_id
    and application_row.company_id=claim.tenant
  for update;
 perform 1 from public.recruitments recruitment_row
  where recruitment_row.id=claim.process_id
    and recruitment_row.company_id=claim.tenant
  for update;
 perform 1 from public.positions position_row
  where position_row.id=claim.position_id
    and position_row.company_id=claim.tenant
  for update;
 perform 1 from (
  select document_row.id from public.candidate_documents document_row
  where document_row.company_id=claim.tenant
    and document_row.candidate_id=claim.candidate_id
  order by document_row.created_at desc, document_row.id desc
  limit 1
  for update
 ) locked_document;
 perform 1 from public.screening_analysis_versions analysis_row
  where analysis_row.id=claim.operation_id
    and analysis_row.company_id=claim.tenant
  for update;

 select att.status,att.lease_token_hash,att.lease_expires_at,
        a.execution_status,a.input_fingerprint,a.provider,a.model
 into check_after
 from public.screening_analysis_attempts att
 join public.screening_analysis_versions a
   on a.id=att.analysis_id and a.company_id=att.company_id
 where att.id=target_attempt;
 if not found or check_after.status is distinct from 'processing'
    or check_after.execution_status is distinct from 'processing'
    or check_after.lease_expires_at <= clock_timestamp()
    or check_after.lease_token_hash is distinct from
      private.screening_hash(target_lease_token)
 then raise exception 'SC021_SCREENING_CLAIM_EXPIRED' using errcode='42501';end if;
 if check_after.input_fingerprint is distinct from target_input_fingerprint
    or check_after.provider is distinct from expected_provider
    or check_after.model is distinct from expected_model
    or private.screening_stale_reason(claim.operation_id) is not null
 then raise exception 'SC021_SCREENING_INPUT_STALE' using errcode='42501';end if;

 if reservation.created then
  insert into private.ai_gateway_screening_attempt_reservations(
   company_id,attempt_id,request_key,usage_id
  ) values (
   claim.tenant,target_attempt,claim.idempotency_key,reservation.usage_id
  );
 else
  select * into binding
  from private.ai_gateway_screening_attempt_reservations
  where attempt_id=target_attempt;
  if not found or binding.company_id is distinct from claim.tenant
     or binding.request_key is distinct from claim.idempotency_key
     or binding.usage_id is distinct from reservation.usage_id
  then raise exception 'SC021_ATTEMPT_RESERVATION_CONFLICT' using errcode='23505';end if;
 end if;

 return query select reservation.usage_id::uuid,
   reservation.created::boolean,reservation.warning::boolean,
   claim.tenant::uuid,claim.idempotency_key::uuid;
end $bridge$;

revoke all on function public.ai_gateway_reserve_screening_attempt(
 uuid,text,text,text,text,text,text,bigint
) from public,anon,authenticated,ai_meter_worker,erasure_purge_owner;
grant execute on function public.ai_gateway_reserve_screening_attempt(
 uuid,text,text,text,text,text,text,bigint
) to screening_worker;
commit;
