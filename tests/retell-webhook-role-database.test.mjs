// R6-1e part 2: the Retell webhook's own database role (20261121220000_r6_retell_webhook_role.sql)
// on the full checked-in chain. ingestRetellWebhook runs as `retell_webhook`
// (set role, exactly what the pinned login gets) through call_started, call_ended
// with a transcript, call_analyzed with a cost and duplicate deliveries; the same
// role cannot read or write anything else (candidates, contact data, pools,
// transcripts, other preparations, the cost settings) and cannot change what the
// guards protect. Manual rollback removes every grant and policy.
// Native disposable PostgreSQL only; synthetic data; no provider, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { activeBoot, users } from './helpers/competency-active-fixture.mjs';
import { seedSyntheticPolicy } from './helpers/sc19-migration-fixture.mjs';
import { voiceInterviewPermissionHarness } from './helpers/voice-interview-permission-fixture.mjs';
import { syntheticRetellProof } from './helpers/voice-preparation-provider-fixture.mjs';
import { behaviorGuideDefinitions } from '../lib/behavior-guide.ts';
import { canonicalVoiceSourceSnapshot } from '../lib/voice/plan-persistence-contract.ts';
import { trustedVoiceTemplateDigest } from '../lib/voice/template-registry.ts';
import { reconstructTrustedVoiceSource } from '../lib/voice/trusted-source-verifier.ts';
import { prepareOfflineVoiceDraft } from '../lib/voice/offline-preparation.ts';
import { ingestRetellWebhook, recordRetellDispatch } from '../lib/voice/retell-dispatch-ledger.ts';
import { RETELL_WEBHOOK_DATABASE_ROLE } from '../lib/voice/retell-webhook-config.ts';

const migration = new URL('../supabase/migrations/20261121220000_r6_retell_webhook_role.sql', import.meta.url);
const rollback = new URL('../supabase/rollbacks/20261121220000_r6_retell_webhook_role_down.sql', import.meta.url);
const role = 'retell_webhook';
const tables = ['private.sc011b_voice_attempts', 'private.sc011b_voice_webhook_receipts', 'private.sc011b_voice_transcripts',
  'private.sc010c_voice_preparations', 'voice_budget.charges'];
const functions = ['voice_budget.record_call_cost(uuid,uuid,integer)', 'private.erasure_lock_candidate(uuid)',
  'private.erasure_normal_row_guard(text,text,text,jsonb,jsonb)', 'private.erasure_purge_allowed(text,jsonb,text)'];
const behaviors = behaviorGuideDefinitions.map((x, i) => x.label + ': ' + (i < 4 ? 'Wysoki' : 'Standardowy'));
const ratings = ['insufficient_data', 'meets', 'below', 'meets', 'above'];
const sha = value => createHash('sha256').update(value).digest('hex');
const denied = e => e.code === '42501';
const webhookKey = 'key_synthetic_webhook_0123456789';
const agentId = 'agent_1234567890abcdef';
const config = { webhookKey, agentId, agentVersion: 2 };

