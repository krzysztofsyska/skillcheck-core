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
--   * the registry answer passed in is status 'Czynny' or 'Zwolniony'
--     (owner decision 2026-11-03: VAT-exempt companies are real companies);
--   * this company has not already tried the automatic path with a DIFFERENT
--     NIP (private.sc19_auto_free_other_nip_tried).
-- Anything else raises and the company stays on the existing manual list.
--
-- ONE FREE PER NIP, AND HOW A MISTAKE IS UNDONE. A NIP is public, and the
-- registry answer proves the company exists, not that the caller represents it.
-- So one account CAN occupy another company's single FREE, once. Two limits and
-- one remedy bound that: the account may only ever try one NIP automatically,
-- the occupied NIP is listed for the operator
-- (public.sc19_operator_taken_trial_nips), and the operator can release it
-- (public.sc19_operator_release_trial_nip) so the real company can activate
-- FREE afterwards. A release frees the NIP only; it never changes a balance,
-- because that is a billing action and belongs to the owner.
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
-- SC-010 NOTE. Five tables are added, so private.erasure_schema_signature()
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

-- Operator releases of an occupied trial NIP. The remedy for the residual risk
-- that a public NIP can be occupied once by an account that does not represent
-- it: the operator frees the NIP so the real company can activate FREE. The
-- company id is a plain uuid, with no foreign key, deliberately — the audit of
-- who occupied the NIP must survive even after the release has removed the rows
-- that linked the two, and the row is never deleted with the company.
create table private.sc19_trial_nip_releases (
  id uuid primary key default gen_random_uuid(),
  nip text not null check (nip ~ '^[0-9]{10}$'),
  released_company_id uuid,
  operator_id uuid not null,
  reason text not null check (length(btrim(reason)) between 8 and 300),
  released_at timestamptz not null default now()
);
create index sc19_trial_nip_releases_nip on private.sc19_trial_nip_releases(nip, released_at desc);
create trigger immutable_history before update or delete on private.sc19_trial_nip_releases
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
  private.sc19_trial_auto_checks, private.sc19_trial_nip_releases,
  private.marketing_consent_events from public, anon, authenticated;
alter table private.sc19_trial_auto_settings enable row level security;
alter table private.sc19_trial_auto_nonces enable row level security;
alter table private.sc19_trial_auto_checks enable row level security;
alter table private.sc19_trial_nip_releases enable row level security;
alter table private.marketing_consent_events enable row level security;

comment on table private.sc19_trial_auto_checks is
  'SC-010: automatic FREE verification audit (company id, NIP, registry answer); company-level data, no candidate data.';
comment on table private.marketing_consent_events is
  'SC-010: append-only consent-to-marketing ledger (company id, wording, version, time); company-level data, no candidate data.';
comment on table private.sc19_trial_auto_settings is
  'SC-010: operator switch and request secret for automatic FREE; no personal data.';
comment on table private.sc19_trial_auto_nonces is
  'SC-010: signed request ids for replay protection; no personal data.';
