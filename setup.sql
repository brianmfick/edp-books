-- EDP Books: database setup.
-- Paste all of this into Supabase > SQL Editor > New query, then click Run.
-- Safe to run more than once.
--
-- Every table is locked with row level security: a row can only be read or
-- changed by the login that owns it. The website's public key alone gets nothing.
-- Accounts are kept by nickname only. Never store account or routing numbers.

-- ---------------------------------------------------------------- tables

create table if not exists public.accounts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name            text not null,
  bank            text,
  kind            text not null default 'checking'
                  check (kind in ('checking','savings','credit card','loan','cash','other')),
  side            text not null default 'business' check (side in ('business','personal')),
  opening_balance numeric(14,2) not null default 0,
  opening_date    date,
  active          boolean not null default true,
  notes           text,
  created_at      timestamptz not null default now()
);

create table if not exists public.categories (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null,
  kind       text not null check (kind in ('income','expense','transfer')),
  side       text not null default 'business' check (side in ('business','personal','both')),
  tax_group  text,
  sort       int not null default 100,
  active     boolean not null default true,
  unique (user_id, name)
);

create table if not exists public.payees (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name                text not null,
  is_contractor       boolean not null default false,
  w9_on_file          boolean not null default false,
  default_category_id uuid references public.categories(id) on delete set null,
  match_text          text,
  notes               text,
  unique (user_id, name)
);

create table if not exists public.statements (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account_id    uuid references public.accounts(id) on delete set null,
  label         text,
  period_start  date,
  period_end    date,
  start_balance numeric(14,2),
  end_balance   numeric(14,2),
  file_path     text,
  file_type     text,
  status        text not null default 'uploaded' check (status in ('uploaded','loaded','problem')),
  notes         text,
  uploaded_at   timestamptz not null default now(),
  loaded_at     timestamptz
);

create table if not exists public.transactions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account_id   uuid not null references public.accounts(id) on delete restrict,
  date         date not null,
  amount       numeric(14,2) not null,          -- money in is positive, money out is negative
  description  text not null default '',        -- as the bank printed it
  payee        text,
  category_id  uuid references public.categories(id) on delete set null,
  side         text check (side in ('business','personal')),
  job          text,                            -- BB-### or IL-###
  check_no     text,
  memo         text,
  reviewed     boolean not null default false,
  flagged      boolean not null default false,
  flag_note    text,
  statement_id uuid references public.statements(id) on delete set null,
  source       text not null default 'manual' check (source in ('manual','statement','csv')),
  import_key   text,                            -- stops one statement line from loading twice
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index if not exists transactions_import_key_all
  on public.transactions (user_id, import_key);
create index if not exists transactions_user_date on public.transactions (user_id, date desc);
create index if not exists transactions_account_date on public.transactions (account_id, date);
create index if not exists transactions_job on public.transactions (user_id, job);

create table if not exists public.flags (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind           text not null default 'other',
  message        text not null,
  job            text,
  transaction_id uuid references public.transactions(id) on delete set null,
  status         text not null default 'open' check (status in ('open','ok','fixed')),
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz
);

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;

create or replace trigger transactions_touch before update on public.transactions
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------- views

create or replace view public.account_balances with (security_invoker = true) as
select a.id as account_id,
       a.opening_balance + coalesce(sum(t.amount) filter (
         where a.opening_date is null or t.date >= a.opening_date), 0) as balance,
       count(t.id) as lines,
       max(t.date) as last_date
from public.accounts a
left join public.transactions t on t.account_id = a.id
group by a.id;

create or replace view public.statement_check with (security_invoker = true) as
select s.id as statement_id,
       s.start_balance + coalesce((
         select sum(t.amount) from public.transactions t
         where t.account_id = s.account_id
           and t.date between s.period_start and s.period_end), 0) as computed_end,
       (select count(*) from public.transactions t where t.statement_id = s.id) as lines
from public.statements s;

-- ---------------------------------------------------------------- locks (row level security)

alter table public.accounts     enable row level security;
alter table public.categories   enable row level security;
alter table public.payees       enable row level security;
alter table public.statements   enable row level security;
alter table public.transactions enable row level security;
alter table public.flags        enable row level security;

