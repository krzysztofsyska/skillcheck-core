-- Roll back only Step 3's new objects. The original R6 claim RPC is immutable.
begin;
drop function if exists public.complete_screening_evidence(uuid,text,text,text,jsonb,text,text,integer,integer,integer,numeric,text);
drop function if exists public.claim_screening_attempt_v2(uuid);
drop function if exists public.screening_attempt_result_schema_version(uuid);
commit;
