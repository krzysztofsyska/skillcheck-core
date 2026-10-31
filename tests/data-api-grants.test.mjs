import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { setupRankingDatabase, users } from './helpers/screening-ranking-fixture.mjs';
import { bootMigrationDatabase } from './helpers/sc19-migration-fixture.mjs';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const repair = await read('supabase/migrations/20261021084245_explicit_data_api_table_acl.sql');
// Reviewed API contract, deliberately independent of the migration's REVOKE list.
const crud = ['company_members', 'company_profiles', 'positions', 'recruitments',
  'candidates', 'applications', 'assessment_stages', 'candidate_assessments'];
const readOnly = ['behavior_assessment_entries', 'exercise_definition_entries',
  'exercise_observation_entries', 'screening_analysis_versions', 'screening_analysis_attempts',
  'screening_criterion_results', 'screening_result_reviews', 'screening_criterion_review_overrides',
  'recruitment_shortlist_entries', 'candidate_contact_permissions', 'candidate_contact_preferences',
  'candidate_communications', 'candidate_communication_events', 'candidate_communication_approvals'];
const rpcOnly = ['sales_leads', 'platform_operators'];
const views = ['latest_behavior_assessments', 'latest_exercise_definitions', 'latest_exercise_observations'];
const tables = [...crud, ...readOnly, ...rpcOnly, 'companies', 'candidate_documents'].sort();
const relations = [...tables, ...views].sort();
const step4Audit = ['application_stage_events','application_decision_events','candidate_assessment_note_revisions'];
const updates = {
  companies: ['name'], company_members: ['role'],
  company_profiles: ['industry', 'description', 'website', 'size_band', 'work_environment', 'company_values'],
  positions: ['title', 'description', 'tasks', 'kpis', 'autonomy_level', 'required_behaviors', 'required_competencies', 'status'],
  recruitments: ['name', 'status', 'opened_at', 'closed_at'],
  candidates: ['first_name', 'last_name', 'email', 'phone'], applications: ['status'],
  assessment_stages: ['name', 'description', 'sequence'],
  candidate_assessments: ['status', 'score', 'notes', 'completed_at'], candidate_documents: ['redacted_text'],
};
const documentInsert = ['company_id', 'candidate_id', 'source_text', 'redacted_text'];
const privileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];
const columnPrivileges = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'];
const denied = promise => assert.rejects(promise, error => error.code === '42501');

async function apiMatrix(db) {
  const serverVersion = Number((await db.query("select current_setting('server_version_num') as value")).rows[0].value);
  // MAINTAIN was introduced in PostgreSQL 17. Keep the independent API matrix
  // strict on both supported native versions and on historical PGlite profiles.
  const supportedPrivileges = serverVersion >= 170000 ? privileges : privileges.filter(value => value !== 'MAINTAIN');
  return (await db.query(`
    select c.relname, r.rolname, p.privilege,
      has_table_privilege(r.oid,c.oid,p.privilege) as allowed
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    cross join pg_roles r cross join unnest($1::text[]) p(privilege)
    where n.nspname='public' and c.relkind in ('r','p','v')
      and r.rolname in ('anon','authenticated','service_role')
    order by 1,2,3`, [supportedPrivileges])).rows;
}
async function columnMatrix(db) {
  return (await db.query(`
    select c.relname,a.attname,r.rolname,p.privilege,
      has_column_privilege(r.oid,c.oid,a.attnum,p.privilege) as allowed
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
    cross join pg_roles r cross join unnest($1::text[]) p(privilege)
    where n.nspname='public' and c.relkind in ('r','p','v')
      and r.rolname in ('anon','authenticated','service_role')
    order by 1,2,3,4`, [columnPrivileges])).rows;
}
async function untouched(db) {
  // No migration may silently broaden user/worker/function/default permissions.
  return {
    api: (await apiMatrix(db)).filter(r => r.rolname !== 'service_role'),
    columns: (await columnMatrix(db)).filter(r => r.rolname !== 'service_role'),
    functions: (await db.query(`select n.nspname,p.proname,p.oid::regprocedure::text as signature,
      p.proacl::text,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('public','private') order by 1,2,3`)).rows,
    policies: (await db.query('select * from pg_policies order by schemaname,tablename,policyname')).rows,
    defaults: (await db.query('select * from pg_default_acl order by oid')).rows,
    signature: (await db.query('select private.erasure_schema_signature() as value')).rows,
  };
}

