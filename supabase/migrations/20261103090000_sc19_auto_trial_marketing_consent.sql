-- SC-FREE-AUTO-001 + SC-CONSENT-001 (owner decision 2026-11-03).
--
-- Part A. Automatic FREE activation when the Ministry of Finance "Wykaz
-- podatników VAT" (biała lista) confirms the NIP as an ACTIVE taxpayer. The
-- reviewed M13 trial logic is NOT changed and NOT duplicated: this migration
-- only produces, automatically, the private.sc19_trial_approvals row that
-- public.sc19_claim_trial already demands, and then calls that same function.
-- Every existing guardrail therefore still applies, unchanged and in one place:
--   * one FREE per NIP globally (private.sc19_trial_nips, unique nip);
--   * no FREE after a paid pack (sc19_trial_after_payment);
--   * no grant without a private.sc19_credit_journal row;
--   * the per-company lock order of private.sc19_lock_company.
-- The operator path (public.sc19_operator_approve_trial) is untouched and stays
-- the fallback for everything the registry does not confirm.
--
-- FAIL-CLOSED. Automatic activation happens only when all of these hold:
--   * private.sc19_trial_auto_settings.auto_free_enabled is true (DEFAULT FALSE,
--     so this migration changes no behaviour until an operator turns it on);
--   * a request secret of at least 32 bytes is configured;
--   * the request carries a valid, unexpired, unreplayed HMAC signature;
--   * the registry answer passed in is status 'Czynny'.
-- Anything else raises and the company stays on the existing manual list.
--
-- WHY THE SIGNATURE. A checksum-valid NIP does not prove the caller represents
-- that company; that is exactly why the operator approval exists. The registry
-- answer is what replaces the operator, so the answer must be unforgeable. This
-- RPC is reachable by any signed-in user through the Data API, so without a
-- signature a caller could simply assert a confirmation that never happened and
-- mint FREE packs with throwaway accounts. Same construction as
-- private.cv_bulk_verify_signature and private.verify_sales_mail_signature.
--
-- Part B. Append-only ledger of the optional consent to commercial contact. The
-- WORDING IS HELD HERE, in private.marketing_consent_text, and the client may
-- only name a version: a forged request cannot invent the text it claims was
-- shown. History is never overwritten — a withdrawal appends a row.
-- NOTHING IN THIS MIGRATION SENDS ANYTHING. There is no outbox, no recipient
-- column and no provider reference in the consent path.
--
-- Part C. Read-only operator and digest reporting over the rows above.
--
-- SC-010 NOTE. Four tables are added, so private.erasure_schema_signature()
-- changes and every erasure preview/purge fails closed with
-- schema_dependency_unknown until the companion inventory revision
-- (20261103090100_sc_erasure_inventory_r11.sql) runs. That order is mandatory.
-- No remote application is authorized from an agent session.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';
set local timezone='UTC';

do $preflight$
begin
  if to_regclass('private.sc19_trial_approvals') is null
     or to_regclass('private.sc19_trial_nips') is null
     or to_regclass('private.sc19_credit_journal') is null
     or to_regprocedure('public.sc19_claim_trial(uuid,text)') is null
     or to_regprocedure('private.sc19_lock_company(uuid)') is null
     or to_regprocedure('private.sc19_valid_nip(text)') is null
     or to_regprocedure('private.sc19_require_operator()') is null then
    raise exception 'sc19_auto_requires_operator_fulfillment' using errcode='55000';
  end if;
  if to_regprocedure('private.is_company_owner(uuid)') is null
     or to_regprocedure('private.has_company_access(uuid,boolean)') is null
     or to_regprocedure('private.contact_immutable()') is null then
    raise exception 'sc19_auto_requires_core_primitives' using errcode='55000';
  end if;
  -- extensions.hmac / extensions.digest back every signed worker RPC here.
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='extensions' and p.proname='hmac') then
    raise exception 'sc19_auto_requires_pgcrypto' using errcode='55000';
  end if;
  if to_regclass('private.erasure_inventory_baseline_r10') is null then
    raise exception 'sc19_auto_requires_r10_inventory' using errcode='55000';
  end if;
  if to_regclass('private.marketing_consent_events') is not null
     or to_regclass('private.sc19_trial_auto_settings') is not null then
    raise exception 'sc19_auto_already_installed' using errcode='55000';
  end if;
