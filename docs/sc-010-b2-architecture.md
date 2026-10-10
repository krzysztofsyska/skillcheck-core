# SC-010 B2 — trusted verification and offline human approval

TASK: SC-010 B2; LEVEL: L3; SCOPE: BACKEND.
DEPENDS ON: accepted B1 (PR #69), SC-006 and SC-008.
OWNER: Codex orchestrator; REVIEWER: independent Codex reviewer.
STATUS: implementation contract; not production approval.

## Bounded outcome

B2 adds authoritative verification evidence, encrypted verified contact snapshots,
and immutable human approval of a particular draft. B1 communication states remain
`draft` and `cancelled`; B1 permission states remain `unverified`, `revoked`, `blocked`.
An approval is a separate record, not a scheduled message. Its current validity is
computed from the live sources and can become false without rewriting history.
No worker, attempt, delivery, provider, public candidate link, contact message,
recording, scheduling or billing API exists in B2. No environment flag can turn an
approval into a send. This explicitly narrows the broader future B2 described in
the original SC-010 architecture; execution authorization belongs to a later task.

## Trust boundary

Owner/recruiter can record a claim or denial and approve an eligible draft. They
cannot create verification evidence or provide their own issuer key, policy,
notice, template, actor identity or verification assertion through an ordinary RPC.
A dedicated `contact_verifier` NOLOGIN database role has only the narrow private
receipt-ingestion capability. No role membership or runtime credential is granted
by this migration. `anon`, `authenticated`, `screening_worker` and PUBLIC receive
neither that capability nor private-table access.

A separate trusted server verifies an Ed25519 signature against an explicitly
configured issuer public key and exact signed bytes, validates the allowlisted
versioned receipt schema, requires the signed destination to be exactly canonical,
and encrypts it with AES-256-GCM before calling the private ingestion RPC through
a connection explicitly bound to the verifier role. The connection is injected;
B2 provides no public HTTP entry point, privileged pool discovery or credential.
Ordinary recruiter sessions are never upgraded. The issuer's private signing key
is outside the application/recruiter boundary; tests use synthetic ephemeral keys.

The database trusts this restricted verifier for the cryptographic assertion, and
independently checks issuer registration, tenant/candidate/recruitment ownership,
policy/notice/template registration, timestamps, replay keys, expected revisions,
and denials. Database validation does not pretend to verify an arbitrary UUID as
proof. Issuer and policy registries start empty and have no recruiter write API.
Production enablement needs reviewed issuer onboarding and actual candidate
verification; deployment alone cannot produce trusted evidence.

## Receipt and encryption contract

The versioned signed receipt binds all of:

- issuer/key identifier, unpredictable nonce, issued_at and expires_at;
- company, candidate, recruitment, channel and `verification_invitation` purpose;
- notice, policy and template version identifiers;
- exact canonical destination, expected prior contact generation;
- expected global permission revision, scoped permission revision and preference
  revision (zero explicitly denotes a missing row).

Only recruitment-scoped proof is accepted in B2. Email, SMS and voice are separate
channels; a verified telephone number does not grant both SMS and voice. Proof of
contact control is separate from permission for the stated purpose and notice:
the receipt must assert both facts through its schema, never infer consent from
an email address, CV upload, shortlist or contact verification alone.

The signed destination is processed privately, never returned by public RPCs.
After signature verification the server computes a tenant/candidate/channel-bound
HMAC with a server-only secret; it does not persist an unkeyed hash of a guessable
address/number. Encryption uses a fresh 96-bit nonce,
a 128-bit authentication tag, a versioned key and context-bound additional data
(company/candidate/channel/contact version). Encryption/HMAC keys are independent
and live outside DB; no key, destination, signature, raw receipt or token is logged.
The retained receipt JSON contains strictly allowlisted metadata and that HMAC,
with the raw destination removed. Equality of this metadata identifies replay;
no separate payload hash is retained. Raw destinations and signatures exist only
during server verification.

Validate strict field types, enum values, bounded strings/body sizes, canonical UUIDs,
finite safe integer revisions and strict UTC timestamps. Reject future-issued,
expired, overlong-lived, wrong-purpose, wrong-context or unregistered evidence.
The same receipt ID and identical verified metadata returns its original ID;
different metadata conflicts. The composite `(company, issuer, key, nonce)` is also
unique, so a new receipt ID cannot reuse that registered nonce. Replay cannot renew evidence or extend its expiry.
A retry returning an existing ID does not assert that evidence remains current.

## Data and API responsibilities

| Object | Contract |
|---|---|
| Private trusted issuer registry | Issuer/key IDs, tenant binding, validity and enabled status; public key material exists only in trusted server configuration |
| Private policy/template registry | Immutable allowed purpose/channel/notice/template versions and active status; trusted provisioning only |
| Private verification receipts | Immutable provenance, bound context, expected revisions, expiry and allowlisted replay metadata |
| Private contact points | Immutable encrypted destination versions, HMAC/key versions and verified receipt relationship |
| Public approval metadata | Immutable tenant, draft/version, receipt ID, approver/time and bound version identifiers; no destination or raw proof |

All links use composite tenant/candidate/recruitment keys as applicable; knowing a
UUID never permits cross-tenant linkage. Public approval metadata has SELECT-only
tenant RLS. Private data has RLS and explicit revoked grants. History is immutable;
no update/delete access is granted to the verifier or recruiter.

Logical API contracts (implementation may use equivalent explicit SQL arguments):

1. Private ingestion accepts only the validated receipt metadata and encrypted
   contact envelope. Under candidate lock it independently checks the registered
   issuer/policy, ownership, both permission revisions, preference revision and
   previous contact generation. It creates exactly one receipt/contact generation.
2. `approve_candidate_communication` accepts a visible draft ID, expected draft
   version, trusted receipt ID and request key. It derives all context and actor
   from the DB/session, validates current proof and shortlist under source locks,
   and appends one immutable approval snapshot. It never returns a destination.
3. A tenant-checked approval-status reader returns only metadata, `current` and a
   safe reason. It checks communication state/version, latest applicable contact,
   both permission revisions, preference revision, issuer/policy activity, evidence
   expiry and current SC-008 shortlist. No caller can assert `current=true`.

An approved draft remains a B1 draft and is covered by the existing one-draft
constraint. B1 cancel/deny/preferences increment or cancel that draft, making its
approval ineffective in the same transaction. Contact replacement changes the
current generation, making previous approvals ineffective. Reapproval requires
current proof and a fresh immutable snapshot; it cannot mutate an old approval.

## Denial precedence, freshness and locks

Any matching global or recruitment `revoked`/`blocked` denies approval AND receipt
ingestion. A trusted signature cannot silently clear a denial. Re-consent and
unblocking are intentionally outside B2. Missing/unverified B1 state may coexist
with separately verified evidence; it is never relabeled as a granted operator
claim. A channel blocked by preferences also denies approval.

Authorization precedes locks. Ingestion and human mutation serialize candidate
writes with `FOR UPDATE NOWAIT`, producing controlled PT409 on contention. Human
approval additionally locks the current membership/owner, communication and
SC-008 material sources using the existing NOWAIT lock discipline. Check the
exact current human shortlist, application active status and open recruitment;
manual shortlists with NULL score remain eligible if their evidence is current.
Later CV, analysis, review, position or shortlist changes make read-time freshness
false. An immutable stored approval is never an enduring authorization to dispatch.
A later sending module must repeat these checks atomically at its own execution
boundary; B2 read-time eligibility cannot be used as that future capability.

Revocation vs ingestion: whichever holds candidate lock completes first; a loser
receives PT409 and must re-read. A receipt signed before a revision change cannot
be installed afterward by changing its expected revision. Revocation vs approval:
approval first is rendered ineffective by revocation in the latter transaction;
revocation first prevents approval. Replay never restores a cancelled draft.

## Required acceptance evidence

- Signature tampering, wrong issuer/key/context/contact digest, expired/future
  receipt, duplicate/different nonce payload and malformed input fail closed.
- Encryption decrypts only with correct key/context and has randomized envelopes;
  plaintext/key/signature are absent from returned metadata and errors.
- Authenticated owner/recruiter, viewer, outsider, anonymous and screening worker
  cannot ingest evidence or mutate registries/private data. Owner/recruiter may
  approve only their eligible draft; viewer remains read-only.
- Actual SQL proves tenant/composite FK isolation, deny precedence in both scopes,
  stale expected revisions, blocked channel, evidence expiry, contact replacement,
  duplicate approval idempotency and changed-payload conflicts.
- Actual SC-006 human review → SC-008 human shortlist → B1 draft → trusted synthetic
  receipt → B2 approval → safe freshness read succeeds; changed review/CV/shortlist,
  cancellation, preferences, issuer or policy makes the old approval ineffective.
- Real independent PostgreSQL sessions exercise ingestion/revoke,
  approval/revoke, contact replacement/approval and SC-008 source changes.
- Typecheck, build, B1 and SC-006/008/009 regression gates remain green.

## Production blockers and handoff

B2 is testable offline without issuer credentials or network contact. Production
still requires approved identity/consent verification source, policy and notice
contents, key provisioning/rotation, retention and an authorized redact/purge flow.
B1 restrictive parent FKs remain an explicit deletion/UI blocker before production.
This change does not claim a legal basis or complete the contact product. Real
candidate contact and production migration require separately reviewed scope and
explicit production approval under AGENTS.md. No existing migration is reapplied.
