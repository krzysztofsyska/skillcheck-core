begin;
-- Migration executor creates a separate membership grant. Keep it explicit-only.
GRANT screening_worker TO postgres WITH SET TRUE, INHERIT FALSE;
commit;