end
$preflight$;

-- ---------------------------------------------------------------------------
-- Tables

-- Operator-held switch and shared request secret. auto_free_enabled DEFAULT
-- FALSE: installing this migration grants nothing and changes nothing.
create table private.sc19_trial_auto_settings (
  singleton boolean primary key default true check(singleton),
  request_secret text check (request_secret is null or octet_length(request_secret) >= 32),
  auto_free_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into private.sc19_trial_auto_settings(singleton) values (true);

-- Replay protection for signed requests; rows older than 3 minutes are deleted
-- on every verification, so the table stays tiny. No candidate or company data.
create table private.sc19_trial_auto_nonces (
  request_id uuid primary key,
  seen_at timestamptz not null default now()
);

-- Audit of every automatic check: where the decision came from (the MF registry)
-- and what the registry returned. Written for refusals and outages too, so the
-- operator can see why a company is waiting. This is NOT an operator decision
-- and is never presented as one.
create table private.sc19_trial_auto_checks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  nip text not null check (nip ~ '^[0-9]{10}$'),
  source text not null default 'mf_whitelist' check (source in ('mf_whitelist')),
  outcome text not null check (outcome in ('granted','refused','unavailable')),
  mf_request_id text check (mf_request_id is null or length(mf_request_id) between 1 and 64),
  mf_status text check (mf_status is null or length(mf_status) between 1 and 32),
  mf_name text check (mf_name is null or length(mf_name) between 1 and 300),
  error_code text check (error_code is null or length(error_code) between 1 and 48),
  granted_credits integer check (granted_credits is null or granted_credits between 1 and 100000),
  checked_at timestamptz not null default now()
);
create index sc19_trial_auto_checks_company on private.sc19_trial_auto_checks(company_id, checked_at desc);
create index sc19_trial_auto_checks_outcome on private.sc19_trial_auto_checks(outcome, checked_at desc);
-- Append-only: an audit row is never edited or removed outside a purge.
create trigger immutable_history before update or delete on private.sc19_trial_auto_checks
  for each row execute function private.contact_immutable();

-- Consent ledger. Append-only by trigger: a withdrawal adds a row, it does not
-- overwrite the grant, so the full history and both timestamps survive.
create table private.marketing_consent_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  event text not null check (event in ('granted','withdrawn')),
  consent_version text not null check (consent_version ~ '^[a-z0-9.-]{3,40}$'),
  consent_text text not null check (length(btrim(consent_text)) between 20 and 2000),
  source text not null check (source in ('registration','company_panel')),
  actor_id uuid,
  occurred_at timestamptz not null default now()
);
create index marketing_consent_events_company on private.marketing_consent_events(company_id, occurred_at desc, id desc);
create trigger immutable_history before update or delete on private.marketing_consent_events
  for each row execute function private.contact_immutable();

-- No user-facing direct CRUD on any of it; every read and write goes through the
-- audited SECURITY DEFINER functions below.
revoke all on private.sc19_trial_auto_settings, private.sc19_trial_auto_nonces,
  private.sc19_trial_auto_checks, private.marketing_consent_events from public, anon, authenticated;
alter table private.sc19_trial_auto_settings enable row level security;
alter table private.sc19_trial_auto_nonces enable row level security;
alter table private.sc19_trial_auto_checks enable row level security;
alter table private.marketing_consent_events enable row level security;

comment on table private.sc19_trial_auto_checks is
  'SC-010: automatic FREE verification audit (company id, NIP, registry answer); company-level data, no candidate data.';
