begin;

-- Text CV intake only. No public storage bucket, AI calls or candidate decisions.
create table public.candidate_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  candidate_id uuid not null,
  source_text text not null check (length(btrim(source_text)) between 1 and 100000),
  redacted_text text not null check (length(btrim(redacted_text)) between 1 and 100000),
  version integer not null default 1 check (version > 0),
  status text not null default 'draft' check (status in ('draft', 'reviewed')),
  reviewed_by uuid references auth.users(id) on delete restrict,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, candidate_id) references public.candidates(company_id, id) on delete cascade,
  check ((status = 'reviewed') = (reviewed_by is not null and reviewed_at is not null)),
  check (status <> 'draft' or (reviewed_by is null and reviewed_at is null))
);
create index candidate_documents_candidate_idx on public.candidate_documents(company_id, candidate_id, created_at desc);
alter table public.candidate_documents enable row level security;
revoke all on public.candidate_documents from public, anon, authenticated;
grant select on public.candidate_documents to authenticated;
grant insert (company_id, candidate_id, source_text, redacted_text) on public.candidate_documents to authenticated;
grant update (redacted_text) on public.candidate_documents to authenticated;
create policy document_read on public.candidate_documents for select to authenticated
  using (private.has_company_access(company_id));
create policy document_insert on public.candidate_documents for insert to authenticated
  with check (private.has_company_access(company_id, true));
create policy document_update on public.candidate_documents for update to authenticated
  using (private.has_company_access(company_id, true)) with check (private.has_company_access(company_id, true));

create function private.version_candidate_document()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.version := old.version + 1;
  new.updated_at := now();
  if new.redacted_text is distinct from old.redacted_text then
    new.status := 'draft';
    new.reviewed_by := null;
    new.reviewed_at := null;
  end if;
  return new;
end;
$$;
revoke all on function private.version_candidate_document() from public, anon, authenticated;
create trigger version_candidate_document before update on public.candidate_documents
  for each row execute function private.version_candidate_document();

-- Approval is bound to the exact version seen by the authenticated reviewer.
create function public.review_candidate_document(document_id uuid, expected_version integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare reviewed_id uuid;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  update public.candidate_documents d
    set status = 'reviewed', reviewed_by = (select auth.uid()), reviewed_at = now()
    where d.id = document_id and d.version = expected_version
      and private.has_company_access(d.company_id, true)
    returning d.id into reviewed_id;
  return reviewed_id is not null;
end;
$$;
revoke all on function public.review_candidate_document(uuid, integer) from public, anon, authenticated;
grant execute on function public.review_candidate_document(uuid, integer) to authenticated;
commit;
