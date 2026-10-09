import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { parse } from "pg-connection-string";

// Real PostgreSQL connections. PGlite cannot show transaction races across sessions.
const maintenanceUrl = process.env.SCREENING_TEST_DATABASE_URL;
const databaseName = `screening_sc007_${process.pid}`;
const migrations = [
  "20260930000100_skillcheck_core.sql",
  "20261001000100_idempotent_onboarding.sql",
  "20261001000200_candidate_documents.sql",
  "20261002000100_behavior_assessments.sql",
  "20261002000200_behavior_conflict_response.sql",
  "20261002000300_exercise_definitions.sql",
  "20261004000100_exercise_observations.sql",
  "20261004000200_screening_results.sql",
  "20261005000100_screening_worker_claim_payload.sql",
  "20261007000100_screening_retry_active_conflict.sql",
  "20261009080000_screening_latest_mutations.sql",
];
const contract = {
  provider: "openai",
  model: "screening-test-model",
  modelRevision: null,
  promptVersion: "screening-v1",
  payloadSchemaVersion: 1,
  resultSchemaVersion: 1,
};
const rawRaceCodes = new Set(["23505", "40P01", "40001"]);

function clientConfig(name) {
  // Explicit database wins. Passing connectionString to Client lets the URL
  // database override a sibling database field.
  const config = parse(maintenanceUrl);
  config.database = name;
  if (!config.password) delete config.password;
  return config;
}

function assertNoRawRace(outcome, label) {
  if (!outcome.ok && rawRaceCodes.has(outcome.code)) {
    assert.fail(`${label} exposed ${outcome.code}: ${outcome.message}`);
  }
}

async function settle(promise) {
  try {
    const result = await promise;
    return { ok: true, rows: result.rows, row: result.rows[0] ?? null };
  } catch (error) {
    return { ok: false, code: error.code ?? "", message: error.message };
  }
}

