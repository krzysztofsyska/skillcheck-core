import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { parse } from 'pg-connection-string';
import { setupRankingDatabase, users } from './screening-ranking-fixture.mjs';
import { voiceInterviewPermissionHarness } from './voice-interview-permission-fixture.mjs';
import { behaviorGuideDefinitions } from '../../lib/behavior-guide.ts';
import { canonicalVoiceSourceSnapshot } from '../../lib/voice/plan-persistence-contract.ts';
import {
  ACTIVE_VOICE_TEMPLATE_VERSION, ACTIVE_VOICE_TEMPLATE_DIGEST,
  reconstructTrustedVoiceSource,
} from '../../lib/voice/trusted-source-verifier.ts';
import { atomicReviewVoicePlan, atomicReleaseVoicePlan } from '../../lib/voice/atomic-plan-operations.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const behaviors = Object.freeze(behaviorGuideDefinitions.map((area, index) =>
  area.label + ': ' + (index < 4 ? 'Wysoki' : 'Standardowy')));
const ratings = Object.freeze(['insufficient_data', 'meets', 'below', 'meets', 'above']);
const schemas = Object.freeze([
  '../../db/prototypes/sc012b-plan-schema.sql',
  '../../db/isolated/sc012b-template-catalog.sql',
  '../../db/isolated/sc012b-review-rpc.sql',
  '../../db/isolated/sc012b-release-rpc.sql',
  '../../db/isolated/sc010c-interview-permission.sql',
  '../../db/isolated/sc019-voice-entitlements.sql',
  '../../db/isolated/sc010c-voice-preparation.sql',
]);

/**
 * Real PostgreSQL only: a random disposable database on the explicitly supplied
 * loopback server. Installs the accepted migration chain plus the isolated
 * source/permission/quota/preparation candidates. No external provider is used.
 *
 * const env = await boot(t);
 * const first = await env.ready('FREE', 1);
 * const second = await env.ready('FREE', 1, {
 *   tenant: first.f, entitlementId: first.request.entitlementId,
 * });
 * const rival = await env.connect(first.f.owner);
 */
