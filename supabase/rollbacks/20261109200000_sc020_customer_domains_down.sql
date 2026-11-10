-- Rollback SC-020-B (domeny klienta, white-label etap B).
-- Odtwarza stan sprzed migracji: schemat `tenant_domains` nie istniał, nie było funkcji
-- public.tenant_domain_* ani nadań dla roli `tenant_domain_verifier`.
--
-- WAŻNE — kolejność względem SC-020-D: ten rollback usuwa cały schemat `tenant_domains`,
-- w którym SC-020-D (20261109220000) tworzy swoje funkcje. Jeśli SC-020-D jest wgrana,
-- najpierw uruchom 20261109220000_sc020d_domain_reverification_down.sql. Poniższy guard
-- odmawia, dopóki tego nie zrobiono, zamiast po cichu usuwać cudze obiekty.
--
-- Zgłoszenia domen i ich dziennik są dowodem, kto i kiedy objął dany host (tabele są
-- niezmienne dla wszystkich ról). Dlatego — wzorem 20261109210000_sc021_ai_ledger_down.sql
-- — rollback wykonuje się WYŁĄCZNIE, gdy nie ma żadnej domeny ani zdarzenia. Wiersz
-- `settings` zakłada sama migracja (wartości domyślne), więc nie blokuje cofnięcia.
--
-- Rola `tenant_domain_verifier` (NOLOGIN) obejmuje cały klaster i ZOSTAJE: operator mógł
-- nadać jej login lub członków poza tą migracją. Bez schematu i bez nadań nic nie może.
--
-- Migracja nie zmieniała relacji w 'public'/'private' (dodała tylko funkcje), więc
-- sygnatura inwentarza SC-010 ma pozostać ta sama — sprawdzane na wejściu i na wyjściu.
-- Idempotentny: ponowne uruchomienie na czystej bazie nic nie robi i nie zgłasza błędu.
begin;
-- UWAGA DLA OPERATORA: odmowa jest NORMALNYM wynikiem tego skryptu. Przy
-- równoległym ruchu rollback świadomie rezygnuje (55P03) zamiast czekać lub
-- zakleszczyć się z aplikacją — wtedy po prostu uruchom go ponownie. Uruchamiaj
-- przez `psql -v ON_ERROR_STOP=1` albo sprawdzaj kod wyjścia: bez tego psql
-- kończy się zerem nawet gdy transakcja została wycofana, a nieudane cofnięcie
-- wygląda jak udane.
--
-- Całą ochronę przed zakleszczeniem daje `lock table ... nowait` niżej, NIE ten
-- limit: przy deadlock_timeout = 1 s detektor zakleszczeń zadziała cztery sekundy
-- wcześniej, więc limit nigdy nie uchroni przed cyklem. Jest tu tylko po to, żeby
-- zwykłe, bezcykliczne czekanie nie trwało w nieskończoność.
set local lock_timeout = '5s';

do $guard$
begin
  if to_regnamespace('tenant_domains') is not null then
    if to_regprocedure('tenant_domains.reverify_due(integer,timestamptz,uuid)') is not null
       or to_regprocedure('tenant_domains.record_scheduled_dns_check(uuid,uuid,text,boolean)') is not null then
      raise exception 'sc020b_rollback_requires_sc020d_down' using errcode = '55000';
    end if;
    -- Schemat bez kompletu tabel = przerwana instalacja. Mówimy to wprost, zamiast
    -- wysypywać się na „relation does not exist" przy pierwszym `exists`.
    if to_regclass('tenant_domains.domains') is null or to_regclass('tenant_domains.events') is null
       or to_regclass('tenant_domains.settings') is null then
      raise exception 'sc020b_rollback_partial_install' using errcode = '55000';
    end if;
    -- Blokada MUSI poprzedzać sprawdzenie pustości — patrz komentarz w
    -- 20261109190000_sc020_brand_configuration_down.sql. Samo `select` nie
    -- wstrzymuje INSERT-u, więc bez tego zgłoszenie domeny wstawione i
    -- zatwierdzone w trakcie sprawdzania zostałoby skasowane przez CASCADE.
    -- `settings` jest na liście dlatego, że `drop schema cascade` ją usuwa —
    -- i tylko dlatego. Nie liczy się do pustości (jej wiersz zakłada sama migracja).
    --
    -- NOWAIT JEST ISTOTNE, nie ozdobne, i to ono — nie kolejność — rozwiązuje
    -- problem zakleszczenia. Żadna stała kolejność go nie rozwiąże, bo aplikacja
    -- używa OBU: tenant_domain_claim czyta settings przed zapisem do domains, ale
    -- record_dns_check, tenant_domain_state, tenant_domain_activate,
    -- tenant_domain_resolve i record_scheduled_dns_check (SC-020-D) dotykają
    -- domains przed settings. Aplikacja sama się nie zakleszcza, bo jej blokady
    -- nie kolidują ze sobą; koliduje dopiero ACCESS EXCLUSIVE rollbacku.
    -- `lock table` bierze pozycje z listy SEKWENCYJNIE, więc bez NOWAIT rollback
    -- czeka na pozycję n, trzymając już 1..n-1 — i to oczekiwanie domyka cykl.
    -- Z NOWAIT rollback nigdy nie jest stroną czekającą: albo bierze wszystko od
    -- razu, albo odmawia (55P03), a transakcja klienta przechodzi bez szwanku.
    lock table tenant_domains.settings, tenant_domains.domains, tenant_domains.events
      in access exclusive mode nowait;
    if exists (select 1 from tenant_domains.domains) or exists (select 1 from tenant_domains.events) then
      raise exception 'sc020b_rollback_domains_not_empty' using errcode = '55000';
    end if;
  end if;
