-- Operational rollback for R6-2 (operator voice interview grant): drop only the
-- three owner-only functions. Every pool grant row stays (the pool guard forbids
-- deletion) and the SC-010 erasure schema signature is unaffected, because
-- functions are not part of it. A trial grant already recorded keeps its derived
-- reference, so a later forward migration still enforces "once per company".
begin;
drop function if exists private.sc19_voice_grant_interviews(uuid,text,integer,uuid,timestamptz,uuid,timestamptz);
drop function if exists private.sc19_voice_interview_balance(uuid);
drop function if exists private.sc19_voice_trial_reference(uuid);
commit;
