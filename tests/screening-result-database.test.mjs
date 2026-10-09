import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  prepareScreening,
  screeningAnalysisContractHash,
} from "../lib/screening.ts";

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

const ownerA = "10000000-0000-0000-0000-000000000001";
const ownerB = "10000000-0000-0000-0000-000000000002";
const recruiter = "10000000-0000-0000-0000-000000000003";
const viewer = "10000000-0000-0000-0000-000000000004";
const outsider = "10000000-0000-0000-0000-000000000005";
const contractV1 = {
  provider: "openai",
  model: "screening-test-model",
  model_revision: null,
  prompt_version: "screening-v1",
  payload_schema_version: 1,
  result_schema_version: 1,
};

test("persisted screening results enforce tenant, worker, evidence and review contracts", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  for (const migration of migrations) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), "utf8"));
  }
  for (const id of [ownerA, ownerB, recruiter, viewer, outsider]) {
    await db.query("insert into auth.users values ($1)", [id]);
  }

  const asUser = async (id, role = "authenticated") => {
    await db.exec(`reset role; set role ${role}`);
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id ?? ""]);
  };
  const asWorker = async () => {
    await db.exec("reset role; set role screening_worker");
  };
  const asAdmin = async () => {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
  };
  const denied = async (sql, params = [], code = "42501") => {
    await assert.rejects(db.query(sql, params), error => error.code === code);
  };
  const insert = async (table, row) => {
    const fields = Object.keys(row);
    const result = await db.query(
      `insert into public.${table} (${fields.join(",")})
       values (${fields.map((_, index) => `$${index + 1}`).join(",")}) returning *`,
      Object.values(row),
    );
    return result.rows[0];
  };
  const seed = async (owner, label) => {
    await asUser(owner);
    const companyId = (await db.query("select public.create_company($1) as id", [`Tenant ${label}`])).rows[0].id;
    const position = await insert("positions", {
      company_id: companyId,
      title: `Data analyst ${label}`,
      tasks: ["Analiza danych"],
      kpis: ["Terminowość raportów"],
      required_competencies: ["SQL"],
      status: "active",
    });
    const recruitment = await insert("recruitments", {
      company_id: companyId,
      position_id: position.id,
      name: `Recruitment ${label}`,
      status: "open",
    });
    const candidate = await insert("candidates", {
      company_id: companyId,
      first_name: "Test",
      last_name: label,
    });
    const application = await insert("applications", {
      company_id: companyId,
      recruitment_id: recruitment.id,
      candidate_id: candidate.id,
    });
    const document = await insert("candidate_documents", {
      company_id: companyId,
      candidate_id: candidate.id,
      source_text: "Original text stays internal",
      redacted_text: "A😀B𝄞C SQL i raporty.",
    });
    assert.equal(
      (await db.query("select public.review_candidate_document($1,$2) as ok", [document.id, document.version])).rows[0].ok,
      true,
    );
    return { companyId, position, recruitment, candidate, application, documentId: document.id };
  };
  const tenantA = await seed(ownerA, "A");
  const tenantB = await seed(ownerB, "B");
  await asUser(ownerA);
  await insert("company_members", { company_id: tenantA.companyId, user_id: recruiter, role: "recruiter" });
  await insert("company_members", { company_id: tenantA.companyId, user_id: viewer, role: "viewer" });

  const loadPrepared = async fixture => {
    const application = (await db.query("select * from public.applications where id=$1", [fixture.application.id])).rows[0];
    const recruitment = (await db.query("select * from public.recruitments where id=$1", [fixture.recruitment.id])).rows[0];
    const position = (await db.query("select * from public.positions where id=$1", [fixture.position.id])).rows[0];
    const document = (await db.query(
      "select * from public.candidate_documents where company_id=$1 and candidate_id=$2 order by created_at desc,id desc limit 1",
      [fixture.companyId, fixture.candidate.id],
    )).rows[0];
    for (const row of [application, recruitment, position]) {
      row.updated_at = (await db.query(
        "select to_jsonb(updated_at)#>>'{}' as value from public." +
          (row === application ? "applications" : row === recruitment ? "recruitments" : "positions") +
          " where id=$1",
        [row.id],
      )).rows[0].value;
    }
    return prepareScreening({
      companyId: fixture.companyId,
      application,
      recruitment,
      position,
      document,
    });
  };
  const start = async (fixture, prepared, contract = contractV1, key = randomUUID(), force = false) => {
    const result = await db.query(
      `select * from public.start_screening_analysis(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
      )`,
      [
        fixture.application.id,
        prepared.fingerprint,
        contract.payload_schema_version,
        contract.result_schema_version,
        contract.prompt_version,
        contract.provider,
        contract.model,
        contract.model_revision,
        key,
        force,
      ],
    );
    return result.rows[0];
  };
  const claim = async attemptId => {
    await asWorker();
    return (await db.query(
      "select * from public.claim_screening_attempt($1)",
      [attemptId],
    )).rows[0];
  };
  const findingsFor = (prepared, supported = false) => prepared.payload.criteria.map((criterion, index) => ({
    criterion_id: criterion.id,
    rating: supported && index === 0 ? "meets" : "insufficient_data",
    evidence: supported && index === 0 ? [{ start: 1, end: 6, quote: "😀B𝄞" }] : [],
  }));
  const complete = async (attemptId, lease, prepared, contract = contractV1, findings = findingsFor(prepared, true)) => {
    await asWorker();
    return (await db.query(
      "select public.complete_screening_analysis($1,$2,$3,$4,$5::jsonb) as id",
      [
        attemptId,
        lease,
        prepared.fingerprint,
        screeningAnalysisContractHash(contract),
        JSON.stringify(findings),
      ],
    )).rows[0].id;
  };

  const preparedA = await loadPrepared(tenantA);
  const contractHash = screeningAnalysisContractHash(contractV1);
  let first;
  let firstClaim;

  await t.test("schema, RLS, grants and canonical hashes are frozen", async () => {
    await asAdmin();
    const tables = [
      "screening_analysis_versions",
      "screening_analysis_attempts",
      "screening_criterion_results",
      "screening_result_reviews",
      "screening_criterion_review_overrides",
    ];
    const schema = await db.query(`
      select c.relname, c.relrowsecurity
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname = any($1)
      order by c.relname
    `, [tables]);
    assert.deepEqual(schema.rows.map(row => row.relname), [...tables].sort());
    assert.ok(schema.rows.every(row => row.relrowsecurity));
    const columnTypes = await db.query(`
      select table_name,column_name,data_type
      from information_schema.columns
      where table_schema='public' and (
        (table_name='screening_analysis_versions' and column_name in
          ('input_fingerprint','analysis_contract_hash','criteria_snapshot',
           'binding_snapshot','overall_score','stale_at'))
        or (table_name='screening_analysis_attempts' and column_name in
          ('idempotency_key','cost_amount','cost_currency'))
        or (table_name='screening_criterion_results' and column_name in
          ('rating','evidence','confidence'))
        or (table_name='screening_result_reviews' and column_name='review_version')
        or (table_name='screening_criterion_review_overrides' and column_name='evidence_override')
      ) order by table_name,column_name
    `);
    assert.deepEqual(columnTypes.rows, [
      { table_name: "screening_analysis_attempts", column_name: "cost_amount", data_type: "numeric" },
      { table_name: "screening_analysis_attempts", column_name: "cost_currency", data_type: "character" },
      { table_name: "screening_analysis_attempts", column_name: "idempotency_key", data_type: "uuid" },
      { table_name: "screening_analysis_versions", column_name: "analysis_contract_hash", data_type: "text" },
      { table_name: "screening_analysis_versions", column_name: "binding_snapshot", data_type: "jsonb" },
      { table_name: "screening_analysis_versions", column_name: "criteria_snapshot", data_type: "jsonb" },
      { table_name: "screening_analysis_versions", column_name: "input_fingerprint", data_type: "text" },
      { table_name: "screening_analysis_versions", column_name: "overall_score", data_type: "numeric" },
      { table_name: "screening_analysis_versions", column_name: "stale_at", data_type: "timestamp with time zone" },
      { table_name: "screening_criterion_results", column_name: "confidence", data_type: "numeric" },
      { table_name: "screening_criterion_results", column_name: "evidence", data_type: "jsonb" },
      { table_name: "screening_criterion_results", column_name: "rating", data_type: "text" },
      { table_name: "screening_criterion_review_overrides", column_name: "evidence_override", data_type: "jsonb" },
      { table_name: "screening_result_reviews", column_name: "review_version", data_type: "integer" },
    ]);
    assert.equal(
      (await db.query(`
        select count(*)::int as count from information_schema.columns
        where table_schema='public' and table_name like 'screening_%'
          and column_name in ('rating_score','provider_request_body','provider_response_body')
      `)).rows[0].count,
      0,
    );
    const workerFunctions = await db.query(`
      select p.proname
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in
        ('claim_screening_attempt','complete_screening_analysis','fail_screening_attempt')
        and has_function_privilege('screening_worker',p.oid,'EXECUTE')
        and not has_function_privilege('authenticated',p.oid,'EXECUTE')
      order by p.proname
    `);
    assert.deepEqual(workerFunctions.rows.map(row => row.proname), [
      "claim_screening_attempt", "complete_screening_analysis", "fail_screening_attempt",
    ]);
    const sqlHash = (await db.query(
      "select private.screening_contract_hash($1,$2,$3,$4,$5,$6) as hash",
      [
        contractV1.provider, contractV1.model, contractV1.model_revision,
        contractV1.prompt_version, contractV1.payload_schema_version,
        contractV1.result_schema_version,
      ],
    )).rows[0].hash;
    assert.equal(sqlHash, contractHash);
    assert.equal(
      (await db.query("select private.screening_utf16_slice($1,1,6) as quote", ["A😀B𝄞C"])).rows[0].quote,
      "😀B𝄞",
    );
    assert.equal(
      (await db.query("select private.screening_utf16_slice($1,2,3) as quote", ["A😀B𝄞C"])).rows[0].quote,
      null,
    );
    const sqlFingerprint = (await db.query(
      "select private.screening_material($1,false)->>'input_fingerprint' as fingerprint",
      [tenantA.application.id],
    )).rows[0].fingerprint;
    assert.equal(sqlFingerprint, preparedA.fingerprint);
  });

  await t.test("owner/recruiter can start idempotently; viewer and outsiders are read-only", async () => {
    await asUser(ownerA);
    const key = randomUUID();
    first = await start(tenantA, preparedA, contractV1, key);
    assert.equal(first.analysis_version, 1);
    assert.equal(first.execution_status, "pending");
    assert.equal(first.reused, false);
    const duplicate = await start(tenantA, preparedA, contractV1, key);
    assert.deepEqual(
      [duplicate.analysis_id, duplicate.attempt_id, duplicate.reused],
      [first.analysis_id, first.attempt_id, true],
    );
    const secondClick = await start(tenantA, preparedA);
    assert.equal(secondClick.analysis_id, first.analysis_id);
    assert.equal(secondClick.attempt_id, first.attempt_id);
    assert.equal(
      (await db.query("select count(*)::int as count from public.screening_analysis_attempts")).rows[0].count,
      1,
    );
    await denied(
      "select * from public.start_screening_analysis($1,$2,1,1,'screening-v1','openai','screening-test-model',null,$3,false)",
      [tenantA.application.id, "0".repeat(64), randomUUID()],
      "PT409",
    );

    await asUser(recruiter);
    assert.equal(
      (await db.query("select count(*)::int as count from public.screening_analysis_versions")).rows[0].count,
      1,
    );
    await asUser(viewer);
    assert.equal(
      (await db.query("select count(*)::int as count from public.screening_analysis_versions")).rows[0].count,
      1,
    );
    await denied(
      "select * from public.start_screening_analysis($1,$2,1,1,'screening-v1','openai','screening-test-model',null,$3,false)",
      [tenantA.application.id, preparedA.fingerprint, randomUUID()],
    );
    await asUser(outsider);
    assert.equal(
      (await db.query("select count(*)::int as count from public.screening_analysis_versions")).rows[0].count,
      0,
    );
    await asUser(null, "anon");
    await denied("select * from public.screening_analysis_versions");
    await asUser(ownerB);
    await denied(
      "select * from public.start_screening_analysis($1,$2,1,1,'screening-v1','openai','screening-test-model',null,$3,false)",
      [tenantA.application.id, preparedA.fingerprint, randomUUID()],
    );
    await asUser(ownerA);
    for (const table of [
      "screening_analysis_versions", "screening_analysis_attempts",
      "screening_criterion_results", "screening_result_reviews",
      "screening_criterion_review_overrides",
    ]) {
      await denied(`delete from public.${table}`);
    }
    await denied(
      "update public.screening_analysis_versions set execution_status='cancelled' where id=$1",
      [first.analysis_id],
    );
    await denied(
      "insert into public.screening_result_reviews(company_id,analysis_id,review_version,reviewer_id,disposition) values($1,$2,1,$3,'approved')",
      [tenantA.companyId, first.analysis_id, ownerA],
    );
    await denied("select * from public.claim_screening_attempt($1)", [first.attempt_id]);
  });

  await t.test("worker lease protects exact and immutable AI completion", async () => {
    firstClaim = await claim(first.attempt_id);
    assert.equal(firstClaim.analysis_id, first.analysis_id);
    assert.equal(firstClaim.lease_token.length, 64);
    assert.equal(firstClaim.input_fingerprint, preparedA.fingerprint);
    assert.equal(firstClaim.analysis_contract_hash, contractHash);
    assert.equal(firstClaim.payload_schema_version, 1);
    assert.equal(firstClaim.prompt_version, contractV1.prompt_version);
    assert.ok(Array.isArray(firstClaim.criteria_snapshot));
    assert.equal(firstClaim.input_cv_text_snapshot, preparedA.payload.cv_text);
    for (const forbidden of [
      "company_id", "candidate_id", "application_id", "recruitment_id",
      "position_id", "document_id", "binding_snapshot", "source_text",
    ]) {
      assert.equal(firstClaim[forbidden], undefined);
    }
    await assert.rejects(
      db.query("select * from public.claim_screening_attempt($1)", [first.attempt_id]),
      error => error.code === "55000",
    );
    await denied(
      "select public.complete_screening_analysis($1,$2,$3,$4,$5::jsonb)",
      [
        first.attempt_id, "x".repeat(64), preparedA.fingerprint, contractHash,
        JSON.stringify(findingsFor(preparedA, true)),
      ],
    );
    await assert.rejects(
      complete(first.attempt_id, firstClaim.lease_token, preparedA, contractV1, []),
      error => error.code === "22023",
    );
    const duplicateCriteria = findingsFor(preparedA, false);
    duplicateCriteria[1] = { ...duplicateCriteria[0] };
    await assert.rejects(
      complete(first.attempt_id, firstClaim.lease_token, preparedA, contractV1, duplicateCriteria),
      error => error.code === "22023",
    );
    const missingEvidence = findingsFor(preparedA, false);
    missingEvidence[0] = { ...missingEvidence[0], rating: "meets" };
    await assert.rejects(
      complete(first.attempt_id, firstClaim.lease_token, preparedA, contractV1, missingEvidence),
      error => error.code === "22023",
    );
    const wrongQuote = findingsFor(preparedA, true);
    wrongQuote[0].evidence[0].quote = "wrong";
    await assert.rejects(
      complete(first.attempt_id, firstClaim.lease_token, preparedA, contractV1, wrongQuote),
      error => error.code === "22023",
    );
    await asAdmin();
    assert.equal(
      (await db.query("select count(*)::int as count from public.screening_criterion_results")).rows[0].count,
      0,
    );
    const analysisId = await complete(first.attempt_id, firstClaim.lease_token, preparedA);
    assert.equal(analysisId, first.analysis_id);
    assert.equal(await complete(first.attempt_id, firstClaim.lease_token, preparedA), first.analysis_id);
    await assert.rejects(
      complete(
        first.attempt_id,
        firstClaim.lease_token,
        preparedA,
        contractV1,
        findingsFor(preparedA, false),
      ),
      error => error.code === "PT409",
    );
    await asAdmin();
    const result = (await db.query(
      "select execution_status,stale_at,overall_score from public.screening_analysis_versions where id=$1",
      [first.analysis_id],
    )).rows[0];
    assert.deepEqual(result, { execution_status: "completed", stale_at: null, overall_score: null });
    assert.equal(
      (await db.query("select count(*)::int as count from public.screening_criterion_results where analysis_id=$1", [first.analysis_id])).rows[0].count,
      preparedA.payload.criteria.length,
    );
    await asUser(ownerA);
    await denied(
      "update public.screening_criterion_results set rating='below' where analysis_id=$1",
      [first.analysis_id],
    );
  });

  await t.test("human review is versioned and never overwrites AI rows", async () => {
    await asUser(ownerA);
    const criterion = (await db.query(
      "select * from public.screening_criterion_results where analysis_id=$1 order by criterion_order limit 1",
      [first.analysis_id],
    )).rows[0];
    const original = structuredClone(criterion);
    const overrides = [{
      criterion_result_id: criterion.id,
      rating_override: "above",
      evidence_override: [{ start: 1, end: 6, quote: "😀B𝄞" }],
      explanation_override: "Zweryfikowano cytat.",
    }];
    const reviewId = (await db.query(
      "select public.review_screening_result($1,0,'approved_with_changes',$2,$3::jsonb) as id",
      [first.analysis_id, "Human review", JSON.stringify(overrides)],
    )).rows[0].id;
    assert.ok(reviewId);
    await denied(
      "select public.review_screening_result($1,0,'approved',null,'[]'::jsonb)",
      [first.analysis_id],
      "PT409",
    );
    const unchanged = (await db.query(
      "select * from public.screening_criterion_results where id=$1",
      [criterion.id],
    )).rows[0];
    assert.deepEqual(unchanged, original);
    assert.equal(
      (await db.query("select count(*)::int as count from public.screening_criterion_review_overrides where review_id=$1", [reviewId])).rows[0].count,
      1,
    );
    await asUser(viewer);
    await denied(
      "select public.review_screening_result($1,1,'approved',null,'[]'::jsonb)",
      [first.analysis_id],
    );
    await asUser(ownerA);
    await db.query(
      "select public.review_screening_result($1,1,'needs_reanalysis',null,'[]'::jsonb)",
      [first.analysis_id],
    );
  });

  let second;
  let changedContractAnalysis;
  await t.test("reuse requires fingerprint and contract hash; versions are monotonic", async () => {
    await asUser(ownerA);
    second = await start(tenantA, preparedA);
    assert.equal(second.analysis_version, 2);
    assert.notEqual(second.analysis_id, first.analysis_id);
    const forced = await start(tenantA, preparedA, contractV1, randomUUID(), true);
    assert.equal(forced.analysis_id, second.analysis_id);
    assert.equal(forced.analysis_version, 2);
  });

  await t.test("failed attempt retries within the logical analysis", async () => {
    const active = await claim(second.attempt_id);
    await asWorker();
    const failed = (await db.query(
      "select public.fail_screening_attempt($1,$2,$3,$4,'provider_timeout','Timed out') as id",
      [second.attempt_id, active.lease_token, preparedA.fingerprint, contractHash],
    )).rows[0].id;
    assert.equal(failed, second.analysis_id);
    assert.equal(
      (await db.query(
        "select public.fail_screening_attempt($1,$2,$3,$4,'provider_timeout','Timed out') as id",
        [second.attempt_id, active.lease_token, preparedA.fingerprint, contractHash],
      )).rows[0].id,
      second.analysis_id,
    );
    await asUser(recruiter);
    const retry = (await db.query(
      "select * from public.retry_screening_analysis($1,$2)",
      [second.analysis_id, randomUUID()],
    )).rows[0];
    assert.equal(retry.analysis_id, second.analysis_id);
    assert.notEqual(retry.attempt_id, second.attempt_id);
    await asAdmin();
    assert.deepEqual(
      (await db.query(
        "select attempt_no,status from public.screening_analysis_attempts where analysis_id=$1 order by attempt_no",
        [second.analysis_id],
      )).rows,
      [{ attempt_no: 1, status: "failed" }, { attempt_no: 2, status: "pending" }],
    );
    await assert.rejects(
      db.query(
        "insert into public.screening_analysis_attempts(company_id,analysis_id,attempt_no,idempotency_key) values($1,$2,3,$3)",
        [tenantA.companyId, second.analysis_id, randomUUID()],
      ),
      error => error.code === "23505",
    );
  });

  await t.test("completion after input change is retained as completed plus stale", async () => {
    await asUser(ownerA);
    const contractV2 = { ...contractV1, prompt_version: "screening-v2" };
    changedContractAnalysis = await start(tenantA, preparedA, contractV2);
    assert.equal(changedContractAnalysis.analysis_version, 3);
    assert.notEqual(screeningAnalysisContractHash(contractV2), contractHash);

    const active = await claim(changedContractAnalysis.attempt_id);
    await asUser(ownerA);
    await db.query(
      "update public.positions set title=$1 where id=$2",
      ["Updated analyst", tenantA.position.id],
    );
    await complete(
      changedContractAnalysis.attempt_id,
      active.lease_token,
      preparedA,
      contractV2,
    );
    await asAdmin();
    const completed = (await db.query(
      "select execution_status,stale_reason,overall_score from public.screening_analysis_versions where id=$1",
      [changedContractAnalysis.analysis_id],
    )).rows[0];
    assert.deepEqual(completed, {
      execution_status: "completed",
      stale_reason: "input_changed_during_processing",
      overall_score: null,
    });
    await asUser(ownerA);
    await denied(
      "select public.review_screening_result($1,0,'approved',null,'[]'::jsonb)",
      [changedContractAnalysis.analysis_id],
      "55000",
    );
    assert.ok((await db.query(
      "select public.review_screening_result($1,0,'needs_reanalysis',null,'[]'::jsonb) as id",
      [changedContractAnalysis.analysis_id],
    )).rows[0].id);
  });

  await t.test("tenant-safe foreign keys reject cross-tenant bindings", async () => {
    await asAdmin();
    const analysis = (await db.query(
      "select * from public.screening_analysis_versions where id=$1",
      [first.analysis_id],
    )).rows[0];
    await assert.rejects(
      db.query(
        `insert into public.screening_analysis_versions(
          company_id,recruitment_id,application_id,position_id,candidate_document_id,
          candidate_document_version,analysis_version,input_fingerprint,analysis_contract_hash,
          payload_schema_version,result_schema_version,prompt_version,provider,model,
          input_cv_text_snapshot,criteria_snapshot,binding_snapshot,created_by
        ) values($1,$2,$3,$4,$5,1,99,$6,$7,1,1,'x','x','x','x','[]','{}',$8)`,
        [
          tenantA.companyId, tenantB.recruitment.id, tenantA.application.id,
          tenantA.position.id, tenantA.documentId, "f".repeat(64),
          analysis.analysis_contract_hash, ownerA,
        ],
      ),
      error => error.code === "23503",
    );
  });
});