comment on table private.marketing_consent_events is
  'SC-010: append-only consent-to-marketing ledger (company id, wording, version, time); company-level data, no candidate data.';
comment on table private.sc19_trial_auto_settings is
  'SC-010: operator switch and request secret for automatic FREE; no personal data.';
comment on table private.sc19_trial_auto_nonces is
  'SC-010: signed request ids for replay protection; no personal data.';

-- ---------------------------------------------------------------------------
-- Consent wording, held by the database

-- The canonical text of every published consent version. Byte-identical to
-- MARKETING_CONSENT_TEXT in lib/marketing-consent.ts, which
-- tests/marketing-consent.test.mjs compares against this migration. Returns
-- null for an unknown version, which the callers below refuse.
create function private.marketing_consent_text(version text)
returns text language sql immutable set search_path='' as $$
  select case version when 'marketing-1.0' then
    'Zgadzam się na kontakt handlowy ze strony KTIG CONSULTING Sp. z o.o. (SkillCheck) '
    || 'na podany przeze mnie adres e-mail, w celu przedstawienia ofert i informacji o usługach SkillCheck. '
    || 'Zgoda jest dobrowolna, nie jest warunkiem rejestracji ani korzystania z SkillCheck '
    || 'i mogę ją wycofać w każdej chwili jednym kliknięciem w panelu firmy.'
  end;
