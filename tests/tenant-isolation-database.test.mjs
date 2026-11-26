// R0 SC-004 — izolacja firm w bazie: dwie fikcyjne firmy (A i B), w każdej właściciel,
// rekruter i osoba tylko do odczytu (viewer), praca równoczesna z osobnych sesji.
// Natywny PostgreSQL 16/17, pełny łańcuch migracji, rola `authenticated` z RLS (jak w
// Supabase), dane wyłącznie syntetyczne. Test niczego nie zmienia w schemacie: gdyby
// wykrył wyciek, test ma się wywalić, a naprawa jest osobnym zadaniem (L3).
//
// Pokrycie tabel jest dynamiczne: każda tabela schematu `public` z kolumną company_id
// (oraz `companies`) trafia do kontroli zbiorczej, więc nowa tabela tenantowa dodana
// przyszłą migracją jest sprawdzana bez zmiany tego pliku.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bootMigrationDatabase, seedSyntheticPolicy } from './helpers/sc19-migration-fixture.mjs';
import { setupRankingDatabase, createRankingHarness, users } from './helpers/screening-ranking-fixture.mjs';

const extra = { recruiterB: '10000000-0000-0000-0000-000000000011', viewerB: '10000000-0000-0000-0000-000000000012' };
const ROLES = ['owner', 'recruiter', 'viewer'];
// Tables the fixture fills for both companies; B must see none of A's rows in them (and vice versa),
// while each company's own members do see their own rows.
const SEEDED = [
  'applications', 'assessment_stages', 'candidate_assessments', 'candidate_documents', 'candidates',
  'application_stage_events', 'application_decision_events', 'screening_analysis_attempts',
  'screening_analysis_versions', 'screening_criterion_results', 'screening_result_reviews',
  'recruitment_shortlist_entries', 'positions', 'recruitments', 'company_members', 'companies',
];
const ident = name => { assert.match(name, /^[a-z_0-9]+$/); return `public.${name}`; };