test("screening RPC races on PostgreSQL", async (t) => {
  assert.ok(
    maintenanceUrl,
    "SCREENING_TEST_DATABASE_URL is required for the PostgreSQL concurrency suite",
  );
  const maintenance = new Client(clientConfig("postgres"));
  await maintenance.connect();
  await maintenance.query(`drop database if exists ${databaseName}`);
  await maintenance.query(`create database ${databaseName}`);
  await maintenance.end();

  const admin = new Client(clientConfig(databaseName));
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.end().catch(() => {})));
    await admin.end().catch(() => {});
    const cleanup = new Client(clientConfig("postgres"));
    await cleanup.connect();
    await cleanup.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
      [databaseName],
    );
    await cleanup.query(`drop database if exists ${databaseName}`);
    await cleanup.query("drop role if exists screening_worker");
    await cleanup.query("drop role if exists authenticated");
    await cleanup.query("drop role if exists anon");
    await cleanup.end();
  });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as name")).rows[0].name, databaseName);
  await admin.query(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then
        create role anon nologin;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then
        create role authenticated nologin;
      end if;
    end $$;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  for (const migration of migrations) {
    await admin.query(await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), "utf8"));
  }
  const contractHash = (await admin.query(
    "select private.screening_contract_hash($1,$2,$3,$4,$5,$6) as hash",
    [
      contract.provider,
      contract.model,
      contract.modelRevision,
      contract.promptVersion,
      contract.payloadSchemaVersion,
      contract.resultSchemaVersion,
    ],
  )).rows[0].hash;

  const connectAs = async (role, userId) => {
    const client = new Client(clientConfig(databaseName));
    clients.push(client);
    await client.connect();
    await client.query(`set role ${role}`);
    await client.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? ""]);
    await client.query("set statement_timeout = '15s'");
    await client.query("set lock_timeout = '5s'");
    return client;
  };
  const insert = async (client, table, row) => {
    const fields = Object.keys(row);
    const result = await client.query(
      `insert into public.${table} (${fields.join(",")})
       values (${fields.map((_, index) => `$${index + 1}`).join(",")}) returning *`,
      Object.values(row),
    );
    return result.rows[0];
  };
  const seed = async (label) => {
    const owner = randomUUID();
    await admin.query("insert into auth.users(id) values ($1)", [owner]);
    const user = await connectAs("authenticated", owner);
    const companyId = (await user.query("select public.create_company($1) as id", [`Tenant ${label}`])).rows[0].id;
    const position = await insert(user, "positions", {
      company_id: companyId,
      title: `Data analyst ${label}`,
      tasks: ["Analiza danych"],
      kpis: ["Terminowość raportów"],
      required_competencies: ["SQL"],
      status: "active",
    });
    const recruitment = await insert(user, "recruitments", {
      company_id: companyId,
      position_id: position.id,
      name: `Recruitment ${label}`,
      status: "open",
    });
    const candidate = await insert(user, "candidates", {
      company_id: companyId,
      first_name: "Test",
      last_name: label,
    });
    const application = await insert(user, "applications", {
      company_id: companyId,
      recruitment_id: recruitment.id,
      candidate_id: candidate.id,
    });
    const document = await insert(user, "candidate_documents", {
      company_id: companyId,
      candidate_id: candidate.id,
      source_text: "Original text stays internal",
      redacted_text: "A😀B𝄞C SQL i raporty.",
    });
    assert.equal(
      (await user.query("select public.review_candidate_document($1,$2) as ok", [document.id, document.version])).rows[0].ok,
      true,
    );
    const fingerprint = (await admin.query(
      "select private.screening_material($1, false)->>'input_fingerprint' as fingerprint",
      [application.id],
    )).rows[0].fingerprint;
    return { owner, user, companyId, position, application, document, fingerprint };
  };
  const startArgs = (fixture, key, force) => [
    fixture.application.id,
    fixture.fingerprint,
    contract.payloadSchemaVersion,
    contract.resultSchemaVersion,
    contract.promptVersion,
    contract.provider,
    contract.model,
    contract.modelRevision,
    key,
    force,
  ];
  const startSql = `select * from public.start_screening_analysis($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`;
  const activeState = async (applicationId) => (await admin.query(`
    select
      (select count(*)::int from public.screening_analysis_versions
        where application_id = $1 and execution_status in ('pending', 'processing')) as active_analyses,
      (select count(*)::int from public.screening_analysis_attempts attempt
        join public.screening_analysis_versions analysis on analysis.id = attempt.analysis_id
          and analysis.company_id = attempt.company_id
        where analysis.application_id = $1 and attempt.status in ('pending', 'processing')) as active_attempts,
      (select count(*)::int from public.screening_analysis_versions
        where application_id = $1 and execution_status = 'completed' and stale_at is null) as current_completed
  `, [applicationId])).rows[0];
  const failCurrent = async (fixture) => {
    const started = (await fixture.user.query(startSql, startArgs(fixture, randomUUID(), false))).rows[0];
    const worker = await connectAs("screening_worker");
    const claim = (await worker.query(
      "select * from public.claim_screening_attempt($1)",
      [started.attempt_id],
    )).rows[0];
    await worker.query(
      "select public.fail_screening_attempt($1,$2,$3,$4,'provider_timeout','Timed out')",
      [started.attempt_id, claim.lease_token, fixture.fingerprint, contractHash],
    );
    return started;
  };
  const findingsFor = (criteria) => criteria.map(criterion => ({
    criterion_id: criterion.id,
    rating: "insufficient_data",
    evidence: [],
  }));

  await t.test("preserves authenticated retry and worker-only finalization grants", async () => {
    const privileges = await admin.query(`
      select p.proname,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
        has_function_privilege('screening_worker', p.oid, 'EXECUTE') as worker
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in (
        'start_screening_analysis', 'retry_screening_analysis', 'review_screening_result',
        'claim_screening_attempt', 'complete_screening_analysis', 'fail_screening_attempt'
      )
      order by p.proname
    `);
    assert.deepEqual(privileges.rows, [
      { proname: "claim_screening_attempt", authenticated: false, worker: true },
      { proname: "complete_screening_analysis", authenticated: false, worker: true },
      { proname: "fail_screening_attempt", authenticated: false, worker: true },
      { proname: "retry_screening_analysis", authenticated: true, worker: false },
      { proname: "review_screening_result", authenticated: true, worker: false },
      { proname: "start_screening_analysis", authenticated: true, worker: false },
    ]);
  });

  await t.test("concurrent starts with different idempotency keys converge", async () => {
    const fixture = await seed("concurrent-start");
    const leftClient = await connectAs("authenticated", fixture.owner);
    const rightClient = await connectAs("authenticated", fixture.owner);
    const [left, right] = await Promise.all([
      settle(leftClient.query(startSql, startArgs(fixture, randomUUID(), false))),
      settle(rightClient.query(startSql, startArgs(fixture, randomUUID(), false))),
    ]);
    assertNoRawRace(left, "start A");
    assertNoRawRace(right, "start B");
    assert.equal(left.ok, true, left.message);
    assert.equal(right.ok, true, right.message);
    assert.equal(left.row.analysis_id, right.row.analysis_id);
    assert.equal(left.row.attempt_id, right.row.attempt_id);
    assert.deepEqual([left.row.reused, right.row.reused].sort(), [false, true]);
    const state = await activeState(fixture.application.id);
    assert.deepEqual(
      [state.active_analyses, state.active_attempts],
      [1, 1],
    );
    assert.equal(
      (await admin.query(
        "select count(*)::int as count from public.screening_analysis_versions where application_id = $1",
        [fixture.application.id],
      )).rows[0].count,
      1,
    );
  });

  await t.test("concurrent forced starts still leave one active analysis", async () => {
    const fixture = await seed("forced-start");
    const leftClient = await connectAs("authenticated", fixture.owner);
    const rightClient = await connectAs("authenticated", fixture.owner);
    const [left, right] = await Promise.all([
      settle(leftClient.query(startSql, startArgs(fixture, randomUUID(), true))),
      settle(rightClient.query(startSql, startArgs(fixture, randomUUID(), true))),
    ]);
    assertNoRawRace(left, "forced start A");
    assertNoRawRace(right, "forced start B");
    assert.equal(left.ok, true, left.message);
    assert.equal(right.ok, true, right.message);
    assert.equal(left.row.analysis_id, right.row.analysis_id);
    assert.equal(left.row.attempt_id, right.row.attempt_id);
    const state = await activeState(fixture.application.id);
    assert.deepEqual([state.active_analyses, state.active_attempts], [1, 1]);
  });

  await t.test("concurrent retries of one failed analysis keep a single active attempt", async () => {
    const fixture = await seed("concurrent-retry");
    const failed = await failCurrent(fixture);
    const leftClient = await connectAs("authenticated", fixture.owner);
    const rightClient = await connectAs("authenticated", fixture.owner);
    const [left, right] = await Promise.all([
      settle(leftClient.query(
        "select * from public.retry_screening_analysis($1,$2)",
        [failed.analysis_id, randomUUID()],
      )),
      settle(rightClient.query(
        "select * from public.retry_screening_analysis($1,$2)",
        [failed.analysis_id, randomUUID()],
      )),
    ]);
    for (const outcome of [left, right]) assertNoRawRace(outcome, "retry");
    const successes = [left, right].filter(outcome => outcome.ok);
    const failures = [left, right].filter(outcome => !outcome.ok);
    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].code, "55000");
    assert.equal(successes[0].row.analysis_id, failed.analysis_id);
    const state = await activeState(fixture.application.id);
    assert.deepEqual([state.active_analyses, state.active_attempts], [1, 1]);
    assert.deepEqual(
      (await admin.query(
        `select attempt_no, status from public.screening_analysis_attempts
         where analysis_id = $1 order by attempt_no`,
        [failed.analysis_id],
      )).rows,
      [
        { attempt_no: 1, status: "failed" },
        { attempt_no: 2, status: "pending" },
      ],
    );
  });

  const waitForLock = async client => {
    const pid = client.processID;
    for (let i=0;i<250;i++) {
      if ((await admin.query("select wait_event_type from pg_stat_activity where pid=$1",[pid])).rows[0]?.wait_event_type === 'Lock') return;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.fail('RPC did not wait on transaction lock');
  };
  const finish = async (fixture, started, worker) => {
    const claim=(await worker.query("select * from public.claim_screening_attempt($1)",[started.attempt_id])).rows[0];
    await worker.query("select public.complete_screening_analysis($1,$2,$3,$4,$5::jsonb)",[
      started.attempt_id,claim.lease_token,claim.input_fingerprint,claim.analysis_contract_hash,JSON.stringify(findingsFor(claim.criteria_snapshot))
    ]);
  };

  await t.test("start wins application lock; retry returns its active peer after commit", async () => {
    const fixture=await seed('ordered-start-retry'), failed=await failCurrent(fixture);
    const starter=await connectAs('authenticated',fixture.owner), retry=await connectAs('authenticated',fixture.owner);
    await starter.query('begin');
    const started=(await starter.query(startSql,startArgs(fixture,randomUUID(),false))).rows[0];
    const pending=settle(retry.query("select * from public.retry_screening_analysis($1,$2)",[failed.analysis_id,randomUUID()]));
    await waitForLock(retry);
    await starter.query('commit');
    const outcome=await pending;
    assert.equal(outcome.ok,true,outcome.message);
    assert.equal(outcome.row.analysis_id,started.analysis_id);
    assert.equal((await activeState(fixture.application.id)).active_analyses,1);
  });

  await t.test("review waits for concurrent reanalysis and rejects the superseded result", async()=>{
    const fixture=await seed('review-start');
    const original=(await fixture.user.query(startSql,startArgs(fixture,randomUUID(),false))).rows[0];
    const worker=await connectAs('screening_worker');await finish(fixture,original,worker);
    await fixture.user.query("select public.review_screening_result($1,0,'needs_reanalysis',null,'[]')",[original.analysis_id]);
    const starter=await connectAs('authenticated',fixture.owner), reviewer=await connectAs('authenticated',fixture.owner);
    await starter.query('begin');
    const newer=(await starter.query(startSql,startArgs(fixture,randomUUID(),false))).rows[0];
    assert.notEqual(newer.analysis_id,original.analysis_id);
    const pending=settle(reviewer.query("select public.review_screening_result($1,1,'approved',null,'[]')",[original.analysis_id]));
    await waitForLock(reviewer);await starter.query('commit');
    const outcome=await pending;assert.equal(outcome.code,'PT409');
    assert.equal((await admin.query("select disposition from public.screening_result_reviews where analysis_id=$1 order by review_version desc limit 1",[original.analysis_id])).rows[0].disposition,'needs_reanalysis');
  });

  await t.test("historical retry waits for start plus completion and cannot stale the newer result", async()=>{
    const fixture=await seed('retry-completed'), failed=await failCurrent(fixture);
    const starter=new Client(clientConfig(databaseName));clients.push(starter);await starter.connect();
    await starter.query("select set_config('request.jwt.claim.sub',$1,false)",[fixture.owner]);
    const retry=await connectAs('authenticated',fixture.owner);
    await starter.query('begin');
    const newer=(await starter.query(startSql,startArgs(fixture,randomUUID(),false))).rows[0];
    await starter.query('set local role screening_worker');
    await finish(fixture,newer,starter);
    const pending=settle(retry.query("select * from public.retry_screening_analysis($1,$2)",[failed.analysis_id,randomUUID()]));
    await waitForLock(retry);await starter.query('commit');
    const outcome=await pending;assert.equal(outcome.code,'PT409');
    const rows=(await admin.query("select execution_status,stale_at from public.screening_analysis_versions where id=$1",[newer.analysis_id])).rows;
    assert.deepEqual(rows,[{execution_status:'completed',stale_at:null}]);
  });

  await t.test("unsynchronized start and retry races stay unique and singular", async () => {
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const fixture = await seed(`burst-${attempt}`);
      const failed = await failCurrent(fixture);
      const startClient = await connectAs("authenticated", fixture.owner);
      const retryClient = await connectAs("authenticated", fixture.owner);
      const [started, retried] = await Promise.all([
        settle(startClient.query(startSql, startArgs(fixture, randomUUID(), false))),
        settle(retryClient.query(
          "select * from public.retry_screening_analysis($1,$2)",
          [failed.analysis_id, randomUUID()],
        )),
      ]);
      assertNoRawRace(started, `burst start ${attempt}`);
      assertNoRawRace(retried, `burst retry ${attempt}`);
      assert.equal(started.ok, true, started.message);
      if (!retried.ok) assert.ok(["55000", "PT409"].includes(retried.code), retried.message);
      const state = await activeState(fixture.application.id);
      assert.deepEqual(
        [state.active_analyses, state.active_attempts],
        [1, 1],
        `burst ${attempt} left duplicate active rows`,
      );
    }
  });

  await t.test("two claims of one attempt leave a single lease holder", async () => {
    const fixture = await seed("claim");
    const started = (await fixture.user.query(startSql, startArgs(fixture, randomUUID(), false))).rows[0];
    const leftWorker = await connectAs("screening_worker");
    const rightWorker = await connectAs("screening_worker");
    const [left, right] = await Promise.all([
      settle(leftWorker.query("select * from public.claim_screening_attempt($1)", [started.attempt_id])),
      settle(rightWorker.query("select * from public.claim_screening_attempt($1)", [started.attempt_id])),
    ]);
    for (const outcome of [left, right]) assertNoRawRace(outcome, "claim");
    const successes = [left, right].filter(outcome => outcome.ok);
    const failures = [left, right].filter(outcome => !outcome.ok);
    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].code, "55000");
    assert.equal(successes[0].row.attempt_id, started.attempt_id);
    const stored = (await admin.query(
      `select status, lease_token_hash, private.screening_hash($2) = lease_token_hash as matches
       from public.screening_analysis_attempts where id = $1`,
      [started.attempt_id, successes[0].row.lease_token],
    )).rows[0];
    assert.equal(stored.status, "processing");
    assert.equal(stored.matches, true);
    const state = await activeState(fixture.application.id);
    assert.deepEqual([state.active_analyses, state.active_attempts], [1, 1]);
  });

  await t.test("a replaced expired lease cannot complete or fail", async () => {
    const fixture = await seed("expired-lease");
    const started = (await fixture.user.query(startSql, startArgs(fixture, randomUUID(), false))).rows[0];
    const firstWorker = await connectAs("screening_worker");
    const firstClaim = (await firstWorker.query(
      "select * from public.claim_screening_attempt($1)",
      [started.attempt_id],
    )).rows[0];
    await admin.query(
      "update public.screening_analysis_attempts set lease_expires_at = clock_timestamp() - interval '1 minute' where id = $1",
      [started.attempt_id],
    );
    const secondWorker = await connectAs("screening_worker");
    const secondClaim = (await secondWorker.query(
      "select * from public.claim_screening_attempt($1)",
      [started.attempt_id],
    )).rows[0];
    assert.notEqual(secondClaim.lease_token, firstClaim.lease_token);
    const findings = JSON.stringify(findingsFor(secondClaim.criteria_snapshot));
    const staleComplete = await settle(firstWorker.query(
      "select public.complete_screening_analysis($1,$2,$3,$4,$5::jsonb) as id",
      [started.attempt_id, firstClaim.lease_token, fixture.fingerprint, contractHash, findings],
    ));
    const staleFail = await settle(firstWorker.query(
      "select public.fail_screening_attempt($1,$2,$3,$4,'provider_timeout','late') as id",
      [started.attempt_id, firstClaim.lease_token, fixture.fingerprint, contractHash],
    ));
    assert.equal(staleComplete.ok, false);
    assert.equal(staleComplete.code, "42501");
    assert.equal(staleFail.ok, false);
    assert.equal(staleFail.code, "42501");
    const beforeReplacementFinalizes = (await admin.query(
      `select analysis.execution_status, attempt.status as attempt_status,
         private.screening_hash($2) = attempt.lease_token_hash as current_lease
       from public.screening_analysis_versions analysis
       join public.screening_analysis_attempts attempt on attempt.analysis_id = analysis.id
       where attempt.id = $1`,
      [started.attempt_id, secondClaim.lease_token],
    )).rows[0];
    assert.deepEqual(
      [beforeReplacementFinalizes.execution_status, beforeReplacementFinalizes.attempt_status, beforeReplacementFinalizes.current_lease],
      ["processing", "processing", true],
    );
    const completed = await secondWorker.query(
      "select public.complete_screening_analysis($1,$2,$3,$4,$5::jsonb) as id",
      [started.attempt_id, secondClaim.lease_token, fixture.fingerprint, contractHash, findings],
    );
    assert.equal(completed.rows[0].id, started.analysis_id);
    assert.equal(
      (await admin.query(
        "select execution_status, stale_at is null as current from public.screening_analysis_versions where id = $1",
        [started.analysis_id],
      )).rows[0].execution_status,
      "completed",
    );
  });

  await t.test("complete and fail on one attempt leave a single terminal result", async () => {
    const fixture = await seed("complete-versus-fail");
    const started = (await fixture.user.query(startSql, startArgs(fixture, randomUUID(), false))).rows[0];
    const claimWorker = await connectAs("screening_worker");
    const claim = (await claimWorker.query(
      "select * from public.claim_screening_attempt($1)",
      [started.attempt_id],
    )).rows[0];
    const findings = JSON.stringify(findingsFor(claim.criteria_snapshot));
    const completeWorker = await connectAs("screening_worker");
    const failWorker = await connectAs("screening_worker");
    const [completed, failed] = await Promise.all([
      settle(completeWorker.query(
        "select public.complete_screening_analysis($1,$2,$3,$4,$5::jsonb) as id",
        [started.attempt_id, claim.lease_token, fixture.fingerprint, contractHash, findings],
      )),
      settle(failWorker.query(
        "select public.fail_screening_attempt($1,$2,$3,$4,'provider_timeout','race') as id",
        [started.attempt_id, claim.lease_token, fixture.fingerprint, contractHash],
      )),
    ]);
    assertNoRawRace(completed, "complete");
    assertNoRawRace(failed, "fail");
    const successes = [completed, failed].filter(outcome => outcome.ok);
    const failures = [completed, failed].filter(outcome => !outcome.ok);
    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    assert.ok(["42501", "PT409"].includes(failures[0].code), failures[0].message);
    const stored = (await admin.query(
      `select analysis.execution_status, attempt.status as attempt_status,
         (select count(*)::int from public.screening_criterion_results criterion
           where criterion.analysis_id = analysis.id) as criteria,
         attempt.finalization_hash is not null as finalized
       from public.screening_analysis_versions analysis
       join public.screening_analysis_attempts attempt on attempt.id = $1
       where analysis.id = $2`,
      [started.attempt_id, started.analysis_id],
    )).rows[0];
    assert.equal(stored.finalized, true);
    assert.equal(stored.execution_status, stored.attempt_status);
    if (completed.ok) {
      assert.equal(stored.execution_status, "completed");
      assert.equal(stored.criteria, claim.criteria_snapshot.length);
    } else {
      assert.equal(stored.execution_status, "failed");
      assert.equal(stored.criteria, 0);
    }
    const state = await activeState(fixture.application.id);
    assert.deepEqual([state.active_analyses, state.active_attempts], [0, 0]);
  });

  await t.test("input changes during processing stay completed, stale, and unapprovable", async () => {
    const changes = [
      {
        label: "position",
        apply: async (fixture) => {
          await fixture.user.query(
            "update public.positions set title = $1 where id = $2",
            ["Updated analyst", fixture.position.id],
          );
        },
      },
      {
        label: "document",
        apply: async (fixture) => {
          await fixture.user.query(
            "update public.candidate_documents set redacted_text = $1 where id = $2",
            ["A😀B𝄞C SQL i raporty. Updated.", fixture.document.id],
          );
        },
      },
    ];
    for (const change of changes) {
      const fixture = await seed(`stale-${change.label}`);
      const started = (await fixture.user.query(startSql, startArgs(fixture, randomUUID(), false))).rows[0];
      const worker = await connectAs("screening_worker");
      const claim = (await worker.query(
        "select * from public.claim_screening_attempt($1)",
        [started.attempt_id],
      )).rows[0];
      await change.apply(fixture);
      const completedId = (await worker.query(
        "select public.complete_screening_analysis($1,$2,$3,$4,$5::jsonb) as id",
        [
          started.attempt_id,
          claim.lease_token,
          claim.input_fingerprint,
          claim.analysis_contract_hash,
          JSON.stringify(findingsFor(claim.criteria_snapshot)),
        ],
      )).rows[0].id;
      assert.equal(completedId, started.analysis_id);
      const stored = (await admin.query(
        `select execution_status, stale_reason, stale_at is not null as stale, overall_score
         from public.screening_analysis_versions where id = $1`,
        [started.analysis_id],
      )).rows[0];
      assert.deepEqual(stored, {
        execution_status: "completed",
        stale_reason: "input_changed_during_processing",
        stale: true,
        overall_score: null,
      });
      const state = await activeState(fixture.application.id);
      assert.equal(state.current_completed, 0);
      const review = await settle(fixture.user.query(
        "select public.review_screening_result($1,0,'approved',null,'[]'::jsonb)",
        [started.analysis_id],
      ));
      assert.equal(review.ok, false);
      assert.equal(review.code, "55000");
      assert.equal(
        (await admin.query(
          "select execution_status, stale_at is not null as stale from public.screening_analysis_versions where id = $1",
          [started.analysis_id],
        )).rows[0].stale,
        true,
      );
    }
  });
});