export async function boot(t, {beforeIsolated} = {}) {
  assert.equal(typeof t?.after, 'function', 'A test cleanup context is required');
  const url = process.env.SCREENING_TEST_DATABASE_URL;
  assert.ok(url, 'SCREENING_TEST_DATABASE_URL must name a disposable loopback PostgreSQL server');
  const parsed = parse(url);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(parsed.host) || parsed.host?.startsWith('/tmp/'),
    'Voice preparation fixtures refuse external PostgreSQL hosts');
  const databaseName = 'sc010c_prep_' + randomUUID().replaceAll('-', '');
  const config = database => ({ ...parsed, database, connectionTimeoutMillis: 5000 });
  const clients = new Set();
  const admin = new Client(config('postgres'));
  await admin.connect();
  try { await admin.query('create database ' + databaseName); }
  finally { await admin.end(); }
  t.after(async () => {
    await Promise.all([...clients].map(client => client.end().catch(() => {})));
    const cleanup = new Client(config('postgres'));
    await cleanup.connect();
    try {
      await cleanup.query('select pg_terminate_backend(pid) from pg_stat_activity where datname=$1', [databaseName]);
      await cleanup.query('drop database if exists ' + databaseName);
    } finally { await cleanup.end(); }
  });
  const setServerActor = async (client, actorId) => {
    assert.ok(actorId === null || (typeof actorId === 'string' && uuid.test(actorId)));
    await client.query('reset role');
    await client.query("select set_config('request.jwt.claim.sub',$1,false)", [actorId ?? '']);
  };
  const connect = async (actorId = users.owner) => {
    const client = new Client(config(databaseName));
    clients.add(client);
    await client.connect();
    client.exec = sql => client.query(sql);
    await client.query("set statement_timeout='15s'; set lock_timeout='2s'");
    await setServerActor(client, actorId);
    return client;
  };
  const db = await connect();
  const h = await setupRankingDatabase(db);
  for (const [index, path] of schemas.entries()) {
    if (index === 1 && beforeIsolated) await beforeIsolated(db);
    await db.exec(await readFile(new URL(path, import.meta.url), 'utf8'));
  }
  await db.query(`insert into private.voice_plan_template_catalog(version,manifest_digest,active)
    values($1,$2,true)`, [ACTIVE_VOICE_TEMPLATE_VERSION, ACTIVE_VOICE_TEMPLATE_DIGEST]);
  const permission = voiceInterviewPermissionHarness(h);
  const asServer = (actorId = users.owner, client = db) => setServerActor(client, actorId);
  // Stable across sessions and repeated requests in this boot, separate from
  // the synthetic B2 contact-encryption and contact-fingerprint keys.
  const idempotencyVault = { keyId: 'synthetic-offline-provider-key-v1', encryptionKey: randomBytes(32) };

  const entitlement = async (f, packageName, total, entitlementId) => {
    await asServer(f.owner);
    if (entitlementId !== undefined) {
      assert.match(entitlementId, uuid);
      const rows = (await db.query(`select e.*,private.sc19_voice_entitlement_eligible(e) as eligible
        from private.sc19_voice_entitlements e where company_id=$1 and id=$2`,
      [f.companyId, entitlementId])).rows;
      assert.equal(rows.length, 1, 'Reused entitlement must belong to this fixture company');
      assert.equal(rows[0].package, packageName);
      assert.equal(rows[0].total, total);
      assert.equal(rows[0].eligible, true);
      return rows[0];
    }
    // Explicit synthetic operator evidence. Real grant creation/verification is
    // intentionally not exposed by the isolated SC019 implementation.
    return (await db.query(`insert into private.sc19_voice_entitlements
      (company_id,package,total,grant_reference,valid_from,expires_at,active,company_verified,
       company_verification_reference,company_verification_expires_at,free_trial_approved,paid_settlement_verified)
      values($1,$2,$3,$4,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 day',true,true,
        $5,clock_timestamp()+interval '1 hour',$6,$7) returning *`,
    [f.companyId, packageName, total, randomUUID(), randomUUID(), packageName === 'FREE', packageName === 'PRESELEKCJA'])).rows[0];
  };

  const ready = async (packageName = 'FREE', total = 1, options = {}) => {
    assert.ok(['FREE', 'PRESELEKCJA'].includes(packageName));
    assert.ok(Number.isSafeInteger(total) && total >= 1 && total <= 100000);
    assert.ok(packageName !== 'FREE' || total === 1, 'The FREE fixture is exactly one lifetime grant');
    assert.ok(options && typeof options === 'object' && !Array.isArray(options));
    const tenant = options.tenant?.f ?? options.tenant;
    // The contact helper sets behaviors before analysis. Reusing a tenant checks
    // its existing position without writing it and invalidating the first plan.
    let f = await permission.ready({ tenant, requiredBehaviors: [...behaviors], ratings: [...ratings] });
    const permissionReceipt = permission.receipt(f);
    const permissionReceiptId = await permission.ingest(f, permissionReceipt);
    assert.equal(typeof permissionReceiptId, 'string');
    assert.match(permissionReceiptId, uuid);
    f = { ...f, permissionReceiptId, permissionReceipt };
    await asServer(f.owner);
    const source = await reconstructTrustedVoiceSource(db, {
      companyId: f.companyId, applicationId: f.application.id,
      analysisId: f.analysis_id, reviewId: f.reviewId, shortlistEntryId: f.shortlistId,
    });
    const planId = (await db.query(`insert into public.voice_plan_versions
      (company_id,recruitment_id,application_id,position_id,analysis_id,screening_review_id,
       shortlist_entry_id,plan_version,source_hash,envelope_hash,source_snapshot,plan_envelope,
       template_version,created_by,retention_policy_version,retention_deadline)
      values($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10::jsonb,$11::jsonb,$12,$13,
        'synthetic-voice-test-v1',coalesce($14::timestamptz,clock_timestamp()+interval '1 day')) returning id`,
    [f.companyId, f.recruitment.id, f.application.id, f.position.id,
      f.analysis_id, f.reviewId, f.shortlistId, source.sourceHash, source.planContractHash,
      JSON.stringify(canonicalVoiceSourceSnapshot(source.sourceBinding, source.planSourceFingerprint)),
      JSON.stringify(source), source.templateVersion, f.owner, options.planRetentionDeadline ?? null])).rows[0].id;
    const planReviewId = await atomicReviewVoicePlan(db, {
      planId, sourceHash: source.sourceHash, expectedReviewVersion: 0,
      decision: 'approved', reason: null, requestKey: randomUUID(),
    });
    const releaseId = await atomicReleaseVoicePlan(db, {
      planId, sourceHash: source.sourceHash, approvedReviewId: planReviewId,
      expectedPointerVersion: null, expectedReleaseId: null, requestKey: randomUUID(),
    });
    const pointer = (await db.query(`select pointer_version,release_entry_id
      from private.voice_plan_current_releases where company_id=$1 and application_id=$2`,
    [f.companyId, f.application.id])).rows[0];
    assert.equal(pointer.release_entry_id, releaseId);
    const grant = await entitlement(f, packageName, total, options.entitlementId);
    const request = Object.freeze({
      communicationId: f.communicationId, approvalId: f.approvalId, permissionReceiptId,
      planId, releaseId, pointerVersion: Number(pointer.pointer_version),
      entitlementId: grant.id, requestKey: randomUUID(),
    });
    f = { ...f, planId, planReviewId, releaseId, pointerVersion: request.pointerVersion,
      source, entitlementId: grant.id };
    await asServer(f.owner);
    const contactVault = f.contactConfig;
    const deps = (retell, verifiedAgent) => ({
      retell, verifiedAgent,
      contactVault: structuredClone(contactVault),
      idempotencyVault: structuredClone(idempotencyVault),
    });
    return {
      f, h, permission, request, context: Object.freeze({ companyId: f.companyId }),
      contactVault, idempotencyVault: structuredClone(idempotencyVault), deps, entitlement: grant,
    };
  };
  return {
    db, h, permission, connect, asServer, actor: setServerActor, ready,
    databaseName, connectionConfig: Object.freeze(config(databaseName)),
  };
}
