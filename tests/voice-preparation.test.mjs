import test from "node:test";
import assert from "node:assert/strict";
import {createHash, randomBytes, randomUUID} from "node:crypto";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {
  prepareOfflineVoiceDraft, cancelOfflineVoicePreparation, OfflineVoicePreparationError,
} from "../lib/voice/offline-preparation.ts";
import {boot} from "./helpers/voice-preparation-fixture.mjs";
import {syntheticRetellProof} from "./helpers/voice-preparation-provider-fixture.mjs";
import {users} from "./helpers/screening-ranking-fixture.mjs";

const uuid4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = value => createHash("sha256").update(value).digest("hex");
const denied = expected => error => {
  assert.ok(error instanceof OfflineVoicePreparationError);
  if (expected) assert.equal(error.code, "VOICE_PREPARATION_" + expected);
  assert.doesNotMatch(error.message, /PRIVATE|synthetic-only|\+48|SELECT|password|ciphertext|secret/i);
  return true;
};
function pauseAfter(client, predicate) {
  let reached, release, used = false;
  const entered = new Promise(resolve => {reached = resolve;});
  const resume = new Promise(resolve => {release = resolve;});
  return {
    entered, release,
    client: {query: async (sql, params) => {
      const result = await client.query(sql, params);
      if (!used && predicate(sql)) {used = true; reached(); await resume;}
      return result;
    }},
  };
}
async function childRestart(input) {
  const child = spawn(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    fileURLToPath(new URL("./helpers/voice-preparation-restart.mjs", import.meta.url)),
  ], {stdio: ["pipe","pipe","pipe"]});
  let out = "", err = "";
  child.stdout.on("data", data => {out += data;});
  child.stderr.on("data", data => {err += data;});
  child.stdin.end(JSON.stringify(input));
  const code = await new Promise((resolve, reject) => {child.on("error", reject); child.on("close", resolve);});
  assert.equal(code, 0, "fresh-process preparation must succeed: " + err);
  return JSON.parse(out);
}