test('SC-004 tenant isolation: two companies, three roles each, RLS as authenticated, concurrent sessions', async t => {
  const env = await bootMigrationDatabase(t);
  const { db } = env;
  const h = await setupRankingDatabase(db, { throughMigration: null });
  await h.asAdmin();
  for (const id of Object.values(extra)) await db.query('insert into auth.users values($1)', [id]);
  await seedSyntheticPolicy(db); // test-only credit policy, so screening analyses may start

  const people = {
    A: { owner: users.owner, recruiter: users.recruiter, viewer: users.viewer },
    B: { owner: users.otherOwner, recruiter: extra.recruiterB, viewer: extra.viewerB },
  };
  const other = { A: 'B', B: 'A' };
  const tenant = {};

  const seedTenant = async (key, label) => {
    const p = people[key];
    const fx = await h.seed(p.owner, label);
    await h.asAdmin();
    // Synthetic credit pack so that screening analyses may start (same call as the other full-chain tests).
    await db.query('select private.sc19_grant_paid($1,$2)', [fx.companyId, `synthetic-sc004-${fx.companyId}`]);
    await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter'),($1,$3,'viewer')", [fx.companyId, p.recruiter, p.viewer]);
    await h.asUser(p.owner);
    const stage = await h.insert('assessment_stages', { company_id: fx.companyId, recruitment_id: fx.recruitment.id, name: `Rozmowa ${label}`, sequence: 1 });
    const assessment = await h.insert('candidate_assessments', { company_id: fx.companyId, recruitment_id: fx.recruitment.id, application_id: fx.application.id, stage_id: stage.id, notes: `Notatka ${label}` });
    const done = await h.completedApplication(fx, Array(5).fill('meets'));
    await h.asUser(p.owner);
    const entryId = await h.add(done);
    await db.query('select public.move_application_stage($1,$2,$3,$4)', [fx.companyId, fx.recruitment.id, fx.application.id, stage.id]);
    await db.query('select public.set_application_human_decision($1,$2,$3,$4,$5)', [fx.companyId, fx.recruitment.id, fx.application.id, 'on_hold', `Uzasadnienie ${label}`]);
    await db.query('select public.record_candidate_report_export($1,$2,$3,$4,$5)', [fx.companyId, fx.recruitment.id, fx.application.id, 'candidate_report_csv', 1]);
    await h.asAdmin();
    const fingerprint = (await db.query("select private.screening_material($1,false)->>'input_fingerprint' v", [fx.application.id])).rows[0].v;
    tenant[key] = { ...done, stage, assessment, entryId, fingerprint, people: p, label };
  };
  await seedTenant('A', 'A');
  await seedTenant('B', 'B');

  await h.asAdmin();
  const tables = (await db.query(`select c.relname name, exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='company_id' and not a.attisdropped) has_company
    from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in ('r','p') and c.relname <> 'platform_operators' order by 1`)).rows;
  const tenantTables = tables.filter(x => x.has_company || x.name === 'companies').map(x => ({ name: x.name, column: x.name === 'companies' ? 'id' : 'company_id' }));
  t.diagnostic(`tenant tables checked: ${tenantTables.map(x => x.name).join(', ')}`);
  for (const name of SEEDED) assert.ok(tenantTables.some(x => x.name === name), `${name} is a tenant table`);
  const untenanted = tables.filter(x => !x.has_company && x.name !== 'companies').map(x => x.name);
  t.diagnostic(`public tables without company_id (checked only for grants): ${untenanted.join(', ')}`);

  const snapshot = async () => {
    await h.asAdmin();
    const out = {};
    for (const { name } of tenantTables) {
      out[name] = (await db.query(`select count(*)::int n, md5(coalesce(string_agg(x::text,'|' order by x::text),'')) d from ${ident(name)} x`)).rows[0];
    }
    return out;
  };
  /** Row count as the current role sees it; a table closed to `authenticated` (42501) counts as 0 rows. */
  const countRows = async (sql, params = []) => {
    try { return (await db.query(sql, params)).rows[0].n; } catch (error) { if (error.code === '42501') return 0; throw error; }
  };
  /** The call must either fail (permission/RLS/validation) or touch nothing: scalar/row results are empty. */
  const blocked = async (label, sql, params, denial = null) => {
    let result;
    try {
      result = await db.query(sql, params);
    } catch (error) {
      // Only database errors count as a denial; an assertion/programming error must never be swallowed here.
      assert.ok(typeof error.code === 'string' && !error.code.startsWith('ERR_'), `${label}: not a database error: ${error.message}`);
      assert.ok(!/^(XX|58)/.test(error.code), `${label}: internal error ${error.code} ${error.message}`);
      if (denial) assert.ok(denial.includes(error.code), `${label}: expected a denial (${denial}), got ${error.code} ${error.message}`);
      return;
    }
    // The call succeeded: it must have returned nothing. (UPDATE/DELETE use `returning 1`, so a leak shows up as a row.)
    const { rows, rowCount } = result;
    const empty = rows.length === 0 || rows.every(row => Object.values(row).every(v => v === null || v === false || (Array.isArray(v) && v.length === 0)));
    assert.ok(empty, `${label}: cross-tenant call returned data ${JSON.stringify(rows).slice(0, 200)} (rowCount ${rowCount})`);
  };

  await t.test('negative proof: the blocked() helper really fails when a call reaches data (own company)', async () => {
    await h.asUser(people.A.owner);
    const own = tenant.A;
    for (const [sql, params] of [
      ['update public.positions set title=title where company_id=$1 returning 1', [own.companyId]],
      ['update public.candidates set last_name=last_name where company_id=$1 returning 1', [own.companyId]],
      ['select * from public.get_screening_ranking($1,null)', [own.recruitment.id]],
    ]) {
      await assert.rejects(blocked('negative proof', sql, params), e => e.code === 'ERR_ASSERTION' && /returned data/.test(e.message), `helper must flag: ${sql}`);
    }
  });

  await t.test('every API-facing table: RLS enabled, no grant to anon, tables without company_id are closed to authenticated', async () => {
    await h.asAdmin();
    for (const { name } of tenantTables) {
      assert.equal((await db.query("select relrowsecurity v from pg_class where oid=$1::regclass", [ident(name)])).rows[0].v, true, `${name} has RLS`);
      assert.equal((await db.query("select has_table_privilege('anon',$1,'SELECT,INSERT,UPDATE,DELETE') v", [ident(name)])).rows[0].v, false, `anon on ${name}`);
    }
    for (const name of untenanted) {
      assert.equal((await db.query("select has_table_privilege('authenticated',$1,'SELECT,INSERT,UPDATE,DELETE') v", [ident(name)])).rows[0].v, false, `authenticated on ${name}`);
    }
    await h.asUser(null, 'anon');
    for (const { name } of tenantTables) await assert.rejects(db.query(`select 1 from ${ident(name)} limit 1`), e => e.code === '42501', `anon select ${name}`);
  });

  await t.test('each role of company X sees only X rows and none of company Y in every tenant table', async () => {
    for (const key of ['A', 'B']) {
      const own = tenant[key].companyId, foreign = tenant[other[key]].companyId;
      for (const role of ROLES) {
        await h.asUser(people[key][role]);
        for (const { name, column } of tenantTables) {
          const where = `${column} = $1`;
          assert.equal(await countRows(`select count(*)::int n from ${ident(name)} where ${where}`, [foreign]), 0, `${key}/${role} reads foreign ${name}`);
          assert.equal(await countRows(`select count(*)::int n from ${ident(name)} where ${column} <> $1`, [own]), 0, `${key}/${role}: ${name} holds only own rows`);
        }
      }
    }
    // Own data is really visible (the test is not vacuous): every role sees its company's seeded rows in the main tables.
    for (const key of ['A', 'B']) {
      for (const role of ROLES) {
        await h.asUser(people[key][role]);
        for (const name of ['positions', 'recruitments', 'candidates', 'applications', 'candidate_assessments', 'screening_analysis_versions', 'screening_criterion_results', 'screening_result_reviews', 'recruitment_shortlist_entries']) {
          assert.ok((await db.query(`select count(*)::int n from ${ident(name)} where company_id=$1`, [tenant[key].companyId])).rows[0].n > 0, `${key}/${role} sees own ${name}`);
        }
      }
    }
  });

  await t.test('screening scores, assessments, reviews, shortlist and history of the other company stay unreadable by id', async () => {
    for (const key of ['A', 'B']) {
      const foreign = tenant[other[key]];
      for (const role of ROLES) {
        await h.asUser(people[key][role]);
        const byId = [
          ['screening_analysis_versions', 'id', foreign.analysis_id],
          ['screening_analysis_attempts', 'id', foreign.attempt_id],
          ['screening_criterion_results', 'analysis_id', foreign.analysis_id],
          ['screening_result_reviews', 'analysis_id', foreign.analysis_id],
          ['candidate_assessments', 'id', foreign.assessment.id],
          ['recruitment_shortlist_entries', 'id', foreign.entryId],
          ['candidate_documents', 'id', foreign.documentId],
          ['application_stage_events', 'application_id', foreign.application.id],
          ['application_decision_events', 'application_id', foreign.application.id],
        ];
        for (const [table, column, value] of byId) {
          assert.equal((await db.query(`select count(*)::int n from ${ident(table)} where ${column}=$1`, [value])).rows[0].n, 0, `${key}/${role} reads ${table} of ${other[key]}`);
        }
        // Even the unfiltered score columns never leak an overall score or review text of the other company.
        const scores = (await db.query('select company_id, overall_score from public.screening_analysis_versions')).rows;
        assert.ok(scores.length > 0 && scores.every(row => row.company_id === tenant[key].companyId), `${key}/${role} score list is own only`);
      }
    }
  });

  await t.test('direct writes into the other company are refused or change nothing: SELECT/UPDATE/DELETE/INSERT in every tenant table', async () => {
    const before = await snapshot();
    for (const key of ['A', 'B']) {
      const foreign = tenant[other[key]].companyId;
      for (const role of ROLES) {
        await h.asUser(people[key][role]);
        for (const { name, column } of tenantTables) {
          for (const sql of [`update ${ident(name)} set ${column}=${column} where ${column}=$1 returning 1`, `delete from ${ident(name)} where ${column}=$1 returning 1`]) {
            await blocked(`${key}/${role} ${sql.split(' ')[0]} ${name}`, sql, [foreign]);
          }
        }
      }
    }
    assert.deepEqual(await snapshot(), before, 'no row of either company changed');
  });

  await t.test('inserts and foreign-key smuggling into the other company are refused', async () => {
    const before = await snapshot();
    for (const key of ['A', 'B']) {
      const own = tenant[key], foreign = tenant[other[key]];
      for (const role of ROLES) {
        await h.asUser(people[key][role]);
        const attempts = {
          positions: { company_id: foreign.companyId, title: 'Przejęta' },
          recruitments: { company_id: foreign.companyId, position_id: foreign.position.id, name: 'Przejęta' },
          candidates: { company_id: foreign.companyId, first_name: 'Obcy', last_name: 'Kandydat' },
          applications: { company_id: foreign.companyId, recruitment_id: foreign.recruitment.id, candidate_id: foreign.candidate.id },
          assessment_stages: { company_id: foreign.companyId, recruitment_id: foreign.recruitment.id, name: 'Obcy', sequence: 9 },
          candidate_assessments: { company_id: foreign.companyId, recruitment_id: foreign.recruitment.id, application_id: foreign.application.id, stage_id: foreign.stage.id },
          company_members: { company_id: foreign.companyId, user_id: people[key][role], role: 'recruiter' },
          company_profiles: { company_id: foreign.companyId },
          // Own company id, but rows pointing at the other company's records.
          'applications ': { company_id: own.companyId, recruitment_id: foreign.recruitment.id, candidate_id: own.candidate.id },
          'applications  ': { company_id: own.companyId, recruitment_id: own.recruitment.id, candidate_id: foreign.candidate.id },
          'recruitments ': { company_id: own.companyId, position_id: foreign.position.id, name: 'Obca pozycja' },
          'candidate_assessments ': { company_id: own.companyId, recruitment_id: own.recruitment.id, application_id: foreign.application.id, stage_id: own.stage.id },
        };
        for (const [label, row] of Object.entries(attempts)) {
          const table = label.trim();
          const fields = Object.keys(row);
          await assert.rejects(
            db.query(`insert into ${ident(table)}(${fields.join(',')}) values(${fields.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(row)),
            // 42501 = RLS/permission, 23503 = foreign key, P0001 = trigger/validation raise,
            // PT404 = RPC-style 'Resource unavailable' (observed for applications). Nothing else is accepted.
            e => ['42501', '23503', 'P0001', 'PT404'].includes(e.code),
            `${key}/${role} insert into ${table} (${label.length - table.length ? 'foreign reference' : 'foreign company'}) must be refused`,
          );
        }
      }
    }
    assert.deepEqual(await snapshot(), before, 'refused inserts left no trace');
  });

  await t.test('roles inside one company: viewer is read-only, recruiter cannot manage members, nobody changes the company record of another', async () => {
    const before = await snapshot();
    for (const key of ['A', 'B']) {
      const own = tenant[key];
      await h.asUser(people[key].viewer);
      for (const [table, row] of [
        ['positions', { company_id: own.companyId, title: 'Viewer nie pisze' }],
        ['candidates', { company_id: own.companyId, first_name: 'Viewer', last_name: 'Nie pisze' }],
        ['company_members', { company_id: own.companyId, user_id: people[key].viewer, role: 'recruiter' }],
      ]) {
        const fields = Object.keys(row);
        await assert.rejects(db.query(`insert into ${ident(table)}(${fields.join(',')}) values(${fields.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(row)),
          e => e.code === '42501', `${key} viewer insert ${table}`);
      }
      for (const sql of ['update public.positions set title=title where company_id=$1 returning 1', 'delete from public.positions where company_id=$1 returning 1',
        'delete from public.candidates where company_id=$1 returning 1', 'delete from public.recruitments where company_id=$1 returning 1']) {
        await blocked(`${key} viewer ${sql}`, sql, [own.companyId]);
      }
      await assert.rejects(db.query('select public.move_application_stage($1,$2,$3,$4)', [own.companyId, own.recruitment.id, own.application.id, own.stage.id]), e => e.code === '42501', `${key} viewer move stage`);
      await assert.rejects(db.query('select public.set_application_human_decision($1,$2,$3,$4,$5)', [own.companyId, own.recruitment.id, own.application.id, 'on_hold', 'Viewer nie decyduje']), e => e.code === '42501', `${key} viewer decision`);
      await h.asUser(people[key].recruiter);
      await assert.rejects(db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter')", [own.companyId, people[other[key]].viewer]), e => e.code === '42501', `${key} recruiter adds member`);
      await blocked(`${key} recruiter changes company`, "update public.companies set name='Zmieniona' where id=$1 returning 1", [own.companyId]);
      await blocked(`${key} viewer changes company`, "update public.companies set name='Zmieniona' where id=$1 returning 1", [own.companyId]);
    }
    assert.deepEqual(await snapshot(), before, 'role checks changed nothing');
  });

  await t.test('RPC entry points refuse a foreign company for every role (scores, reviews, shortlist, stages, decisions, exports, history)', async () => {
    const before = await snapshot();
    for (const key of ['A', 'B']) {
      const f = tenant[other[key]];
      const calls = [
        ['get_screening_ranking', 'select * from public.get_screening_ranking($1,null)', [f.recruitment.id]],
        ['get_recruitment_shortlist', 'select * from public.get_recruitment_shortlist($1,false)', [f.recruitment.id]],
        ['start_screening_analysis', "select * from public.start_screening_analysis($1,$2,1,1,'screening-v1','openai','tenant-test-model',null,$3,true)", [f.application.id, f.fingerprint, randomUUID()]],
        ['review_screening_result', "select public.review_screening_result($1,1,'approved',null,'[]'::jsonb)", [f.analysis_id]],
        ['review_candidate_document', 'select public.review_candidate_document($1,1)', [f.documentId]],
        ['add_recruitment_shortlist_entry', "select public.add_recruitment_shortlist_entry($1,'manual',$2,$3,$4,null,null)", [f.application.id, f.analysis_id, f.reviewId, 'screening-ranking-v1']],
        ['remove_recruitment_shortlist_entry', 'select public.remove_recruitment_shortlist_entry($1)', [f.entryId]],
        ['move_application_stage', 'select public.move_application_stage($1,$2,$3,$4)', [f.companyId, f.recruitment.id, f.application.id, f.stage.id]],
        ['move_assessment_stage', 'select public.move_assessment_stage($1,$2,$3,1)', [f.companyId, f.recruitment.id, f.stage.id]],
        ['set_application_human_decision', "select public.set_application_human_decision($1,$2,$3,'closed','Przejęcie')", [f.companyId, f.recruitment.id, f.application.id]],
        ['record_candidate_report_export', "select public.record_candidate_report_export($1,$2,$3,'candidate_report_csv',1)", [f.companyId, f.recruitment.id, f.application.id]],
        ['list_candidate_report_exports', 'select * from public.list_candidate_report_exports($1,$2,$3)', [f.companyId, f.recruitment.id, f.application.id]],
        ['list_company_report_exports', 'select * from public.list_company_report_exports($1)', [f.companyId]],
        ['get_candidate_communication_history', 'select * from public.get_candidate_communication_history($1,null,null,10)', [f.candidate.id]],
        ['get_preselection_group_history', 'select * from public.get_preselection_group_history($1)', [f.application.id]],
        ['get_preselection_groups', 'select public.get_preselection_groups($1)', [f.recruitment.id]],
        ['get_retention_schedule', 'select public.get_retention_schedule($1)', [f.companyId]],
      ];
      for (const role of ROLES) {
        await h.asUser(people[key][role]);
        for (const [name, sql, params] of calls) {
          // Observed denials are 42501 (no access) and PT404 (resource unavailable); any other error would not prove isolation.
          await blocked(`${key}/${role} ${name} on the other company`, sql, params, ['42501', 'PT404']);
        }
      }
    }
    assert.deepEqual(await snapshot(), before, 'RPC attempts changed nothing, wrote no audit/history row');
    // A person outside both companies sees and changes nothing either.
    await h.asUser(users.outsider);
    for (const { name, column } of tenantTables) {
      assert.equal(await countRows(`select count(*)::int n from ${ident(name)}`), 0, `outsider reads ${name}`);
    }
    for (const key of ['A', 'B']) {
      await assert.rejects(db.query('select * from public.list_company_report_exports($1)', [tenant[key].companyId]), e => e.code === '42501');
    }
  });

  await t.test('concurrent work of both companies from separate sessions never leaks across', async () => {
    const sessions = {};
    for (const key of ['A', 'B']) {
      for (const role of ROLES) {
        const client = await env.connect();
        const harness = createRankingHarness(client);
        await harness.asUser(people[key][role]);
        sessions[`${key}${role}`] = { client, harness, key };
      }
    }
    const ROUNDS = 6;
    const created = { A: [], B: [] };
    const worker = async key => {
      const own = tenant[key], foreignCompany = tenant[other[key]].companyId, foreign = tenant[other[key]];
      const s = sessions[`${key}owner`], r = sessions[`${key}recruiter`], v = sessions[`${key}viewer`];
      for (let i = 0; i < ROUNDS; i++) {
        // Owner writes inside an open transaction while the foreign company reads and attacks concurrently.
        await s.client.query('begin');
        const candidate = await s.harness.insert('candidates', { company_id: own.companyId, first_name: 'Rownolegly', last_name: `${key}-${i}` });
        created[key].push(candidate.id);
        const application = await s.harness.insert('applications', { company_id: own.companyId, recruitment_id: own.recruitment.id, candidate_id: candidate.id });
        const [recruiterView, viewerView, foreignRead, foreignWrite, foreignDelete] = await Promise.all([
          r.client.query('select distinct company_id from public.candidates'),
          v.client.query('select distinct company_id from public.applications'),
          s.client.query('select count(*)::int n from public.candidates where company_id=$1', [foreignCompany]),
          s.client.query('update public.candidates set last_name=last_name where company_id=$1 returning id', [foreignCompany]).catch(e => ({ rows: [], code: e.code })),
          s.client.query('delete from public.applications where company_id=$1 returning id', [foreignCompany]).catch(e => ({ rows: [], code: e.code })),
        ].map(p => p.catch(e => { throw e; })));
        assert.deepEqual(recruiterView.rows.map(x => x.company_id), [own.companyId], `${key} recruiter sees only own candidates`);
        assert.deepEqual(viewerView.rows.map(x => x.company_id), [own.companyId], `${key} viewer sees only own applications`);
        assert.equal(foreignRead.rows[0].n, 0, `${key} owner reads foreign candidates`);
        assert.equal(foreignWrite.rows.length, 0, `${key} owner updated foreign candidates`);
        assert.equal(foreignDelete.rows.length, 0, `${key} owner deleted foreign applications`);
        await s.client.query('commit');
        // The other company's sessions never see this company's committed or in-flight rows.
        const peer = sessions[`${other[key]}recruiter`];
        assert.equal((await peer.client.query('select count(*)::int n from public.candidates where id=$1 or company_id=$2', [candidate.id, own.companyId])).rows[0].n, 0, `${other[key]} recruiter sees ${key} candidate`);
        assert.equal((await peer.client.query('select count(*)::int n from public.applications where id=$1', [application.id])).rows[0].n, 0);
        // Screening read paths run in parallel for both tenants.
        const ranking = await s.client.query('select * from public.get_screening_ranking($1,null)', [own.recruitment.id]);
        assert.ok(ranking.rows.every(row => !row.application_id || row.application_id !== foreign.application.id), `${key} ranking contains the other company's application`);
      }
    }
    await Promise.all([worker('A'), worker('B')]);

    // Parallel complete screening cycles (start -> worker -> review) in both companies at the same time.
    const cycle = async key => {
      const s = sessions[`${key}owner`];
      const fx = await s.harness.candidate({ owner: people[key].owner, companyId: tenant[key].companyId, position: tenant[key].position, recruitment: tenant[key].recruitment }, `${key}-parallel`);
      return s.harness.completedApplication(fx, Array(5).fill('above'));
    };
    const [doneA, doneB] = await Promise.all([cycle('A'), cycle('B')]);
    for (const [key, done] of [['A', doneA], ['B', doneB]]) {
      const foreign = key === 'A' ? doneB : doneA;
      for (const role of ROLES) {
        const s = sessions[`${key}${role}`];
        assert.equal((await s.client.query('select count(*)::int n from public.screening_analysis_versions where id=$1', [done.analysis_id])).rows[0].n, 1, `${key}/${role} sees own new score`);
        assert.equal((await s.client.query('select count(*)::int n from public.screening_analysis_versions where id=$1', [foreign.analysis_id])).rows[0].n, 0, `${key}/${role} sees foreign score`);
        assert.equal((await s.client.query('select count(*)::int n from public.screening_result_reviews where analysis_id=$1', [foreign.analysis_id])).rows[0].n, 0);
        assert.equal((await s.client.query('select count(*)::int n from public.screening_criterion_results where analysis_id=$1', [foreign.analysis_id])).rows[0].n, 0);
      }
    }
    // Ground truth as admin: every row each company created is attributed to that company only.
    await h.asAdmin();
    for (const key of ['A', 'B']) {
      const rows = (await db.query('select id, company_id from public.candidates where id = any($1::uuid[])', [created[key]])).rows;
      assert.equal(rows.length, ROUNDS, `${key} created candidates`);
      assert.ok(rows.every(row => row.company_id === tenant[key].companyId), `${key} candidates belong to ${key}`);
    }
    for (const { name, column } of tenantTables) {
      const bad = (await db.query(`select count(*)::int n from ${ident(name)} where ${column} not in ($1,$2)`, [tenant.A.companyId, tenant.B.companyId])).rows[0].n;
      assert.equal(bad, 0, `${name} contains only the two fixture companies`);
    }
  });
});
