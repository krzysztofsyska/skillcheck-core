// Real fresh Node process. All input is ephemeral synthetic fixture data on stdin;
// stdout contains only opaque operation identity and random-key digest.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {Client} from "pg";
import {prepareOfflineVoiceDraft} from "../../lib/voice/offline-preparation.ts";
import {syntheticRetellProof} from "./voice-preparation-provider-fixture.mjs";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const bytes = Buffer.concat(chunks);
assert.ok(bytes.length < 50000);
const input = JSON.parse(bytes.toString("utf8"));
assert.ok(["127.0.0.1","localhost","::1"].includes(input.connectionConfig.host) ||
  input.connectionConfig.host?.startsWith("/tmp/"));
assert.match(input.connectionConfig.database, /^sc010c_prep_[a-z0-9_]+$/);
const db = new Client(input.connectionConfig);
await db.connect();
try {
  globalThis.fetch = async () => {throw new Error("Network forbidden in restart fixture");};
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [input.actorId]);
  const {retell, verifiedAgent} = await syntheticRetellProof();
  const contactVault = {...input.contactVault,
    encryptionKey: Buffer.from(input.contactVault.encryptionKey, "base64"),
    fingerprintKey: Buffer.from(input.contactVault.fingerprintKey, "base64")};
  const idempotencyVault = {...input.idempotencyVault,
    encryptionKey: Buffer.from(input.idempotencyVault.encryptionKey, "base64")};
  const result = await prepareOfflineVoiceDraft(db, input.context, input.request,
    {retell, verifiedAgent, contactVault, idempotencyVault});
  process.stdout.write(JSON.stringify({
    operationId: result.operationId, replayed: result.replayed, preflightOnly: result.preflightOnly,
    keyDigest: createHash("sha256").update(result.draft.payload.idempotency_key).digest("hex"),
  }));
} finally { await db.end(); }
