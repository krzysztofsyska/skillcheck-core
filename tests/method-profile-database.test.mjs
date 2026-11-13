// SC-METHOD / #275 — profil metody stanowiska i macierz dowodów w bazie.
// Natywny PostgreSQL 16/17, pełny łańcuch migracji, dwie syntetyczne firmy.
// Sprawdza: ścieżkę pozytywną od propozycji (lib/method-profile.ts) do
// zatwierdzonej wersji, brak danych, nieuprawnioną rolę, dostęp między firmami,
// niezmienność historii oraz to, że nowa wersja metody nie zmienia rozpoczętej
// próby ani definicji zadania, z którą próba jest związana.
// Dane są fikcyjne; żadnego prawdziwego kandydata, CV ani firmy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { activeBoot, users, definition } from './helpers/competency-active-fixture.mjs';
import {
  proposeMethodProfile, methodProfileProblems, methodProfileError, parseMethodProfileContent, parseMethodProfileState, parseMethodVersion,
} from '../lib/method-profile.ts';

const migration = '20261112100000_sc_method_profile.sql';
// Inventory signature SC-METHOD was reviewed against (R15) and the one of the full current chain
// (R16 since SC-AC-SESSION #276). Schema `method` itself stays outside the inventory.
const r15 = '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44';
const signature = '8ad238e75d4d4ccb82e03b89f368ba06483580781494fe1f7f9306a3c9c7f73f';
const code = (...codes) => error => codes.includes(error.code);
const says = (sqlstate, text) => error => error.code === sqlstate && error.message.includes(text);
const sql = name => readFile(new URL(`../supabase/${name}`, import.meta.url), 'utf8');
const functions = [
  'method_profile_save_draft(uuid,uuid,jsonb,integer)', 'method_profile_approve(uuid,uuid,integer)',
  'method_profile_state(uuid,uuid)', 'method_profile_version(uuid,uuid)',
  'method_bind_definition(uuid,uuid)', 'method_bind_recruitment_definitions(uuid,uuid)', 'method_definition_binding(uuid,uuid)',
];

