import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

export const users = Object.fromEntries(['owner', 'otherOwner', 'recruiter', 'viewer', 'outsider'].map((name, i) =>
  [name, `10000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`]));

// Both PGlite and pg (with exec = query) run the actual migration/RPC chain.
export async function setupRankingDatabase(db, { defaultTargetSize } = {}) {
  await db.exec(`
    do $$ begin
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    end $$;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
    $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  const dir = new URL('../../supabase/migrations/', import.meta.url);
  const migrations = (await readdir(dir)).filter(name => name.endsWith('.sql')).sort();
  assert.ok(migrations.some(name => name.includes('ranking')), 'SC-008 migration must exist');
  for (const name of migrations) {
    let sql = await readFile(new URL(name, dir), 'utf8');
    if (defaultTargetSize !== undefined && name.includes('ranking')) {
      // Change the initial seed in an isolated database, never mutate an installed policy.
      const replaced = sql.replace(/('screening-ranking-v1'\s*,\s*0\.60?\s*,\s*0\s*,\s*50\s*,\s*100\s*,\s*5\s*,\s*10\s*,\s*)10\b/, `$1${defaultTargetSize}`);
      assert.notEqual(replaced, sql, 'alternate policy fixture must replace initial seed');
      sql = replaced;
    }
    await db.exec(sql);
  }
  for (const id of Object.values(users)) await db.query('insert into auth.users values($1)', [id]);
  return createRankingHarness(db);
}

export function createRankingHarness(db) {
  const asUser = async (id = users.owner, role = 'authenticated') => {
    assert.ok(['authenticated', 'anon', 'screening_worker'].includes(role));
    await db.exec(`reset role; set role ${role}`);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id ?? '']);
  };
  const asAdmin = async () => {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub','',false)");
  };
  const asWorker = () => asUser(null, 'screening_worker');
  const insert = async (table, row) => {
    assert.match(table, /^[a-z_]+$/);
    const fields = Object.keys(row);
    return (await db.query(`insert into public.${table}(${fields.join(',')}) values(${fields.map((_, i) => `$${i+1}`).join(',')}) returning *`, Object.values(row))).rows[0];
  };
  const candidate = async (tenant, label = randomUUID()) => {
    await asUser(tenant.owner);
    const person = await insert('candidates', { company_id: tenant.companyId, first_name: 'Test', last_name: label });
    const application = await insert('applications', { company_id: tenant.companyId, recruitment_id: tenant.recruitment.id, candidate_id: person.id });
    const document = await insert('candidate_documents', { company_id: tenant.companyId, candidate_id: person.id, source_text: 'PRIVATE original CV', redacted_text: 'SQL expertise in reports.' });
    await db.query('select public.review_candidate_document($1,$2)', [document.id, document.version]);
    return { ...tenant, candidate: person, application, document, documentId: document.id };
  };
  const seed = async (owner = users.owner, label = randomUUID(), criteriaCount = 5) => {
    assert.ok(criteriaCount >= 2 && criteriaCount <= 32);
    await asUser(owner);
    const companyId = (await db.query('select public.create_company($1) as id', [`Tenant ${label}`])).rows[0].id;
    const position = await insert('positions', { company_id: companyId, title: 'Analyst', tasks: ['SQL'], kpis: ['Reports'], required_competencies: Array.from({ length: criteriaCount - 2 }, (_, i) => `Skill ${i}`), status: 'active' });
    const recruitment = await insert('recruitments', { company_id: companyId, position_id: position.id, name: `Recruitment ${label}`, status: 'open' });
    return candidate({ owner, companyId, position, recruitment }, label);
  };
  const start = async (fixture, { promptVersion = 'screening-v1', force = false } = {}) => {
    await asAdmin();
    const fingerprint = (await db.query("select private.screening_material($1,false)->>'input_fingerprint' as value", [fixture.application.id])).rows[0].value;
    await asUser(fixture.owner);
    return (await db.query("select * from public.start_screening_analysis($1,$2,1,1,$3,'openai','ranking-test-model',null,$4,$5)", [fixture.application.id, fingerprint, promptVersion, randomUUID(), force])).rows[0];
  };
  const claim = async started => {
    await asWorker();
    return (await db.query('select * from public.claim_screening_attempt($1)', [started.attempt_id])).rows[0];
  };
  const findings = (claimed, ratings) => {
    assert.equal(claimed.criteria_snapshot.length, ratings.length);
    return claimed.criteria_snapshot.map((criterion, i) => ({ criterion_id: criterion.id, rating: ratings[i], evidence: ratings[i] === 'insufficient_data' ? [] : [{start: 0, end: 3, quote: 'SQL'}], explanation: 'Synthetic fixture.' }));
  };
  const finishClaim = async (started, claimed, ratings) => {
    await asWorker();
    return (await db.query('select public.complete_screening_analysis($1,$2,$3,$4,$5::jsonb) as id', [started.attempt_id, claimed.lease_token, claimed.input_fingerprint, claimed.analysis_contract_hash, JSON.stringify(findings(claimed, ratings))])).rows[0].id;
  };
  const complete = async (_fixture, started, ratings) => finishClaim(started, await claim(started), ratings);
  const review = async (fixture, analysisId, disposition = 'approved', overrides = []) => {
    await asUser(fixture.owner);
    const version = (await db.query('select latest_review_version from public.screening_analysis_versions where id=$1', [analysisId])).rows[0].latest_review_version;
    return (await db.query('select public.review_screening_result($1,$2,$3,null,$4::jsonb) as id', [analysisId, version, disposition, JSON.stringify(overrides)])).rows[0].id;
  };
  const completedApplication = async (fixture, ratings, disposition = 'approved') => {
    const started = await start(fixture);
    await complete(fixture, started, ratings);
    const reviewId = disposition === null ? null : await review(fixture, started.analysis_id, disposition);
    return { ...fixture, ...started, reviewId };
  };
  // Read/write helpers deliberately preserve the current role for authorization tests.
  const ranking = async (fixture, size = null) => (await db.query('select * from public.get_screening_ranking($1,$2)', [fixture.recruitment.id, size])).rows;
  const row = async fixture => (await ranking(fixture)).find(item => item.application_id === fixture.application.id);
  const shortlist = async (fixture, history = false) => (await db.query('select * from public.get_recruitment_shortlist($1,$2)', [fixture.recruitment.id, history])).rows;
  const add = async (fixture, source = 'manual', expected, note = null, size = null) => {
    expected ??= await row(fixture);
    return (await db.query('select public.add_recruitment_shortlist_entry($1,$2,$3,$4,$5,$6,$7) as id', [fixture.application.id, source, expected.analysis_id, expected.review_id, expected.ranking_policy_version, note, size])).rows[0].id;
  };
  const remove = async id => (await db.query('select public.remove_recruitment_shortlist_entry($1) as id', [id])).rows[0].id;
  return { db, asUser, asAdmin, asWorker, insert, seed, candidate, start, claim, findings, finishClaim, complete, review, completedApplication, ranking, row, shortlist, add, remove };
}
