import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { preselekcjaOffer, freeOffer } from '../lib/preselekcja-offer.ts';
// Kalkulator wewnętrzny czytany jako tekst: jego moduł importuje silnik wycen
// bez rozszerzenia, czego runtime testów nie rozwiąże, a chodzi tu wyłącznie
// o liczby w defaultConfig().

// SC-PRICING-W2 — katalog cen jako jedno źródło prawdy.
// Audyt (docs/audyt-zrodel-cennika-2026-11-03.md) wykazał pięć miejsc z tymi
// samymi liczbami. Cztery z nich pilnuje już tests/pricing-cv-pool.test.mjs
// (dokument cennika, strona, kalkulator publiczny i kalkulator wewnętrzny).
// Ten plik dopina do nich katalog, żeby nowe źródło nie stało się szóstą kopią
// żyjącą własnym życiem.

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const migration = read('supabase/migrations/20261104080000_pricing_catalog.sql');
const rollback = read('supabase/rollbacks/20261104080000_pricing_catalog_down.sql');
const cennik = read('docs/cennik-2026-11-02.md');

async function database() {
  const db = new PGlite();
  for (const role of ['anon', 'authenticated', 'service_role']) await db.exec(`create role ${role};`);
  await db.exec(migration);
  return db;
}

test('katalog wchodzi z dzisiejszymi cenami, co do grosza', async () => {
  const db = await database();
  const rows = Object.fromEntries((await db.query('select * from public.pricing_published_packages()'))
    .rows.map(r => [r.package_code, r]));
  assert.deepEqual(Object.keys(rows).sort(),
    ['ASSESSMENT_CENTER', 'FREE', 'PRESELEKCJA', 'WERYFIKACJA']);
  // Zgodność ze stroną (lib/preselekcja-offer.ts).
  assert.equal(rows.PRESELEKCJA.gross_minor, preselekcjaOffer.grossPln * 100);
  assert.equal(rows.PRESELEKCJA.cv_included, preselekcjaOffer.analyses);
  assert.equal(rows.FREE.gross_minor, freeOffer.grossPln * 100);
  assert.equal(rows.FREE.cv_included, freeOffer.analyses);
  // Zgodność z kalkulatorem wewnętrznym (lib/pricing/internal-calculator.ts).
  const calculator = read('lib/pricing/internal-calculator.ts');
  for (const code of ['FREE', 'PRESELEKCJA', 'WERYFIKACJA', 'ASSESSMENT_CENTER']) {
    const line = calculator.split('\n').find(l => l.trim().startsWith(`${code}: { grossMinor:`));
    assert.ok(line, `kalkulator wewnętrzny definiuje ${code}`);
    const gross = Number(line.match(/grossMinor: ([\d_]+)/)[1].replace(/_/g, ''));
    const cv = Number(line.match(/cvIncluded: (\d+)/)[1]);
    assert.equal(rows[code].gross_minor, gross, `cena ${code}`);
    assert.equal(rows[code].cv_included, cv, `pula CV ${code}`);
  }
  // Zgodność z dokumentem cennika (docs/cennik-2026-11-02.md).
  for (const [code, price, cv] of [['PRESELEKCJA', '300 zł', 60], ['WERYFIKACJA', '615 zł', 60],
    ['ASSESSMENT CENTER', '1 499 zł', 50]]) {
    const line = cennik.split('\n').find(l => l.startsWith(`| ${code} |`));
    assert.ok(line, `dokument cennika wymienia ${code}`);
    assert.ok(line.includes(price), `${code}: cena w dokumencie to ${price}`);
    const key = code.replace(' ', '_');
    assert.equal(rows[key].gross_minor, Number(price.replace(/[^\d]/g, '')) * 100, `${code}: katalog = dokument`);
    assert.equal(rows[key].cv_included, cv, `${code}: pula CV = dokument`);
  }
});

test('kupić można tylko to, co jest gotowe do realizacji', async () => {
  const db = await database();
  const rows = Object.fromEntries((await db.query('select * from public.pricing_published_packages()'))
    .rows.map(r => [r.package_code, r]));
  // Decyzja właściciela 2026-11-02: ceny kolejnych etapów są zatwierdzone i jawne,
  // ale żadnego z nich nie można dziś kupić.
  assert.equal(rows.FREE.sellable, true);
  assert.equal(rows.PRESELEKCJA.sellable, true);
  assert.equal(rows.WERYFIKACJA.sellable, false);
  assert.equal(rows.ASSESSMENT_CENTER.sellable, false);
});

test('dodatek pojawia się klientowi dopiero po wycenie i oznaczeniu jako gotowy', async () => {
  const db = await database();
  assert.equal((await db.query('select * from public.pricing_published_addons()')).rows.length, 0,
    'żaden dodatek nie ma jeszcze zatwierdzonej stawki, więc klient nie widzi żadnego');
  assert.ok((await db.query('select count(*)::int c from pricing.addon_options')).rows[0].c > 0,
    'dodatki są w katalogu, tylko niewidoczne');
  const version = (await db.query('select id from pricing.catalog_versions')).rows[0].id;
  // Gotowy bez ceny jest niemożliwy: nie da się wystawić klientowi pozycji za 0 zł.
  // Kod musi przejść walidację formatu, inaczej odrzuciłoby go inne ograniczenie
  // i ten test nie pilnowałby niczego.
  await assert.rejects(db.query(
    "insert into pricing.addon_options(version_id,code,name,unit,gross_minor,sellable) values($1,'zero_rate','X','szt',0,true)",
    [version]), e => e.constraint === 'addon_options_check');
  // Wyceniony i oznaczony jako gotowy — i dopiero wtedy widoczny.
  await db.query("update pricing.addon_options set gross_minor=5000, sellable=true where code='skill_test'");
  const visible = (await db.query('select * from public.pricing_published_addons()')).rows;
  assert.deepEqual(visible.map(r => r.code), ['skill_test']);
  assert.equal(visible[0].gross_minor, 5000);
});