test('R6-1e part 2: the Retell webhook ingests as retell_webhook and reaches nothing else', async t => {
  const env = await activeBoot(t, { fullChain: true });
  const { db, h } = env;
  const one = async (sql, args) => (await db.query(sql, args)).rows[0].v;
  const asServer = async actor => {
    await db.query('reset role');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [actor]);
  };
  const asWebhook = async () => {
    await db.query('reset role');
    await db.query("select set_config('request.jwt.claim.sub','',false)");
    await db.query(`set role ${role}`);
  };
  let policySeeded = false;
  const credited = { ...h, seed: async (owner = users.owner, ...rest) => {
    const f = await h.seed(owner, ...rest);
    await h.asAdmin();
    if (!policySeeded) { await seedSyntheticPolicy(db); policySeeded = true; }
    await db.query('select private.sc19_grant_paid($1,$2)', [f.companyId, `synthetic-voice-${randomUUID()}`]);
    await h.asUser(owner);
    return f;
  } };
  const permission = voiceInterviewPermissionHarness(credited);
  const ready = async tenant => {
    let f = await permission.ready({ tenant, requiredBehaviors: [...behaviors], ratings: [...ratings] });
    const permissionReceiptId = await permission.ingest(f, permission.receipt(f));
    f = { ...f, permissionReceiptId };
    await asServer(f.owner);
    const source = await reconstructTrustedVoiceSource(db, { companyId: f.companyId, applicationId: f.application.id,
      analysisId: f.analysis_id, reviewId: f.reviewId, shortlistEntryId: f.shortlistId });
    const planId = await one(`insert into public.voice_plan_versions
      (company_id,recruitment_id,application_id,position_id,analysis_id,screening_review_id,shortlist_entry_id,
       plan_version,source_hash,envelope_hash,source_snapshot,plan_envelope,template_version,created_by,
       retention_policy_version,retention_deadline)
      values($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10::jsonb,$11::jsonb,'skillcheck-voice-plan-v1',$12,'synthetic-v1',
       clock_timestamp()+interval '30 days') returning id as v`,
    [f.companyId, f.recruitment.id, f.application.id, f.position.id, f.analysis_id, f.reviewId, f.shortlistId,
      source.sourceHash, source.planContractHash,
      JSON.stringify(canonicalVoiceSourceSnapshot(source.sourceBinding, source.planSourceFingerprint)), JSON.stringify(source), f.owner]);
    const reviewId = await one('select private.sc012b_review_plan($1,0,$2,$3,null,$4) as v', [planId, source.sourceHash, 'approved', randomUUID()]);
    const releaseId = await one('select private.sc012b_release_plan($1,$2,$3,null,null,$4) as v', [planId, reviewId, source.sourceHash, randomUUID()]);
    const pointerVersion = await one(`select pointer_version as v from private.voice_plan_current_releases
      where company_id=$1 and application_id=$2`, [f.companyId, f.application.id]);
    return { ...f, planId, releaseId, pointerVersion: Number(pointerVersion) };
  };

  await h.asAdmin();
  await db.query('insert into private.voice_plan_template_catalog(version,manifest_digest,active) values($1,$2,true) on conflict do nothing',
    ['skillcheck-voice-plan-v1', trustedVoiceTemplateDigest('skillcheck-voice-plan-v1')]);
  const proof = await syntheticRetellProof();
  const vaultKey = randomBytes(32);
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error('External network forbidden'); };
  t.after(() => { globalThis.fetch = originalFetch; });

  const f = await ready();
  await h.asAdmin();
  const pool = await one(`select entitlement_id as v from private.sc19_voice_grant_interviews($1,'operator_manual',5,$2,
    clock_timestamp()+interval '30 days',$3,clock_timestamp()+interval '30 days')`, [f.companyId, randomUUID(), randomUUID()]);
  // One candidate per call: a preparation is bound to its candidate's approval.
  const order = async () => {
    const g = await ready(f);
    await asServer(g.owner);
    const o = await prepareOfflineVoiceDraft(db, { companyId: g.companyId }, {
      communicationId: g.communicationId, approvalId: g.approvalId, permissionReceiptId: g.permissionReceiptId,
      planId: g.planId, releaseId: g.releaseId, pointerVersion: g.pointerVersion, entitlementId: pool, requestKey: randomUUID(),
    }, { retell: proof.retell, verifiedAgent: proof.verifiedAgent, contactVault: structuredClone(g.contactConfig),
      idempotencyVault: { keyId: 'synthetic-offline-provider-key-v1', encryptionKey: vaultKey } });
    return { ...o, candidateId: g.candidate.id };
  };
  // A placed call: preparation, once-only claim (reserves the cost cap) and the recorded provider call id.
  const placed = async () => {
    const o = await order();
    await h.asAdmin();
    const keyDigest = await one('select provider_key_digest as v from private.sc010c_voice_preparations where id=$1', [o.operationId]);
    await asServer(f.owner);
    await db.query(`insert into private.sc011b_voice_dispatches(company_id,preparation_id,provider_key_digest,payload_sha256)
      values($1,$2,$3,$4)`, [f.companyId, o.operationId, keyDigest, sha('synthetic-payload')]);
    const callId = `call_role_${randomUUID().slice(0, 8)}`;
    await h.asAdmin();
    const { attemptId } = await recordRetellDispatch(db, { companyId: f.companyId, operationId: o.operationId, providerCallId: callId, agentId });
    return { operationId: o.operationId, callId, attemptId, candidateId: o.candidateId };
  };
  const deliver = async (event, callId, change = {}, at = Date.now()) => {
    const body = new TextEncoder().encode(JSON.stringify({ event, call: {
      call_type: 'phone_call', direction: 'outbound', call_id: callId, agent_id: agentId, agent_version: 2,
      start_timestamp: at - 400_000, end_timestamp: at - 10_000, disconnection_reason: 'user_hangup',
      transcript_object: [{ role: 'agent', content: 'Dzień dobry' }, { role: 'user', content: 'Syntetyczna odpowiedź' }], ...change,
    } }));
    const signature = 'v=' + at + ',d=' + createHmac('sha256', webhookKey)
      .update(Buffer.concat([Buffer.from(body), Buffer.from(String(at))])).digest('hex');
    await asWebhook();
    try {
      assert.equal(await one('select current_user as v'), role);
      return await ingestRetellWebhook(db, body, signature, config, at);
    } finally { await h.asAdmin(); }
  };

  await t.test('installed closed: NOLOGIN without password, inherits nothing, no API role touched', async () => {
    await h.asAdmin();
    assert.equal(RETELL_WEBHOOK_DATABASE_ROLE, role, 'the runtime gate pins the login to this role');
    const r = (await db.query(`select rolcanlogin,rolpassword is null nopass,rolsuper,rolinherit,rolcreaterole,rolcreatedb,
      rolreplication,rolbypassrls from pg_authid where rolname=$1`, [role])).rows[0];
    assert.deepEqual(r, { rolcanlogin: false, nopass: true, rolsuper: false, rolinherit: false, rolcreaterole: false,
      rolcreatedb: false, rolreplication: false, rolbypassrls: false });
    assert.equal(await one('select count(*)::int as v from pg_auth_members where member=$1::regrole', [role]), 0);
    for (const table of tables) {
      assert.equal(await one('select relforcerowsecurity as v from pg_class where oid=$1::regclass', [table]), true, table);
      // Every policy for this role names this role only.
      const policies = (await db.query(`select policyname,roles::text r from pg_policies where schemaname||'.'||tablename=$1
        and policyname like 'retell_webhook%'`, [table])).rows;
      assert.ok(policies.length >= 1, table);
      for (const p of policies) assert.equal(p.r, `{${role}}`, `${table} ${p.policyname}`);
    }
    for (const api of ['anon', 'authenticated', 'service_role', 'public']) {
      if (api !== 'public' && !await one('select to_regrole($1) is not null as v', [api])) continue;
      assert.equal(await one(`select count(*)::int as v from pg_policies where $1=any(roles) and policyname like 'retell_webhook%'`, [api]), 0);
    }
    // Re-running the migration leaves the same privileges (idempotent).
    const acl = () => one(`select string_agg(c.oid::regclass::text||':'||coalesce(c.relacl::text,''),'|' order by c.oid) as v
      from pg_class c where c.oid=any($1::regclass[])`, [tables]);
    const before = await acl();
    await db.query(await readFile(migration, 'utf8'));
    assert.equal(await acl(), before);
    // The postflight refuses a role that holds anything beyond these grants.
    const body = (await readFile(migration, 'utf8')).replace(/^begin;$/m, '').replace(/^commit;$/m, '');
    for (const [extra, error] of [['grant select on public.candidates to retell_webhook', 'retell_webhook_relation_exposed'],
      ['grant select(id) on public.companies to retell_webhook', 'retell_webhook_relation_exposed'],
      ['grant execute on function private.erasure_purge_engine(uuid,bigint,boolean) to retell_webhook', 'retell_webhook_function_exposed'],
      ['grant usage on schema public to retell_webhook', 'retell_webhook_function_exposed'],
      ['grant delete on private.sc011b_voice_attempts to retell_webhook', 'retell_webhook_privilege_too_wide']]) {
      await db.query('begin');
      try {
        await db.query(extra);
        await assert.rejects(db.query(body), e => e.code === '55000' && e.message === error, extra);
      } finally { await db.query('rollback'); }
    }
  });

  const call = await placed();
  const other = await placed();
  const unplaced = await order();

  await t.test('the full webhook chain runs as retell_webhook: status, transcript, cost, duplicates', async () => {
    assert.deepEqual(await deliver('call_started', call.callId), { outcome: 'applied' });
    assert.deepEqual(await deliver('call_started', call.callId), { outcome: 'duplicate_delivery' });
    assert.deepEqual(await deliver('call_ended', call.callId), { outcome: 'applied' });
    assert.deepEqual(await deliver('call_analyzed', call.callId, { call_cost: { combined_cost: 40 } }), { outcome: 'recorded' });
    assert.deepEqual(await deliver('call_analyzed', call.callId, { call_cost: { combined_cost: 90 } }), { outcome: 'duplicate_delivery' });
    assert.deepEqual(await deliver('call_unknown_event', call.callId), { outcome: 'ignored' });
    assert.deepEqual(await deliver('call_started', 'call_never_recorded_01'), { outcome: 'uncorrelated' });
    // A request not to be called again ends the other call and is recorded.
    assert.deepEqual(await deliver('call_ended', other.callId, { disconnection_reason: 'user_requested_dnc', transcript_object: [] }),
      { outcome: 'applied' });
    await h.asAdmin();
    assert.deepEqual((await db.query('select status,outcome,dnc_requested from private.sc011b_voice_attempts where id=$1', [call.attemptId])).rows,
      [{ status: 'completed', outcome: 'completed', dnc_requested: false }]);
    assert.deepEqual((await db.query('select status,outcome,dnc_requested from private.sc011b_voice_attempts where id=$1', [other.attemptId])).rows,
      [{ status: 'completed', outcome: 'dnc_requested', dnc_requested: true }]);
    assert.deepEqual((await db.query('select utterances,candidate_id from private.sc011b_voice_transcripts where attempt_id=$1', [call.attemptId])).rows,
      [{ utterances: [{ speaker: 'agent', text: 'Dzień dobry' }, { speaker: 'candidate', text: 'Syntetyczna odpowiedź' }], candidate_id: call.candidateId }]);
    assert.equal(await one('select cost_grosze as v from voice_budget.charges where preparation_id=$1', [call.operationId]), 180);
    assert.equal(await one('select count(*)::int as v from private.sc011b_voice_webhook_receipts'), 5);
    assert.equal(networkCalls, 0);
  });

  await t.test('as retell_webhook: nothing else is readable or writable, and the guards still hold', async () => {
    const refused = [
      'select id from public.candidates limit 1',
      'select id from public.companies limit 1',
      'select * from public.candidate_contact_preferences limit 1',
      'select * from private.sc19_voice_entitlements limit 1',
      'select * from private.sc011b_voice_dispatches limit 1',
      'select * from private.sc011b_voice_transcripts limit 1',
      'select utterances from private.sc011b_voice_transcripts limit 1',
      'select reserved_grosze from voice_budget.charges limit 1',
      'select * from voice_budget.settings',
      'select * from voice_budget.owner_alerts',
      'update voice_budget.settings set monthly_cap_grosze=999999',
      `select voice_budget.reserve_at('${f.companyId}','${unplaced.operationId}',now())`,
      `select voice_budget.release_dispatch('${f.companyId}','${call.operationId}')`,
      `update voice_budget.charges set cost_grosze=0 where preparation_id='${call.operationId}'`,
      `delete from private.sc011b_voice_attempts where id='${call.attemptId}'`,
      `update private.sc011b_voice_attempts set provider_call_id='call_hijacked_000000' where id='${call.attemptId}'`,
      `update private.sc011b_voice_attempts set provider_account_id='${agentId}' where id='${call.attemptId}'`,
      `insert into private.sc011b_voice_attempts(company_id,preparation_id,candidate_id,provider_account_id,provider_call_id)
        values('${f.companyId}','${unplaced.operationId}','${unplaced.candidateId}','${agentId}','call_injected_000000')`,
      'delete from private.sc011b_voice_webhook_receipts',
      'update private.sc011b_voice_webhook_receipts set result=\'ignored\'',
      `update private.sc010c_voice_preparations set state='cancelled_offline' where id='${call.operationId}'`,
      'delete from private.sc011b_voice_transcripts',
      `select private.erasure_purge_engine('${randomUUID()}',1,false)`,
      `select private.sc19_grant_paid('${f.companyId}','synthetic-forbidden')`,
    ];
    for (const sql of refused) {
      await asWebhook();
      await assert.rejects(db.query(sql), denied, sql);
    }
    // Rows outside the dispatched calls are invisible, not just unwritable.
    await asWebhook();
    assert.equal(await one('select count(*)::int as v from private.sc010c_voice_preparations where id=$1', [unplaced.operationId]), 0);
    assert.equal(await one('select count(*)::int as v from private.sc010c_voice_preparations where id=$1', [call.operationId]), 1);
    // A finished attempt cannot be moved by the webhook role either (guard, not privilege).
    await assert.rejects(db.query("update private.sc011b_voice_attempts set status='failed' where id=$1", [call.attemptId]),
      e => e.code === '42501' && /IMMUTABLE/.test(e.message));
    await h.asAdmin();
    // Catalog: exactly the five relations and four functions.
    const relations = (await db.query(`select c.oid::regclass::text t from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname not in ('pg_catalog','information_schema') and c.relkind in ('r','v','m','p','f','S')
      and (has_table_privilege($1,c.oid,'select,insert,update,delete,truncate,references,trigger')
        or has_any_column_privilege($1,c.oid,'select,insert,update,references')) order by 1`, [role])).rows.map(r => r.t);
    assert.deepEqual(relations, [...tables].sort());
    const routines = (await db.query(`select p.oid::regprocedure::text s from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('public','private','voice_budget','ai_ledger','sc19_stripe','sc19_commerce')
      and has_function_privilege($1,p.oid,'execute') order by 1`, [role])).rows.map(r => r.s);
    // public.* functions executable through PUBLIC are not this role's grants; only the private/voice_budget ones are.
    assert.deepEqual(routines.filter(s => !s.startsWith('public.')), [...functions].sort());
    for (const s of routines.filter(x => x.startsWith('public.')))
      assert.equal(await one(`select coalesce(proacl::text,'') like '%' || $2 || '=%' as v from pg_proc where oid=$1::regprocedure`, [s, role]), false, s);
  });

  await t.test('manual rollback removes every grant and policy of the role; the migration then reinstalls', async () => {
    await h.asAdmin();
    await db.query('begin');
    try {
      await db.query(await readFile(rollback, 'utf8').then(s => s.replace(/^begin;$/m, '').replace(/^commit;$/m, '')));
      assert.equal(await one(`select count(*)::int as v from pg_policies where policyname like 'retell_webhook%'`), 0);
      if (await one('select to_regrole($1) is not null as v', [role]))
        for (const table of tables)
          assert.equal(await one('select has_table_privilege($1,$2,$3) or has_any_column_privilege($1,$2,$4) as v',
            [role, table, 'select,insert,update,delete', 'select,insert,update']), false, table);
      await db.query(await readFile(migration, 'utf8').then(s => s.replace(/^begin;$/m, '').replace(/^commit;$/m, '')));
      assert.equal(await one(`select count(*)::int as v from pg_policies where policyname like 'retell_webhook%'`), 7);
    } finally { await db.query('rollback'); }
    assert.equal(await one(`select count(*)::int as v from pg_policies where policyname like 'retell_webhook%'`), 7);
  });
});
