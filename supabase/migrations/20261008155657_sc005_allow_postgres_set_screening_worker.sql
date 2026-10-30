begin;
-- SC-005: permit explicit server-side switch to the existing restricted worker role.
-- Preserve INHERIT and ADMIN options; no client grants or RLS changes.
GRANT screening_worker TO postgres WITH SET TRUE;
commit;