async function assertApiContract(db) {
  const catalog = (await db.query(`select c.relname,c.relkind,c.relrowsecurity,c.reloptions
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p','v') order by c.relname`)).rows;
  const step4Present = catalog.some(row => row.relname === 'application_stage_events');
  const expectedRelations = step4Present ? [...relations, ...step4Audit].sort() : relations;
  assert.deepEqual(catalog.map(r => r.relname), expectedRelations, 'new tables require a reviewed API contract');
  for (const row of catalog) {
    if (row.relkind === 'v') assert.ok(row.reloptions.includes('security_invoker=true'), row.relname);
    else assert.equal(row.relrowsecurity, true, row.relname);
  }
  for (const row of await apiMatrix(db)) {
    const expected = row.rolname === 'authenticated' && (
      (row.privilege === 'SELECT' && !rpcOnly.includes(row.relname)) ||
      (['INSERT','DELETE'].includes(row.privilege) && crud.includes(row.relname)));
    assert.equal(row.allowed, expected, JSON.stringify(row));
  }
  for (const row of await columnMatrix(db)) {
    const expected = row.rolname === 'authenticated' && (
      (row.privilege === 'SELECT' && !rpcOnly.includes(row.relname)) ||
      (row.privilege === 'INSERT' && (crud.includes(row.relname) ||
        (row.relname === 'candidate_documents' && documentInsert.includes(row.attname)))) ||
      (row.privilege === 'UPDATE' && (updates[row.relname] ?? []).includes(row.attname)));
    assert.equal(row.allowed, expected, JSON.stringify(row));
  }
}

