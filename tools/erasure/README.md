# SC-010-R3 independent ledger reference runtime

These modules are server/operator code. They are not a browser dependency, public
HTTP endpoint, deployed worker, or automatic erasure schedule. No infrastructure,
keys, credentials, retention duration or external-resource adapter is provisioned.

`ledger.sql` must be installed in a separately administered PostgreSQL database,
with independent backups, never in the product database. Initialize the singleton
head with a deployment UUID. Provision a dedicated ledger identity with schema
USAGE, SELECT/INSERT on events and SELECT/UPDATE on head. It must not own these
objects and must have no UPDATE/DELETE on events. The service pins the deployment
UUID. Product workers and product `service_role` receive no ledger access.

`PostgresErasureLedger` accepts a connection factory returning a new connected
`pg` Client per operation. It serializes append using the global head row,
compares the request sequence/previous phase/hash, commits encrypted envelope and
signed receipt with synchronous_commit=on, then returns the receipt. A failed or
ambiguous ACK must retry the same reservation/event UUID. An expired product
lease does not authorize an opposite transition. Once `erasing` is committed,
`cancelled` is permanently impossible. Entering `erasing`, or another `erasing` event, can refresh only
the operational manifest; tenant, IDs, policy, owner authorization, retention and
schema boundary remain fixed. Per-request `sequence` differs from global
`ledger_sequence`.

Envelope UTF-8 bytes are exactly the product reservation's `envelope_text`
(PostgreSQL jsonb::text); no cross-language JSON reserialization is used for its
hash. Recovery envelopes contain the complete minimal authorization boundary and
policy, not CV/contact content. AES-256-GCM keys and Ed25519 signing keys are
versioned, pinned and stored outside both databases. Old encryption and verify
keys must remain available through the approved recoverable-backup horizon.
Never silently select a key from product data. Signatures use canonical receipt
metadata; GCM AAD binds the exact envelope hash. Encryption key custody, rotation,
independent backup availability and finite pruning policy are deployment gates.

`createLedgerAttestor` belongs in a separate trusted process possessing only the
product `erasure_ledger_attestor` connection. It validates the signature and all
reservation bindings before calling the private SQL ACK. The worker cannot ACK.
`commitReservedTransition` joins durable append and attestation; neither a client
flag nor an unsigned worker JSON object can replace the verified receipt.

Restore stays isolated with application and workers disabled. Fetch a checkpoint
from the independent live ledger using a newly generated challenge. Supply a
mandatory `minimumWatermark = {ledger_id, sequence, event_hash}` from a separately
trusted durable checkpoint register, outside both restored databases. This is an
operator trust input, never an HTTP caller's value or a value inferred from the
product backup. There is no default zero watermark. The operator must reconcile
the register through the latest authorized ledger event before restore; otherwise
coverage is not established. Fresh signatures alone cannot detect a ledger DB
that was itself rolled back. Tests explicitly cover that rollback with a freshly
signed checkpoint and a retained independent high-water mark.

`verifyReplayCoverage` decrypts and verifies the entire contiguous global and
per-request history up to the fresh signed checkpoint, the independent minimum
sequence/hash and immutable boundaries before any product write.
`replayVerifiedLedger` then replays only the latest verified event per request,
in global order, so retries never regress an already recovered request to an
older phase. It calls the private replay RPC using only a separate
`erasure_restore_attestor` connection. The SQL checkpoint uses the verified stable `head_hash`, not the signed
checkpoint receipt hash (which changes with each fresh challenge). A partial
replay failure leaves isolation
in force. It never clears isolation or enables the application. The restore SQL
replays authorization even when the old backup predates its policy/owner/request;
irreversible phases require the restored graph to be purged again. External
resources, unknown adapters or missing keys fail closed. Product restore release,
backup expiry proof and administrative metadata pruning require a separately
approved operator runbook and end-to-end drill.

Tests:
- `node --test tests/erasure-ledger.test.mjs` (PGlite persistence + crypto/runtime)
- `node --test tests/erasure-ledger-concurrency.test.mjs` (real PostgreSQL,
  `SCREENING_TEST_DATABASE_URL`, creates and drops its own synthetic database)
