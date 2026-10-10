-- Install explicitly in an INDEPENDENT PostgreSQL database, never the product DB.
-- Connection role/key provisioning and independent backup policy are operator tasks.
create schema erasure_ledger;
revoke all on schema erasure_ledger from public;
create table erasure_ledger.head (
 singleton boolean primary key default true check(singleton),
 ledger_id uuid not null,
 sequence bigint not null default 0 check(sequence>=0),
 event_hash text
);
create table erasure_ledger.events (
 sequence bigint primary key,
 event_id uuid not null unique,
 request_id uuid not null,
 request_sequence bigint not null,
 envelope_hash text not null,
 encrypted_envelope jsonb not null,
 receipt jsonb not null,
 unique(request_id,request_sequence)
);
revoke all on all tables in schema erasure_ledger from public;
-- Initialize head with a separately generated deployment UUID. Only a dedicated
-- ledger service identity receives SELECT/INSERT on events and SELECT/UPDATE on
-- head. Product worker, product service_role and restore role receive NO access.
-- No UPDATE/DELETE privilege on events. Retention requires a separate controlled
-- archive/pruning runbook covering the oldest recoverable product backup.