for (const profile of ['no-default-grants', 'legacy-all', 'opt-in-residual']) {
  test(`Data API ACL: full migration chain / ${profile}`, async t => {
    const db = new PGlite({ extensions: { pgcrypto } });
    t.after(() => db.close());
    await db.exec(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls;
      grant usage on schema public to anon,authenticated,service_role;`);
    if (profile !== 'no-default-grants') {
      await db.exec(`alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
        alter default privileges in schema public grant all on sequences to anon,authenticated,service_role;
        alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;`);
      if (profile === 'opt-in-residual') await db.exec(`
        alter default privileges in schema public revoke select,insert,update,delete on tables from anon,authenticated,service_role;
        alter default privileges in schema public revoke usage,select on sequences from anon,authenticated,service_role;`);
    }
    const h = await setupRankingDatabase(db, { throughMigration: '20261012031039_retention_scheduler_inventory.sql' });
    const a = await h.seed(users.owner, 'A'), b = await h.seed(users.otherOwner, 'B');
    await h.asAdmin();
    await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter'),($1,$3,'viewer')",
      [a.companyId, users.recruiter, users.viewer]);
    const before = await untouched(db);

    await t.test('legacy failure is reproducible; transaction rollback preserves original ACL', async () => {
      if (profile === 'legacy-all') {
        await db.exec('set role service_role');
        assert.equal((await db.query('select id from public.candidate_documents')).rows.length, 2);
        await h.asAdmin();
      }
      // Independently granted columns must not survive a table-level REVOKE.
      await db.exec('grant select (id), update (redacted_text) on public.candidate_documents to service_role');
      const original = { table: await apiMatrix(db), column: await columnMatrix(db) };
      assert.match(repair, /commit;\s*$/i);
      await db.exec(repair.replace(/commit;\s*$/i, 'rollback;'));
      assert.deepEqual({ table: await apiMatrix(db), column: await columnMatrix(db) }, original);
    });

    await db.exec(repair);
    await t.test('exact table/column allowlist, RLS, invoker views, no anonymous or service CRUD', async () => {
      await assertApiContract(db);
      assert.deepEqual(await untouched(db), before, 'user/worker RPCs, policies, defaults and SC-010 signature unchanged');
      assert.equal((await db.query(`select count(*)::int as count from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind='S'`)).rows[0].count, 0);
      for (const role of ['anon', 'service_role']) {
        await db.exec(`set role ${role}`);
        for (const name of relations) await denied(db.query(`select * from public.${name}`));
        await h.asAdmin();
      }
    });

    await t.test('two tenants, owner/recruiter/viewer/outsider, column identity and worker RPC regression', async () => {
      await h.asUser(users.owner);
      assert.equal((await db.query('select id from public.candidate_documents')).rows.length, 1);
      assert.equal((await db.query('select id from public.candidate_documents where id=$1', [b.documentId])).rows.length, 0);
      await denied(db.query('update public.companies set owner_id=$1 where id=$2', [users.otherOwner, a.companyId]));
      await denied(db.query('update public.candidate_documents set company_id=$1 where id=$2', [b.companyId, a.documentId]));
      await denied(db.query("insert into public.candidates(company_id,first_name,last_name) values($1,'Synthetic','Cross tenant')", [b.companyId]));
      await h.asUser(users.recruiter);
      assert.equal((await db.query("update public.candidates set first_name='Updated' where id=$1 returning id", [a.candidate.id])).rows.length, 1);
      await h.asUser(users.viewer);
      assert.equal((await db.query('select id from public.candidate_documents')).rows.length, 1);
      assert.equal((await db.query("update public.candidates set first_name='Denied' returning id")).rows.length, 0);
      await h.asUser(users.outsider);
      assert.equal((await db.query('select id from public.candidate_documents')).rows.length, 0);
      const completed = await h.completedApplication(a, Array(5).fill('meets'));
      await h.asUser(users.owner);
      assert.equal((await h.row(completed)).rankable, true);
      await h.asWorker();
      await denied(db.query('select * from public.candidate_documents'));
      await h.asAdmin();
    });

    await t.test('repair leaves unrelated tables untouched and is idempotent in isolated tests', async () => {
      await db.exec('create table public.audit_unrelated_fixture(id integer); grant select on public.audit_unrelated_fixture to service_role');
      await db.exec(repair);
      assert.equal((await db.query("select has_table_privilege('service_role','public.audit_unrelated_fixture','SELECT') as ok")).rows[0].ok, true);
      await db.exec('drop table public.audit_unrelated_fixture');
      assert.deepEqual(await untouched(db), before);
    });

    await t.test('planned SC-019 tables stay private; package RPC remains explicit and tenant balance isolated', async () => {
      // Stronger than platform defaults: prove the existing prototype cleans even private inherited ACL.
      await db.exec(`alter default privileges in schema private grant all on tables to anon,authenticated,service_role;
        alter default privileges in schema private grant execute on functions to anon,authenticated,service_role;`);
      await db.exec(await read('docs/prototypes/sc-019-mvp-credits.sql'));
      // The payment prototype must still refuse a full SC-010 installation.
      await assert.rejects(db.exec(await read('docs/prototypes/sc19-payment-storage.sql')),
        error => error.code === '55000' && /sc19_payment_erasure_revision_required/.test(error.message));
      await db.exec('rollback');
      const rows = (await db.query(`select c.oid,c.relname,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='private' and c.relkind='r' and c.relname like 'sc19_%' order by c.relname`)).rows;
      assert.equal(rows.length, 6);
      for (const row of rows) {
        assert.equal(row.relrowsecurity, true);
        for (const role of ['anon','authenticated','service_role']) {
          const perms = (await db.query(`select has_table_privilege($1,$2::oid,p) as allowed from unnest($3::text[]) p`, [role, row.oid, privileges])).rows;
          assert.ok(perms.every(p => !p.allowed), `${role}/${row.relname}`);
        }
      }
      await db.query("insert into private.sc19_trial_approvals(company_id,nip,proof_reference) values($1,'1234563218','synthetic-acl-proof')", [a.companyId]);
      await h.asUser(null, 'anon');
      assert.equal((await db.query('select * from public.sc19_package_sizes()')).rows.length, 2);
      await denied(db.query('select * from public.sc19_get_balance($1)', [a.companyId]));
      await h.asUser(users.owner);
      await db.query("select public.sc19_claim_trial($1,'1234563218')", [a.companyId]);
      assert.equal((await db.query('select * from public.sc19_get_balance($1)', [a.companyId])).rows.length, 1);
      await denied(db.query('select * from public.sc19_get_balance($1)', [b.companyId]));
      await h.asAdmin();
    });

    await t.test('planned SC-012 public plan remains RPC-only with historical defaults', async () => {
      await h.asAdmin();
      await db.exec(await read('db/prototypes/sc012b-plan-schema.sql'));
      for (const role of ['anon','authenticated','service_role']) {
        const perms = (await db.query("select has_table_privilege($1,'public.voice_plan_versions',p) as allowed from unnest($2::text[]) p", [role, privileges])).rows;
        assert.ok(perms.every(p => !p.allowed), role);
        await db.exec(`set role ${role}`);
        await denied(db.query('select * from public.voice_plan_versions'));
        await h.asAdmin();
      }
    });
  });
}

test('planned SC-019 payment storage clears inherited ACL in its supported isolated fixture', async t => {
  const db = new PGlite({ extensions: { pgcrypto } });
  t.after(() => db.close());
  await db.exec('create role service_role nologin bypassrls');
  // Existing payment test contract: no SC-010 installation, no guard removal.
  await setupRankingDatabase(db, { throughMigration: '20261009081908_screening_ranking_shortlist.sql' });
  await db.exec(`alter default privileges in schema private grant all on tables to anon,authenticated,service_role;
    alter default privileges in schema private grant execute on functions to anon,authenticated,service_role;`);
  await db.exec(await read('docs/prototypes/sc-019-mvp-credits.sql'));
  await db.exec(await read('docs/prototypes/sc19-payment-storage.sql'));
  const rows = (await db.query(`select c.oid,c.relname,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='private' and c.relkind='r' and c.relname like 'sc19_payment_%' order by c.relname`)).rows;
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.relrowsecurity, true);
    for (const role of ['anon','authenticated','service_role']) {
      const perms = (await db.query(`select has_table_privilege($1,$2::oid,p) as allowed from unnest($3::text[]) p`, [role, row.oid, privileges])).rows;
      assert.ok(perms.every(p => !p.allowed), `${role}/${row.relname}`);
    }
  }
});

test('full clean replay checks every current migration against the public API contract', async t => {
  const env = await bootMigrationDatabase(t), { db } = env;
  let createdServiceRole = false;
  const cleanup = async () => {
    if (!createdServiceRole) return;
    await db.exec('rollback; reset role; drop owned by service_role');
    await env.admin.query('drop role service_role'); createdServiceRole = false;
  };
  t.after(cleanup);
  try {
    // Roles are cluster-global in native PostgreSQL. Own this synthetic role
    // explicitly; never remove or repurpose a pre-existing service principal.
    assert.equal((await db.query("select to_regrole('service_role') value")).rows[0].value, null,
      'Clean disposable cluster required: service_role must not already exist');
    await db.exec(`do $$ begin
      if not exists(select from pg_roles where rolname='anon') then create role anon nologin; end if;
      if not exists(select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    end $$`);
    await db.exec('create role service_role nologin bypassrls'); createdServiceRole = true;
    await db.exec('alter default privileges in schema public grant all on tables to anon,authenticated,service_role');
    await setupRankingDatabase(db, { throughMigration: null });
    await assertApiContract(db);
    // Prove the guard detects both a new table and privilege drift in a future migration.
    await db.exec('begin; create table public.unreviewed_future_table(id integer)');
    await assert.rejects(assertApiContract(db), error => error.code === 'ERR_ASSERTION');
    await db.exec('rollback; begin; grant select on public.candidate_documents to anon');
    await assert.rejects(assertApiContract(db), error => error.code === 'ERR_ASSERTION');
    await db.exec('rollback');
    await assertApiContract(db);
  } finally { await cleanup(); }
});

test('full clean replay includes the ACL repair even without a Supabase service role', async t => {
  const { db } = await bootMigrationDatabase(t);
  assert.equal((await db.query("select to_regrole('service_role') value")).rows[0].value, null);
  const h = await setupRankingDatabase(db, { throughMigration: null });
  await assertApiContract(db);
  const a = await h.seed();
  assert.ok(a.documentId);
});
