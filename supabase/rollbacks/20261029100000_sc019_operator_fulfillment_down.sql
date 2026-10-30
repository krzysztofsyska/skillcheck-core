-- Roll back only the operator fulfillment functions. Approvals, policy rows,
-- balances and journal entries written through them stay as audited data.
begin;
drop function if exists public.sc19_operator_grant_paid(uuid,text);
drop function if exists public.sc19_operator_approve_trial(uuid,text,text);
drop function if exists public.sc19_operator_set_package_policy(text,integer);
drop function if exists public.sc19_operator_package_policy();
drop function if exists public.sc19_operator_companies(text);
drop function if exists private.sc19_require_operator();
commit;
