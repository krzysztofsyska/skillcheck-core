-- Operational rollback for R6-2 (package voice pools): drop only the three
-- owner-only functions. Every pool already given to a company stays (the pool
-- guard forbids deletion) and keeps its derived reference, so a later forward
-- migration still never gives the same package a second pool. The SC-010
-- erasure schema signature is unaffected, because functions are not part of it.
begin;
drop function if exists private.sc19_voice_sync_package_pools(uuid);
drop function if exists private.sc19_voice_package_events(uuid);
drop function if exists private.sc19_voice_package_reference(uuid,text,text);
commit;