end
$guard$;

do $preflight$
begin
  if private.erasure_schema_signature() is distinct from '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44' then
    raise exception 'sc020b_rollback_schema_unreviewed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
end
$preflight$;

-- 1. Nadania dla roli weryfikatora (odwrotnie niż w migracji). Rola zostaje.
do $grants$
begin
  if exists (select 1 from pg_roles where rolname = 'tenant_domain_verifier')
     and to_regnamespace('tenant_domains') is not null then
    if to_regprocedure('tenant_domains.record_tls_check(uuid,uuid,text,boolean,uuid)') is not null then
      revoke execute on function tenant_domains.record_tls_check(uuid, uuid, text, boolean, uuid) from tenant_domain_verifier;
    end if;
    if to_regprocedure('tenant_domains.record_dns_check(uuid,uuid,text,boolean,uuid)') is not null then
      revoke execute on function tenant_domains.record_dns_check(uuid, uuid, text, boolean, uuid) from tenant_domain_verifier;
    end if;
    if to_regprocedure('tenant_domains.verifier_target(uuid,uuid)') is not null then
      revoke execute on function tenant_domains.verifier_target(uuid, uuid) from tenant_domain_verifier;
    end if;
    revoke usage on schema tenant_domains from tenant_domain_verifier;
  end if;
end
$grants$;

-- 2. Nadanie dla anon na publicznym rozpoznawaniu hosta (migracja nadaje je warunkowo).
do $anon$
begin
  if exists (select 1 from pg_roles where rolname = 'anon')
     and to_regprocedure('public.tenant_domain_resolve(text)') is not null then
    revoke execute on function public.tenant_domain_resolve(text) from anon;
  end if;
end
$anon$;

-- 3. Funkcje wystawione aplikacji (public.tenant_domain_*), odwrotnie niż w migracji.
drop function if exists public.tenant_domain_resolve(text);
drop function if exists public.tenant_domain_state(uuid);
drop function if exists public.tenant_domain_revoke(uuid, uuid);
drop function if exists public.tenant_domain_deactivate(uuid, uuid);
drop function if exists public.tenant_domain_activate(uuid, uuid);
drop function if exists public.tenant_domain_claim(uuid, text, text);

-- 4. Schemat `tenant_domains` wraz z tabelami, indeksami, wyzwalaczami i funkcjami.
--    CASCADE jest bezpieczne: guard powyżej potwierdził brak zgłoszeń domen i zdarzeń
--    oraz brak obiektów SC-020-D, a migracja nie tworzyła kluczy obcych z
--    'public'/'private' do tego schematu. Ginie też wiersz `settings`, ale to
--    konfiguracja, którą migracja zakłada na nowo z wartościami domyślnymi — jego
--    utrata jest zamierzona i dlatego nie liczy się do guardu pustości.
drop schema if exists tenant_domains cascade;

do $postflight$
begin
  if private.erasure_schema_signature() is distinct from '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44' then
    raise exception 'sc020b_rollback_inventory_changed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
  if to_regnamespace('tenant_domains') is not null then
    raise exception 'sc020b_rollback_incomplete' using errcode = '55000';
  end if;
end
$postflight$;

commit;
