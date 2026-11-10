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

do $guard$
begin
  if to_regnamespace('tenant_domains') is not null then
    if to_regprocedure('tenant_domains.reverify_due(integer,timestamptz,uuid)') is not null
       or to_regprocedure('tenant_domains.record_scheduled_dns_check(uuid,uuid,text,boolean)') is not null then
      raise exception 'sc020b_rollback_requires_sc020d_down' using errcode = '55000';
    end if;
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
--    CASCADE jest bezpieczne: guard powyżej potwierdził brak danych i brak obiektów
--    SC-020-D, a migracja nie tworzyła kluczy obcych z 'public'/'private' do tego schematu.
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