$$;
revoke all on function private.marketing_consent_text(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Signed-request verification

-- HMAC-SHA256 over the request; both sides are compared as digests so the
-- secret-dependent comparison is constant time. Each request id is accepted
-- once, inside a +-60 s window. `op` separates the operations that share the
-- one secret, so a signature for one can never be replayed as the other.
create function private.sc19_trial_auto_verify_signature(op text, request_id uuid, stamp bigint, payload text, signature text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare secret text; expected text;
begin
  select s.request_secret into secret from private.sc19_trial_auto_settings s where s.singleton;
  if secret is null or octet_length(secret) < 32 then return false; end if;
  if op is null or op not in ('auto_claim','digest') then return false; end if;
  if request_id is null or stamp is null or signature is null or length(signature) > 200 then return false; end if;
  if abs(extract(epoch from clock_timestamp()) * 1000 - stamp::numeric) > 60000 then return false; end if;
  expected := encode(extensions.hmac(concat_ws(E'\n', 'sc19-trial-auto-v1', op, lower(request_id::text), stamp::text,
    encode(extensions.digest(coalesce(payload,''), 'sha256'), 'hex')), secret, 'sha256'), 'hex');
  if extensions.digest(lower(signature), 'sha256') <> extensions.digest(expected, 'sha256') then return false; end if;
  delete from private.sc19_trial_auto_nonces where seen_at < now() - interval '3 minutes';
  insert into private.sc19_trial_auto_nonces(request_id) values (request_id) on conflict do nothing;
  return found;
end;
$$;
revoke all on function private.sc19_trial_auto_verify_signature(text,uuid,bigint,text,text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Part A: automatic FREE

-- Records the automatic verification and, only for a confirmed ACTIVE taxpayer,
-- produces the approval row and hands over to the reviewed public.sc19_claim_trial.
--
-- The caller must be the signed-in company OWNER (same rule as the manual form)
-- AND the request must be signed by the server, so neither alone is enough.
-- Only 'Czynny' qualifies: a VAT-exempt ('Zwolniony') company exists in the
-- registry but is not a czynny podatnik, so it is refused here and reviewed by
-- hand — the stricter and reversible reading.
--
-- A refusal is RETURNED, not raised: raising would roll back the audit row that
-- tells the operator why this company is waiting. Only a genuinely forbidden or
-- malformed call raises, and those write nothing. `reason` carries the machine
-- code for the panel notice; the company never sees more than "we will check
-- this by hand".
create function public.sc19_auto_claim_trial(
  target_company uuid, supplied_nip text,
  mf_request_id text, mf_status text, mf_name text,
  request_id uuid, issued_at_ms bigint, request_signature text)
returns table(outcome text, available integer, reason text)
language plpgsql volatile security definer set search_path='' as $$
declare
  normalized text := replace(replace(btrim(coalesce(supplied_nip,'')), '-', ''), ' ', '');
  settings private.sc19_trial_auto_settings;
  payload text;
  credits integer;
  trimmed_name text := left(btrim(coalesce(mf_name,'')), 300);
  trimmed_status text := left(btrim(coalesce(mf_status,'')), 32);
  trimmed_request text := left(btrim(coalesce(mf_request_id,'')), 64);
begin
  -- The owner rule is identical to the manual form; the signature is additional.
  if (select auth.uid()) is null or not private.is_company_owner(target_company) then
    raise exception 'sc19_company_forbidden' using errcode='42501';
  end if;
  if not private.sc19_valid_nip(normalized) then
    raise exception 'sc19_invalid_nip' using errcode='22023';
  end if;
  payload := concat_ws(E'\n', lower(target_company::text), normalized,
    coalesce(nullif(trimmed_request,''),'-'), coalesce(nullif(trimmed_status,''),'-'),
    encode(extensions.digest(trimmed_name, 'sha256'), 'hex'));
  if not private.sc19_trial_auto_verify_signature('auto_claim', request_id, issued_at_ms, payload, request_signature) then
    raise exception 'sc19_auto_forbidden' using errcode='42501';
  end if;
  select * into settings from private.sc19_trial_auto_settings where singleton;
  if settings.singleton is null or not settings.auto_free_enabled then
    raise exception 'sc19_auto_disabled' using errcode='55000';
  end if;

  perform private.sc19_lock_company(target_company);

  -- Not an ACTIVE taxpayer, or no usable registry answer: record and refuse.
  if trimmed_status <> 'Czynny' or trimmed_request = '' or trimmed_name = '' then
    insert into private.sc19_trial_auto_checks(company_id,nip,outcome,mf_request_id,mf_status,mf_name,error_code)
      values(target_company,normalized,'refused',nullif(trimmed_request,''),nullif(trimmed_status,''),
        nullif(trimmed_name,''),'STATUS_NOT_ACTIVE');
    return query select 'refused'::text, null::integer, 'STATUS_NOT_ACTIVE'::text;
    return;
  end if;

  -- This NIP, or this company, is already spoken for. One FREE per NIP stands.
  if not exists (select 1 from private.sc19_trial_approvals a
                 where a.company_id=target_company and a.nip=normalized) then
    if exists (select 1 from private.sc19_trial_approvals a where a.nip=normalized)
       or exists (select 1 from private.sc19_trial_nips t where t.nip=normalized)
       or exists (select 1 from private.sc19_trial_approvals a where a.company_id=target_company) then
      insert into private.sc19_trial_auto_checks(company_id,nip,outcome,mf_request_id,mf_status,mf_name,error_code)
        values(target_company,normalized,'refused',trimmed_request,trimmed_status,trimmed_name,'NIP_TAKEN');
      return query select 'refused'::text, null::integer, 'NIP_TAKEN'::text;
      return;
    end if;
    -- Provenance in the approval itself: the MF registry, never an operator id.
    insert into private.sc19_trial_approvals(company_id,nip,proof_reference)
      values(target_company,normalized,
        'mf-biala-lista:' || trimmed_request || ':' || trimmed_status);
  end if;

  -- Reviewed M13 logic, unchanged: one FREE per NIP, no FREE after a paid pack,
  -- and the credit journal row. Its exceptions propagate to the caller.
  credits := public.sc19_claim_trial(target_company, normalized);
  insert into private.sc19_trial_auto_checks(company_id,nip,outcome,mf_request_id,mf_status,mf_name,granted_credits)
    values(target_company,normalized,'granted',trimmed_request,trimmed_status,trimmed_name,credits);
  return query select 'granted'::text, credits, null::text;
end;
$$;
revoke all on function public.sc19_auto_claim_trial(uuid,text,text,text,text,uuid,bigint,text) from public, anon, authenticated;
grant execute on function public.sc19_auto_claim_trial(uuid,text,text,text,text,uuid,bigint,text) to authenticated;

-- Records an attempt that never reached a usable registry answer (timeout, rate
-- limit, outage, unparseable response) so the operator can see the company is
-- waiting and why. Grants nothing and touches no balance.
create function public.sc19_auto_record_failure(
  target_company uuid, supplied_nip text, failure_code text,
  request_id uuid, issued_at_ms bigint, request_signature text)
returns void language plpgsql volatile security definer set search_path='' as $$
declare
  normalized text := replace(replace(btrim(coalesce(supplied_nip,'')), '-', ''), ' ', '');
  code text := left(btrim(coalesce(failure_code,'')), 48);
  payload text;
begin
  if (select auth.uid()) is null or not private.is_company_owner(target_company) then
    raise exception 'sc19_company_forbidden' using errcode='42501';
  end if;
  if not private.sc19_valid_nip(normalized) or code = '' or code !~ '^[A-Z_]{3,48}$' then
    raise exception 'sc19_invalid_nip' using errcode='22023';
  end if;
  payload := concat_ws(E'\n', lower(target_company::text), normalized, code);
  if not private.sc19_trial_auto_verify_signature('auto_claim', request_id, issued_at_ms, payload, request_signature) then
    raise exception 'sc19_auto_forbidden' using errcode='42501';
  end if;
  perform private.sc19_lock_company(target_company);
  insert into private.sc19_trial_auto_checks(company_id,nip,outcome,error_code)
    values(target_company,normalized,'unavailable',code);
end;
$$;
revoke all on function public.sc19_auto_record_failure(uuid,text,text,uuid,bigint,text) from public, anon, authenticated;
grant execute on function public.sc19_auto_record_failure(uuid,text,text,uuid,bigint,text) to authenticated;

-- Operator switch for automatic FREE. Billing-adjacent, so operator-only and
-- audited through the existing operator check.
create function public.sc19_operator_set_auto_free(enabled boolean)
returns boolean language plpgsql volatile security definer set search_path='' as $$
begin
  perform private.sc19_require_operator();
  if enabled is null then raise exception 'sc19_invalid_policy' using errcode='22023'; end if;
  update private.sc19_trial_auto_settings set auto_free_enabled=enabled, updated_at=now() where singleton;
  return enabled;
end;
$$;
revoke all on function public.sc19_operator_set_auto_free(boolean) from public, anon, authenticated;
grant execute on function public.sc19_operator_set_auto_free(boolean) to authenticated;

create function public.sc19_operator_auto_free_settings()
returns table(auto_free_enabled boolean, secret_configured boolean, updated_at timestamptz)
language plpgsql stable security definer set search_path='' as $$
begin
  perform private.sc19_require_operator();
  -- Never returns the secret itself, only whether one is configured.
  return query select s.auto_free_enabled, (s.request_secret is not null and octet_length(s.request_secret) >= 32), s.updated_at
    from private.sc19_trial_auto_settings s where s.singleton;
end;
$$;
revoke all on function public.sc19_operator_auto_free_settings() from public, anon, authenticated;
grant execute on function public.sc19_operator_auto_free_settings() to authenticated;

-- ---------------------------------------------------------------------------
-- Part B: consent

-- Grants consent for the company. The wording is read from the database for the
-- named version; the caller cannot supply it. Re-granting an already active
-- consent appends nothing and returns the time of the consent in force.
create function public.marketing_consent_grant(target_company uuid, consent_version text, consent_source text default 'company_panel')
returns timestamptz language plpgsql volatile security definer set search_path='' as $$
declare
  actor uuid := (select auth.uid());
  wording text;
  latest private.marketing_consent_events;
  granted_at timestamptz;
begin
  if actor is null or not private.is_company_owner(target_company) then
    raise exception 'sc19_company_forbidden' using errcode='42501';
  end if;
  if consent_source is null or consent_source not in ('registration','company_panel') then
    raise exception 'marketing_consent_invalid_source' using errcode='22023';
  end if;
  wording := private.marketing_consent_text(consent_version);
  if wording is null then
    raise exception 'marketing_consent_unknown_version' using errcode='22023';
  end if;
  perform private.sc19_lock_company(target_company);
  select * into latest from private.marketing_consent_events
    where company_id=target_company order by occurred_at desc, id desc limit 1;
  if latest.id is not null and latest.event='granted' then
    return latest.occurred_at; -- already active: history untouched
  end if;
  insert into private.marketing_consent_events(company_id,event,consent_version,consent_text,source,actor_id)
    values(target_company,'granted',consent_version,wording,consent_source,actor)
    returning occurred_at into granted_at;
  return granted_at;
end;
$$;
revoke all on function public.marketing_consent_grant(uuid,text,text) from public, anon, authenticated;
grant execute on function public.marketing_consent_grant(uuid,text,text) to authenticated;

-- One-click withdrawal. Appends a 'withdrawn' row carrying the version and the
-- wording that was in force, and the time of withdrawal. The grant row stays.
create function public.marketing_consent_withdraw(target_company uuid)
returns timestamptz language plpgsql volatile security definer set search_path='' as $$
declare
  actor uuid := (select auth.uid());
  latest private.marketing_consent_events;
  withdrawn_at timestamptz;
begin
  if actor is null or not private.is_company_owner(target_company) then
    raise exception 'sc19_company_forbidden' using errcode='42501';
  end if;
  perform private.sc19_lock_company(target_company);
  select * into latest from private.marketing_consent_events
    where company_id=target_company order by occurred_at desc, id desc limit 1;
  if latest.id is null or latest.event='withdrawn' then
    raise exception 'marketing_consent_not_active' using errcode='22023';
  end if;
  insert into private.marketing_consent_events(company_id,event,consent_version,consent_text,source,actor_id)
    values(target_company,'withdrawn',latest.consent_version,latest.consent_text,'company_panel',actor)
    returning occurred_at into withdrawn_at;
  return withdrawn_at;
end;
$$;
revoke all on function public.marketing_consent_withdraw(uuid) from public, anon, authenticated;
grant execute on function public.marketing_consent_withdraw(uuid) to authenticated;

-- Current state for the company panel: the latest event only. Any member with
-- company access may read it; only the owner may change it.
create function public.marketing_consent_state(target_company uuid)
returns table(event text, consent_version text, consent_text text, occurred_at timestamptz)
language plpgsql stable security definer set search_path='' as $$
begin
  if (select auth.uid()) is null or not private.has_company_access(target_company, false) then
    raise exception 'sc19_company_forbidden' using errcode='42501';
  end if;
  return query select e.event, e.consent_version, e.consent_text, e.occurred_at
    from private.marketing_consent_events e where e.company_id=target_company
    order by e.occurred_at desc, e.id desc limit 1;
end;
$$;
revoke all on function public.marketing_consent_state(uuid) from public, anon, authenticated;
grant execute on function public.marketing_consent_state(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Part C: operator reporting

-- Consent state per company for /operator/billing. The wording is not repeated
-- here; the operator needs the state and the time, not the text.
create function public.sc19_operator_marketing_consents(search text default null)
returns table(company_id uuid, event text, consent_version text, occurred_at timestamptz)
language plpgsql stable security definer set search_path='' as $$
declare needle text := nullif(btrim(coalesce(search,'')),'');
begin
  perform private.sc19_require_operator();
  if length(needle) > 200 then raise exception 'sc19_invalid_search' using errcode='22023'; end if;
  return query
    select c.id, latest.event, latest.consent_version, latest.occurred_at
    from public.companies c
    join lateral (
      select e.event, e.consent_version, e.occurred_at from private.marketing_consent_events e
      where e.company_id=c.id order by e.occurred_at desc, e.id desc limit 1
    ) latest on true
    where needle is null or c.id::text=lower(needle) or strpos(lower(c.name), lower(needle)) > 0
    order by c.created_at desc, c.id
    limit 200;
end;
$$;
revoke all on function public.sc19_operator_marketing_consents(text) from public, anon, authenticated;
grant execute on function public.sc19_operator_marketing_consents(text) to authenticated;

-- Companies whose FREE was granted automatically: name, NIP, when, how many
-- analyses were granted and how many have been consumed since. Consumption is
-- read from the credit journal, which is the only record of a spend.
create function public.sc19_operator_auto_free_grants()
returns table(company_id uuid, company_name text, nip text, granted_at timestamptz,
  granted_credits integer, used_credits integer, mf_status text)
language plpgsql stable security definer set search_path='' as $$
begin
  perform private.sc19_require_operator();
  return query
    select c.id, c.name, g.nip, g.checked_at, g.granted_credits,
      coalesce((select -sum(j.delta)::integer from private.sc19_credit_journal j
        where j.company_id=c.id and j.reason in ('analysis_reserve','analysis_release','analysis_retry')), 0),
      g.mf_status
    from private.sc19_trial_auto_checks g
    join public.companies c on c.id=g.company_id
    where g.outcome='granted'
    order by g.checked_at desc, g.id
    limit 200;
end;
$$;
revoke all on function public.sc19_operator_auto_free_grants() from public, anon, authenticated;
grant execute on function public.sc19_operator_auto_free_grants() to authenticated;

-- Counts for the daily internal summary. Signed, not operator-authenticated,
-- because the scheduler has no session. COUNTS ONLY: no name, NIP, e-mail or
-- any other identifying value leaves this function, so the summary can be
-- mailed to an internal address without carrying personal data.
create function public.sc19_daily_digest(window_start timestamptz, window_end timestamptz,
  request_id uuid, issued_at_ms bigint, request_signature text)
returns table(registered integer, auto_free integer, awaiting_manual integer, marketing_consents integer)
language plpgsql stable security definer set search_path='' as $$
declare payload text;
begin
  if window_start is null or window_end is null or window_end <= window_start
     or window_end - window_start > interval '32 days' then
    raise exception 'sc19_digest_invalid_window' using errcode='22023';
  end if;
  payload := concat_ws(E'\n', to_char(window_start at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS'),
    to_char(window_end at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS'));
  if not private.sc19_trial_auto_verify_signature('digest', request_id, issued_at_ms, payload, request_signature) then
    raise exception 'sc19_auto_forbidden' using errcode='42501';
  end if;
  return query select
    (select count(*)::integer from public.companies c
       where c.created_at >= window_start and c.created_at < window_end),
    (select count(*)::integer from private.sc19_trial_auto_checks g
       where g.outcome='granted' and g.checked_at >= window_start and g.checked_at < window_end),
    (select count(*)::integer from public.companies c
       where c.created_at >= window_start and c.created_at < window_end
         and not exists (select 1 from private.sc19_trial_approvals a where a.company_id=c.id)),
    (select count(*)::integer from private.marketing_consent_events e
       where e.event='granted' and e.occurred_at >= window_start and e.occurred_at < window_end);
end;
$$;
revoke all on function public.sc19_daily_digest(timestamptz,timestamptz,uuid,bigint,text) from public, anon, authenticated;
grant execute on function public.sc19_daily_digest(timestamptz,timestamptz,uuid,bigint,text) to anon, authenticated;

commit;
