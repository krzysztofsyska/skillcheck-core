-- SC-PRICING-W2 — katalog cen jako jedno źródło prawdy (część 1: katalog i odczyt).
--
-- Dziś te same liczby żyją w pięciu miejscach (docs/audyt-zrodel-cennika-2026-11-03.md).
-- Ta migracja przenosi ceny z kodu do bazy i NIE ZMIENIA ŻADNEJ CENY: wartości
-- poniżej są co do grosza takie, jakie są dziś na stronie, w kalkulatorze
-- publicznym, w kalkulatorze wewnętrznym i w docs/cennik-2026-11-02.md.
--
-- Dlaczego osobny schemat `pricing`, a nie `public`/`private`:
-- private.erasure_schema_signature() obejmuje relacje w 'public' i 'private' i
-- jest przypięta do baseline'u inwentarza usuwania danych kandydatów. Katalog
-- cen nie zawiera danych osobowych i nie należy do tego inwentarza, więc nowy
-- schemat trzyma go poza tą kontrolą zamiast wymuszać nowy baseline. Sygnatura
-- SC-010 pozostaje niezmieniona przez tę migrację.
--
-- Co ta migracja ROBI: tworzy schemat, trzy relacje i jedną funkcję odczytu,
-- oraz wstawia jedną wersję katalogu w stanie PUBLISHED z dzisiejszymi cenami.
-- Czego NIE robi: nie dotyka żadnej istniejącej relacji, kolumny, polityki RLS
-- ani funkcji; nie zmienia cen widocznych dla klienta (strona i kalkulatory
-- nadal czytają własne stałe — przepięcie to osobne zadanie za flagą); nie
-- przechowuje kosztów ani marż (te zostają wyłącznie w panelu operatora).
begin;

create schema if not exists pricing;
revoke all on schema pricing from public;
grant usage on schema pricing to authenticated, anon;

-- Wersja katalogu. Publikacja jest decyzją właściciela, więc stan PUBLISHED
-- wymaga `approved`, a opublikowana wersja może być tylko jedna naraz.
create table pricing.catalog_versions (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'DRAFT' check (status in ('DRAFT','PUBLISHED','SUPERSEDED')),
  approved boolean not null default false,
  vat_basis_points integer not null check (vat_basis_points between 0 and 10000),
  note text check (note is null or length(note) <= 500),
  created_at timestamptz not null default now(),
  published_at timestamptz,
  check (status <> 'PUBLISHED' or approved),
  check ((status = 'PUBLISHED') = (published_at is not null))
);
create unique index catalog_versions_one_published on pricing.catalog_versions (status) where status = 'PUBLISHED';

-- Cennik pakietu. Wyłącznie liczby widoczne dla klienta: cena brutto, pula CV,
-- krok zmiany puli i dopłata za CV ponad pulę. Żadnych kosztów ani marż.
create table pricing.package_prices (
  version_id uuid not null references pricing.catalog_versions(id) on delete cascade,
  package_code text not null check (package_code in ('FREE','PRESELEKCJA','WERYFIKACJA','ASSESSMENT_CENTER')),
  gross_minor integer not null check (gross_minor between 0 and 100000000),
  cv_included integer not null check (cv_included between 0 and 10000),
  -- Krok zmiany puli CV (decyzja właściciela 2026-11-02: co 5).
  cv_step integer not null default 5 check (cv_step between 1 and 1000),
  cv_max integer not null check (cv_max between 0 and 10000),
  -- Dopłata za CV ponad pulę, brutto. 0 oznacza pakiet sprzedawany w całości.
  overage_gross_per_cv_minor integer not null default 0 check (overage_gross_per_cv_minor between 0 and 100000000),
  -- Czy pakiet można dziś kupić. Etap zatwierdzony cenowo, ale niegotowy do
  -- realizacji, ma cenę w katalogu i `sellable = false`. UWAGA: pakiet może być
  -- gotowy przy cenie 0 — tak jest FREE. Dodatki mają regułę odwrotną (gotowy
  -- musi być wyceniony), więc nie przenoś jej tutaj.
  sellable boolean not null default false,
  primary key (version_id, package_code),
  check (cv_max >= cv_included)
);

-- Opcje dodatkowe. Istnieją dziś tylko w kalkulatorze wewnętrznym i żadna nie ma
-- zatwierdzonej stawki, dlatego wchodzą z ceną 0 i `sellable = false`: klient ich
-- nie zobaczy, dopóki właściciel ich nie wyceni i nie oznaczy jako gotowe
-- (SC-PRICING-W3).
create table pricing.addon_options (
  version_id uuid not null references pricing.catalog_versions(id) on delete cascade,
  code text not null check (code ~ '^[a-z][a-z0-9_]{1,40}$'),
  name text not null check (length(name) between 1 and 120),
  unit text not null check (length(unit) between 1 and 40),
  gross_minor integer not null default 0 check (gross_minor between 0 and 100000000),
  sellable boolean not null default false,
  primary key (version_id, code),
  -- Nie da się wystawić klientowi pozycji bez ceny: gotowa znaczy wyceniona.
  check (not sellable or gross_minor > 0)
);

alter table pricing.catalog_versions enable row level security;
alter table pricing.package_prices enable row level security;
alter table pricing.addon_options enable row level security;
revoke all on pricing.catalog_versions, pricing.package_prices, pricing.addon_options from public, anon, authenticated;