do $$
declare t text;
begin
  foreach t in array array['accounts','categories','payees','statements','transactions','flags'] loop
    if not exists (select 1 from pg_policies
                   where schemaname = 'public' and tablename = t and policyname = 'owner only') then
      execute format(
        'create policy "owner only" on public.%I for all to authenticated
           using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
    end if;
  end loop;
end $$;

revoke all on public.accounts, public.categories, public.payees, public.statements,
              public.transactions, public.flags, public.account_balances, public.statement_check
  from anon;
grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete
  on public.accounts, public.categories, public.payees, public.statements,
     public.transactions, public.flags
  to authenticated, service_role;
grant select on public.account_balances, public.statement_check to authenticated, service_role;

-- ---------------------------------------------------------------- starting categories

create or replace function public.seed_categories(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.categories (user_id, name, kind, side, tax_group, sort) values
    (p_user, 'Job income - retail',          'income',   'business', 'Gross receipts',          10),
    (p_user, 'Job income - insurance',       'income',   'business', 'Gross receipts',          11),
    (p_user, 'Other business income',        'income',   'business', 'Other income',            12),
    (p_user, 'Refunds and returns',          'income',   'business', 'Returns',                 13),
    (p_user, 'Materials',                    'expense',  'business', 'Materials / supplies',    20),
    (p_user, 'Subcontractors and labor',     'expense',  'business', 'Contract labor',          21),
    (p_user, 'Dumpsters and disposal',       'expense',  'business', 'Other expenses',          22),
    (p_user, 'Permits',                      'expense',  'business', 'Taxes and licenses',      23),
    (p_user, 'Tools and equipment',          'expense',  'business', 'Supplies',                24),
    (p_user, 'Equipment rental',             'expense',  'business', 'Rent - equipment',        25),
    (p_user, 'Fuel',                         'expense',  'business', 'Car and truck',           26),
    (p_user, 'Truck repairs and upkeep',     'expense',  'business', 'Car and truck',           27),
    (p_user, 'Business insurance',           'expense',  'business', 'Insurance',               28),
    (p_user, 'Advertising and leads',        'expense',  'business', 'Advertising',             29),
    (p_user, 'Software and subscriptions',   'expense',  'business', 'Office expense',          30),
    (p_user, 'Phone and internet',           'expense',  'business', 'Utilities',               31),
    (p_user, 'Office supplies',              'expense',  'business', 'Office expense',          32),
    (p_user, 'Meals',                        'expense',  'business', 'Meals',                   33),
    (p_user, 'Travel',                       'expense',  'business', 'Travel',                  34),
    (p_user, 'Wages',                        'expense',  'business', 'Wages',                   35),
    (p_user, 'Payroll taxes',                'expense',  'business', 'Taxes and licenses',      36),
    (p_user, 'Licenses and fees',            'expense',  'business', 'Taxes and licenses',      37),
    (p_user, 'Legal and accounting',         'expense',  'business', 'Legal and professional',  38),
    (p_user, 'Rent and office',              'expense',  'business', 'Rent - property',         39),
    (p_user, 'Bank and card fees',           'expense',  'business', 'Other expenses',          40),
    (p_user, 'Loan interest',                'expense',  'business', 'Interest',                41),
    (p_user, 'Warranty and callbacks',       'expense',  'business', 'Repairs',                 42),
    (p_user, 'Other business expense',       'expense',  'business', 'Other expenses',          49),
    (p_user, 'Groceries',                    'expense',  'personal', null,                      60),
    (p_user, 'Dining out',                   'expense',  'personal', null,                      61),
    (p_user, 'Home and mortgage',            'expense',  'personal', null,                      62),
    (p_user, 'Home utilities',               'expense',  'personal', null,                      63),
    (p_user, 'Car (personal)',               'expense',  'personal', null,                      64),
    (p_user, 'Medical',                      'expense',  'personal', null,                      65),
    (p_user, 'Personal insurance',           'expense',  'personal', null,                      66),
    (p_user, 'Family',                       'expense',  'personal', null,                      67),
    (p_user, 'Shopping',                     'expense',  'personal', null,                      68),
    (p_user, 'Entertainment',                'expense',  'personal', null,                      69),
    (p_user, 'Subscriptions (personal)',     'expense',  'personal', null,                      70),
    (p_user, 'Gifts and donations',          'expense',  'personal', null,                      71),
    (p_user, 'Personal taxes',               'expense',  'personal', null,                      72),
    (p_user, 'Other personal expense',       'expense',  'personal', null,                      79),
    (p_user, 'Pay and draws received',       'income',   'personal', null,                      80),
    (p_user, 'Other personal income',        'income',   'personal', null,                      81),
    (p_user, 'Transfer between accounts',    'transfer', 'both',     null,                      90),
    (p_user, 'Credit card payment',          'transfer', 'both',     null,                      91),
    (p_user, 'Owner draw',                   'transfer', 'both',     null,                      92),
    (p_user, 'Owner money put in',           'transfer', 'both',     null,                      93),
    (p_user, 'Loan payment (principal)',     'transfer', 'both',     null,                      94)
  on conflict (user_id, name) do nothing;
end $$;

revoke execute on function public.seed_categories(uuid) from public, anon, authenticated;

create or replace function public.seed_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.seed_categories(new.id);
  return new;
end $$;

revoke execute on function public.seed_new_user() from public, anon, authenticated;

create or replace trigger edp_books_seed after insert on auth.users
  for each row execute function public.seed_new_user();

select public.seed_categories(id) from auth.users;

-- ---------------------------------------------------------------- statement files

insert into storage.buckets (id, name, public, file_size_limit)
values ('statements', 'statements', false, 26214400)
on conflict (id) do nothing;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                 and policyname = 'statements: owner reads') then
    create policy "statements: owner reads" on storage.objects for select to authenticated
      using (bucket_id = 'statements' and (storage.foldername(name))[1] = (select auth.uid())::text);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                 and policyname = 'statements: owner uploads') then
    create policy "statements: owner uploads" on storage.objects for insert to authenticated
      with check (bucket_id = 'statements' and (storage.foldername(name))[1] = (select auth.uid())::text);
  end if;
end $$;

select 'EDP Books is set up' as result;
