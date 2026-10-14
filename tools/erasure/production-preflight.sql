-- Read-only SC-010 release inventory. This does not activate or migrate anything.
-- No candidate data, secrets, connection strings or function bodies are selected.
select current_database() as database_name, current_setting('server_version') as postgres_version;
with required(name) as (values
 ('candidate_communication_foundation'),('candidate_communication_verification'),
 ('candidate_retention_preview'),('candidate_erasure_lifecycle'),
 ('candidate_erasure_guards'),('candidate_erasure_inventory_v2'),
 ('erasure_execution_protocol'),('erasure_purge_graph'),('erasure_inventory_v3'),
 ('retention_scheduler_protocol'),('retention_scheduler_inventory'))
select r.name, m.version, m.version is not null as recorded
from required r left join supabase_migrations.schema_migrations m on m.name=r.name
order by r.name;
with required(name) as (values
 ('private.candidate_retention_policies'),('private.erasure_execution_config'),
 ('private.erasure_executions'),('private.retention_delegations'),
 ('private.erasure_inventory_baseline_r4'))
select name,to_regclass(name) is not null as present from required;
select rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
from pg_roles where rolname in ('erasure_scheduler','erasure_worker','erasure_ledger_attestor','erasure_restore_attestor','erasure_purge_owner') order by rolname;
-- A recorded migration name is an inventory hint, not proof of matching SQL.
-- Reconcile exact reviewed definitions before apply. Never rerun by timestamp alone.
-- Ledger independence, approved horizons, provider inventory and isolated restore
-- evidence must be verified separately; this query cannot declare production ready.