-- Jedyna droga do katalogu dla przeglądarki: opublikowana wersja, tylko odczyt,
-- tylko pola widoczne dla klienta. Brak opublikowanej wersji = pusty wynik, a nie
-- cena zmyślona; strona ma wtedy pokazać komunikat, nie liczbę.
create function public.pricing_published_packages()
returns table (package_code text, gross_minor integer, cv_included integer, cv_step integer,
  cv_max integer, overage_gross_per_cv_minor integer, sellable boolean, vat_basis_points integer)
language sql stable security definer set search_path = '' as $$
  select p.package_code, p.gross_minor, p.cv_included, p.cv_step, p.cv_max,
         p.overage_gross_per_cv_minor, p.sellable, v.vat_basis_points
  from pricing.package_prices p
  join pricing.catalog_versions v on v.id = p.version_id
  where v.status = 'PUBLISHED'
  order by p.package_code
$$;
revoke all on function public.pricing_published_packages() from public;
grant execute on function public.pricing_published_packages() to anon, authenticated;

-- Opcje dodatkowe: klient widzi wyłącznie te oznaczone jako gotowe do realizacji.
create function public.pricing_published_addons()
returns table (code text, name text, unit text, gross_minor integer)
language sql stable security definer set search_path = '' as $$
  select a.code, a.name, a.unit, a.gross_minor
  from pricing.addon_options a
  join pricing.catalog_versions v on v.id = a.version_id
  where v.status = 'PUBLISHED' and a.sellable
  order by a.code
$$;
revoke all on function public.pricing_published_addons() from public;
grant execute on function public.pricing_published_addons() to anon, authenticated;

-- Dzisiejsze ceny, przeniesione bez zmiany. Idempotentne: ponowne uruchomienie
-- nie tworzy drugiej wersji.
do $seed$
declare version_id uuid;
begin
  if exists (select 1 from pricing.catalog_versions) then return; end if;
  insert into pricing.catalog_versions (status, approved, vat_basis_points, note, published_at)
    values ('PUBLISHED', true, 2300,
      'Ceny przeniesione z kodu bez zmiany (SC-PRICING-W2, docs/cennik-2026-11-02.md)', now())
    returning id into version_id;
  insert into pricing.package_prices
    (version_id, package_code, gross_minor, cv_included, cv_step, cv_max, overage_gross_per_cv_minor, sellable) values
    -- FREE: 5 CV, 0 zł, jedna próba na firmę (aktywacja osobną ścieżką operatorską).
    (version_id, 'FREE', 0, 5, 5, 5, 0, true),
    -- PRESELEKCJA: 60 CV za 300 zł brutto, sprzedawana w całych pakietach,
    -- dlatego brak dopłaty za pojedyncze CV (audyt R7).
    (version_id, 'PRESELEKCJA', 30000, 60, 5, 60, 0, true),
    -- Etapy zatwierdzone cenowo, ale niegotowe do sprzedaży (decyzja właściciela
    -- 2026-11-02): cena jest w katalogu, kupić się ich nie da.
    (version_id, 'WERYFIKACJA', 61500, 60, 5, 150, 20, false),
    (version_id, 'ASSESSMENT_CENTER', 149900, 50, 5, 150, 20, false);
  insert into pricing.addon_options (version_id, code, name, unit) values
    (version_id, 'skill_test', 'Test kompetencji', 'test'),
    (version_id, 'case_study', 'Zadanie / case study', 'zadanie'),
    (version_id, 'expert_consult', 'Konsultacja ekspercka', 'godzina'),
    (version_id, 'user_account', 'Konto użytkownika', 'konto'),
    (version_id, 'report', 'Raport PDF/CSV', 'raport'),
    (version_id, 'position', 'Stanowisko / profil', 'stanowisko'),
    (version_id, 'email', 'Wiadomość e-mail', 'wiadomość'),
    (version_id, 'sms', 'SMS', 'SMS'),
    (version_id, 'ocr_page', 'Strona OCR', 'strona'),
    (version_id, 'ai_task', 'Wygenerowanie zadania przez AI', 'zadanie'),
    (version_id, 'manual_cv_review', 'Manualny review CV', 'CV'),
    (version_id, 'priority_sla', 'Priorytetowe SLA / obsługa', 'godzina'),
    (version_id, 'support_hours', 'Godziny wsparcia', 'godzina'),
    (version_id, 'ats_integration', 'Integracja ATS / API / SSO', 'wdrożenie'),
    (version_id, 'branding', 'Branding / raport dedykowany', 'wdrożenie'),
    (version_id, 'localization', 'Język dodatkowy / lokalizacja', 'wdrożenie'),
    (version_id, 'custom_contract', 'Umowa indywidualna / DPA', 'umowa'),
    (version_id, 'talent_pool', 'Talent Pool — kandydat-miesiąc', 'kand.-mies.'),
    (version_id, 'quality_of_hire', 'Quality of Hire — pomiar', 'kontakt');
  -- 'interview' (rozmowa AI) celowo nie wchodzi: voicebot nie działa i nie jest
  -- pokazywany na żadnej powierzchni publicznej (decyzja właściciela 2026-11-02).
end
$seed$;

commit;
