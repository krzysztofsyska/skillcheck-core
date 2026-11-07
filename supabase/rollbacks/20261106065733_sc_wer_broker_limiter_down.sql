-- Disable the Preview broker before this runtime-only rollback.
begin;
drop function private.consume_competency_rate_limit(text,bigint);
drop table competency_runtime.rate_window;
drop schema competency_runtime;
commit;
