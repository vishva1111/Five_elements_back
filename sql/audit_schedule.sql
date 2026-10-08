-- Audit schedule: Planting -> Audit 1 -> (+3 months) -> Audit 2 -> Audit 3 -> Audit 4
-- Run once in the Supabase SQL editor. Safe to run again.

-- 1. The plan for the NEXT audit of a tree (rounds 2-4).
--    When an audit is approved a row is added for the following round, due 3 months
--    later; the backend turns it into a normal task once the date comes.
create table if not exists public.audit_schedule (
  id               uuid primary key default gen_random_uuid(),
  tree_id          uuid not null references public.tree_records (id) on delete cascade,
  project_id       text,
  round            integer not null check (round between 2 and 4),
  due_at           timestamptz not null,
  status           text not null default 'pending'
                     check (status in ('pending', 'created', 'cancelled')),
  cancel_reason    text,                    -- 'dead' | 'missing' | 'tree removed'
  source_task_id   text,                    -- the approved audit that planned this one
  partner_user_id  uuid,                    -- who the new task is created for (the partner)
  created_task_id  text,                    -- the task that was created
  created_task_at  timestamptz,
  created_at       timestamptz not null default now(),
  unique (tree_id, round)                   -- one plan per tree and round: no duplicates
);

create index if not exists audit_schedule_due_idx
  on public.audit_schedule (status, due_at);
create index if not exists audit_schedule_project_idx
  on public.audit_schedule (project_id);

-- Only the backend (service role) reads and writes this table.
alter table public.audit_schedule enable row level security;

-- 2. Optional, run AFTER the backfill from the admin panel has labelled the old tasks:
--    a tree can have only one task per audit round.
-- create unique index if not exists tasks_one_audit_per_round
--   on public.tasks (tree_id, audit_round)
--   where task_type = 'audit' and audit_round is not null;