test('SC-METHOD method profile: approval, missing data, roles, tenant isolation and started attempts', async t => {
  const e = await activeBoot(t, { fullChain: true });
  const { db, h, call } = e;
  const save = (companyId, positionId, content, revision) =>
    call('public.method_profile_save_draft', [companyId, positionId, JSON.stringify(content), revision]);
  const approve = (companyId, positionId, revision) => call('public.method_profile_approve', [companyId, positionId, revision]);
  const state = async (companyId, positionId) => parseMethodProfileState(await call('public.method_profile_state', [companyId, positionId]));
  const position = async id => (await db.query('select * from public.positions where id=$1', [id])).rows[0];

  // Firma A ma definicję zadania utworzoną ZANIM powstała jakakolwiek metoda.
  const a = await e.seed();
  const b = await e.seed({ owner: users.otherOwner });
  await h.asAdmin();
  await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter'),($1,$3,'viewer')",
    [a.companyId, users.recruiter, users.viewer]);
  const positionA = await position(a.position.id);
  const proposal = proposeMethodProfile(positionA, 'specialist');

  await t.test('installs outside the SC-010 inventory: signature unchanged, schema closed to API roles', async () => {
    await h.asAdmin();
    assert.equal((await db.query("select count(*)::int n from pg_namespace where nspname='method'")).rows[0].n, 1,
      `${migration} must be part of the checked-in chain`);
    assert.equal((await db.query('select private.erasure_schema_signature() v')).rows[0].v, signature);
    const tables = (await db.query(`select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='method' and c.relkind='r' order by 1`)).rows;
    assert.deepEqual(tables, [{ relname: 'definition_bindings', relrowsecurity: true }, { relname: 'profile_versions', relrowsecurity: true }]);
    assert.equal((await db.query("select count(*)::int n from pg_policies where schemaname='method'")).rows[0].n, 0, 'deny by default: no policies');
    // Żaden więz ze schematu `method` nie wskazuje na public/private (to zmieniłoby sygnaturę SC-010).
    assert.equal((await db.query(`select count(*)::int n from pg_constraint k
      join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace
      join pg_class f on f.oid=k.confrelid join pg_namespace fn on fn.oid=f.relnamespace
      where n.nspname='method' and fn.nspname<>'method'`)).rows[0].n, 0);
    for (const role of ['anon', 'authenticated', 'screening_worker']) {
      assert.equal((await db.query("select has_schema_privilege($1,'method','USAGE') v", [role])).rows[0].v, false, role);
      for (const table of ['method.profile_versions', 'method.definition_bindings']) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          assert.equal((await db.query('select has_table_privilege($1,$2,$3) v', [role, table, privilege])).rows[0].v, false, `${role} ${privilege} ${table}`);
        }
      }
      for (const fn of functions) {
        assert.equal((await db.query("select has_function_privilege($1,$2,'EXECUTE') v", [role, `public.${fn}`])).rows[0].v,
          role === 'authenticated', `${role} ${fn}`);
      }
    }
    const definer = (await db.query(`select p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname like 'method\\_%' order by 1`)).rows;
    assert.equal(definer.length, functions.length);
    for (const row of definer) {
      assert.equal(row.prosecdef, true, row.proname);
      assert.deepEqual(row.proconfig, ['search_path=""'], row.proname);
    }
    await h.asUser(users.owner);
    await assert.rejects(db.query('select * from method.profile_versions'), code('42501'));
    await assert.rejects(db.query('select * from method.definition_bindings'), code('42501'));
  });

  let v1;
  await t.test('positive path: proposal -> draft -> recruiter correction -> approved immutable version', async () => {
    await h.asUser(users.owner);
    assert.deepEqual(await state(a.companyId, a.position.id), { can_edit: true, revision: 0, draft: null, approved: null, history: [] });
    assert.deepEqual(methodProfileProblems(proposal.content, positionA.required_competencies), [], 'the proposal is complete for this position');
    assert.equal(await save(a.companyId, a.position.id, proposal.content, 0), 1);
    const drafted = await state(a.companyId, a.position.id);
    assert.deepEqual(drafted.draft.content, proposal.content, 'stored draft equals the canonical proposal');
    assert.equal(drafted.approved, null);

    // Rekruter (nie właściciel) koryguje propozycję przed zatwierdzeniem.
    await h.asUser(users.recruiter);
    const corrected = structuredClone(proposal.content);
    corrected.goal = '  Utrzymać poprawne raporty sprzedaży dla zarządu.  ';
    corrected.matrix[0].criteria = ['Raport bez błędów w danych źródłowych.', '', 'Raport oddany w uzgodnionym terminie.'];
    corrected.matrix[0].method = 'case_study';
    assert.equal(await save(a.companyId, a.position.id, corrected, 1), 2);
    v1 = await approve(a.companyId, a.position.id, 2);

    const approved = await state(a.companyId, a.position.id);
    assert.equal(approved.draft, null, 'approval consumes the draft');
    assert.equal(approved.revision, 3, 'approval advances the change counter too');
    assert.equal(approved.approved.id, v1);
    assert.equal(approved.approved.version_no, 1);
    assert.match(approved.approved.content_hash, /^[0-9a-f]{64}$/);
    assert.equal(approved.approved.content.goal, 'Utrzymać poprawne raporty sprzedaży dla zarządu.', 'text is trimmed');
    assert.deepEqual(approved.approved.content.matrix[0].criteria,
      ['Raport bez błędów w danych źródłowych.', 'Raport oddany w uzgodnionym terminie.'], 'empty criteria are dropped');
    assert.equal(approved.approved.content.matrix[0].method, 'case_study', 'the recruiter correction is what gets approved');
    assert.deepEqual(approved.approved.content.matrix.slice(1), proposal.content.matrix.slice(1));
    assert.deepEqual(approved.approved.position_snapshot.required_competencies, positionA.required_competencies);
    assert.equal(approved.approved.position_snapshot.autonomy_level, positionA.autonomy_level);
    assert.deepEqual(approved.history.map(row => [row.id, row.version_no, row.responsibility_level]), [[v1, 1, 'specialist']]);
    assert.deepEqual(parseMethodVersion(await call('public.method_profile_version', [a.companyId, v1])).content, approved.approved.content);
    // Zapis profilu metody nie dotyka profilu stanowiska, więc nie unieważnia analiz CV.
    assert.equal((await position(a.position.id)).updated_at.toISOString(), positionA.updated_at.toISOString());
  });

  await t.test('missing data: an incomplete profile cannot be approved and says what is missing', async () => {
    await h.asUser(users.owner);
    const empty = await h.insert('positions', { company_id: a.companyId, title: 'Stanowisko bez kompetencji',
      tasks: ['Zadanie'], kpis: ['Miernik'], required_competencies: [], status: 'active' });
    const bare = proposeMethodProfile(empty, 'manager');
    assert.deepEqual(bare.missing, ['competencies']);
    assert.equal(await save(a.companyId, empty.id, bare.content, 0), 1);
    await assert.rejects(approve(a.companyId, empty.id, 1), error => {
      assert.ok(says('22023', 'method_profile_incomplete:position.competencies')(error));
      assert.match(methodProfileError(error), /nie ma żadnej kompetencji/);
      return true;
    });

    const target = await h.insert('positions', { company_id: a.companyId, title: 'Kierownik zmiany',
      tasks: ['Planowanie zmian'], kpis: ['Terminowość'], required_competencies: ['Planowanie pracy', 'Rozmowa z pracownikiem'], status: 'active' });
    const full = proposeMethodProfile(target, 'manager').content;
    const broken = [
      ['goal', c => { c.goal = ''; }],
      ['expectedOutcome', c => { c.expectedOutcome = '   '; }],
      ['constraints', c => { c.constraints = ''; }],
      ['responsibilityLevel', c => { c.responsibilityLevel = ''; }],
      ['matrix.evidence', c => { c.matrix[1].evidence = ''; }],
      ['matrix.method', c => { c.matrix[0].method = ''; }],
      ['matrix.justification', c => { c.matrix[0].justification = ''; }],
      ['matrix.criteria', c => { c.matrix[1].criteria = ['  ']; }],
      ['matrix.limits', c => { c.matrix[0].limits = ''; }],
      ['matrix.coverage', c => { c.matrix.pop(); }],
      ['matrix.coverage', c => { c.matrix = []; }],
      ['matrix.unknown', c => { c.matrix.push({ ...c.matrix[0], competency: 'Kompetencja spoza profilu' }); }],
    ];
    let revision = 0;
    for (const [field, mutate] of broken) {
      const content = structuredClone(full); mutate(content);
      revision = await save(a.companyId, target.id, content, revision);
      assert.ok(methodProfileProblems(parseMethodProfileContent(content), target.required_competencies).length > 0, `${field}: lib reports the gap`);
      await assert.rejects(approve(a.companyId, target.id, revision), error => {
        assert.ok(says('22023', `method_profile_incomplete:${field}`)(error), `${field}: ${error.message}`);
        assert.match(methodProfileError(error), /^Nie można zatwierdzić: /);
        return true;
      });
    }
    assert.equal((await state(a.companyId, target.id)).approved, null, 'nothing was approved');

    // Zły kształt nie trafia nawet do szkicu.
    for (const invalid of [[], 'tekst', { ...full, responsibilityLevel: 'prezes' }, { ...full, goal: 'x'.repeat(1001) },
      { ...full, matrix: [{ ...full.matrix[0], method: 'wrozenie' }] }, { ...full, matrix: [full.matrix[0], full.matrix[0]] },
      { ...full, matrix: [{ ...full.matrix[0], competency: '' }] }, { ...full, matrix: 'x' },
      { ...full, matrix: [{ ...full.matrix[0], criteria: Array(9).fill('k') }] }]) {
      await assert.rejects(save(a.companyId, target.id, invalid, revision), says('22023', 'method_profile_invalid'));
    }
    // Nieaktualny numer zapisu i brak szkicu.
    await assert.rejects(save(a.companyId, target.id, full, revision - 1), code('PT409'));
    await assert.rejects(approve(a.companyId, target.id, revision - 1), code('PT409'));
    await assert.rejects(approve(a.companyId, a.position.id, 1), code('PT409'), 'no draft to approve');
    // Kompletny profil przechodzi; zmiana kompetencji w profilu stanowiska blokuje kolejne zatwierdzenie starej macierzy.
    revision = await save(a.companyId, target.id, full, revision);
    await approve(a.companyId, target.id, revision);
    await db.query("update public.positions set required_competencies=array['Planowanie pracy','Budżet zmiany'] where id=$1", [target.id]);
    const next = await save(a.companyId, target.id, full, revision + 1);
    assert.equal(next, revision + 2);
    await assert.rejects(approve(a.companyId, target.id, next), says('22023', 'method_profile_incomplete:matrix.coverage'));
    await db.query("update public.positions set status='archived' where id=$1", [target.id]);
    await assert.rejects(save(a.companyId, target.id, full, next), says('55000', 'method_position_archived'));
  });

  await t.test('unauthorised role: viewer reads approved versions only; anon and outsiders get nothing', async () => {
    await h.asUser(users.owner);
    assert.equal(await save(a.companyId, a.position.id, proposal.content, 3), 4);
    await h.asUser(users.viewer);
    const seen = await state(a.companyId, a.position.id);
    assert.equal(seen.can_edit, false);
    assert.equal(seen.draft, null, 'a viewer does not see the working draft');
    assert.equal(seen.approved.id, v1);
    await assert.rejects(save(a.companyId, a.position.id, proposal.content, 4), says('42501', 'method_forbidden'));
    await assert.rejects(approve(a.companyId, a.position.id, 4), says('42501', 'method_forbidden'));
    await assert.rejects(call('public.method_bind_definition', [a.companyId, a.definitionId]), says('42501', 'method_forbidden'));
    await assert.rejects(call('public.method_bind_recruitment_definitions', [a.companyId, a.recruitment.id]), says('42501', 'method_forbidden'));
    for (const outsider of [users.outsider, null]) {
      await h.asUser(outsider);
      await assert.rejects(state(a.companyId, a.position.id), code('42501'));
      await assert.rejects(save(a.companyId, a.position.id, proposal.content, 4), code('42501'));
      await assert.rejects(approve(a.companyId, a.position.id, 4), code('42501'));
      await assert.rejects(call('public.method_profile_version', [a.companyId, v1]), code('42501'));
      await assert.rejects(call('public.method_bind_definition', [a.companyId, a.definitionId]), code('42501'));
      await assert.rejects(call('public.method_bind_recruitment_definitions', [a.companyId, a.recruitment.id]), code('42501'));
      await assert.rejects(call('public.method_definition_binding', [a.companyId, a.definitionId]), code('42501'));
    }
    await h.asUser(null, 'anon');
    for (const [name, args] of [['method_profile_state', [a.companyId, a.position.id]], ['method_profile_version', [a.companyId, v1]],
      ['method_profile_save_draft', [a.companyId, a.position.id, '{}', 0]], ['method_profile_approve', [a.companyId, a.position.id, 1]],
      ['method_bind_definition', [a.companyId, a.definitionId]], ['method_bind_recruitment_definitions', [a.companyId, a.recruitment.id]],
      ['method_definition_binding', [a.companyId, a.definitionId]]]) {
      await assert.rejects(call(`public.${name}`, args), code('42501'), `anon ${name}`);
    }
    await h.asUser(users.owner);
    assert.equal((await state(a.companyId, a.position.id)).draft.revision, 4, 'refused calls changed nothing');
  });

  await t.test('cross-company: company B cannot read, write, approve or bind anything of company A', async () => {
    await h.asUser(users.otherOwner);
    await assert.rejects(state(a.companyId, a.position.id), code('42501'));
    await assert.rejects(save(a.companyId, a.position.id, proposal.content, 4), code('42501'));
    await assert.rejects(approve(a.companyId, a.position.id, 4), code('42501'));
    await assert.rejects(call('public.method_profile_version', [a.companyId, v1]), code('42501'));
    await assert.rejects(call('public.method_bind_definition', [a.companyId, a.definitionId]), code('42501'));
    await assert.rejects(call('public.method_bind_recruitment_definitions', [a.companyId, a.recruitment.id]), code('42501'));
    await assert.rejects(call('public.method_bind_recruitment_definitions', [b.companyId, a.recruitment.id]), code('42501'));
    // Identyfikatory firmy A pod własnym company_id też nie przechodzą.
    await assert.rejects(state(b.companyId, a.position.id), code('42501'));
    await assert.rejects(save(b.companyId, a.position.id, proposal.content, 0), code('42501'));
    await assert.rejects(approve(b.companyId, a.position.id, 4), code('42501'));
    assert.equal(await call('public.method_profile_version', [b.companyId, v1]), null);
    await assert.rejects(call('public.method_bind_definition', [b.companyId, a.definitionId]), code('42501'));
    assert.equal(await call('public.method_definition_binding', [b.companyId, a.definitionId]), null);
    // Własne dane firmy B działają i nie mieszają się z firmą A.
    const own = proposeMethodProfile(await position(b.position.id), 'director').content;
    assert.equal(await save(b.companyId, b.position.id, own, 0), 1);
    const vB = await approve(b.companyId, b.position.id, 1);
    await h.asUser(users.owner);
    assert.equal(await call('public.method_profile_version', [a.companyId, vB]), null);
    assert.deepEqual((await state(a.companyId, a.position.id)).history.map(row => row.id), [v1]);
  });

  await t.test('history is immutable for every role, including the table owner', async () => {
    await h.asAdmin();
    await assert.rejects(db.query("update method.profile_versions set content=jsonb_set(content,'{goal}','\"x\"') where id=$1", [v1]), says('42501', 'method_history_immutable'));
    await assert.rejects(db.query("update method.profile_versions set status='draft', version_no=null, approved_at=null, approved_by=null, content_hash=null, position_snapshot=null where id=$1", [v1]), says('42501', 'method_history_immutable'));
    await assert.rejects(db.query('delete from method.profile_versions where id=$1', [v1]), says('42501', 'method_history_immutable'));
    await assert.rejects(db.query("update method.profile_versions set company_id=$1 where status='draft' and company_id=$2", [b.companyId, a.companyId]), says('42501', 'method_history_immutable'));
  });

  await t.test('a new method version changes neither a started attempt nor the definition it is bound to', async () => {
    // Definicja sprzed pierwszej metody: nie ma z czym jej związać.
    await h.asUser(users.owner);
    assert.equal(await call('public.method_bind_definition', [a.companyId, a.definitionId]), null);
    assert.equal(await call('public.method_definition_binding', [a.companyId, a.definitionId]), null);

    // Nowa definicja powstaje po zatwierdzeniu v1; kandydat rozpoczyna próbę.
    const r = await e.started({ tenant: a });
    await h.asUser(users.recruiter);
    assert.equal(await call('public.method_bind_definition', [a.companyId, r.f.definitionId]), v1);
    const snapshot = async () => {
      await h.asAdmin();
      const attempt = (await db.query('select * from public.competency_test_attempts where definition_entry_id=$1', [r.f.definitionId])).rows;
      const entry = (await db.query('select * from public.exercise_definition_entries where id=$1', [r.f.definitionId])).rows;
      const grant = (await db.query('select id, definition_entry_id, application_id from private.competency_test_grants where definition_entry_id=$1', [r.f.definitionId])).rows;
      await h.asUser(users.owner);
      return { attempt, entry, grant,
        binding: await call('public.method_definition_binding', [a.companyId, r.f.definitionId]),
        version: await call('public.method_profile_version', [a.companyId, v1]) };
    };
    const before = await snapshot();
    assert.equal(before.attempt.length, 1, 'the attempt has started');
    assert.equal(before.attempt[0].definition_entry_id, r.f.definitionId);
    assert.equal(before.binding.method_version_id, v1);
    assert.equal(before.binding.version_no, 1);
    assert.equal(before.binding.content_hash, before.version.content_hash);

    // Rekruter zmienia metodę: inny poziom, inne kryteria -> wersja 2.
    await h.asUser(users.recruiter);
    const next = proposeMethodProfile(positionA, 'manager').content;
    assert.equal(await save(a.companyId, a.position.id, next, 4), 5, 'editing the draft');
    assert.deepEqual(await snapshot(), before, 'saving a draft changes nothing that has started');
    await h.asUser(users.recruiter);
    const v2 = await approve(a.companyId, a.position.id, 5);
    assert.notEqual(v2, v1);
    const after = await snapshot();
    assert.deepEqual(after, before, 'approving version 2 changes neither the attempt, the definition, the grant nor the binding');

    const current = await state(a.companyId, a.position.id);
    assert.equal(current.approved.id, v2);
    assert.equal(current.approved.version_no, 2);
    assert.equal(current.approved.content.responsibilityLevel, 'manager');
    assert.notEqual(current.approved.content_hash, before.version.content_hash);
    assert.notDeepEqual(current.approved.content.matrix.map(row => row.criteria), before.version.content.matrix.map(row => row.criteria),
      'the two levels carry different criteria');
    assert.deepEqual(current.history.map(row => [row.version_no, row.responsibility_level]), [[2, 'manager'], [1, 'specialist']]);

    // Powiązanie jest idempotentne i nie przeskakuje na nowszą wersję.
    assert.equal(await call('public.method_bind_definition', [a.companyId, r.f.definitionId]), v1);
    assert.equal(await call('public.method_bind_definition', [a.companyId, a.definitionId]), null, 'still older than any approved method');
    // Dopiero NOWA wersja definicji wiąże się z wersją 2.
    const fresh = await call('public.save_exercise_definition',
      [a.recruitment.id, randomUUID(), JSON.stringify(definition()), 0, a.position.id, a.position.updated_at]);
    assert.equal(await call('public.method_bind_definition', [a.companyId, fresh]), v2);
    assert.equal((await call('public.method_definition_binding', [a.companyId, fresh])).version_no, 2);
    assert.deepEqual(await snapshot(), before);

    await h.asAdmin();
    await assert.rejects(db.query('update method.definition_bindings set method_version_id=$1 where definition_entry_id=$2', [v2, r.f.definitionId]), says('42501', 'method_history_immutable'));
    await assert.rejects(db.query('delete from method.definition_bindings where definition_entry_id=$1', [r.f.definitionId]), says('42501', 'method_history_immutable'));
    assert.equal((await db.query('select private.erasure_schema_signature() v')).rows[0].v, signature);
  });

  await t.test('a stale tab cannot overwrite a draft created after an approval (the counter never restarts)', async () => {
    await h.asUser(users.owner);
    const fresh = await h.insert('positions', { company_id: a.companyId, title: 'Koordynator dostaw',
      tasks: ['Planowanie tras'], kpis: ['Terminowość'], required_competencies: ['Planowanie tras'], status: 'active' });
    const first = proposeMethodProfile(fresh, 'specialist').content;
    // Karta 1 i karta 2 widzą ten sam szkic w numerze 1.
    assert.equal(await save(a.companyId, fresh.id, first, 0), 1);
    const staleTab = (await state(a.companyId, fresh.id)).revision;
    assert.equal(staleTab, 1);
    // Karta 2 zatwierdza ten szkic, a potem ktoś zaczyna NOWY szkic.
    const approved = await approve(a.companyId, fresh.id, 1);
    const afterApproval = (await state(a.companyId, fresh.id)).revision;
    assert.equal(afterApproval, 2);
    const second = { ...proposeMethodProfile(fresh, 'manager').content, goal: 'Nowy szkic drugiej osoby' };
    await h.asUser(users.recruiter);
    const newDraft = await save(a.companyId, fresh.id, second, afterApproval);
    assert.equal(newDraft, 3, 'the new draft continues the numbering instead of restarting at 1');
    // Karta 1 nadal ma numer 1: zapis i zatwierdzenie muszą dać konflikt, a nowy szkic zostać nietknięty.
    await h.asUser(users.owner);
    await assert.rejects(save(a.companyId, fresh.id, { ...first, goal: 'Stara karta' }, staleTab), says('PT409', 'method_draft_changed'));
    await assert.rejects(approve(a.companyId, fresh.id, staleTab), says('PT409', 'method_draft_changed'));
    // Karta otwarta tuż przed zatwierdzeniem (numer szkicu sprzed zatwierdzenia) też nie tworzy szkicu po cichu.
    await assert.rejects(save(a.companyId, fresh.id, first, 0), says('PT409', 'method_draft_changed'));
    const now = await state(a.companyId, fresh.id);
    assert.equal(now.revision, 3);
    assert.equal(now.draft.revision, 3);
    assert.equal(now.draft.content.goal, 'Nowy szkic drugiej osoby', 'the newer draft was not overwritten');
    assert.equal(now.approved.id, approved);
    // Zatwierdzenie bez szkicu po drodze: numer sprzed zatwierdzenia nie pozwala założyć nowego szkicu.
    const solo = await h.insert('positions', { company_id: a.companyId, title: 'Magazynier',
      tasks: ['Kompletacja'], kpis: ['Bezbłędność'], required_competencies: ['Kompletacja zamówień'], status: 'active' });
    const soloContent = proposeMethodProfile(solo, 'specialist').content;
    assert.equal(await save(a.companyId, solo.id, soloContent, 0), 1);
    await approve(a.companyId, solo.id, 1);
    await assert.rejects(save(a.companyId, solo.id, soloContent, 1), says('PT409', 'method_draft_changed'));
    assert.equal(await save(a.companyId, solo.id, soloContent, 2), 3);
  });

  await t.test('whitespace: a competency saved with a trailing tab or newline can still be covered and approved', async () => {
    await h.asUser(users.owner);
    // Zapis prosto przez API, z pominięciem formularza, który przycina wiersze.
    const messy = await h.insert('positions', { company_id: a.companyId, title: 'Specjalista wsparcia',
      tasks: ['Obsługa zgłoszeń'], kpis: ['Czas odpowiedzi'],
      required_competencies: ['Obsługa zgłoszeń\t', '\r\nPraca z systemem zgłoszeń\n', 'Język angielski ', ' \t '], status: 'active' });
    const stored = (await position(messy.id)).required_competencies;
    assert.equal(stored[0], 'Obsługa zgłoszeń\t', 'the position really keeps the trailing tab');
    const content = proposeMethodProfile(await position(messy.id), 'specialist').content;
    assert.deepEqual(content.matrix.map(row => row.competency), ['Obsługa zgłoszeń', 'Praca z systemem zgłoszeń', 'Język angielski']);
    assert.deepEqual(methodProfileProblems(content, stored), []);
    assert.equal(await save(a.companyId, messy.id, content, 0), 1);
    const version = parseMethodVersion(await call('public.method_profile_version', [a.companyId, await approve(a.companyId, messy.id, 1)]));
    assert.deepEqual(version.content.matrix.map(row => row.competency), ['Obsługa zgłoszeń', 'Praca z systemem zgłoszeń', 'Język angielski']);
    // Wiersz macierzy wpisany z tym samym „brudnym" tekstem też jest przycinany tak samo.
    const padded = structuredClone(content); padded.matrix[0].competency = '\tObsługa zgłoszeń\n'; padded.goal = '\n Cel \t';
    const again = await save(a.companyId, messy.id, padded, 2);
    await approve(a.companyId, messy.id, again);
    const latest = (await state(a.companyId, messy.id)).approved.content;
    assert.equal(latest.matrix[0].competency, 'Obsługa zgłoszeń');
    assert.equal(latest.goal, 'Cel');
    // Brakująca kompetencja nadal blokuje — przycinanie niczego nie maskuje.
    const short = structuredClone(content); short.matrix.pop();
    const third = await save(a.companyId, messy.id, short, again + 1);
    await assert.rejects(approve(a.companyId, messy.id, third), says('22023', 'method_profile_incomplete:matrix.coverage'));
  });

  await t.test('definitions created inside the database by the AI paths are bound without the caller knowing their id', async () => {
    await h.asAdmin();
    const [current] = (await db.query(`select id, version_no from method.profile_versions
      where company_id=$1 and position_id=$2 and status='approved' order by version_no desc limit 1`, [a.companyId, a.position.id])).rows;
    assert.equal(current.version_no, 2);
    const unbound = async () => { await h.asAdmin(); const rows = (await db.query(`select e.id from public.exercise_definition_entries e
      where e.company_id=$1 and e.recruitment_id=$2 and not exists (select 1 from method.definition_bindings b where b.definition_entry_id=e.id)
      order by e.created_at, e.id`, [a.companyId, a.recruitment.id])).rows.map(row => row.id); await h.asUser(users.recruiter); return rows; };
    const bindAll = () => call('public.method_bind_recruitment_definitions', [a.companyId, a.recruitment.id]);
    const before = await unbound();

    // 1. Generowanie propozycji AI: public.finish_exercise_ai_generation tworzy definicję w bazie.
    await h.asUser(users.recruiter);
    const key = randomUUID(), fingerprint = 'c'.repeat(64);
    const companyStamp = (await db.query('select updated_at::text value from public.company_profiles where company_id=$1', [a.companyId])).rows[0]?.value ?? null;
    const reserved = await call('public.reserve_exercise_ai_generation', [a.companyId, a.recruitment.id, key, a.position.updated_at, companyStamp, fingerprint]);
    assert.equal(reserved.claimed, true);
    const trace = { provider: 'synthetic', model: 'fixture', prompt_version: 'v1', payload_schema_version: 1, result_schema_version: 1,
      input_fingerprint: fingerprint, position_id: a.position.id, position_updated_at: a.position.updated_at };
    const generated = await call('public.finish_exercise_ai_generation',
      [a.companyId, a.recruitment.id, key, fingerprint, JSON.stringify(definition()), JSON.stringify(trace), null]);
    assert.equal(generated.status, 'completed');
    assert.equal(await call('public.method_definition_binding', [a.companyId, generated.definition_id]), null, 'the database function itself does not bind');
    // Akcja serwera zna tylko rekrutację (lib/method-binding.ts), nie id definicji.
    assert.equal(await bindAll(), 1);
    const generatedBinding = await call('public.method_definition_binding', [a.companyId, generated.definition_id]);
    assert.equal(generatedBinding.method_version_id, current.id);
    assert.equal(generatedBinding.version_no, 2);

    // 2. Korekta propozycji AI: public.edit_exercise_ai_proposal tworzy kolejną wersję definicji.
    const edited = await call('public.edit_exercise_ai_proposal', [a.companyId, a.recruitment.id, generated.definition_id, a.position.updated_at,
      JSON.stringify({ ...definition(), title: 'Poprawiona propozycja' }), a.position.updated_at]);
    assert.notEqual(edited, generated.definition_id);
    assert.equal(await call('public.method_definition_binding', [a.companyId, edited]), null);
    assert.equal(await bindAll(), 1);
    assert.equal((await call('public.method_definition_binding', [a.companyId, edited])).method_version_id, current.id);

    // 3. Zatwierdzenie propozycji AI nie tworzy definicji; ponowne wiązanie niczego nie zmienia.
    assert.equal(await bindAll(), 0, 'idempotent');
    assert.deepEqual(await call('public.method_definition_binding', [a.companyId, generated.definition_id]), generatedBinding);
    assert.deepEqual(await unbound(), before, 'only definitions older than any approved method stay unbound');
    assert.ok(before.includes(a.definitionId));

    // 4. Reguła czasu także tutaj: nowa wersja metody nie przepina istniejących powiązań, a wiąże tylko późniejsze definicje.
    const draftNo = await save(a.companyId, a.position.id, proposeMethodProfile(positionA, 'director').content, (await state(a.companyId, a.position.id)).revision);
    const v3 = await approve(a.companyId, a.position.id, draftNo);
    assert.equal(await bindAll(), 0);
    assert.equal((await call('public.method_definition_binding', [a.companyId, edited])).method_version_id, current.id);
    const later = await call('public.save_exercise_definition',
      [a.recruitment.id, randomUUID(), JSON.stringify(definition()), 0, a.position.id, a.position.updated_at]);
    assert.equal(await bindAll(), 1);
    assert.equal((await call('public.method_definition_binding', [a.companyId, later])).method_version_id, v3);
    // Wynik zbiorczy i pojedynczy są zgodne.
    assert.equal(await call('public.method_bind_definition', [a.companyId, later]), v3);
    assert.equal(await call('public.method_bind_definition', [a.companyId, edited]), current.id);
  });

  await t.test('rollback refuses while profiles exist, then removes everything and the migration re-installs', async () => {
    await h.asAdmin();
    const down = await sql('rollbacks/20261112100000_sc_method_profile_down.sql');
    await assert.rejects(db.exec(down), says('55000', 'sc_method_rollback_not_empty'));
    await db.exec('rollback');
    assert.equal((await db.query('select count(*)::int n from method.profile_versions')).rows[0].n > 0, true);
    // Jedyna droga usunięcia: uprzywilejowana procedura z jawnym wskazaniem firmy, tylko dla tej firmy.
    await db.exec('begin');
    await db.query("select set_config('method.purge_company',$1,true)", [a.companyId]);
    await assert.rejects(db.query('delete from method.profile_versions where company_id=$1', [b.companyId]), says('42501', 'method_history_immutable'));
    await db.exec('rollback');
    for (const companyId of [a.companyId, b.companyId]) {
      await db.exec('begin');
      await db.query("select set_config('method.purge_company',$1,true)", [companyId]);
      await db.query('delete from method.definition_bindings where company_id=$1', [companyId]);
      await db.query('delete from method.profile_versions where company_id=$1', [companyId]);
      await db.exec('commit');
    }
    await db.exec(down);
    assert.equal((await db.query("select to_regnamespace('method') v")).rows[0].v, null);
    assert.equal((await db.query("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'method\\_%'")).rows[0].n, 0);
    assert.equal((await db.query('select private.erasure_schema_signature() v')).rows[0].v, signature);
    await db.exec(down); // idempotentny
    // Migracja SC-METHOD jest przypięta do R15 i nie jest zmieniana. Po R16 (pełny łańcuch) jej
    // ponowna instalacja wymaga nowej, sprawdzonej migracji naprzód: odmawia atomowo.
    await assert.rejects(db.exec(await sql(`migrations/${migration}`)), says('55000', 'sc_method_source_schema_unreviewed'));
    await db.exec('rollback');
    assert.equal((await db.query("select to_regnamespace('method') v")).rows[0].v, null);
    assert.equal((await db.query('select private.erasure_schema_signature() v')).rows[0].v, signature);
  });
});

test('SC-METHOD at its reviewed position in the chain (R15): rollback, re-install and refusal of a second install', async t => {
  const e = await activeBoot(t, { fullChain: true, throughMigration: migration });
  const { db, h } = e;
  await h.asAdmin();
  const down = await sql('rollbacks/20261112100000_sc_method_profile_down.sql');
  assert.equal((await db.query('select private.erasure_schema_signature() v')).rows[0].v, r15);
  await db.exec(down);
  assert.equal((await db.query("select to_regnamespace('method') v")).rows[0].v, null);
  assert.equal((await db.query('select private.erasure_schema_signature() v')).rows[0].v, r15);
  await db.exec(down); // idempotentny
  await db.exec(await sql(`migrations/${migration}`));
  assert.equal((await db.query("select count(*)::int n from pg_namespace where nspname='method'")).rows[0].n, 1);
  assert.equal((await db.query('select private.erasure_schema_signature() v')).rows[0].v, r15);
  await assert.rejects(db.exec(await sql(`migrations/${migration}`)), says('55000', 'sc_method_already_installed'));
  await db.exec('rollback');
});
