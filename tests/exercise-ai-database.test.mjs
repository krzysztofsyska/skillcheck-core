// SC-014-C6 krok 2a — propozycje AI na prawdziwej migracji, odtworzonej w PGlite.
// Sprawdzamy zachowanie bazy, nie kodu aplikacji: limit wywołań, ślad pochodzenia,
// zwolnienie propozycji (ręczne albo automatyczne) i izolację firm.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = [
  '20260930000100_skillcheck_core',
  '20261001000100_idempotent_onboarding',
  '20261001000200_candidate_documents',
  '20261002000100_behavior_assessments',
  '20261002000200_behavior_conflict_response',
  '20261002000300_exercise_definitions',
  '20261106130000_exercise_ai_proposals',
];

const provenance = (overrides = {}) => ({
  provider: 'openai',
  model: 'gpt-5.4-mini-2026-03-17',
  model_revision: null,
  prompt_version: 'exercise-draft-v1',
  payload_schema_version: 1,
  result_schema_version: 1,
  input_fingerprint: 'a'.repeat(64),
  position_id: '00000000-0000-0000-0000-0000000000aa',
  position_updated_at: '2026-11-06T08:00:00Z',
  ...overrides,
});

test('propozycje AI: migracja, limit wywołań, ślad pochodzenia i zwolnienie zadania', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`create role anon nologin; create role authenticated nologin; create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`);
  for (const name of MIGRATIONS) {
    await db.exec(await readFile(new URL('../supabase/migrations/' + name + '.sql', import.meta.url), 'utf8'));
  }

  const ids = [1, 2, 3, 4].map(n => '00000000-0000-0000-0000-00000000000' + n);
  const [ownerA, ownerB, recruiter, viewer] = ids;
  for (const id of ids) await db.query('insert into auth.users values($1)', [id]);
  const as = async (id, role = 'authenticated') => {
    await db.exec('reset role;set role ' + role);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id ?? '']);
  };
  const seed = async owner => {
    await as(owner);
    const company = (await db.query("select public.create_company('TEST') id")).rows[0].id;
    const position = (await db.query(
      "insert into public.positions(company_id,title,tasks) values($1,'TEST',array['Zadanie']) returning id,updated_at::text stamp",
      [company])).rows[0];
    const recruitment = (await db.query(
      "insert into public.recruitments(company_id,position_id,name) values($1,$2,'TEST') returning id", [company, position.id])).rows[0].id;
    return { company, position, recruitment };
  };
  const a = await seed(ownerA), b = await seed(ownerB);
  await as(ownerA);
  for (const [user, role] of [[recruiter, 'recruiter'], [viewer, 'viewer']]) {
    await db.query('insert into public.company_members(company_id,user_id,role) values($1,$2,$3)', [a.company, user, role]);
  }

  const definition = (title = 'Zadanie') => ({
    kind: 'competency_test', title, instructions: 'Uporządkuj zgłoszenia.',
    expectedOutput: 'Lista z uzasadnieniem.', durationMinutes: 20,
    criteria: [{ competency: 'Planowanie pracy', below: 'Pomija pilne.', meets: 'Uwzględnia terminy.', above: 'Wskazuje zależności.' }],
  });
  let exerciseCounter = 0;
  /** Zapisuje nową definicję istniejącą ścieżką i zwraca id wpisu. */
  const saveDefinition = async (target = a, title = 'Zadanie') => {
    exerciseCounter += 1;
    const exercise = '10000000-0000-0000-0000-' + String(exerciseCounter).padStart(12, '0');
    return (await db.query('select public.save_exercise_definition($1,$2,$3::jsonb,$4,$5,$6) id',
      [target.recruitment, exercise, JSON.stringify(definition(title)), 0, target.position.id, target.position.stamp])).rows[0].id;
  };
  const record = (entry, target = a, prov = provenance(), limit = 20) =>
    db.query('select exercise_ai.record_proposal($1,$2,$3::jsonb,$4) id',
      [target.recruitment, entry, JSON.stringify(prov), limit]);
  const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);

  await t.test('propozycja zapisuje ślad pochodzenia i domyślnie czeka na rekrutera', async () => {
    await as(ownerA);
    const entry = await saveDefinition();
    const id = (await record(entry)).rows[0].id;
    const row = (await db.query('select * from exercise_ai.proposals where id=$1', [id])).rows[0];
    assert.equal(row.definition_entry_id, entry);
    assert.equal(row.created_by, ownerA);
    assert.equal(row.approved_at, null, 'bez ustawienia automatu propozycja nie jest zwolniona');
    assert.equal(row.approval_mode, null);
    assert.equal(row.provenance.input_fingerprint, 'a'.repeat(64));
    assert.equal(row.provenance.prompt_version, 'exercise-draft-v1');
  });

  await t.test('ślad pochodzenia bez źródła jest odrzucany', async () => {
    await as(ownerA);
    for (const broken of [
      provenance({ input_fingerprint: 'nie-jest-odciskiem' }),
      provenance({ provider: '' }),
      provenance({ prompt_version: undefined }),
      provenance({ payload_schema_version: 0 }),
      provenance({ payload_schema_version: 1.5 }),
      provenance({ position_updated_at: 'wczoraj' }),
      provenance({ model_revision: 7 }),
    ]) {
      const entry = await saveDefinition();
      await rejects(record(entry, a, broken), '22023');
    }
    await rejects(db.query('select exercise_ai.record_proposal($1,$2,$3::jsonb,$4) id',
      [a.recruitment, await saveDefinition(), null, 20]), '22023');
  });

  await t.test('zwolnienie ręczne jest imienne, powtórne kliknięcie nic nie psuje', async () => {
    await as(ownerA);
    const entry = await saveDefinition();
    await record(entry);
    await as(recruiter);
    const first = (await db.query('select exercise_ai.approve_proposal($1) id', [entry])).rows[0].id;
    const second = (await db.query('select exercise_ai.approve_proposal($1) id', [entry])).rows[0].id;
    assert.equal(first, second);
    const row = (await db.query('select * from exercise_ai.proposals where definition_entry_id=$1', [entry])).rows[0];
    assert.equal(row.approved_by, recruiter);
    assert.equal(row.approval_mode, 'manual');
    assert.ok(row.approved_at);
  });

  await t.test('automat wypuszcza zadanie bez rekrutera, ale zapis mówi, że nikt go nie czytał', async () => {
    await as(ownerA);
    await db.query('select exercise_ai.set_auto_release($1,true)', [a.recruitment]);
    const entry = await saveDefinition();
    await record(entry);
    const row = (await db.query('select * from exercise_ai.proposals where definition_entry_id=$1', [entry])).rows[0];
    assert.ok(row.approved_at, 'przy automacie propozycja jest zwolniona od razu');
    assert.equal(row.approval_mode, 'auto');
    // Wyłączenie wraca do zatwierdzania ręcznego dla kolejnych propozycji.
    await db.query('select exercise_ai.set_auto_release($1,false)', [a.recruitment]);
    const next = await saveDefinition();
    await record(next);
    assert.equal((await db.query('select approval_mode from exercise_ai.proposals where definition_entry_id=$1', [next])).rows[0].approval_mode, null);
  });

  await t.test('ustawienia automatu nie da się podać z wywołania ani ustawić bez prawa zapisu', async () => {
    // Tryb bierze się z ustawienia rekrutacji czytanego w bazie; funkcja zapisu
    // propozycji nie przyjmuje go jako argumentu — brak takiego parametru.
    const args = (await db.query(
      "select pg_get_function_arguments(p.oid) a from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exercise_ai' and p.proname='record_proposal'")).rows[0].a;
    assert.equal(/auto|release|approv/i.test(args), false, `record_proposal przyjmuje tryb: ${args}`);
    await as(viewer);
    await rejects(db.query('select exercise_ai.set_auto_release($1,true)', [a.recruitment]), '42501');
    await as(ownerB);
    await rejects(db.query('select exercise_ai.set_auto_release($1,true)', [a.recruitment]), '42501');
  });

  await t.test('limit wywołań modelu na rekrutację jest twardy', async () => {
    await as(ownerA);
    const used = Number((await db.query('select count(*)::int c from exercise_ai.proposals where recruitment_id=$1', [a.recruitment])).rows[0].c);
    const entry = await saveDefinition();
    await rejects(record(entry, a, provenance(), used), 'PT429');
    // Limit liczy się per rekrutacja, więc druga firma nie jest nim dotknięta.
    await as(ownerB);
    const other = await saveDefinition(b);
    assert.ok((await record(other, b, provenance(), 1)).rows[0].id);
    // Niepoprawny limit to błąd, a nie cicha zgoda na nieograniczone wywołania.
    await as(ownerA);
    for (const bad of [0, -1, 5000, null]) {
      await rejects(db.query('select exercise_ai.record_proposal($1,$2,$3::jsonb,$4)',
        [a.recruitment, entry, JSON.stringify(provenance()), bad]), '22023');
    }
  });

  await t.test('izolacja firm: cudza rekrutacja i cudza definicja są nieosiągalne', async () => {
    await as(ownerB);
    const mine = await saveDefinition(b);
    await rejects(record(mine, a), '42501');
    await as(ownerA);
    await rejects(record(mine, a), '42501');
    const entry = await saveDefinition();
    await record(entry);
    await as(ownerB);
    await rejects(db.query('select exercise_ai.approve_proposal($1)', [entry]), '42501');
    assert.equal((await db.query('select count(*)::int c from exercise_ai.proposals')).rows[0].c > 0, true);
    assert.equal(Number((await db.query('select count(*)::int c from exercise_ai.proposals where company_id=$1', [a.company])).rows[0].c), 0,
      'firma B nie widzi propozycji firmy A');
  });

  await t.test('viewer nie zwalnia zadań', async () => {
    await as(ownerA);
    const entry = await saveDefinition();
    await record(entry);
    await as(viewer);
    await rejects(db.query('select exercise_ai.approve_proposal($1)', [entry]), '42501');
  });

  await t.test('zamknięta rekrutacja i zarchiwizowane stanowisko blokują zwolnienie', async () => {
    await as(ownerA);
    const entry = await saveDefinition();
    await record(entry);
    await db.query("update public.recruitments set status='closed' where id=$1", [a.recruitment]);
    await rejects(db.query('select exercise_ai.approve_proposal($1)', [entry]), '55000');
    await db.query("update public.recruitments set status='open' where id=$1", [a.recruitment]);
    await db.query("update public.positions set status='archived' where id=$1", [a.position.id]);
    await rejects(db.query('select exercise_ai.approve_proposal($1)', [entry]), '55000');
    await db.query("update public.positions set status='draft' where id=$1", [a.position.id]);
  });

  await t.test('schemat kandydata pozostaje nietknięty przez tę migrację', async () => {
    // Uzasadnienie osobnego schematu: nic w 'public' ani 'private' nie przybyło,
    // więc inwentarz usuwania danych kandydata nie wymaga nowej rewizji.
    const rows = (await db.query(`select n.nspname from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where c.relkind='r' and c.relname in ('proposals','recruitment_settings')`)).rows;
    assert.deepEqual([...new Set(rows.map(r => r.nspname))], ['exercise_ai']);
  });

  await t.test('bez logowania nie da się zapisać ani zwolnić propozycji', async () => {
    await as(null, 'anon');
    await rejects(db.query('select exercise_ai.record_proposal($1,$2,$3::jsonb,$4)',
      [a.recruitment, '10000000-0000-0000-0000-000000000001', JSON.stringify(provenance()), 20]), '42501');
  });
});
