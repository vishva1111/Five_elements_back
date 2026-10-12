-- Business panel: give every team member, report and org profile an owner.
-- Run once in the Supabase SQL editor. Safe to run again.
--
-- Until now team_members and reports had no owner, so every business account saw
-- (and could delete) every other business's team and reports. The backend now
-- scopes both to owner_id = the signed-in business account.

-- 1. Team members belong to the business account that added them.
alter table public.team_members add column if not exists owner_id uuid;
create index if not exists team_members_owner_idx on public.team_members (owner_id);
-- One row per email per business (existing rows have no owner, so they don't clash).
create unique index if not exists team_members_owner_email_uidx
  on public.team_members (owner_id, lower(email));

-- 2. Reports belong to the business account that generated them.
alter table public.reports add column if not exists owner_id uuid;
create index if not exists reports_owner_idx on public.reports (owner_id);

-- 3. Organisation settings + public-profile settings, one row per business account.
create table if not exists public.business_orgs (
  owner_id       uuid primary key,
  org_name       text,
  industry       text,
  country        text,
  employees      text,
  framework      text,
  fy_end         text,
  tagline        text,
  website        text,
  visibility     text not null default 'public' check (visibility in ('public', 'private')),
  show_trees     boolean not null default true,
  show_tco2e     boolean not null default true,
  show_projects  boolean not null default true,
  show_ledger    boolean not null default true,
  updated_at     timestamptz not null default now()
);
-- Only the backend (service role) reads/writes this table.
alter table public.business_orgs enable row level security;

-- Existing team_members / reports rows were created before ownership existed and
-- stay unassigned (hidden from every business). To hand one to an account:
--   update public.reports      set owner_id = '<auth user id>' where id = '<report id>';
--   update public.team_members set owner_id = '<auth user id>' where id = '<member id>';
