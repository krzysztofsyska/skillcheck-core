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
Before every append, `createReservationProver` reads
`get_erasure_reservation_binding` as `erasure_ledger_attestor` and signs that
stored envelope hash with a separate Ed25519 key. The worker cannot call the
binding, and the prover refuses caller text that differs from the product row.
The ledger and restore pin only the public key. A handcrafted first `authorized`
envelope, or a later event transplanted from another reservation, is rejected
before it can become restore authority. The private key is not stored in either
database or in this repository.

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

`erasure_executions.created_at` is the owner authorization time copied from
`erasure_requests.created_at`. `execution_started_at` records worker pickup.
Status and cursor pagination use the authorization time, so a later worker does
not reorder the request. A new `erasing` reservation is refused once
`recovery_retain_until` has passed and the phase is still `authorized`;
cancellation remains available. A reservation that was already exported can
still be acknowledged after that horizon: tombstones keep the original
`retain_until`, their enforcement does not expire, and purge can finish. Expiry
alone never authorizes a new erasure.

Expired recovery envelopes are never filtered in the Node runtime. They undergo
full signature/history verification and reach the isolated SQL ingress just like
current envelopes. For expired irreversible phases,
only that ingress can prove the exact signed scope is already absent from all
reviewed operational and R1/R2 adapters (including holds and typed JSON). Any
remaining scope or unknown adapter blocks those recoveries. A signed authorized
event restores only the non-destructive freeze even after expiry; it cannot open
a new erasing transition after its horizon. Expired cancellation
is handled separately: the signed terminal cancellation remains authoritative and
can reconcile only its own request, including a live candidate. Expiry itself
never authorizes a purge, releases a freeze, changes a phase, or removes retired
IDs. Absent irreversible scopes preserve/install retired IDs with the original
finite retain_until. Their enforcement deliberately does not expire, and no
automatic tombstone garbage collection is implemented; removal requires a
separately reviewed pruning protocol. A recent clean restore can acknowledge old
absent scopes while an old backup containing their erased data remains isolated.

Replaying an identical completed sequence and event hash preserves the original
receipt and deletion counts only after verifying that its full reviewed graph
is still absent. Resurrected data must pass the normal recovery path, and expired
irreversible scope with remaining data fails closed. Exact resolution-command
retries return the committed result before current freeze checks; changed payloads
under the same request key are rejected.

## R4 explicit policy scheduling and read-only health

R3 `authorization: {kind: "owner", actor_id}` envelopes remain byte-compatible.
The additional exact union member is `kind: "retention_policy"` with `actor_id`,
`delegation_id`, `activation_revision`, `policy_revision`, `due_generation`,
`due_at`, and `evidence_hash`. IDs are UUIDs, revisions/generation are positive
safe integers, evidence is a lowercase SHA-256 hex digest, and due time is a
valid UTC timestamp no later than authorization. The policy revision must equal
the included policy snapshot. `actor_id` denotes the actual owner who delegated
execution; a scheduler never manufactures a legacy owner authorization. All
these fields participate in the existing immutable signed/encrypted boundary.
The attestor still proves the stored reservation; caller-created policy JSON
cannot mint consent. Restore preserves that entire signed boundary even when
the restored product backup predates the delegation.

`runRetentionScheduleTick({connect, batchLimit: 25})` performs one bounded call
(1–100 items) to `private.tick_retention_schedule`. Its connection must already
be the dedicated `erasure_scheduler` identity; the adapter checks `current_user`
and never elevates or changes roles. SQL remains responsible for current policy,
delegation, due evidence, activation and execution gates. The return value exposes
only aggregate processed/suggested/authorized/blocked counters. It neither starts
an interval nor claims, proves, commits or purges an erasure. Provisioning a
scheduler, role credentials and cadence is separate deployment work; importing
this module has no scheduling side effects. Do not reuse worker, attestor,
service-role or administrative credentials. An ambiguous tick response must be
reconciled using the durable database suggestion/request records; counters are
not authorization or proof that deletion occurred.

`inspectErasureLedgerHealth` generates its own fresh challenge and obtains a
live independent checkpoint, full encrypted records and a minimum watermark
from separately pinned operator adapters. It verifies signatures, reservation
proofs, continuity and the independent watermark without product writes. It
returns only verification metadata and blocker codes; raw envelopes, candidate
IDs, key material and adapter exceptions are not returned. A checkpoint register
behind the live ledger is reported explicitly. The result always says
`production_ready: false`: this cryptographic check cannot establish deployment
separation, independent backup custody, scheduler provisioning or a completed
restore drill. It neither releases restore isolation nor activates scheduling.
Use the existing `replayVerifiedLedger` only in an explicitly isolated drill or
approved recovery procedure; health never invokes it automatically.

Explicit operator commands (no daemon, interval or automatic startup):

```
node tools/erasure/cli.mjs tick --config /secure/erasure-config.mjs --limit 25
node tools/erasure/cli.mjs health --config /secure/erasure-config.mjs
node tools/erasure/cli.mjs drill --config /secure/isolated-drill-config.mjs --isolated
```

The configuration path points to trusted local operator code, not uploaded or
request-selected content. Its named exports are `schedulerConnect`, `ledgerHealth`
(the pinned health adapter/key options described above), and `restoreConnect`
(for the isolated restore attestor only). Keep this module and secrets outside the
repository and product backup; never put passwords or key values on the command
line. Commands return safe aggregate metadata and generic errors. A drill requires
an explicit flag and the existing SQL isolation checks; it never releases isolation
or reports production readiness. The tick only processes due policy suggestions
and authorizations. **Independent R3 executor provisioning is still required** to
advance authorized requests through durable ledger ACK, erasing, purge and final
ACK. The tick does not perform those destructive operations or claim their success.