comment on table private.sc19_trial_nip_releases is
  'SC-010: operator releases of an occupied trial NIP (NIP, which company held it, which operator, why, when); company-level data, no candidate data.';

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
-- secret-dependent comparison is constant time. `op` separates the three
-- operations that share the one secret, so a signature for one can never be
-- replayed as another. 'consent' is NOT in this list on purpose: that signature
-- is verified in Node only (lib/marketing-consent.ts) and must never be
-- presentable to an RPC.
--
-- REPLAY WINDOW, EXACTLY WHAT IT IS. The signature is accepted only inside a
-- +-60 s window, and the nonce insert below makes a SECOND SUCCESSFUL use of the
-- same request id fail. It does NOT make a retry after a failure fail: the
-- insert happens in the caller's transaction, so when the calling RPC raises
-- afterwards (a forbidden caller, a disabled switch, a trial guardrail) the
-- nonce row is rolled back with it and the same signed request may be presented
-- again until its 60 s window closes. That is accepted: a request that raises
-- grants nothing and writes nothing, so repeating it inside one minute achieves
-- nothing a single attempt would not. Making the nonce survive a rollback would
-- need its own transaction (dblink or a background worker), which this change
-- deliberately does not introduce.
create function private.sc19_trial_auto_verify_signature(op text, request_id uuid, stamp bigint, payload text, signature text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare secret text; expected text;
begin
  select s.request_secret into secret from private.sc19_trial_auto_settings s where s.singleton;
  if secret is null or octet_length(secret) < 32 then return false; end if;
  if op is null or op not in ('auto_claim','auto_failure','digest') then return false; end if;
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

-- The only supported way to install or change the request secret, modelled on
-- private.rotate_sales_lead_request_secret. Without it the column could be set
-- only by a raw UPDATE, which the owner cannot run (he does not open Supabase)
-- and an agent session must not run against production — so Part A could never
-- be switched on. Private: it is called from the approved production SQL step,
-- never from the Data API, and it never returns or logs the secret.
create function private.rotate_sc19_trial_auto_secret(new_secret text)
returns void language plpgsql volatile security definer set search_path='' as $$
begin
  if new_secret is null or octet_length(new_secret) < 32 then
    raise exception 'sc19_trial_auto_secret_invalid' using errcode='22023';
  end if;
  update private.sc19_trial_auto_settings
    set request_secret=new_secret, updated_at=now() where singleton;
  if not found then raise exception 'sc19_trial_auto_settings_missing' using errcode='55000'; end if;
  -- Signed requests made with the previous secret stop verifying immediately.
  -- That is intended: the window is 60 s and a rejected request grants nothing.
  delete from private.sc19_trial_auto_nonces;
end;
$$;
revoke all on function private.rotate_sc19_trial_auto_secret(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Part A: automatic FREE

-- One account may only ever use the automatic path for ONE NIP. A NIP is
-- public, so without this an account could walk a list of other companies' NIPs
-- and occupy their single FREE one after another.
--
-- The account's NIP is the FIRST one whose check actually reached the registry,
-- or the NIP of its approval. Refusals decided locally before the registry
-- (AUTO_DISABLED, NIP_TAKEN, ANOTHER_NIP_TRIED) do NOT claim the slot: the
-- automat being off, or a mistyped NIP bouncing off this very rule, must not
-- lock an account out of the one NIP it is entitled to check. Once the slot is
-- taken, that NIP stays retryable for ever — an outage must not burn the
-- attempt — and every other NIP is refused.
create function private.sc19_auto_free_other_nip_tried(target_company uuid, normalized text)
returns boolean language plpgsql stable security definer set search_path='' as $$
declare claimed text;
begin
  select c.nip into claimed from private.sc19_trial_auto_checks c
    where c.company_id=target_company
      and coalesce(c.error_code,'') not in ('AUTO_DISABLED','NIP_TAKEN','ANOTHER_NIP_TRIED')
    order by c.checked_at, c.id limit 1;
  if claimed is null then
    select a.nip into claimed from private.sc19_trial_approvals a where a.company_id=target_company;
  end if;
  return claimed is not null and claimed <> normalized;
end;
$$;
revoke all on function private.sc19_auto_free_other_nip_tried(uuid,text) from public, anon, authenticated;

-- Asked BEFORE the Ministry of Finance registry is called. Unsigned on purpose:
-- it grants nothing, changes no balance and tells the company's own owner only
-- what he could discover by submitting the form anyway. It exists so that a
-- switched-off automat, a missing secret or a second NIP from the same account
-- never spends a call against the public registry's low daily quota, and so the
-- refusal is recorded where the operator can see it.
--
-- The refusal row is written once per (company, NIP, reason), so repeated
-- submissions cannot inflate the audit table.
create function public.sc19_auto_free_precheck(target_company uuid, supplied_nip text)
returns table(allowed boolean, reason text)
language plpgsql volatile security definer set search_path='' as $$
declare
  normalized text := replace(replace(btrim(coalesce(supplied_nip,'')), '-', ''), ' ', '');
  settings private.sc19_trial_auto_settings;
  refusal text;
begin
  if (select auth.uid()) is null or not private.is_company_owner(target_company) then
    raise exception 'sc19_company_forbidden' using errcode='42501';
  end if;
  if not private.sc19_valid_nip(normalized) then
    raise exception 'sc19_invalid_nip' using errcode='22023';
  end if;
  select * into settings from private.sc19_trial_auto_settings where singleton;
  if settings.singleton is null or not settings.auto_free_enabled
     or settings.request_secret is null or octet_length(settings.request_secret) < 32 then
    refusal := 'AUTO_DISABLED';
  elsif private.sc19_auto_free_other_nip_tried(target_company, normalized) then
    refusal := 'ANOTHER_NIP_TRIED';
  elsif exists (select 1 from private.sc19_trial_nips t where t.nip=normalized and t.company_id<>target_company)
     or exists (select 1 from private.sc19_trial_approvals a where a.nip=normalized and a.company_id<>target_company) then
    -- Taken by SOMEONE ELSE. This company's own rows are not a refusal: asking
    -- again for the NIP it already holds is idempotent, not a second attempt.
    refusal := 'NIP_TAKEN';
  end if;
  if refusal is null then return query select true, null::text; return; end if;
  perform private.sc19_lock_company(target_company);
  if not exists (select 1 from private.sc19_trial_auto_checks c
    where c.company_id=target_company and c.nip=normalized and c.error_code=refusal) then
    insert into private.sc19_trial_auto_checks(company_id,nip,outcome,error_code)
      values(target_company,normalized,'refused',refusal);
  end if;
  return query select false, refusal;
end;
$$;
revoke all on function public.sc19_auto_free_precheck(uuid,text) from public, anon, authenticated;
grant execute on function public.sc19_auto_free_precheck(uuid,text) to authenticated;

-- Records the automatic verification and, only for a confirmed registered
-- taxpayer, produces the approval row and hands over to public.sc19_claim_trial.
--
-- The caller must be the signed-in company OWNER (same rule as the manual form)
-- AND the request must be signed by the server, so neither alone is enough.
-- 'Czynny' and 'Zwolniony' both qualify (owner decision 2026-11-03): a VAT-exempt
-- company is in the register and is a real company, and many small Polish firms
-- are exempt. Any other status, or a missing one, is refused and reviewed by hand.
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

  -- One account, one NIP. Re-checked here and not only in the precheck, so the
  -- rule holds for a caller who goes straight to this RPC through the Data API.
  if private.sc19_auto_free_other_nip_tried(target_company, normalized) then
    insert into private.sc19_trial_auto_checks(company_id,nip,outcome,mf_request_id,mf_status,mf_name,error_code)
      values(target_company,normalized,'refused',nullif(trimmed_request,''),nullif(trimmed_status,''),
        nullif(trimmed_name,''),'ANOTHER_NIP_TRIED');
    return query select 'refused'::text, null::integer, 'ANOTHER_NIP_TRIED'::text;
    return;
  end if;

  -- Not in the register under a granting status, or no usable registry answer.
  if trimmed_status not in ('Czynny','Zwolniony') or trimmed_request = '' or trimmed_name = '' then
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

-- Records an attempt the registry refused ('refused': not found, unknown status,
-- unparseable address) or that never reached a usable answer ('unavailable':
-- timeout, rate limit, outage), so the operator can see the company is waiting
-- and why. Grants nothing and touches no balance.
--
-- Signed under its OWN op label 'auto_failure'. With the shared 'auto_claim'
-- label the two RPCs were kept apart only by how many lines their payload had.
create function public.sc19_auto_record_failure(
  target_company uuid, supplied_nip text, failure_outcome text, failure_code text,
  request_id uuid, issued_at_ms bigint, request_signature text)
returns void language plpgsql volatile security definer set search_path='' as $$
declare
  normalized text := replace(replace(btrim(coalesce(supplied_nip,'')), '-', ''), ' ', '');
  code text := left(btrim(coalesce(failure_code,'')), 48);
  result text := btrim(coalesce(failure_outcome,''));
  payload text;
begin
  if (select auth.uid()) is null or not private.is_company_owner(target_company) then
    raise exception 'sc19_company_forbidden' using errcode='42501';
  end if;
  if not private.sc19_valid_nip(normalized) or code = '' or code !~ '^[A-Z_]{3,48}$'
     or result not in ('refused','unavailable') then
    raise exception 'sc19_invalid_nip' using errcode='22023';
  end if;
  payload := concat_ws(E'\n', lower(target_company::text), normalized, result, code);
  if not private.sc19_trial_auto_verify_signature('auto_failure', request_id, issued_at_ms, payload, request_signature) then
    raise exception 'sc19_auto_forbidden' using errcode='42501';
  end if;
  perform private.sc19_lock_company(target_company);
  insert into private.sc19_trial_auto_checks(company_id,nip,outcome,error_code)
    values(target_company,normalized,result,code);
end;
$$;
revoke all on function public.sc19_auto_record_failure(uuid,text,text,text,uuid,bigint,text) from public, anon, authenticated;
grant execute on function public.sc19_auto_record_failure(uuid,text,text,text,uuid,bigint,text) to authenticated;

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

-- Every occupied trial NIP, with who occupied it and when, so the operator can
-- recognise a NIP occupied by an account that does not represent that company.
create function public.sc19_operator_taken_trial_nips()
returns table(nip text, company_id uuid, company_name text, approved_at timestamptz,
  free_claimed boolean, source text)
language plpgsql stable security definer set search_path='' as $$
begin
  perform private.sc19_require_operator();
  return query
    select a.nip, a.company_id, c.name, a.approved_at,
      exists (select 1 from private.sc19_trial_nips t where t.company_id=a.company_id and t.nip=a.nip),
      case when a.proof_reference like 'mf-biala-lista:%' then 'wykaz VAT' else 'operator' end
    from private.sc19_trial_approvals a
    join public.companies c on c.id=a.company_id
    order by a.approved_at desc, a.nip
    limit 200;
end;
$$;
revoke all on function public.sc19_operator_taken_trial_nips() from public, anon, authenticated;
grant execute on function public.sc19_operator_taken_trial_nips() to authenticated;

-- Releases an occupied trial NIP so the company that really holds it can
-- activate FREE afterwards. The remedy for the one abuse a public NIP allows:
-- an account that does not represent a company occupying its single FREE.
--
-- WHAT IT DOES. It removes the approval row and the claimed-NIP row for that
-- NIP, re-keys the occupying company's trial journal entry (see below) and
-- records who released it, when and why.
--
-- WHY THE JOURNAL ENTRY IS RE-KEYED. public.sc19_claim_trial writes a journal
-- row with reference 'trial:<nip>', and private.sc19_credit_journal has UNIQUE
-- (reference). Deleting only the approval and the claimed-NIP row therefore does
-- NOT free the NIP: the real company's claim would fail on that unique
-- constraint and the release would be useless — which is exactly what the first
-- version of this function did. The reference is an IDEMPOTENCY KEY encoding
-- "this NIP's one FREE", not an accounting fact, and releasing that key is the
-- whole point of the operation. So the reference alone is suffixed with the
-- release id; the row, its company, its reason, its amount and its timestamp are
-- untouched, and the suffix points at the release that explains it.
--
-- WHAT IT DOES NOT DO. It changes no balance, no amount and no package: taking
-- analyses back is a billing action and belongs to the owner, not to this
-- function. The occupying company keeps the analyses it was already granted.
-- The automatic-check audit is untouched too, so the original occupation stays
-- visible. RESIDUAL RISK, stated plainly: a public NIP can still be occupied
-- once by an account that does not represent it, and this is the remedy, not a
-- prevention.
create function public.sc19_operator_release_trial_nip(supplied_nip text, release_reason text)
returns table(released_company_id uuid, released_at timestamptz)
language plpgsql volatile security definer set search_path='' as $$
declare
  actor uuid;
  normalized text := replace(replace(btrim(coalesce(supplied_nip,'')), '-', ''), ' ', '');
  reason text := btrim(coalesce(release_reason,''));
  holder uuid;
  release_id uuid;
  stamp timestamptz;
begin
  actor := private.sc19_require_operator();
  if not private.sc19_valid_nip(normalized) then
    raise exception 'sc19_invalid_nip' using errcode='22023';
  end if;
  if length(reason) < 8 or length(reason) > 300 then
    raise exception 'sc19_release_reason_required' using errcode='22023';
  end if;
  select a.company_id into holder from private.sc19_trial_approvals a where a.nip=normalized;
  if holder is null then
    select t.company_id into holder from private.sc19_trial_nips t where t.nip=normalized;
  end if;
  if holder is null then
    raise exception 'sc19_trial_nip_not_taken' using errcode='22023';
  end if;
  perform private.sc19_lock_company(holder);
  insert into private.sc19_trial_nip_releases(nip,released_company_id,operator_id,reason)
    values(normalized,holder,actor,reason)
    returning sc19_trial_nip_releases.id, sc19_trial_nip_releases.released_at into release_id, stamp;
  delete from private.sc19_trial_nips where nip=normalized;
  delete from private.sc19_trial_approvals where nip=normalized;
  -- Columns are qualified: `reason` is also a local variable here.
  update private.sc19_credit_journal j
    set reference = 'trial:' || normalized || ':zwolniony:' || release_id::text
    where j.reason='trial' and j.reference='trial:' || normalized;
  return query select holder, stamp;
end;
$$;
revoke all on function public.sc19_operator_release_trial_nip(text,text) from public, anon, authenticated;
grant execute on function public.sc19_operator_release_trial_nip(text,text) to authenticated;

-- The releases themselves, so the operator can see what has already been freed.
create function public.sc19_operator_trial_nip_releases()
returns table(nip text, released_company_id uuid, company_name text, reason text, released_at timestamptz)
language plpgsql stable security definer set search_path='' as $$
begin
  perform private.sc19_require_operator();
  return query
    select r.nip, r.released_company_id, c.name, r.reason, r.released_at
    from private.sc19_trial_nip_releases r
    left join public.companies c on c.id=r.released_company_id
    order by r.released_at desc, r.id
    limit 200;
end;
$$;
revoke all on function public.sc19_operator_trial_nip_releases() from public, anon, authenticated;
grant execute on function public.sc19_operator_trial_nip_releases() to authenticated;

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

-- EVERY automatic check, not only the grants: the refusals and the outages are
-- exactly what tells the operator which company is waiting and why, and with
-- the grant-only filter they were written but visible nowhere.
--
-- `used_credits` is the company's LIFETIME consumption from the credit journal,
-- which is the only record of a spend. It therefore also counts analyses paid
-- for later under PRESELEKCJA, and is null for anything but a grant; the panel
-- labels it accordingly rather than implying it is FREE usage.
create function public.sc19_operator_auto_free_grants()
returns table(company_id uuid, company_name text, nip text, checked_at timestamptz,
  outcome text, error_code text, granted_credits integer, used_credits integer, mf_status text)
language plpgsql stable security definer set search_path='' as $$
begin
  perform private.sc19_require_operator();
  return query
    select c.id, c.name, g.nip, g.checked_at, g.outcome, g.error_code, g.granted_credits,
      case when g.outcome='granted' then
        coalesce((select -sum(j.delta)::integer from private.sc19_credit_journal j
          where j.company_id=c.id and j.reason in ('analysis_reserve','analysis_release','analysis_retry')), 0)
      end,
      g.mf_status
    from private.sc19_trial_auto_checks g
    join public.companies c on c.id=g.company_id
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
-- VOLATILE, not stable: verifying the signature prunes and inserts a nonce row,
-- so this function writes. Declaring it stable let PostgreSQL treat it as
-- read-only and would allow it inside a read-only transaction, where the nonce
-- insert — the replay protection — would fail or be skipped.
language plpgsql volatile security definer set search_path='' as $$
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
