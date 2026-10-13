-- Business funding: mark whose funding each row is — the person's own, or
-- their organisation's. Run once in the Supabase SQL editor. Safe to run again.
--
-- Until now every funding was personal, and the Business panel (dashboard,
-- portfolio, ledger, reports) showed the same rows as the Individual panel. An
-- account holding both roles saw its personal funding counted as the business's.

-- 1. Whose funding this is. Existing rows (and anything inserted without it)
--    are personal.
alter table public.individual_fundings
  add column if not exists funded_as text not null default 'individual';

do $$
begin
  alter table public.individual_fundings
    add constraint individual_fundings_funded_as_check
    check (funded_as in ('individual', 'business'));
exception when duplicate_object then null;
end $$;

create index if not exists individual_fundings_user_funded_as_idx
  on public.individual_fundings (user_id, funded_as);

-- 2. Accounts that are Business only (no Individual role) never had a personal
--    panel, so whatever funding they already have belongs to the business.
--    (roles is matched as text so this works whether it's text[] or jsonb.)
update public.individual_fundings f
   set funded_as = 'business'
  from public.profiles p
 where p.auth_id::text = f.user_id::text
   and f.funded_as = 'individual'
   and (p.role = 'business' or coalesce(p.roles::text, '') ~ '\mbusiness\M')
   and not (p.role = 'individual' or coalesce(p.roles::text, '') ~ '\mindividual\M');
