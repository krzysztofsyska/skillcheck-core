-- SC-021/SC-005 restricted screening claim -> metered reservation bridge.
-- OFFLINE PROTOTYPE ONLY, outside supabase/migrations. Does not modify
-- claim_screening_attempt or the Production SC-005 worker.
begin;
create function private.ai_gateway_reserve_screening_attempt(
 target_attempt uuid,
 target_lease_token text,
 target_input_fingerprint text,
 target_request_key uuid,
 expected_provider text,
 expected_model text,
 expected_policy_version text,
 expected_price_version text,
 expected_micro_usd bigint
)
returns table(usage_id uuid,created boolean,warning boolean,
 company_id uuid,candidate_id uuid)
language plpgsql security definer set search_path = '' as $bridge$
declare
 claim record;
 check_after record;
 reservation record;
begin
 if target_attempt is null or target_lease_token is null
    or length(target_lease_token)<>64 or target_input_fingerprint is null
    or target_request_key is null or expected_provider is null
    or expected_model is null or expected_policy_version is null
    or expected_price_version is null or expected_micro_usd is null
 then raise exception 'SC021_SCREENING_CLAIM_INVALID' using errcode='42501';end if;

 -- Only the DB-held worker lease grants the right to create a billable
 -- candidate-linked AI attempt. Company and candidate are derived from the
 -- authoritative screening -> application chain, NOT user-supplied.
 select att.status,att.lease_token_hash,att.lease_expires_at,
        a.id as operation_id,a.company_id as tenant,a.execution_status,
        a.provider,a.model,a.input_fingerprint,
        app.company_id as application_tenant,app.candidate_id,
        app.recruitment_id as process_id
 into claim
 from public.screening_analysis_attempts att
 join public.screening_analysis_versions a
   on a.id=att.analysis_id and a.company_id=att.company_id
 join public.applications app
   on app.id=a.application_id and app.company_id=a.company_id
 where att.id=target_attempt;
 if not found or claim.status is distinct from 'processing'
    or claim.execution_status is distinct from 'processing'
    or claim.lease_expires_at <= clock_timestamp()
    or claim.lease_token_hash is distinct from
      private.screening_hash(target_lease_token)
    or claim.input_fingerprint is distinct from target_input_fingerprint
    or claim.provider is distinct from expected_provider
    or claim.model is distinct from expected_model
    or claim.tenant is distinct from claim.application_tenant
    or private.screening_stale_reason(claim.operation_id) is not null
 then raise exception 'SC021_SCREENING_CLAIM_INVALID' using errcode='42501';end if;

 -- Candidate is locked by the bound reservation function first. No direct
 -- generic worker reservation, no free-form candidate pseudonym.
 select * into reservation from private.ai_gateway_reserve_candidate(
  claim.tenant,claim.candidate_id,target_request_key,
  claim.operation_id,claim.process_id,'cv_screening',
  expected_provider,expected_model,expected_policy_version,
  expected_price_version,expected_micro_usd
 );

 -- A lease may have expired/revoked while we took the candidate budget lock.
 -- Recheck after reservation in the SAME transaction; a failure rolls back
 -- both physical-call reservation and private candidate link atomically.
 select att.status,att.lease_token_hash,att.lease_expires_at,
        a.execution_status
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
 return query select reservation.usage_id::uuid,
   reservation.created::boolean,reservation.warning::boolean,
   claim.tenant::uuid,claim.candidate_id::uuid;
end $bridge$;

revoke all on function private.ai_gateway_reserve_screening_attempt(
 uuid,text,text,uuid,text,text,text,text,bigint
) from public,anon,authenticated,ai_meter_worker,erasure_purge_owner;
grant execute on function private.ai_gateway_reserve_screening_attempt(
 uuid,text,text,uuid,text,text,text,text,bigint
) to screening_worker;
commit;
