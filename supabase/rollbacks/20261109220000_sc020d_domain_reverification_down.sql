-- Rollback SC-020-D (cykliczna ponowna weryfikacja DNS własnych domen firm).
-- Odtwarza stan sprzed migracji: nie było funkcji tenant_domains.reverify_due ani
-- tenant_domains.record_scheduled_dns_check, ani nadań dla roli `tenant_domain_reverifier`.
--
-- Zakres jest celowo wąski. SC-020-D dodaje WYŁĄCZNIE dwie funkcje, rolę i nadania —
-- nie tworzy tabel, kolumn, wyzwalaczy ani wierszy. Schemat `tenant_domains`, tabele
-- domen i zdarzenia należą do SC-020-B (20261109200000) i ten rollback ich nie dotyka.
-- Dlatego nie ma tu guardu „brak danych": nie ma żadnych danych należących do SC-020-D.
--
-- Zdarzenia zapisane przez zadanie cykliczne (actor = NULL) zostają w dzienniku: to
-- historia weryfikacji domeny, a nie obiekt tej migracji.
--
-- Po tym rollbacku zadanie cykliczne z lib/tenant-domain-reverify.ts nie ma czego wołać
-- (fail closed). Jeżeli operator nadał roli login i ustawił harmonogram, trzeba je
-- wyłączyć osobno — ta migracja ich nie tworzyła i rollback ich nie usuwa.
--
-- Rola `tenant_domain_reverifier` (NOLOGIN) obejmuje cały klaster i ZOSTAJE, zgodnie ze
-- wzorcem 20261109210000_sc021_ai_ledger_down.sql: bez nadań nic nie może.
--
-- Uruchom to PRZED 20261109200000_sc020_customer_domains_down.sql, który usuwa cały
-- schemat `tenant_domains`.
--
-- Migracja nie zmieniała relacji w 'public'/'private', więc sygnatura inwentarza SC-010
-- ma pozostać ta sama — sprawdzane na wejściu i na wyjściu.
-- Idempotentny: ponowne uruchomienie na czystej bazie nic nie robi i nie zgłasza błędu.
begin;

do $preflight$
begin
  -- R15, or R16 once SC-AC-SESSION (#276) is installed: both are reviewed baselines. The
  -- accepted value is remembered for this transaction and the postflight requires the same one.
  if private.erasure_schema_signature() not in ('1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44',
      'e958cb168fc311a1e908b374cfc1bfee6524945b56f00e9639899ad72f75aea8',
      '8ad238e75d4d4ccb82e03b89f368ba06483580781494fe1f7f9306a3c9c7f73f') then
    raise exception 'sc020d_rollback_schema_unreviewed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
  perform set_config('sc020.rollback_signature', private.erasure_schema_signature(), true);
end
$preflight$;

-- 1. Nadania (odwrotnie niż w migracji: najpierw schemat, potem funkcje). Rola zostaje.
do $grants$
begin
  if exists (select 1 from pg_roles where rolname = 'tenant_domain_reverifier') then
    if to_regnamespace('tenant_domains') is not null then
      revoke usage on schema tenant_domains from tenant_domain_reverifier;
    end if;
    if to_regprocedure('tenant_domains.record_scheduled_dns_check(uuid,uuid,text,boolean)') is not null then
      revoke execute on function tenant_domains.record_scheduled_dns_check(uuid, uuid, text, boolean) from tenant_domain_reverifier;
    end if;
    if to_regprocedure('tenant_domains.reverify_due(integer,timestamptz,uuid)') is not null then
      revoke execute on function tenant_domains.reverify_due(integer, timestamptz, uuid) from tenant_domain_reverifier;
    end if;
  end if;
end
$grants$;

-- 2. Funkcje zadania cyklicznego, odwrotnie niż w migracji.
drop function if exists tenant_domains.record_scheduled_dns_check(uuid, uuid, text, boolean);
drop function if exists tenant_domains.reverify_due(integer, timestamptz, uuid);

do $postflight$
begin
  -- The inventory signature must be exactly the one the preflight accepted: this rollback
  -- touches no relation of the public/private inventory.
  if private.erasure_schema_signature() is distinct from current_setting('sc020.rollback_signature', true) then
    raise exception 'sc020d_rollback_inventory_changed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
  if to_regprocedure('tenant_domains.reverify_due(integer,timestamptz,uuid)') is not null
     or to_regprocedure('tenant_domains.record_scheduled_dns_check(uuid,uuid,text,boolean)') is not null then
    raise exception 'sc020d_rollback_incomplete' using errcode = '55000';
  end if;
end
$postflight$;

commit;
