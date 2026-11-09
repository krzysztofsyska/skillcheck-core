-- SC-020-D — cykliczna ponowna weryfikacja DNS własnych domen firm (issue #21).
--
-- Dotąd właściciel firmy musiał co najmniej raz na `reverify_days` kliknąć
-- „Sprawdź”; inaczej domena przestawała wskazywać firmę. Ta migracja dodaje
-- dwie funkcje dla roli `tenant_domain_verifier` (NOLOGIN), z których korzysta
-- zadanie cykliczne w lib/tenant-domain-reverify.ts:
--   * tenant_domains.reverify_due(max_rows) — lista własnych domen, którym
--     zbliża się termin ponownej weryfikacji (host, token; nic więcej),
--   * tenant_domains.record_scheduled_dns_check(...) — zapis wyniku. Może
--     wyłącznie ODNOWIĆ weryfikację domeny już zweryfikowanej/aktywnej albo
--     zapisać niepowodzenie (a po terminie cofnąć domenę do `pending`).
--     Nigdy nie weryfikuje domeny `pending`, nie włącza domeny, nie zmienia TLS
--     i nie dotyka domen innych firm. Zdarzenia mają actor = NULL
--     („automatycznie” w historii właściciela).
--
-- Bez loginu dla roli, bez sekretu i bez harmonogramu: uruchomienie zadania
-- (login roli, sekret, cron) to osobna decyzja operatora/właściciela. Bez tego
-- funkcje istnieją, ale nikt ich nie woła (fail closed).
--
-- Schemat `tenant_domains` leży poza inwentarzem SC-010: migracja nie tworzy
-- ani nie zmienia relacji w 'public'/'private'. Sygnatura sprawdzana w
-- preflight i postflight.

begin;

do $preflight$
begin
  if private.erasure_schema_signature() is distinct from '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44' then
    raise exception 'sc020d_source_schema_unreviewed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
  if to_regnamespace('tenant_domains') is null or to_regrole('tenant_domain_verifier') is null then
    raise exception 'sc020d_requires_sc020b' using errcode = '55000';
  end if;
  if to_regprocedure('tenant_domains.reverify_due(integer)') is not null then
    raise exception 'sc020d_already_installed' using errcode = '55000';
  end if;
end
$preflight$;

-- Domeny do ponownego sprawdzenia: własne, zweryfikowane lub aktywne, których
-- ostatnia udana weryfikacja jest starsza niż (reverify_days - 7) dni (co
-- najmniej 1 dzień) — czyli zanim wygasną. Najstarsze najpierw.
create function tenant_domains.reverify_due(max_rows integer)
returns table (company_id uuid, domain_id uuid, hostname text, verification_token text)
language sql stable security definer set search_path = '' as $$
  select d.company_id, d.id, d.hostname, d.verification_token
    from tenant_domains.domains d, tenant_domains.settings s
   where s.singleton and d.kind = 'custom' and d.status in ('verified', 'active')
     and d.last_verified_at <= clock_timestamp() - make_interval(days => greatest(s.reverify_days - 7, 1))
   order by d.last_verified_at, d.id
   limit least(greatest(coalesce(max_rows, 0), 0), 500)
$$;

-- Wynik zaplanowanego sprawdzenia DNS. Token musi się zgadzać (wiersz nie
-- zmienił się od odczytu listy). Zwraca status domeny po zapisie albo
-- 'skipped', gdy domena nie kwalifikuje się już do odnowienia.
create function tenant_domains.record_scheduled_dns_check(target_company uuid, target_domain uuid, expected_token text, dns_ok boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare d tenant_domains.domains; cfg tenant_domains.settings;
begin
  if dns_ok is null or expected_token is null then raise exception 'tenant_domain_bad_check' using errcode = '22023'; end if;
  -- Ta sama kolejność blokad co record_dns_check: host (doradcza), potem wiersz.
  perform pg_advisory_xact_lock(hashtextextended('tenant_domains:' || d2.hostname, 0))
    from tenant_domains.domains d2 where d2.company_id = target_company and d2.id = target_domain;
  d := tenant_domains.lock_domain(target_company, target_domain);
  if d.verification_token is distinct from expected_token then
    raise exception 'tenant_domain_stale_check' using errcode = 'PT409';
  end if;
  if d.kind <> 'custom' or d.status not in ('verified', 'active') then
    return 'skipped';
  end if;
  select * into cfg from tenant_domains.settings s where s.singleton;
  if dns_ok then
    update tenant_domains.domains set last_verified_at = clock_timestamp() where id = d.id;
    perform tenant_domains.log(target_company, d.id, 'reverified', null);
    return d.status;
  end if;
  perform tenant_domains.log(target_company, d.id, 'verification_failed', null);
  if not tenant_domains.fresh(d) then
    update tenant_domains.domains set status = 'pending', activated_at = null, tls_ready_at = null,
      pending_expires_at = clock_timestamp() + make_interval(days => cfg.pending_days) where id = d.id;
    perform tenant_domains.log(target_company, d.id, 'verification_lapsed', null);
    return 'pending';
  end if;
  return d.status;
end;
$$;

do $grants$
declare fn regprocedure;
begin
  foreach fn in array array['tenant_domains.reverify_due(integer)',
                            'tenant_domains.record_scheduled_dns_check(uuid,uuid,text,boolean)']::regprocedure[] loop
    execute format('revoke all on function %s from public', fn);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', fn); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', fn); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('revoke all on function %s from service_role', fn); end if;
    execute format('grant execute on function %s to tenant_domain_verifier', fn);
  end loop;
end
$grants$;

do $postflight$
begin
  if private.erasure_schema_signature() is distinct from '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44' then
    raise exception 'sc020d_final_schema_mismatch:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
end
$postflight$;

commit;