test('klient widzi wyłącznie wersję opublikowaną, i tylko jedną', async () => {
  const db = await database();
  const published = (await db.query("select id from pricing.catalog_versions where status='PUBLISHED'")).rows[0].id;
  // Szkic nie wycieka do odczytu publicznego.
  const draft = (await db.query(
    "insert into pricing.catalog_versions(status,vat_basis_points) values('DRAFT',2300) returning id")).rows[0].id;
  await db.query("insert into pricing.package_prices(version_id,package_code,gross_minor,cv_included,cv_max,sellable) values($1,'PRESELEKCJA',99900,999,999,true)", [draft]);
  const rows = (await db.query('select * from public.pricing_published_packages()')).rows;
  assert.equal(rows.filter(r => r.package_code === 'PRESELEKCJA').length, 1);
  assert.equal(rows.find(r => r.package_code === 'PRESELEKCJA').gross_minor, 30000,
    'cena ze szkicu nie trafia do klienta');
  // Druga opublikowana wersja naraz jest niemożliwa.
  await assert.rejects(db.query("update pricing.catalog_versions set status='PUBLISHED',approved=true,published_at=now() where id=$1", [draft]));
  // Publikacja wymaga akceptacji. Najpierw zdejmujemy opublikowaną wersję, żeby
  // odrzucenie pochodziło z bramki akceptacji, a nie z unikalności publikacji.
  await db.query("update pricing.catalog_versions set status='SUPERSEDED',published_at=null where id=$1", [published]);
  await assert.rejects(
    db.query("insert into pricing.catalog_versions(status,approved,vat_basis_points,published_at) values('PUBLISHED',false,2300,now())"),
    e => e.constraint === 'catalog_versions_check');
});

test('pula CV nie może być mniejsza od tej zawartej w pakiecie', async () => {
  const db = await database();
  const version = (await db.query('select id from pricing.catalog_versions').then(r => r)).rows[0].id;
  await assert.rejects(db.query(
    "insert into pricing.package_prices(version_id,package_code,gross_minor,cv_included,cv_max) values($1,'WERYFIKACJA',61500,60,5)",
    [version]), e => e.constraint === 'package_prices_check');
});

test('katalog nie przechowuje kosztów ani marż', async () => {
  const db = await database();
  const columns = (await db.query(
    "select table_name, column_name from information_schema.columns where table_schema='pricing'")).rows;
  assert.ok(columns.length > 0);
  for (const { table_name, column_name } of columns) {
    assert.doesNotMatch(column_name, /cost|margin|koszt|marz/i,
      `koszty i marże zostają w panelu operatora, nie w katalogu: ${table_name}.${column_name}`);
  }
});

test('przeglądarka nie czyta tabel katalogu bezpośrednio, tylko przez funkcje odczytu', () => {
  // Tabele bez uprawnień dla ról przeglądarki; jawne revoke w migracji.
  assert.match(migration, /revoke all on pricing\.catalog_versions, pricing\.package_prices, pricing\.addon_options from public, anon, authenticated;/);
  for (const table of ['catalog_versions', 'package_prices', 'addon_options']) {
    assert.match(migration, new RegExp(`alter table pricing\\.${table} enable row level security;`));
  }
  // Odczyt publiczny wyłącznie przez dwie funkcje, obie stable i bez zapisu.
  for (const fn of ['pricing_published_packages', 'pricing_published_addons']) {
    assert.match(migration, new RegExp(`grant execute on function public\\.${fn}\\(\\) to anon, authenticated;`));
  }
  assert.doesNotMatch(migration, /grant (insert|update|delete)/i);
});

test('migracja nie dotyka schematów objętych kontrolą usuwania danych kandydatów', () => {
  // Sygnatura SC-010 obejmuje relacje w 'public' i 'private'. Katalog ma własny
  // schemat właśnie po to, żeby jej nie ruszać ani nie wymuszać nowego baseline'u.
  assert.doesNotMatch(migration, /create table (public|private)\./i);
  assert.doesNotMatch(migration, /alter table (public|private)\./i);
  assert.doesNotMatch(migration, /drop /i);
});

test('rollback odtwarza stan sprzed migracji', async () => {
  const db = await database();
  await db.exec(rollback);
  assert.equal((await db.query(
    "select count(*)::int c from information_schema.schemata where schema_name='pricing'")).rows[0].c, 0);
  assert.equal((await db.query(
    "select count(*)::int c from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'pricing_%'")).rows[0].c, 0);
});

test('migracja trafia na Preview i ma plik cofnięcia we właściwym katalogu', () => {
  const list = read('supabase/preview-migrations.txt');
  assert.ok(list.split('\n').map(l => l.trim()).includes('20261104080000_pricing_catalog.sql'));
  assert.match(rollback, /drop schema if exists pricing;/);
});