test("SC010/012/019: one persistent offline draft from current database authority", async t => {
  const env = await boot(t), {db} = env;
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {networkCalls++; throw new Error("External network forbidden");};
  t.after(() => {globalThis.fetch = originalFetch;});
  const deps = async (subject, change = {}) => {
    const proof = await syntheticRetellProof(change);
    assert.equal(proof.calls.length, 2);
    assert.ok(proof.calls.every(call => call.method === "GET"));
    return subject.deps(proof.retell, proof.verifiedAgent);
  };
  const run = async (subject, change = {}, client = db, dependencies) => {
    await env.actor(client, subject.f.owner);
    return prepareOfflineVoiceDraft(client, subject.context, {...subject.request, ...change},
      dependencies ?? await deps(subject));
  };
  const stats = async subject => {
    await env.asServer(subject.f.owner);
    const counter = (await db.query(
      "select used,reserved,revision from private.sc19_voice_entitlements where id=$1",
      [subject.request.entitlementId])).rows[0];
    const rows = (await db.query(
      "select * from private.sc010c_voice_preparations where company_id=$1 order by created_at,id",
      [subject.f.companyId])).rows;
    const keys = (await db.query(
      "select * from private.sc010c_voice_preparation_requests where company_id=$1",
      [subject.f.companyId])).rows;
    return {counter, rows, keys};
  };

  await t.test("FREE reserves once, decrypts only the approved contact, and returns the minimal offline payload", async () => {
    const s = await env.ready(), result = await run(s), stored = await stats(s);
    assert.match(result.operationId, uuid4);
    assert.equal(result.state, "prepared_offline");
    assert.equal(result.replayed, false);
    assert.equal(result.preflightOnly, true);
    assert.equal(result.draft.preflightOnly, true);
    assert.equal(result.draft.payload.to_number, s.f.contactContext.destination);
    assert.match(result.draft.payload.idempotency_key, uuid4);
    assert.equal(result.draft.payload.honor_internal_dnc, true);
    assert.equal(result.draft.payload.override_agent_version, 2);
    assert.equal(result.draft.requestedMaxSeconds, 480);
    assert.deepEqual(Object.keys(result.draft.payload).sort(), [
      "from_number","to_number","idempotency_key","honor_internal_dnc","override_agent_id",
      "override_agent_version","retell_llm_dynamic_variables",
    ].sort());
    const vars = result.draft.payload.retell_llm_dynamic_variables;
    assert.deepEqual(Object.keys(vars).sort(),
      ["skillcheck_interview_script","skillcheck_notice_version","skillcheck_language"].sort());
    assert.equal(vars.skillcheck_notice_version, "notice-pl-202610");
    assert.equal(vars.skillcheck_language, "pl-PL");
    for (const forbidden of [s.f.companyId,s.f.application.id,s.f.candidate.id,"PRIVATE original CV"]) {
      assert.ok(!JSON.stringify(result.draft.payload).includes(forbidden));
    }
    assert.equal(stored.counter.reserved, 1); assert.equal(stored.counter.used, 0);
    assert.equal(stored.rows.length, 1); assert.equal(stored.keys.length, 1);
    const row = stored.rows[0], persisted = JSON.stringify(row);
    assert.equal(row.provider_key_digest, hash(result.draft.payload.idempotency_key));
    assert.equal(row.provider_key_envelope.algorithm, "A256GCM");
    for (const forbidden of [result.draft.payload.idempotency_key,s.f.contactContext.destination,"PRIVATE original CV",
      Buffer.from(s.idempotencyVault.encryptionKey).toString("base64")]) assert.ok(!persisted.includes(forbidden));
    assert.equal(row.binding_json.purpose, "voice_interview");
    assert.equal(row.binding_json.recordingAllowed, false);
    assert.equal(row.permission_receipt_id, s.request.permissionReceiptId);
    assert.equal(row.contact_point_id, s.f.contactPoint.id);
    assert.equal(networkCalls, 0);
  });

  await t.test("same key and different key recover one logical approval without another reservation", async () => {
    const s = await env.ready(), first = await run(s);
    const again = await run(s), otherKey = await run(s, {requestKey: randomUUID()});
    for (const result of [again, otherKey]) {
      assert.equal(result.operationId, first.operationId);
      assert.equal(result.draft.payload.idempotency_key, first.draft.payload.idempotency_key);
      assert.equal(result.replayed, true);
    }
    const stored = await stats(s);
    assert.equal(stored.rows.length, 1); assert.equal(stored.keys.length, 2);
    assert.equal(stored.counter.reserved, 1);
    assert.equal(Number(stored.counter.revision), 2);
    const proof = await syntheticRetellProof();
    const reordered = Object.fromEntries(Object.entries(proof.retell).reverse());
    const stable = await run(s, {}, db, s.deps(reordered, proof.verifiedAgent));
    assert.equal(stable.operationId, first.operationId, "config insertion order is not a new identity");
  });

  await t.test("a real fresh Node process recovers the encrypted UUID from PostgreSQL", async () => {
    const s = await env.ready(), first = await run(s);
    const fresh = await childRestart({
      connectionConfig: env.connectionConfig, actorId: s.f.owner,
      context: s.context, request: s.request,
      contactVault: {...s.contactVault,
        encryptionKey: Buffer.from(s.contactVault.encryptionKey).toString("base64"),
        fingerprintKey: Buffer.from(s.contactVault.fingerprintKey).toString("base64")},
      idempotencyVault: {...s.idempotencyVault,
        encryptionKey: Buffer.from(s.idempotencyVault.encryptionKey).toString("base64")},
    });
    assert.deepEqual(fresh, {operationId: first.operationId, replayed: true, preflightOnly: true,
      keyDigest: hash(first.draft.payload.idempotency_key)});
    assert.equal((await stats(s)).counter.reserved, 1);
  });

  await t.test("a lost COMMIT acknowledgement recovers the committed operation and never reserves twice", async () => {
    const s = await env.ready();
    let lose = true;
    const uncertain = {query: async (sql, params) => {
      const result = await db.query(sql, params);
      if (sql === "commit" && lose) {lose = false; throw new Error("Synthetic lost commit acknowledgement");}
      return result;
    }};
    await assert.rejects(run(s, {}, uncertain), denied("REJECTED"));
    const stored = await stats(s);
    assert.equal(stored.rows.length, 1); assert.equal(stored.counter.reserved, 1);
    const fresh = await env.connect(s.f.owner);
    const recovered = await run(s, {}, fresh);
    assert.equal(recovered.operationId, stored.rows[0].id);
    assert.equal(hash(recovered.draft.payload.idempotency_key), stored.rows[0].provider_key_digest);
    assert.equal(recovered.replayed, true);
  });

  await t.test("insert failure after counter update rolls back quota, operation and request key", async () => {
    const s = await env.ready();
    const broken = {query: async (sql, params) => {
      if (sql.startsWith("insert into private.sc010c_voice_preparations ")) {
        throw new Error("PRIVATE synthetic secret +48221234567 must never escape");
      }
      return db.query(sql, params);
    }};
    await assert.rejects(run(s, {}, broken), denied("REJECTED"));
    const stored = await stats(s);
    assert.equal(stored.counter.reserved, 0); assert.equal(Number(stored.counter.revision), 1);
    assert.equal(stored.rows.length, 0); assert.equal(stored.keys.length, 0);
    assert.equal((await run(s)).replayed, false);
  });

  await t.test("caller-owned transactions are rejected without committing their work", async () => {
    const s = await env.ready(), dependencies = await deps(s);
    await db.query("begin isolation level repeatable read");
    try {
      await db.query("update private.sc19_voice_entitlements set active=false where id=$1", [s.request.entitlementId]);
      await assert.rejects(prepareOfflineVoiceDraft(db, s.context, s.request, dependencies), denied("REJECTED"));
      assert.equal((await db.query("show transaction_isolation")).rows[0].transaction_isolation, "repeatable read");
    } finally {await db.query("rollback");}
    assert.equal((await db.query("select active from private.sc19_voice_entitlements where id=$1",
      [s.request.entitlementId])).rows[0].active, true);
    assert.equal((await run(s)).replayed, false);
  });

  for (const replay of [false, true]) await t.test(
    `plan/review/release expiry after reconstruction rolls back ${replay ? "exact replay" : "new preparation"}`,
    async () => {
      const deadline = Date.now() + 5000;
      const s = await env.ready("FREE", 1, {planRetentionDeadline: new Date(deadline).toISOString()});
      const first = replay ? await run(s) : null;
      const a = await env.connect(s.f.owner);
      const gate = pauseAfter(a, sql => sql.includes("auth.uid()"));
      const pending = assert.rejects(run(s, {}, gate.client), denied("CONFLICT"));
      await gate.entered;
      try {await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now() + 100)));}
      finally {gate.release();}
      await pending;
      const stored = await stats(s);
      assert.equal(stored.counter.reserved, replay ? 1 : 0);
      assert.equal(stored.rows.length, replay ? 1 : 0);
      assert.equal(stored.keys.length, replay ? 1 : 0);
      if (first) assert.equal(stored.rows[0].id, first.operationId);
    });

  for (const boundary of ["last-read", "all-writes", "exact-replay"]) await t.test(
    `signed interview consent expiring after ${boundary} is rejected inside COMMIT`, async () => {
      const base = await env.ready();
      const deadline = Date.now() + 2500;
      const receipt = env.permission.receipt(base.f, {expires_at: new Date(deadline).toISOString()});
      const receiptId = await env.permission.ingest(base.f, receipt);
      const s = {...base, request: {...base.request, permissionReceiptId: receiptId}};
      const first = boundary === "exact-replay" ? await run(s) : null;
      const a = await env.connect(s.f.owner);
      const gate = pauseAfter(a, sql => boundary === "last-read"
        ? sql.startsWith("select private.sc19_voice_entitlement_eligible(e) as eligible")
        : boundary === "all-writes"
          ? sql.startsWith("insert into private.sc010c_voice_preparation_requests")
          : sql.startsWith("update private.sc010c_voice_preparations set state=state"));
      const pending = assert.rejects(run(s, {}, gate.client), denied("CONFLICT"));
      await gate.entered;
      try {await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now() + 100)));}
      finally {gate.release();}
      await pending;
      const stored = await stats(s);
      assert.equal(stored.counter.reserved, first ? 1 : 0);
      assert.equal(stored.rows.length, first ? 1 : 0);
      assert.equal(stored.keys.length, first ? 1 : 0);
      if (first) assert.equal(stored.rows[0].id, first.operationId);
    });

  await t.test("entitlement verification expiry after all writes rolls the entire preparation back", async () => {
    const s = await env.ready(), deadline = Date.now() + 2500;
    await db.query("update private.sc19_voice_entitlements set company_verification_expires_at=$2 where id=$1",
      [s.request.entitlementId, new Date(deadline).toISOString()]);
    const a = await env.connect(s.f.owner);
    const gate = pauseAfter(a, sql => sql.startsWith("insert into private.sc010c_voice_preparation_requests"));
    const pending = assert.rejects(run(s, {}, gate.client), denied("CONFLICT"));
    await gate.entered;
    try {await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now() + 100)));}
    finally {gate.release();}
    await pending;
    const stored = await stats(s);
    assert.equal(stored.counter.reserved, 0);
    assert.equal(stored.rows.length, 0); assert.equal(stored.keys.length, 0);
  });

  await t.test("plain approval flags, phone fields, copied proof and missing interview permission grant no authority", async () => {
    const s = await env.ready();
    for (const extra of [{contactApproved: true},{noticeDelivered: true},
      {destinationE164: "+48123456789"},{released: true}]) {
      await assert.rejects(run(s, extra), denied("REJECTED"));
    }
    await assert.rejects(run(s, {permissionReceiptId: s.f.contactReceiptId}), denied("CONFLICT"));
    const dependencies = await deps(s);
    await assert.rejects(run(s, {}, db, {...dependencies, verifiedAgent: structuredClone(dependencies.verifiedAgent)}),
      denied("REJECTED"));
    assert.equal((await stats(s)).counter.reserved, 0);
  });

  await t.test("tenant, application, release, approval and request-key mismatches cannot cross bindings", async () => {
    const s = await env.ready(), another = await env.ready();
    await env.asServer(s.f.owner);
    await assert.rejects(prepareOfflineVoiceDraft(db, another.context, s.request, await deps(s)), denied("UNAVAILABLE"));
    for (const changed of [
      {approvalId: another.request.approvalId}, {planId: another.request.planId},
      {releaseId: another.request.releaseId}, {pointerVersion: 2},
      {entitlementId: another.request.entitlementId},
    ]) await assert.rejects(run(s, changed), denied());
    const sameCompany = await env.ready("FREE", 1, {tenant: s.f, entitlementId: s.request.entitlementId});
    await assert.rejects(run(s, {planId: sameCompany.request.planId, releaseId: sameCompany.request.releaseId}), denied());
    await run(s);
    await assert.rejects(run(s, {}, db, await deps(s, {maxBudgetSeconds: 600})), denied("CONFLICT"));
    await assert.rejects(run(sameCompany, {requestKey: s.request.requestKey}), denied("CONFLICT"));
    assert.equal((await stats(s)).rows.length, 1);
  });

  await t.test("authenticated browsers and unrelated workers cannot call the private loader or read operational tables", async () => {
    const s = await env.ready();
    const rls = (await db.query("select relrowsecurity,relforcerowsecurity from pg_class where oid in ('private.sc010c_voice_preparations'::regclass,'private.sc010c_voice_preparation_requests'::regclass)")).rows;
    assert.equal(rls.length, 2);
    assert.ok(rls.every(row => row.relrowsecurity && row.relforcerowsecurity));
    for (const role of ["anon","authenticated","screening_worker","contact_verifier","voice_permission_verifier"]) {
      await db.query("reset role");
      await db.query("set role " + role);
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [s.f.owner]);
      for (const sql of [
        "select * from private.sc010c_voice_preparations",
        "select * from private.sc010c_voice_preparation_requests",
        "select private.sc010c_lock_voice_contact($1,$2,$3,$4)",
      ]) await assert.rejects(db.query(sql, sql.includes("$1") ?
        [s.f.companyId,s.request.communicationId,s.request.approvalId,s.request.permissionReceiptId] : []),
      error => error.code === "42501");
    }
    await env.asServer(users.outsider);
    await assert.rejects(prepareOfflineVoiceDraft(db, s.context, s.request, await deps(s)), denied("UNAVAILABLE"));
    await env.asServer(s.f.owner);
    assert.equal((await stats(s)).counter.reserved, 0);
  });

  for (const [name, mutate] of [
    ["interview permission revoked", async s => env.permission.revoke(s.f, s.request.permissionReceiptId)],
    ["interview notice withdrawn", async s => db.query(
      "update private.voice_interview_permission_policies set enabled=false where company_id=$1", [s.f.companyId])],
    ["interview issuer disabled", async s => db.query(
      "update private.voice_interview_permission_issuers set enabled=false where company_id=$1", [s.f.companyId])],
    ["B2 contact issuer disabled", async s => db.query(
      "update private.contact_trusted_issuers set enabled=false where company_id=$1", [s.f.companyId])],
    ["B2 contact notice withdrawn", async s => db.query(
      "update private.contact_policy_templates set enabled=false where company_id=$1 and channel='voice'", [s.f.companyId])],
    ["contact generation stale after candidate edit", async s => db.query(
      "update public.candidates set first_name='Synthetic changed' where id=$1", [s.f.candidate.id])],
    ["source changed after position edit", async s => db.query(
      "update public.positions set title='Changed synthetic role' where id=$1", [s.f.position.id])],
    ["released pointer removed", async s => db.query(
      "delete from private.voice_plan_current_releases where company_id=$1 and application_id=$2", [s.f.companyId,s.f.application.id])],
    ["company verification expired", async s => db.query(
      "update private.sc19_voice_entitlements set company_verification_expires_at=clock_timestamp()-interval '1 second' where id=$1",
      [s.request.entitlementId])],
    ["entitlement revoked", async s => db.query(
      "update private.sc19_voice_entitlements set revoked_at=clock_timestamp() where id=$1", [s.request.entitlementId])],
  ]) await t.test(name + " blocks a retry while retaining its original identity", async () => {
    const s = await env.ready(), first = await run(s);
    await env.asServer(s.f.owner); await mutate(s);
    await assert.rejects(run(s), denied());
    const stored = await stats(s);
    assert.equal(stored.rows.length, 1); assert.equal(stored.rows[0].id, first.operationId);
    assert.equal(stored.rows[0].provider_key_digest, hash(first.draft.payload.idempotency_key));
    assert.equal(stored.counter.reserved, 1);
    const cancelled = await cancelOfflineVoicePreparation(db, s.context, first.operationId);
    assert.equal(cancelled.state, "cancelled_offline");
    assert.equal((await stats(s)).counter.reserved, 0);
  });

  await t.test("preferences without a current contact window prevent preparation", async () => {
    const s = await env.ready();
    await s.h.asUser(s.f.owner);
    await env.permission.contact.preferences(s.f, 1, randomUUID(), [], "UTC", []);
    await assert.rejects(run(s), denied("CONFLICT"));
    assert.equal((await stats(s)).counter.reserved, 0);
  });

  await t.test("restore isolation blocks new and historical preparations without bypassing R4 inventory", async () => {
    const s = await env.ready(), first = await run(s);
    await db.query("update private.erasure_execution_config set restore_isolated=true where singleton");
    try {await assert.rejects(run(s), denied("CONFLICT"));}
    finally {await env.asServer(s.f.owner); await db.query("update private.erasure_execution_config set restore_isolated=false where singleton");}
    assert.equal((await run(s)).operationId, first.operationId);
    await s.h.asUser(s.f.owner);
    const preview = (await db.query("select public.preview_candidate_erasure($1) as value",
      [s.f.candidate.id])).rows[0].value;
    assert.ok(preview.blockers.includes("schema_dependency_unknown"));
    await env.asServer(s.f.owner);
  });

  await t.test("missing paid settlement or FREE approval never reserves even if quantity exists", async () => {
    for (const packageName of ["FREE","PRESELEKCJA"]) {
      const s = await env.ready(packageName, packageName === "FREE" ? 1 : 7);
      const field = packageName === "FREE" ? "free_trial_approved" : "paid_settlement_verified";
      await db.query("update private.sc19_voice_entitlements set " + field + "=false where id=$1",
        [s.request.entitlementId]);
      await assert.rejects(run(s), denied("UNAVAILABLE"));
      assert.equal((await stats(s)).counter.reserved, 0);
    }
  });

  await t.test("PRESELEKCJA consumes only its separate configured conversation pool", async () => {
    const first = await env.ready("PRESELEKCJA", 2);
    const second = await env.ready("PRESELEKCJA", 2, {tenant: first.f, entitlementId: first.request.entitlementId});
    const third = await env.ready("PRESELEKCJA", 2, {tenant: first.f, entitlementId: first.request.entitlementId});
    const a = await run(first), b = await run(second);
    assert.notEqual(a.operationId, b.operationId);
    assert.equal((await stats(first)).counter.reserved, 2);
    await assert.rejects(run(third), denied("QUOTA_EXHAUSTED"));
    assert.equal((await stats(first)).rows.length, 2);
    assert.equal((await run(first)).operationId, a.operationId);
  });

  await t.test("two sessions competing for the final unit cannot both reserve", async () => {
    const first = await env.ready(), second = await env.ready("FREE", 1,
      {tenant: first.f, entitlementId: first.request.entitlementId});
    const a = await env.connect(first.f.owner), b = await env.connect(second.f.owner);
    const gate = pauseAfter(a, sql => sql.startsWith("update private.sc19_voice_entitlements set reserved=reserved+1"));
    const winner = run(first, {}, gate.client);
    await gate.entered;
    try {await assert.rejects(run(second, {}, b), denied("CONFLICT"));}
    finally {gate.release();}
    const result = await winner;
    await assert.rejects(run(second, {}, b), denied("QUOTA_EXHAUSTED"));
    const stored = await stats(first);
    assert.equal(stored.counter.reserved, 1); assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0].id, result.operationId);
  });

  await t.test("concurrent request keys for one approval conflict then recover the same UUID", async () => {
    const s = await env.ready(), a = await env.connect(s.f.owner), b = await env.connect(s.f.owner);
    const other = {requestKey: randomUUID()};
    const gate = pauseAfter(a, sql => sql.startsWith("update private.sc19_voice_entitlements set reserved=reserved+1"));
    const winner = run(s, {}, gate.client);
    await gate.entered;
    try {await assert.rejects(run(s, other, b), denied("CONFLICT"));}
    finally {gate.release();}
    const first = await winner, recovered = await run(s, other, b);
    assert.equal(recovered.operationId, first.operationId);
    assert.equal(recovered.draft.payload.idempotency_key, first.draft.payload.idempotency_key);
    assert.equal((await stats(s)).counter.reserved, 1);
  });

  const revokeVoice = async (client, s) => client.query(
    "select public.record_contact_permission($1,$2,'voice','revoked',$3,0,$4)",
    [s.f.candidate.id,s.f.recruitment.id,randomUUID(),randomUUID()]);
  await t.test("revocation first blocks preparation; rollback does not manufacture a reservation", async () => {
    const s = await env.ready(), a = await env.connect(s.f.owner), b = await env.connect(s.f.owner);
    await b.query("begin"); await revokeVoice(b, s);
    try {await assert.rejects(run(s, {}, a), denied("CONFLICT"));}
    finally {await b.query("rollback");}
    assert.equal((await stats(s)).counter.reserved, 0);
    assert.equal((await run(s, {}, a)).replayed, false);
  });
  await t.test("restore-mode changes serialize with preparation in both lock orders", async () => {
    const s = await env.ready(), a = await env.connect(s.f.owner), b = await env.connect(s.f.owner);
    await b.query("begin");
    await b.query("update private.erasure_execution_config set restore_isolated=true where singleton");
    try {await assert.rejects(run(s, {}, a), denied("CONFLICT"));}
    finally {await b.query("rollback");}
    const gate = pauseAfter(a, sql => sql.startsWith("update private.sc19_voice_entitlements set reserved=reserved+1"));
    const pending = run(s, {}, gate.client); await gate.entered;
    await b.query("set lock_timeout='100ms'");
    try {
      await assert.rejects(b.query("update private.erasure_execution_config set restore_isolated=true where singleton"),
        error => error.code === "55P03");
    } finally {gate.release();}
    const prepared = await pending;
    await b.query("update private.erasure_execution_config set restore_isolated=true where singleton");
    try {await assert.rejects(run(s, {}, a), denied("CONFLICT"));}
    finally {await b.query("update private.erasure_execution_config set restore_isolated=false where singleton");}
    assert.equal((await stats(s)).rows[0].id, prepared.operationId);
  });
  await t.test("reservation first serializes revoke; a committed later revoke prevents every retry", async () => {
    const s = await env.ready(), a = await env.connect(s.f.owner), b = await env.connect(s.f.owner);
    const gate = pauseAfter(a, sql => sql.startsWith("update private.sc19_voice_entitlements set reserved=reserved+1"));
    const pending = run(s, {}, gate.client); await gate.entered;
    try {await assert.rejects(revokeVoice(b, s), error => error.code === "PT409");}
    finally {gate.release();}
    const first = await pending;
    await revokeVoice(b, s);
    await assert.rejects(run(s, {}, a), denied("CONFLICT"));
    const stored = await stats(s);
    assert.equal(stored.rows[0].id, first.operationId); assert.equal(stored.counter.reserved, 1);
    assert.equal(networkCalls, 0);
  });

  await t.test("cancellation releases exactly once and a replay never reopens the terminal approval", async () => {
    const s = await env.ready(), first = await run(s);
    assert.equal((await cancelOfflineVoicePreparation(db, s.context, first.operationId)).state, "cancelled_offline");
    assert.equal((await cancelOfflineVoicePreparation(db, s.context, first.operationId)).state, "cancelled_offline");
    await assert.rejects(run(s), denied("CONFLICT"));
    await assert.rejects(run(s, {requestKey: randomUUID()}), denied("CONFLICT"));
    const stored = await stats(s);
    assert.equal(stored.rows.length, 1); assert.equal(stored.rows[0].state, "cancelled_offline");
    assert.equal(stored.counter.reserved, 0); assert.equal(Number(stored.counter.revision), 3);
    await assert.rejects(db.query("update private.sc010c_voice_preparations set state='prepared_offline' where id=$1",
      [first.operationId]), error => error.code === "42501");
    await assert.rejects(db.query("delete from private.sc010c_voice_preparations where id=$1",
      [first.operationId]), error => error.code === "42501");
    await assert.rejects(db.query("truncate private.sc010c_voice_preparations cascade"),
      error => error.code === "42501");
  });

  await t.test("restore-mode changes serialize with cancellation in both transaction orders", async () => {
    const s = await env.ready(), first = await run(s);
    const a = await env.connect(s.f.owner), b = await env.connect(s.f.owner);
    await b.query("begin");
    await b.query("update private.erasure_execution_config set restore_isolated=true where singleton");
    try {await assert.rejects(cancelOfflineVoicePreparation(a, s.context, first.operationId), denied("CONFLICT"));}
    finally {await b.query("rollback");}
    const gate = pauseAfter(a, sql => sql.startsWith("update private.sc010c_voice_preparations set state='cancelled_offline'"));
    const pending = cancelOfflineVoicePreparation(gate.client, s.context, first.operationId);
    await gate.entered;
    await b.query("set lock_timeout='100ms'");
    try {
      await assert.rejects(b.query("update private.erasure_execution_config set restore_isolated=true where singleton"),
        error => error.code === "55P03");
    } finally {gate.release();}
    assert.equal((await pending).state, "cancelled_offline");
    await b.query("update private.erasure_execution_config set restore_isolated=true where singleton");
    try {await assert.rejects(cancelOfflineVoicePreparation(a, s.context, first.operationId), denied("CONFLICT"));}
    finally {await b.query("update private.erasure_execution_config set restore_isolated=false where singleton");}
    const stored = await stats(s);
    assert.equal(stored.rows[0].state, "cancelled_offline");
    assert.equal(stored.counter.reserved, 0);
  });

  await t.test("wrong encryption key or changed reviewed config cannot replace a persisted retry identity", async () => {
    const s = await env.ready(), first = await run(s), dependencies = await deps(s);
    await assert.rejects(run(s, {}, db, {...dependencies,
      idempotencyVault: {...dependencies.idempotencyVault, encryptionKey: randomBytes(32)}}), denied("REJECTED"));
    await assert.rejects(run(s, {}, db, {...dependencies,
      idempotencyVault: {...dependencies.idempotencyVault, keyId: "missing-key-version"}}), denied("REJECTED"));
    const stored = await stats(s);
    assert.equal(stored.rows.length, 1); assert.equal(stored.rows[0].id, first.operationId);
    assert.equal(stored.counter.reserved, 1);
  });
  assert.equal(networkCalls, 0, "no test enters a real HTTP transport or provider adapter");
});
