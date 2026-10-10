begin;
-- Disabled until the owner resumes production rollout. No backfill of historical leads.
create table private.sales_mail_settings (
  id boolean primary key default true check(id),
  enabled boolean not null default false,
  worker_secret text check(worker_secret is null or octet_length(worker_secret)>=32)
);
insert into private.sales_mail_settings(id) values(true);
alter table private.sales_mail_settings enable row level security;
revoke all on private.sales_mail_settings from public,anon,authenticated;

create table private.sales_mail_outbox (
  lead_id uuid primary key references public.sales_leads(id) on delete cascade,
  template_version text not null default 'v1' check(template_version='v1'),
  state text not null default 'pending' check(state in ('pending','sending','retry','accepted','failed','uncertain','suppressed')),
  created_at timestamptz not null default clock_timestamp(),
  next_attempt_at timestamptz not null default clock_timestamp(),
  first_attempt_at timestamptz,
  attempts integer not null default 0 check(attempts between 0 and 6),
  lease_id uuid,
  lease_until timestamptz,
  provider_id uuid,
  last_code text,
  accepted_at timestamptz
);
alter table private.sales_mail_outbox enable row level security;
revoke all on private.sales_mail_outbox from public,anon,authenticated;
create index sales_mail_pending_idx on private.sales_mail_outbox(next_attempt_at) where state in ('pending','retry','sending');

create function private.enqueue_sales_mail() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from private.sales_mail_settings where id and enabled and worker_secret is not null) then return new; end if;
  -- Limit confirmation abuse: one message per normalized address per 24h.
  perform pg_advisory_xact_lock(6107,hashtext(new.email));
  if exists(select 1 from private.sales_mail_outbox o join public.sales_leads l on l.id=o.lead_id
    where l.email=new.email and o.created_at>clock_timestamp()-interval '24 hours') then return new; end if;
  insert into private.sales_mail_outbox(lead_id) values(new.id) on conflict do nothing;
  return new;
end $$;
revoke all on function private.enqueue_sales_mail() from public,anon,authenticated;
create trigger sales_lead_auto_reply after insert on public.sales_leads for each row execute function private.enqueue_sales_mail();

-- Separate worker capability, never exposed to browsers. Sign all operation arguments.
create function private.verify_sales_mail_signature(op text,target uuid,lease uuid,stamp bigint,outcome text,provider uuid,signature text) returns boolean
language plpgsql security definer set search_path='' as $$
declare secret text; canonical text;
begin
  select worker_secret into secret from private.sales_mail_settings where id and enabled for share;
  if secret is null or stamp is null or lease is null or signature is null then return false; end if;
  if abs(extract(epoch from clock_timestamp())*1000-stamp::numeric)>60000 then return false; end if;
  canonical:=concat_ws(E'\n','sales-mail-v1',op,coalesce(target::text,'-'),lease::text,stamp::text,coalesce(outcome,'-'),coalesce(provider::text,'-'));
  return signature=encode(extensions.hmac(canonical,secret,'sha256'),'hex');
end $$;
revoke all on function private.verify_sales_mail_signature(text,uuid,uuid,bigint,text,uuid,text) from public,anon,authenticated;

create function public.claim_sales_mail(target_lead uuid,request_id uuid,issued_at_ms bigint,request_signature text)
returns table(lead_id uuid,email text,template_version text,lease_id uuid)
language plpgsql security definer set search_path='' as $$
declare chosen uuid;
begin
  if not private.verify_sales_mail_signature('claim',target_lead,request_id,issued_at_ms,null,null,request_signature) then raise exception 'sales_mail_forbidden'; end if;
  -- A captured signed claim cannot drain more jobs by replaying the same nonce.
  perform pg_advisory_xact_lock(6108,hashtext(request_id::text));
  if exists(select 1 from private.sales_mail_outbox o where o.lease_id=request_id) then return; end if;
  update private.sales_mail_outbox o set state='suppressed',last_code='confirmation_expired'
    where o.state='pending' and o.created_at<=clock_timestamp()-interval '24 hours';
  -- Never automatically resend beyond the provider's 24h idempotency window.
  update private.sales_mail_outbox o set state='uncertain',last_code='retry_window_exhausted'
    where o.state in ('pending','retry','sending') and (o.first_attempt_at<=clock_timestamp()-interval '12 hours' or
      (o.attempts>=6 and (o.lease_until is null or o.lease_until<=clock_timestamp())));
  update private.sales_mail_outbox o set state='suppressed',last_code='conversation_closed'
    where o.state in ('pending','retry') and exists(select 1 from private.sales_lead_closures c where c.lead_id=o.lead_id);
  select o.lead_id into chosen from private.sales_mail_outbox o
    where (target_lead is null or o.lead_id=target_lead) and o.attempts<6
      and ((o.state in ('pending','retry') and o.next_attempt_at<=clock_timestamp())
        or (o.state='sending' and o.lease_until<=clock_timestamp()))
    order by o.next_attempt_at,o.lead_id for update skip locked limit 1;
  if chosen is null then return; end if;
  update private.sales_mail_outbox o set state='sending',lease_id=request_id,lease_until=clock_timestamp()+interval '2 minutes',
    attempts=o.attempts+1,first_attempt_at=coalesce(o.first_attempt_at,clock_timestamp()) where o.lead_id=chosen;
  return query select o.lead_id,l.email,o.template_version,o.lease_id from private.sales_mail_outbox o
    join public.sales_leads l on l.id=o.lead_id where o.lead_id=chosen;
end $$;
revoke all on function public.claim_sales_mail(uuid,uuid,bigint,text) from public,anon,authenticated;
grant execute on function public.claim_sales_mail(uuid,uuid,bigint,text) to anon,authenticated;

create function public.finish_sales_mail(target_lead uuid,request_id uuid,issued_at_ms bigint,outcome text,provider_id uuid,request_signature text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if outcome is null or outcome not in ('accepted','retry','failed') or
    (outcome='accepted' and provider_id is null) or
    not private.verify_sales_mail_signature('finish',target_lead,request_id,issued_at_ms,outcome,provider_id,request_signature)
    then raise exception 'sales_mail_forbidden'; end if;
  update private.sales_mail_outbox o set state=outcome,
    provider_id=finish_sales_mail.provider_id,
    accepted_at=case when outcome='accepted' then clock_timestamp() else null end,
    last_code=outcome,lease_until=null,
    next_attempt_at=clock_timestamp()+make_interval(secs=>least(3600,60*power(3,o.attempts-1))::integer)
    where o.lead_id=target_lead and o.lease_id=request_id and o.state='sending' and o.lease_until>clock_timestamp();
  return found;
end $$;
revoke all on function public.finish_sales_mail(uuid,uuid,bigint,text,uuid,text) from public,anon,authenticated;
grant execute on function public.finish_sales_mail(uuid,uuid,bigint,text,uuid,text) to anon,authenticated;
commit;
