-- Operational rollback pauses AI registration. Never remove the candidate approval
-- boundary or retag historical definitions; approved/manual tasks remain usable.
-- Resume registration only with reviewed forward SQL. No evidence is deleted.
begin;
revoke all on function exercise_ai.record_proposal(uuid,uuid,jsonb,integer) from public,anon,authenticated;
commit;
