/**
 * SC010/012/019, trusted-server-only OFFLINE preparation transaction.
 *
 * The caller supplies a dedicated, idle SQL connection with an authenticated
 * server session. It must not accept a SqlClient, vault, tenant, provider config
 * or verified-agent object from a browser. No API route or live adapter exists.
 * Every authority fact is reconstructed from locked database rows. Returned
 * drafts remain preflightOnly and never authorize a provider call.
 */
import {
  createCipheriv, createDecipheriv, createHash, createHmac, randomBytes,
  randomUUID, timingSafeEqual,
} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {
  decryptContactEnvelope, type ContactEnvelope, type VerificationConfig,
  type VerificationContext,
} from "../contact-verification.ts";
import {
  rehydrateCurrentReleasedVoicePlanWithinTransaction, type SqlClient,
} from "./trusted-source-verifier.ts";
import {voiceScenarioFromApprovedPlan} from "./mvp-package-gate.ts";
import {SC012_INTRODUCTION_VERSION} from "./interview-plan.ts";
import {
  compileRetellOutboundDraft, retellSpokenName, type RetellOutboundConfig,
  type RetellOutboundDraft, type RetellVerifiedAgent,
} from "./retell-outbound-draft.ts";

export type OfflineVoicePreparationRequest = Readonly<{
  communicationId: string; approvalId: string; permissionReceiptId: string;
  planId: string; releaseId: string; pointerVersion: number;
  entitlementId: string; requestKey: string;
}>;
export type OfflineVoicePreparationDependencies = Readonly<{
  retell: RetellOutboundConfig;
  verifiedAgent: RetellVerifiedAgent;
  contactVault: VerificationConfig;
  /** Separate server-side KEK. Never persisted or passed to SQL. */
  idempotencyVault: Readonly<{keyId: string; encryptionKey: Uint8Array}>;
}>;
export type OfflineVoicePreparation = Readonly<{
  operationId: string;
  state: "prepared_offline";
  replayed: boolean;
  preflightOnly: true;
  draft: RetellOutboundDraft;
}>;
type KeyEnvelope = Readonly<{
  algorithm: "A256GCM"; key_id: string; iv: string; ciphertext: string; tag: string;
}>;
type Contact = {
  companyId: string; candidateId: string; applicationId: string; recruitmentId: string;
  communicationId: string; approvalId: string; permissionReceiptId: string;
  contactReceiptId: string; contactPointId: string; contactVersion: number;
  analysisId: string; reviewId: string; shortlistEntryId: string;
  noticeVersion: string; permissionPolicySha256: string; noticeReceivedAt: string;
  contactEnvelope: ContactEnvelope; contactDigest: string;
  contactNoticeVersion: string; contactPolicyVersion: string; contactTemplateVersion: string;
  globalPermissionRevision: number; scopedPermissionRevision: number; preferenceRevision: number;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hex = /^[0-9a-f]{64}$/;
const keyId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const requestFields = ["communicationId","approvalId","permissionReceiptId","planId",
  "releaseId","pointerVersion","entitlementId","requestKey"] as const;
type Failure = "REJECTED" | "CONFLICT" | "UNAVAILABLE" | "QUOTA_EXHAUSTED";
export class OfflineVoicePreparationError extends Error {
  readonly code: string;
  constructor(reason: Failure) {
    super("VOICE_PREPARATION_" + reason);
    this.code = "VOICE_PREPARATION_" + reason;
  }
}
const fail = (reason: Failure = "REJECTED"): never => {
  throw new OfflineVoicePreparationError(reason);
};
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return (proto === Object.prototype || proto === null) &&
    Reflect.ownKeys(value).length === keys.length &&
    Reflect.ownKeys(value).every(k => typeof k === "string" && keys.includes(k));
}
function requestSnapshot(raw: OfflineVoicePreparationRequest): OfflineVoicePreparationRequest {
  let value: OfflineVoicePreparationRequest;
  try { value = structuredClone(raw); } catch { return fail(); }
  if (!exact(value, requestFields)) return fail();
  for (const field of requestFields) {
    if (field === "pointerVersion") {
      if (!Number.isSafeInteger(value[field]) || value[field] < 1) return fail();
    } else if (typeof value[field] !== "string" || !uuid.test(value[field])) return fail();
  }
  return Object.freeze(value);
}
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function keyAad(operationId: string, companyId: string, approvalId: string, bindingHash: string): Buffer {
  // Explicitly an offline compiler identity, not a live dispatch capability.
  return Buffer.from(JSON.stringify([
    "SC010C_OFFLINE_PROVIDER_UUID_V1", operationId, companyId, approvalId, bindingHash,
  ]));
}
function decode(value: unknown, size: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return fail();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== size || bytes.toString("base64url") !== value) return fail();
  return bytes;
}
function sealProviderKey(
  key: string, aad: Buffer, vault: OfflineVoicePreparationDependencies["idempotencyVault"],
): KeyEnvelope {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", vault.encryptionKey, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
  return Object.freeze({algorithm: "A256GCM", key_id: vault.keyId,
    iv: iv.toString("base64url"), ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url")});
}
function openProviderKey(
  envelope: unknown, expectedDigest: unknown, aad: Buffer,
  vault: OfflineVoicePreparationDependencies["idempotencyVault"],
): string {
  if (!exact(envelope, ["algorithm","key_id","iv","ciphertext","tag"]) ||
    envelope.algorithm !== "A256GCM" || envelope.key_id !== vault.keyId ||
    typeof expectedDigest !== "string" || !hex.test(expectedDigest)) return fail();
  const decipher = createDecipheriv("aes-256-gcm", vault.encryptionKey, decode(envelope.iv, 12));
  decipher.setAAD(aad); decipher.setAuthTag(decode(envelope.tag, 16));
  const value = Buffer.concat([decipher.update(decode(envelope.ciphertext, 36)), decipher.final()]).toString("utf8");
  if (!uuid4.test(value) || !timingSafeEqual(Buffer.from(digest(value), "hex"), Buffer.from(expectedDigest, "hex"))) return fail();
  return value;
}
function snapshotDependencies(raw: OfflineVoicePreparationDependencies): OfflineVoicePreparationDependencies {
  try {
    if (typeof window !== "undefined") return fail();
    const retell = structuredClone(raw.retell), contactVault = structuredClone(raw.contactVault);
    const idempotencyVault = structuredClone(raw.idempotencyVault);
    if (!exact(idempotencyVault, ["keyId","encryptionKey"]) ||
      typeof idempotencyVault.keyId !== "string" || !keyId.test(idempotencyVault.keyId) ||
      !(idempotencyVault.encryptionKey instanceof Uint8Array) || idempotencyVault.encryptionKey.length !== 32 ||
      !(contactVault.encryptionKey instanceof Uint8Array) || contactVault.encryptionKey.length !== 32 ||
      !(contactVault.fingerprintKey instanceof Uint8Array) || contactVault.fingerprintKey.length !== 32 ||
      timingSafeEqual(idempotencyVault.encryptionKey, contactVault.encryptionKey) ||
      timingSafeEqual(idempotencyVault.encryptionKey, contactVault.fingerprintKey)) return fail();
    // Agent proof is intentionally NOT cloned: its exact identity is authenticated
    // by the existing compiler. All mutable configuration and keys are detached.
    return {retell, contactVault, idempotencyVault, verifiedAgent: raw.verifiedAgent};
  } catch { return fail(); }
}
function safeError(error: unknown): OfflineVoicePreparationError {
  if (error instanceof OfflineVoicePreparationError) return error;
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "PT402") return new OfflineVoicePreparationError("QUOTA_EXHAUSTED");
  if (["PT409","55P03","40001","40P01","23505","CONFLICT","STALE"].includes(code)) {
    return new OfflineVoicePreparationError("CONFLICT");
  }
  if (["42501","PT401","PT404","FORBIDDEN","UNAVAILABLE"].includes(code)) {
    return new OfflineVoicePreparationError("UNAVAILABLE");
  }
  return new OfflineVoicePreparationError("REJECTED");
}
async function transaction<T>(db: SqlClient, run: () => Promise<T>): Promise<T> {
  // Dedicated idle connection is a server-side dependency. No transaction-level
  // retry here: the caller retries the entire operation with its original key.
  // Never commit a caller's pre-existing transaction. A SAVEPOINT probe gives
  // an unambiguous PostgreSQL result without guessing from timestamps or XIDs.
  let callerTransaction = false;
  try { await db.query("savepoint sc010c_idle_probe"); callerTransaction = true; }
  catch (e) {
    if (!e || typeof e !== "object" || !("code" in e) || e.code !== "25P01") throw safeError(e);
  }
  if (callerTransaction) {
    try { await db.query("release savepoint sc010c_idle_probe"); } catch (e) { throw safeError(e); }
    return fail();
  }
  try { await db.query("begin isolation level read committed"); } catch (e) { throw safeError(e); }
  try {
    await db.query("set local statement_timeout='8s'");
    await db.query("set local lock_timeout='1s'");
    await db.query("set local idle_in_transaction_session_timeout='10s'");
    const result = await run();
    await db.query("commit");
    return result;
  } catch (e) {
    // A lost COMMIT acknowledgement may leave a committed operation. Returning an
    // error never asserts that it was rolled back; the same request recovers it.
    try { await db.query("rollback"); } catch { /* no raw database error escapes */ }
    throw safeError(e);
  }
}

export async function prepareOfflineVoiceDraft(
  db: SqlClient, context: Readonly<{companyId: string}>,
  raw: OfflineVoicePreparationRequest, rawDependencies: OfflineVoicePreparationDependencies,
): Promise<OfflineVoicePreparation> {
  const request = requestSnapshot(raw), dependencies = snapshotDependencies(rawDependencies);
  const companyId = context?.companyId;
  if (!exact(context, ["companyId"]) || typeof companyId !== "string" || !uuid.test(companyId)) return fail();
  return transaction(db, async () => {
    const result = await db.query("select private.sc010c_lock_voice_contact($1,$2,$3,$4) as contact",
      [companyId, request.communicationId, request.approvalId, request.permissionReceiptId]);
    if (result.rows.length !== 1) return fail("UNAVAILABLE");
    const contact = result.rows[0].contact as Contact;
    if (!contact || contact.companyId !== companyId || contact.communicationId !== request.communicationId ||
      contact.approvalId !== request.approvalId || contact.permissionReceiptId !== request.permissionReceiptId) return fail();
    const current = await rehydrateCurrentReleasedVoicePlanWithinTransaction(db, {
      companyId, applicationId: contact.applicationId,
      expectedPlanId: request.planId, expectedReleaseId: request.releaseId,
      expectedPointerVersion: request.pointerVersion,
    });
    const source = current.snapshot.sourceBinding;
    if (source.analysisId !== contact.analysisId || source.reviewId !== contact.reviewId ||
      source.shortlistEntryId !== contact.shortlistEntryId || source.recruitmentId !== contact.recruitmentId ||
      contact.noticeVersion !== dependencies.retell.noticeVersion ||
      SC012_INTRODUCTION_VERSION !== contact.noticeVersion) return fail("CONFLICT");
    const entitlements = (await db.query([
      "select e.*,private.sc19_voice_entitlement_eligible(e) as eligible",
      "from private.sc19_voice_entitlements e",
      "where e.company_id=$1 and e.id=$2 for update nowait",
    ].join(" "), [companyId, request.entitlementId])).rows;
    if (entitlements.length !== 1 || entitlements[0].eligible !== true) return fail("UNAVAILABLE");
    const entitlement = entitlements[0];
    const actor = (await db.query("select auth.uid() as id")).rows[0]?.id;
    if (typeof actor !== "string" || !uuid.test(actor)) return fail("UNAVAILABLE");
    const locked = (await db.query(
      "select pg_try_advisory_xact_lock(hashtextextended($1,0)) as locked",
      ["SC010C_OFFLINE_REQUEST:" + companyId + ":" + actor + ":" + request.requestKey],
    )).rows[0]?.locked;
    if (locked !== true) return fail("CONFLICT");

    // Spoken employer name only; tenant-scoped by RLS and the company id filter.
    // Its digest is bound below so a rename cannot change a replayed draft.
    const companies = (await db.query("select name from public.companies where id=$1", [companyId])).rows;
    if (companies.length !== 1) return fail("UNAVAILABLE");
    const companyName = retellSpokenName(companies[0].name);
    if (!companyName) return fail();
    const binding = {
      version: 1, purpose: "voice_interview", recordingAllowed: false,
      companyId, candidateId: contact.candidateId, recruitmentId: contact.recruitmentId,
      applicationId: contact.applicationId, communicationId: request.communicationId,
      approvalId: request.approvalId, permissionReceiptId: request.permissionReceiptId,
      contactReceiptId: contact.contactReceiptId, contactPointId: contact.contactPointId,
      contactVersion: contact.contactVersion, planId: current.planId, releaseId: current.releaseId,
      pointerVersion: current.pointerVersion, sourceHash: current.sourceHash,
      planSourceFingerprint: current.snapshot.planSourceFingerprint,
      planContractHash: current.snapshot.planContractHash,
      noticeVersion: contact.noticeVersion, permissionPolicySha256: contact.permissionPolicySha256,
      entitlementId: request.entitlementId, entitlementGrant: entitlement.grant_reference,
      package: entitlement.package, total: entitlement.total,
      companyNameSha256: digest(companyName),
      // Only a hash of reviewed server configuration; no contact destination,
      // key material, CV, transcript, HTTP body or provider response is persisted.
      providerConfigHash: digest(JSON.stringify({
        agentId: dependencies.retell.agentId, agentVersionTag: dependencies.retell.agentVersionTag,
        agentVersion: dependencies.retell.agentVersion,
        approvedAssistantVersion: dependencies.retell.approvedAssistantVersion,
        noticeVersion: dependencies.retell.noticeVersion, fromNumberE164: dependencies.retell.fromNumberE164,
        maxBudgetSeconds: dependencies.retell.maxBudgetSeconds,
        approvedFlowSha256: dependencies.retell.approvedFlowSha256,
        approvedAgentSha256: dependencies.retell.approvedAgentSha256,
      })),
    };
    const bindingJson = JSON.stringify(binding), bindingHash = digest(bindingJson);
    const keyed = (await db.query([
      "select operation_id,binding_hash from private.sc010c_voice_preparation_requests",
      "where company_id=$1 and actor_id=$2 and request_key=$3 for update nowait",
    ].join(" "), [companyId, actor, request.requestKey])).rows;
    if (keyed.length > 1 || (keyed.length === 1 && keyed[0].binding_hash !== bindingHash)) return fail("CONFLICT");
    const previous = (await db.query([
      "select * from private.sc010c_voice_preparations",
      "where company_id=$1 and approval_id=$2 for update nowait",
    ].join(" "), [companyId, request.approvalId])).rows;
    if (previous.length > 1) return fail("CONFLICT");
    const prior = previous[0];
    if (prior && (prior.binding_hash !== bindingHash || !isDeepStrictEqual(prior.binding_json, binding) ||
      prior.state !== "prepared_offline")) return fail("CONFLICT");
    if (keyed.length === 1 && (!prior || keyed[0].operation_id !== prior.id)) return fail("CONFLICT");
    if (!prior && Number(entitlement.used) + Number(entitlement.reserved) >= Number(entitlement.total)) return fail("QUOTA_EXHAUSTED");
    const operationId = prior ? String(prior.id) :
      String((await db.query("select gen_random_uuid() as id")).rows[0]?.id);
    if (!uuid4.test(operationId)) return fail();
    const aad = keyAad(operationId, companyId, request.approvalId, bindingHash);
    const providerKey = prior ?
      openProviderKey(prior.provider_key_envelope, prior.provider_key_digest, aad, dependencies.idempotencyVault) :
      randomUUID();
    const envelope = prior?.provider_key_envelope ??
      sealProviderKey(providerKey, aad, dependencies.idempotencyVault);

    const contactContext: VerificationContext = {
      company_id: companyId, candidate_id: contact.candidateId, recruitment_id: contact.recruitmentId,
      channel: "voice", purpose: "verification_invitation",
      notice_version: contact.contactNoticeVersion, policy_version: contact.contactPolicyVersion,
      template_version: contact.contactTemplateVersion,
      global_permission_revision: contact.globalPermissionRevision,
      scoped_permission_revision: contact.scopedPermissionRevision, preference_revision: contact.preferenceRevision,
      expected_contact_version: contact.contactVersion - 1, destination: "",
    };
    const destination = decryptContactEnvelope(contact.contactEnvelope, contactContext, dependencies.contactVault);
    const contactDigest = createHmac("sha256", dependencies.contactVault.fingerprintKey)
      .update(JSON.stringify(["SC010B2_CONTACT_DIGEST_V1", companyId, contact.candidateId, "voice", destination])).digest("hex");
    if (contactDigest !== contact.contactDigest) return fail();
    const scenario = voiceScenarioFromApprovedPlan(current.releasedPlan);
    const draft = compileRetellOutboundDraft({
      externalCorrelationId: contact.applicationId, destinationE164: destination,
      publishedAssistantVersion: dependencies.retell.approvedAssistantVersion,
      scenario, recordingAllowed: false,
      callTimeoutSeconds: Math.min(current.releasedPlan.durationMaxSeconds, dependencies.retell.maxBudgetSeconds),
      providerIdempotencyKey: providerKey,
    }, dependencies.retell, current.releasedPlan, dependencies.verifiedAgent, {
      companyId, applicationId: contact.applicationId,
      sourceFingerprint: current.snapshot.planSourceFingerprint, destinationE164: destination,
      contactApproved: true, noticeDelivered: true,
    }, {companyId, companyName});
    // Reject stale facts before writing. The deferred database constraint also
    // checks all clocks inside COMMIT, including plan/review/release retention.
    await db.query("select private.sc010c_lock_voice_contact($1,$2,$3,$4)",
      [companyId, request.communicationId, request.approvalId, request.permissionReceiptId]);
    const eligible = (await db.query(
      "select private.sc19_voice_entitlement_eligible(e) as eligible from private.sc19_voice_entitlements e where company_id=$1 and id=$2",
      [companyId, request.entitlementId])).rows[0]?.eligible;
    if (eligible !== true) return fail("UNAVAILABLE");
    if (!prior) {
      await db.query("update private.sc19_voice_entitlements set reserved=reserved+1 where company_id=$1 and id=$2",
        [companyId, request.entitlementId]);
      await db.query([
        "insert into private.sc010c_voice_preparations",
        "(id,company_id,recruitment_id,candidate_id,application_id,communication_id,approval_id,",
        "permission_receipt_id,contact_receipt_id,contact_point_id,contact_version,plan_id,release_id,",
        "pointer_version,entitlement_id,binding_json,binding_hash,provider_key_envelope,provider_key_digest,created_by)",
        "values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18::jsonb,$19,$20)",
      ].join(" "), [operationId, companyId, contact.recruitmentId, contact.candidateId,
        contact.applicationId, request.communicationId, request.approvalId, request.permissionReceiptId,
        contact.contactReceiptId, contact.contactPointId, contact.contactVersion, current.planId, current.releaseId,
        current.pointerVersion, request.entitlementId, bindingJson, bindingHash, JSON.stringify(envelope),
        digest(providerKey), actor]);
    } else {
      // Queue the same deferred-at-COMMIT check on every retry, including an
      // already known request key. No persisted field or quota counter changes.
      await db.query("update private.sc010c_voice_preparations set state=state where company_id=$1 and id=$2",
        [companyId, operationId]);
    }
    if (keyed.length === 0) await db.query([
      "insert into private.sc010c_voice_preparation_requests",
      "(company_id,actor_id,request_key,operation_id,binding_hash) values($1,$2,$3,$4,$5)",
    ].join(" "), [companyId, actor, request.requestKey, operationId, bindingHash]);
    return Object.freeze({operationId, state: "prepared_offline", replayed: !!prior, preflightOnly: true, draft});
  });
}

/** Only this offline state can be cancelled/refunded. There is no transition to
 * dispatching or UNKNOWN: future provider work requires a separate protocol.
 * Revoked consent or expired entitlement does not prevent safely dropping an
 * unsent offline draft. Candidate erasure/freeze and actor authorization remain.
 */
export async function cancelOfflineVoicePreparation(
  db: SqlClient, context: Readonly<{companyId: string}>, operationId: string,
): Promise<Readonly<{operationId: string; state: "cancelled_offline"}>> {
  if (typeof window !== "undefined" || !exact(context, ["companyId"]) ||
    typeof context.companyId !== "string" || !uuid.test(context.companyId) ||
    typeof operationId !== "string" || !uuid4.test(operationId)) return fail();
  const companyId = context.companyId;
  return transaction(db, async () => {
    const identity = (await db.query(
      "select candidate_id,entitlement_id from private.sc010c_voice_preparations where company_id=$1 and id=$2",
      [companyId, operationId])).rows;
    if (identity.length !== 1) return fail("UNAVAILABLE");
    const tenant = (await db.query("select private.contact_lock_candidate($1) as company",
      [identity[0].candidate_id])).rows[0]?.company;
    if (tenant !== companyId) return fail("UNAVAILABLE");
    const restore = (await db.query(
      "select restore_isolated from private.erasure_execution_config where singleton for share nowait")).rows;
    if (restore.length !== 1 || restore[0].restore_isolated !== false) return fail("UNAVAILABLE");
    const entitlement = (await db.query(
      "select reserved from private.sc19_voice_entitlements where company_id=$1 and id=$2 for update nowait",
      [companyId, identity[0].entitlement_id])).rows[0];
    const operation = (await db.query(
      "select state from private.sc010c_voice_preparations where company_id=$1 and id=$2 for update nowait",
      [companyId, operationId])).rows[0];
    if (!entitlement || !operation) return fail("UNAVAILABLE");
    if (operation.state === "cancelled_offline") return Object.freeze({operationId, state: "cancelled_offline"});
    if (operation.state !== "prepared_offline" || Number(entitlement.reserved) < 1) return fail("CONFLICT");
    await db.query("update private.sc010c_voice_preparations set state='cancelled_offline' where company_id=$1 and id=$2",
      [companyId, operationId]);
    await db.query("update private.sc19_voice_entitlements set reserved=reserved-1 where company_id=$1 and id=$2",
      [companyId, identity[0].entitlement_id]);
    return Object.freeze({operationId, state: "cancelled_offline"});
  });
}
