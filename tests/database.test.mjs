import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('SkillCheck migration and tenant isolation', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  // Emulate Supabase Auth roles, not a production auth implementation.
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
  await db.exec(await readFile(new URL('../supabase/migrations/20260930000100_skillcheck_core.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/20261001000100_idempotent_onboarding.sql', import.meta.url), 'utf8'));
  const ids = Array.from({ length: 6 }, (_, i) => `00000000-0000-0000-0000-00000000000${i + 1}`);
  const [ownerA, ownerB, recruiter, viewer, outsider, multi] = ids;
  for (const id of ids) await db.query('insert into auth.users values ($1)', [id]);
  const asUser = async (id, role = 'authenticated') => {
    await db.exec(`reset role; set role ${role}`);
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id ?? '']);
  };
  const insert = async (table, row) => {
    const fields = Object.keys(row);
    const result = await db.query(`insert into public.${table} (${fields.join(',')}) values (${fields.map((_, i) => `$${i + 1}`).join(',')}) returning *`, Object.values(row));
    return result.rows[0];
  };
  const denied = async (sql, params = [], code = '42501') => {
    await assert.rejects(db.query(sql, params), (error) => error.code === code);
  };
  const seed = async (owner, label) => {
    await asUser(owner);
    const { rows } = await db.query('select public.create_company($1) as id', [label]);
    const company_id = rows[0].id;
    const position = await insert('positions', { company_id, title: 'Developer' });
    const recruitment = await insert('recruitments', { company_id, position_id: position.id, name: 'Autumn' });
    const candidate = await insert('candidates', { company_id, first_name: 'Test', last_name: label });
    const application = await insert('applications', { company_id, recruitment_id: recruitment.id, candidate_id: candidate.id });
    const stage = await insert('assessment_stages', { company_id, recruitment_id: recruitment.id, name: 'Interview', sequence: 1 });
    const assessment = await insert('candidate_assessments', { company_id, recruitment_id: recruitment.id, application_id: application.id, stage_id: stage.id });
    await insert('company_members', { company_id, user_id: multi, role: 'recruiter' });
    return { company_id, position, recruitment, candidate, application, stage, assessment };
  };
  const a = await seed(ownerA, 'A');
  const b = await seed(ownerB, 'B');
  await asUser(ownerA);
  await insert('company_members', { company_id: a.company_id, user_id: recruiter, role: 'recruiter' });
  await insert('company_members', { company_id: a.company_id, user_id: viewer, role: 'viewer' });
  const tables = ['companies', 'company_members', 'company_profiles', 'positions', 'recruitments', 'candidates', 'applications', 'assessment_stages', 'candidate_assessments'];
  const mutable = { companies: "name = 'Changed'", company_members: "role = 'recruiter'", company_profiles: "description = 'Changed'", positions: "title = 'Changed'", recruitments: "name = 'Changed'", candidates: "first_name = 'Changed'", applications: "status = 'in_progress'", assessment_stages: "name = 'Changed'", candidate_assessments: "notes = 'Changed'" };
  const tenantColumn = (table) => table === 'companies' ? 'id' : 'company_id';

  await t.test('all nine tables have RLS and anonymous access is denied', async () => {
    await db.exec('reset role');
    const { rows } = await db.query("select relname from pg_class join pg_namespace n on n.oid = relnamespace where n.nspname = 'public' and relkind = 'r' and relrowsecurity");
    assert.deepEqual(rows.map(x => x.relname).sort(), [...tables].sort());
    await asUser(null, 'anon');
    for (const table of tables) await denied(`select * from public.${table}`);
    await denied("select public.create_company('Anonymous')");
    await asUser(null);
    await denied("select public.create_company('Missing session')");
  });

  await t.test('owner sees own data; other tenant reads, updates and deletes are blocked', async () => {
    await asUser(ownerA);
    for (const table of tables) {
      const column = tenantColumn(table);
      assert.ok((await db.query(`select * from public.${table} where ${column} = $1`, [a.company_id])).rows.length > 0);
      assert.equal((await db.query(`select * from public.${table} where ${column} = $1`, [b.company_id])).rows.length, 0);
      assert.equal((await db.query(`update public.${table} set ${mutable[table]} where ${column} = $1 returning *`, [b.company_id])).rows.length, 0);
      if (table !== 'companies') assert.equal((await db.query(`delete from public.${table} where ${column} = $1 returning *`, [b.company_id])).rows.length, 0);
    }
  });

  await t.test('cross-tenant INSERT denied for every tenant child table', async () => {
    await asUser(ownerA);
    const attempts = {
      company_profiles: { company_id: b.company_id },
      company_members: { company_id: b.company_id, user_id: outsider },
      positions: { company_id: b.company_id, title: 'Intruder' },
      recruitments: { company_id: b.company_id, position_id: b.position.id, name: 'Intruder' },
      candidates: { company_id: b.company_id, first_name: 'X', last_name: 'Y' },
      applications: { company_id: b.company_id, recruitment_id: b.recruitment.id, candidate_id: b.candidate.id },
      assessment_stages: { company_id: b.company_id, recruitment_id: b.recruitment.id, name: 'X', sequence: 2 },
      candidate_assessments: { company_id: b.company_id, recruitment_id: b.recruitment.id, application_id: b.application.id, stage_id: b.stage.id },
    };
    for (const [table, row] of Object.entries(attempts)) await assert.rejects(insert(table, row), e => e.code === '42501');
    await denied('insert into public.companies(name, owner_id) values ($1, $2)', ['Spoof', ownerB]);
  });

  await t.test('viewer and outsider cannot write; viewer cannot change own role', async () => {
    for (const user of [viewer, outsider]) {
      await asUser(user);
      for (const table of tables) {
        assert.equal((await db.query(`update public.${table} set ${mutable[table]} returning *`)).rows.length, 0);
        if (table !== 'companies') assert.equal((await db.query(`delete from public.${table} returning *`)).rows.length, 0);
      }
      await denied('insert into public.positions(company_id, title) values ($1, $2)', [a.company_id, 'Forbidden']);
    }
    await asUser(viewer);
    assert.equal((await db.query('select * from public.positions')).rows.length, 1);
    await asUser(outsider);
    for (const table of tables) assert.equal((await db.query(`select * from public.${table}`)).rows.length, 0);
  });

  await t.test('recruiter can CRUD operational data but cannot manage members', async () => {
    await asUser(recruiter);
    for (const table of tables.filter(x => !['companies', 'company_members'].includes(x))) {
      assert.ok((await db.query(`update public.${table} set ${mutable[table]} returning *`)).rows.length > 0);
    }
    const temporary = await insert('candidates', { company_id: a.company_id, first_name: 'Temporary', last_name: 'Record' });
    assert.equal((await db.query('delete from public.candidates where id = $1 returning *', [temporary.id])).rows.length, 1);
    await denied('insert into public.company_members(company_id, user_id) values ($1, $2)', [a.company_id, outsider]);
    assert.equal((await db.query("update public.company_members set role = 'recruiter' returning *")).rows.length, 0);
  });

  await t.test('identity, owner and tenant cannot be changed even by a multi-company member', async () => {
    await asUser(ownerA);
    await denied('update public.companies set owner_id = $1 where id = $2', [ownerB, a.company_id]);
    await denied('delete from public.companies where id = $1', [a.company_id]);
    await asUser(multi);
    for (const table of tables.filter(x => x !== 'companies')) await denied(`update public.${table} set company_id = $1 where company_id = $2`, [b.company_id, a.company_id]);
    await denied('update public.applications set recruitment_id = $1 where id = $2', [b.recruitment.id, a.application.id]);
  });

  await t.test('composite keys reject cross-company and cross-recruitment relationships', async () => {
    await asUser(multi);
    const badRows = [
      ['recruitments', { company_id: a.company_id, position_id: b.position.id, name: 'Wrong' }],
      ['applications', { company_id: a.company_id, recruitment_id: a.recruitment.id, candidate_id: b.candidate.id }],
      ['assessment_stages', { company_id: a.company_id, recruitment_id: b.recruitment.id, name: 'Wrong', sequence: 3 }],
      ['candidate_assessments', { company_id: a.company_id, recruitment_id: a.recruitment.id, application_id: b.application.id, stage_id: a.stage.id }],
    ];
    for (const [table, row] of badRows) await assert.rejects(insert(table, row), e => e.code === '23503');
    const otherRecruitment = await insert('recruitments', { company_id: a.company_id, position_id: a.position.id, name: 'Second' });
    const otherStage = await insert('assessment_stages', { company_id: a.company_id, recruitment_id: otherRecruitment.id, name: 'Other', sequence: 1 });
    await assert.rejects(insert('candidate_assessments', { company_id: a.company_id, recruitment_id: a.recruitment.id, application_id: a.application.id, stage_id: otherStage.id }), e => e.code === '23503');
  });

  await t.test('constraints, bootstrap atomicity and member revocation', async () => {
    await asUser(ownerA);
    const before = (await db.query('select * from public.companies')).rows.length;
    await denied("select public.create_company('   ')", [], '23514');
    assert.equal((await db.query('select * from public.companies')).rows.length, before);
    await denied('update public.candidate_assessments set score = 101 where id = $1', [a.assessment.id], '23514');
    await denied("update public.candidate_assessments set status = 'completed' where id = $1", [a.assessment.id], '23514');
    await db.query("update public.candidate_assessments set status = 'completed', completed_at = now(), score = 80 where id = $1", [a.assessment.id]);
    await denied('insert into public.applications(company_id, recruitment_id, candidate_id) values ($1, $2, $3)', [a.company_id, a.recruitment.id, a.candidate.id], '23505');
    await db.query('delete from public.company_members where company_id = $1 and user_id = $2', [a.company_id, recruiter]);
    await asUser(recruiter);
    assert.equal((await db.query('select * from public.candidates')).rows.length, 0);
  });

  await t.test('onboarding retries return one firm and reuse existing memberships', async () => {
    await asUser(null, 'anon');
    await denied("select public.ensure_initial_company('Denied')");
    await asUser(null);
    await denied("select public.ensure_initial_company('Denied')");
    await asUser(viewer);
    const memberResult = await db.query("select public.ensure_initial_company('Do not create') as id");
    assert.equal(memberResult.rows[0].id, a.company_id);
    await asUser(outsider);
    const first = await db.query("select public.ensure_initial_company('New firm') as id");
    const retry = await db.query("select public.ensure_initial_company('Retry') as id");
    assert.equal(first.rows[0].id, retry.rows[0].id);
    const companies = await db.query('select name from public.companies');
    assert.deepEqual(companies.rows, [{ name: 'New firm' }]);
    assert.equal((await db.query('select * from public.company_profiles')).rows.length, 1);
  });
});
