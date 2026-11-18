import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { prepareScreening } from "../lib/screening.ts";

// R2-B1 (docs/checks/r2-preview-walk-2026-11-18.md): a stage move, a recruiter decision or a
// recruitment rename is not a CV-analysis input and must not make the analysis stale — neither
// through stale_at nor through the updated_at binding (fingerprint / screening_stale_reason).
// A real input change (application status, recruitment status, requirements, CV) still does.
const chain = [
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
  "20261030160000_sc_step4_interview_decision.sql",
];
const migration = new URL("../supabase/migrations/20261118120000_r2_screening_stale_input_columns.sql", import.meta.url);
const rollback = new URL("../supabase/rollbacks/20261118120000_r2_screening_stale_input_columns_down.sql", import.meta.url);
const owner = "20000000-0000-0000-0000-000000000001";
const contract = {
  provider: "openai", model: "screening-test-model", model_revision: null,
  prompt_version: "screening-v1", payload_schema_version: 1, result_schema_version: 1,
};

test("R2-B1: only CV-analysis inputs mark the screening analysis stale", async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  for (const name of chain) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8"));
  }
  const triggersSql = `select string_agg(pg_get_triggerdef(oid, true), E'\\n' order by tgrelid::regclass::text, tgname) as defs
    from pg_trigger where tgrelid in ('public.applications'::regclass, 'public.recruitments'::regclass) and not tgisinternal`;
  const triggersBefore = (await db.query(triggersSql)).rows[0].defs;
  await db.exec(await readFile(migration, "utf8"));
  await db.query("insert into auth.users values ($1)", [owner]);

  const asOwner = async () => {
    await db.exec("reset role; set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [owner]);
  };
  const asAdmin = async () => {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
  };
  const insert = async (table, row) => {
    const fields = Object.keys(row);
    return (await db.query(
      `insert into public.${table} (${fields.join(",")}) values (${fields.map((_, i) => `$${i + 1}`).join(",")}) returning *`,
      Object.values(row),
    )).rows[0];
  };

  await asOwner();
  const companyId = (await db.query("select public.create_company($1) as id", ["Firma R2-B1"])).rows[0].id;
  const position = await insert("positions", {
    company_id: companyId, title: "Analityk", tasks: ["Analiza danych"], kpis: ["Terminowość raportów"],
    required_competencies: ["SQL"], status: "active",
  });
  const recruitment = await insert("recruitments", { company_id: companyId, position_id: position.id, name: "Analitycy", status: "open" });
  const candidate = await insert("candidates", { company_id: companyId, first_name: "Test", last_name: "B1" });
  const application = await insert("applications", { company_id: companyId, recruitment_id: recruitment.id, candidate_id: candidate.id });
  const addDocument = async text => {
    const document = await insert("candidate_documents", {
      company_id: companyId, candidate_id: candidate.id, source_text: "Oryginał zostaje wewnątrz", redacted_text: text,
    });
    assert.equal((await db.query("select public.review_candidate_document($1,$2) as ok", [document.id, document.version])).rows[0].ok, true);
  };
  await addDocument("SQL i raporty.");
  const stage1 = await insert("assessment_stages", { company_id: companyId, recruitment_id: recruitment.id, name: "Rozmowa", sequence: 1 });
  const stage2 = await insert("assessment_stages", { company_id: companyId, recruitment_id: recruitment.id, name: "Referencje", sequence: 2 });

  const prepared = async () => {
    const one = async (table, id) => (await db.query(
      `select t.*, to_jsonb(t.updated_at)#>>'{}' as updated_at from public.${table} t where id=$1`, [id])).rows[0];
    const document = (await db.query(
      "select * from public.candidate_documents where company_id=$1 and candidate_id=$2 order by created_at desc, id desc limit 1",
      [companyId, candidate.id])).rows[0];
    return prepareScreening({
      companyId, application: await one("applications", application.id), recruitment: await one("recruitments", recruitment.id),
      position: await one("positions", position.id), document,
    });
  };
  const start = async () => {
    await asOwner();
    const input = await prepared();
    const row = (await db.query("select * from public.start_screening_analysis($1,$2,$3,$4,$5,$6,$7,$8,$9,false)", [
      application.id, input.fingerprint, contract.payload_schema_version, contract.result_schema_version,
      contract.prompt_version, contract.provider, contract.model, contract.model_revision, randomUUID(),
    ])).rows[0];
    assert.equal(row.reused, false);
    return row.analysis_id;
  };
  const state = async analysisId => {
    await asAdmin();
    const row = (await db.query(
      `select stale_at, stale_reason, input_fingerprint, private.screening_stale_reason(id) as detected
       from public.screening_analysis_versions where id=$1`, [analysisId])).rows[0];
    const fingerprint = (await prepared()).fingerprint;
    return { stale: row.stale_at !== null, reason: row.stale_reason, detected: row.detected, fingerprintMatches: row.input_fingerprint === fingerprint };
  };
  const fresh = { stale: false, reason: null, detected: null, fingerprintMatches: true };
  const updatedAt = async table => {
    await asAdmin();
    return (await db.query(`select to_jsonb(updated_at)#>>'{}' as v from public.${table} where id=$1`,
      [table === "applications" ? application.id : recruitment.id])).rows[0].v;
  };

  await t.test("triggers themselves are unchanged (only function bodies were replaced)", async () => {
    await asAdmin();
    assert.equal((await db.query(triggersSql)).rows[0].defs, triggersBefore);
  });

  const first = await start();
  assert.deepEqual(await state(first), fresh);

  await t.test("stage move does not mark the analysis stale", async () => {
    const before = await updatedAt("applications");
    await asOwner();
    await db.query("select public.move_application_stage($1,$2,$3,$4)", [companyId, recruitment.id, application.id, stage1.id]);
    await db.query("select public.move_application_stage($1,$2,$3,$4)", [companyId, recruitment.id, application.id, stage2.id]);
    assert.equal(await updatedAt("applications"), before);
    assert.deepEqual(await state(first), fresh);
    assert.equal((await db.query("select current_stage_id from public.applications where id=$1", [application.id])).rows[0].current_stage_id, stage2.id);
  });

  await t.test("recruiter decision does not mark the analysis stale", async () => {
    await asOwner();
    await db.query("select public.set_application_human_decision($1,$2,$3,$4,$5)",
      [companyId, recruitment.id, application.id, "next_stage", "Dobre doświadczenie z SQL."]);
    assert.deepEqual(await state(first), fresh);
  });

  await t.test("recruitment rename does not mark the analysis stale", async () => {
    const before = await updatedAt("recruitments");
    await asAdmin();
    await db.query("update public.recruitments set name='Analitycy danych' where id=$1", [recruitment.id]);
    assert.equal(await updatedAt("recruitments"), before);
    assert.deepEqual(await state(first), fresh);
  });

  await t.test("stage move together with an input change still marks stale", async () => {
    const before = await updatedAt("applications");
    await asAdmin();
    await db.query("update public.applications set current_stage_id=$2, status='in_progress' where id=$1", [application.id, stage1.id]);
    assert.notEqual(await updatedAt("applications"), before);
    const result = await state(first);
    assert.equal(result.stale, true);
    assert.equal(result.reason, "application_changed");
    assert.equal(result.fingerprintMatches, false);
  });

  await t.test("recruitment status change marks stale", async () => {
    const analysis = await start();
    const before = await updatedAt("recruitments");
    await asAdmin();
    await db.query("update public.recruitments set status='draft' where id=$1", [recruitment.id]);
    assert.notEqual(await updatedAt("recruitments"), before);
    const result = await state(analysis);
    assert.equal(result.stale, true);
    assert.equal(result.reason, "recruitment_changed");
  });

  await t.test("requirements change marks stale", async () => {
    const analysis = await start();
    await asAdmin();
    await db.query("update public.positions set tasks=array['Analiza danych','Raporty miesięczne'] where id=$1", [position.id]);
    const result = await state(analysis);
    assert.equal(result.stale, true);
    assert.equal(result.reason, "position_changed");
  });

  await t.test("new CV marks stale", async () => {
    const analysis = await start();
    await asOwner();
    await addDocument("SQL, raporty i Python.");
    const result = await state(analysis);
    assert.equal(result.stale, true);
    assert.match(result.reason, /^candidate_document_/);
  });

  await t.test("updated_at of other tables still moves on every update", async () => {
    await asAdmin();
    const before = (await db.query("select to_jsonb(updated_at)#>>'{}' as v from public.candidates where id=$1", [candidate.id])).rows[0].v;
    await db.query("update public.candidates set phone=null where id=$1", [candidate.id]);
    const after = (await db.query("select to_jsonb(updated_at)#>>'{}' as v from public.candidates where id=$1", [candidate.id])).rows[0].v;
    assert.notEqual(after, before);
  });

  await t.test("migration fails closed on a second run; rollback restores the old behaviour", async () => {
    await asAdmin();
    await assert.rejects(db.exec(await readFile(migration, "utf8")), /r2_b1_dependency_unreviewed/);
    await db.exec("rollback");
    await db.exec(await readFile(rollback, "utf8"));
    assert.equal((await db.query(triggersSql)).rows[0].defs, triggersBefore);
    const analysis = await start();
    await asOwner();
    await db.query("select public.move_application_stage($1,$2,$3,$4)", [companyId, recruitment.id, application.id, stage2.id]);
    const result = await state(analysis);
    assert.equal(result.stale, true);
    assert.equal(result.reason, "application_changed");
  });
});
