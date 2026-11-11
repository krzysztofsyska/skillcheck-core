-- SC-015 / #268 — oznaczenie wymagania stanowiska: konieczne albo dodatkowe.
--
-- Dlaczego OSOBNA TABELA, a nie kolumna przy wymaganiach stanowiska:
-- wymagania to trzy tablice text[] w public.positions. Każdy zapis do positions
-- podbija positions.updated_at, a trigger screening_position_stale
-- (20260930000100_skillcheck_core.sql) unieważnia wtedy KAŻDĄ analizę tego
-- stanowiska ze stale_reason = 'position_changed'. Samo oznaczenie wymagania
-- kasowałoby więc korekty rekrutera i wymuszało płatną ponowną analizę CV.
-- Ta migracja nie dotyka positions ani żadnej istniejącej relacji, kolumny,
-- polityki RLS czy funkcji, więc oznaczanie nie unieważnia analiz.
--
-- Dlaczego OSOBNY SCHEMAT `requirements`, a nie public:
-- private.erasure_schema_signature() (20261010190255_candidate_retention_preview.sql)
-- obejmuje relacje w 'public' i 'private' i jest przypięta do baseline'u
-- inwentarza usuwania danych kandydatów; nowa relacja w tych schematach
-- blokowałaby każdy podgląd i każde usunięcie danych z blokadą
-- schema_dependency_unknown aż do nowej, osobno zatwierdzonej rewizji
-- inwentarza. Ta tabela nie zawiera żadnych danych kandydata — trzyma tekst
-- wymagania stanowiska (dane firmy) i etykietę — więc do tego inwentarza nie
-- należy. To ten sam wybór, co w 20261104080000_pricing_catalog.sql.
-- Z tego samego powodu tabela NIE MA klucza obcego do public.positions:
-- sygnatura liczy też ograniczenia wskazujące na śledzone relacje
-- (confrelid), więc taki klucz zmieniłby sygnaturę mimo innego schematu.
-- Spójność z profilem stanowiska wymuszają zamiast tego obie funkcje poniżej,
-- które za każdym razem sprawdzają stanowisko w public.positions pod tym samym
-- company_id. Wiersze osierocone po usunięciu stanowiska są niewidoczne dla
-- odczytu (złączenie po positions) i nie zawierają danych osobowych.
--
-- Funkcje są w public, bo tylko ten schemat jest wystawiony przez PostgREST.
-- Funkcje nie są relacjami, więc nie wchodzą do sygnatury inwentarza.
begin;

create schema if not exists requirements;
revoke all on schema requirements from public;
-- Bez `grant usage`: do tabeli nie sięga żadna rola aplikacji bezpośrednio,
-- wyłącznie dwie funkcje security definer poniżej.

create table requirements.position_flags (
  company_id uuid not null,
  position_id uuid not null,
  -- Identyfikator kryterium z lib/screening.ts: 'task:1', 'kpi:2', 'competency:3'.
  criterion_id text not null check (criterion_id ~ '^(task|kpi|competency):[1-9][0-9]{0,2}$'),
  -- Tekst wymagania w chwili oznaczania. Identyfikator jest pozycyjny, więc po
  -- przestawieniu kolejności wskazuje inne wymaganie; odczyt porównuje ten tekst
  -- z aktualnym profilem i przy różnicy traktuje wymaganie jako nieoznaczone.
  criterion_text text not null check (length(btrim(criterion_text)) between 1 and 500),
  -- Trzeci stan — nieoznaczone — to BRAK wiersza. Starsze profile nie mają
  -- żadnych wierszy, więc ich wymagania są nieoznaczone, a nie konieczne.
  flag text not null check (flag in ('required','additional')),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (company_id, position_id, criterion_id)
);

-- RLS włączone bez polityk: dla ról aplikacji każdy bezpośredni odczyt i zapis
-- jest odmawiany. Jedyna droga to funkcje poniżej.
alter table requirements.position_flags enable row level security;
revoke all on table requirements.position_flags from public, anon, authenticated;

-- Odczyt: surowe wiersze. Rozstrzygnięcie „oznaczenie nieaktualne -> nieoznaczone"
-- robi lib/requirement-flags.ts, żeby ta zasada miała jedno miejsce.
create function public.position_requirement_flags(target_company uuid, target_position uuid)
returns table (criterion_id text, criterion_text text, flag text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or not private.has_company_access(target_company) then
    raise exception 'No access' using errcode = '42501';
  end if;
  if not exists (select 1 from public.positions p
    where p.company_id = target_company and p.id = target_position) then
    raise exception 'Position not found' using errcode = '42501';
  end if;
  return query
    select f.criterion_id, f.criterion_text, f.flag
    from requirements.position_flags f
    where f.company_id = target_company and f.position_id = target_position
    order by f.criterion_id;
end;
$$;
revoke all on function public.position_requirement_flags(uuid,uuid)
  from public, anon, authenticated, screening_worker;
grant execute on function public.position_requirement_flags(uuid,uuid) to authenticated;

-- Zapis. next_flag = null kasuje oznaczenie (wymaganie wraca do „nieoznaczone").
-- expected_text to tekst wymagania, który rekruter widział na ekranie: jeśli
-- profil stanowiska zmienił się w międzyczasie, zapis jest odrzucany zamiast
-- przykleić etykietę do innego wymagania.
create function public.set_position_requirement_flag(
  target_company uuid,
  target_position uuid,
  target_criterion text,
  expected_text text,
  next_flag text default null
) returns text language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  kind text;
  index_value integer;
  items text[];
  current_text text;
begin
  if actor is null or not private.has_company_access(target_company, true) then
    raise exception 'No write access' using errcode = '42501';
  end if;
  if next_flag is not null and next_flag not in ('required','additional') then
    raise exception 'Invalid flag' using errcode = '22023';
  end if;
  if target_criterion !~ '^(task|kpi|competency):[1-9][0-9]{0,2}$' then
    raise exception 'Invalid criterion' using errcode = '22023';
  end if;
  kind := split_part(target_criterion, ':', 1);
  index_value := split_part(target_criterion, ':', 2)::integer;
  select case kind
           when 'task' then p.tasks
           when 'kpi' then p.kpis
           else p.required_competencies
         end
    into items
    from public.positions p
   where p.company_id = target_company and p.id = target_position;
  if not found then raise exception 'Position not found' using errcode = '42501'; end if;
  if items is null or index_value > cardinality(items) then
    raise exception 'Requirement changed' using errcode = 'PT409';
  end if;
  current_text := items[index_value];
  if btrim(coalesce(current_text,'')) = '' or btrim(coalesce(current_text,'')) is distinct from btrim(coalesce(expected_text,'')) then
    raise exception 'Requirement changed' using errcode = 'PT409';
  end if;
  if next_flag is null then
    delete from requirements.position_flags
     where company_id = target_company and position_id = target_position
       and criterion_id = target_criterion;
    return 'unmarked';
  end if;
  insert into requirements.position_flags
    (company_id, position_id, criterion_id, criterion_text, flag, updated_by, updated_at)
  values (target_company, target_position, target_criterion, current_text, next_flag, actor, clock_timestamp())
  on conflict (company_id, position_id, criterion_id) do update
    set criterion_text = excluded.criterion_text,
        flag = excluded.flag,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at;
  return next_flag;
end;
$$;
revoke all on function public.set_position_requirement_flag(uuid,uuid,text,text,text)
  from public, anon, authenticated, screening_worker;
grant execute on function public.set_position_requirement_flag(uuid,uuid,text,text,text) to authenticated;

commit;
