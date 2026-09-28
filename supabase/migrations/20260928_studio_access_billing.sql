create extension if not exists pgcrypto;

create table if not exists public.studio_products (
  product_key text primary key,
  title text not null,
  amount_ugx integer not null check (amount_ugx > 0),
  active boolean not null default true
);

insert into public.studio_products (product_key, title, amount_ugx)
values
  ('brand-story', 'Brand Story Builder', 100000),
  ('seo-audit', 'Website SEO & Visibility Audit', 75000),
  ('market-plan', 'Market Development Planner', 125000),
  ('content-seo', 'SEO Content Starter', 75000),
  ('data-story', 'Data Story Builder', 100000),
  ('speaker-ready', 'Speaker Ready Pack', 75000)
on conflict (product_key) do update
set title = excluded.title,
    amount_ugx = excluded.amount_ugx,
    active = true;

create table if not exists public.studio_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_key text not null references public.studio_products(product_key),
  amount_ugx integer not null check (amount_ugx > 0),
  currency text not null default 'UGX',
  tx_ref text not null unique,
  status text not null default 'pending' check (status in ('pending','paid','failed','cancelled')),
  flutterwave_transaction_id text,
  provider_payload jsonb,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create table if not exists public.studio_entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_key text not null references public.studio_products(product_key),
  order_id uuid not null unique references public.studio_orders(id) on delete restrict,
  remaining_uses integer not null default 1 check (remaining_uses >= 0),
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create table if not exists public.studio_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_key text not null references public.studio_products(product_key),
  run_type text not null check (run_type in ('trial','paid')),
  status text not null default 'reserved' check (status in ('reserved','completed','failed')),
  order_id uuid references public.studio_orders(id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists studio_runs_user_type_idx
  on public.studio_runs(user_id, run_type, created_at desc);

create index if not exists studio_entitlements_user_product_idx
  on public.studio_entitlements(user_id, product_key, created_at desc);

alter table public.studio_products enable row level security;
alter table public.studio_orders enable row level security;
alter table public.studio_entitlements enable row level security;
alter table public.studio_runs enable row level security;

revoke all on table public.studio_products from anon, authenticated;
revoke all on table public.studio_orders from anon, authenticated;
revoke all on table public.studio_entitlements from anon, authenticated;
revoke all on table public.studio_runs from anon, authenticated;

grant all on table public.studio_products to service_role;
grant all on table public.studio_orders to service_role;
grant all on table public.studio_entitlements to service_role;
grant all on table public.studio_runs to service_role;

create schema if not exists studio_private;

revoke all on schema studio_private from public;
grant usage on schema studio_private to service_role;

create or replace function studio_private.reserve_run(
  p_user_id uuid,
  p_product_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, studio_private
as $$
declare
  v_product public.studio_products;
  v_trial_count integer;
  v_entitlement public.studio_entitlements;
  v_run public.studio_runs;
begin
  if p_user_id is null then
    raise exception 'user_id is required';
  end if;

  select *
  into v_product
  from public.studio_products
  where product_key = p_product_key
    and active = true;

  if not found then
    raise exception 'Product is not available';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  select count(*)
  into v_trial_count
  from public.studio_runs
  where user_id = p_user_id
    and run_type = 'trial'
    and status in ('reserved','completed');

  if v_trial_count < 3 then
    insert into public.studio_runs (user_id, product_key, run_type, status)
    values (p_user_id, p_product_key, 'trial', 'reserved')
    returning * into v_run;

    return jsonb_build_object(
      'allowed', true,
      'run_id', v_run.id,
      'run_type', 'trial',
      'trial_count', v_trial_count + 1,
      'trials_remaining', greatest(0, 3 - (v_trial_count + 1)),
      'amount_ugx', v_product.amount_ugx
    );
  end if;

  select *
  into v_entitlement
  from public.studio_entitlements
  where user_id = p_user_id
    and product_key = p_product_key
    and remaining_uses > 0
  order by created_at asc
  limit 1
  for update;

  if found then
    update public.studio_entitlements
    set remaining_uses = remaining_uses - 1,
        last_used_at = now()
    where id = v_entitlement.id;

    insert into public.studio_runs (user_id, product_key, run_type, status, order_id)
    values (p_user_id, p_product_key, 'paid', 'reserved', v_entitlement.order_id)
    returning * into v_run;

    return jsonb_build_object(
      'allowed', true,
      'run_id', v_run.id,
      'run_type', 'paid',
      'trial_count', v_trial_count,
      'trials_remaining', 0,
      'amount_ugx', v_product.amount_ugx
    );
  end if;

  return jsonb_build_object(
    'allowed', false,
    'run_type', 'payment_required',
    'trial_count', v_trial_count,
    'trials_remaining', 0,
    'amount_ugx', v_product.amount_ugx,
    'product_key', v_product.product_key,
    'title', v_product.title
  );
end;
$$;

create or replace function studio_private.finish_run(
  p_user_id uuid,
  p_run_id uuid,
  p_status text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, studio_private
as $$
declare
  v_run_type text;
  v_order_id uuid;
begin
  if p_status not in ('completed','failed') then
    raise exception 'Invalid run status';
  end if;

  select run_type, order_id
  into v_run_type, v_order_id
  from public.studio_runs
  where id = p_run_id
    and user_id = p_user_id
    and status = 'reserved'
  for update;

  if not found then
    return false;
  end if;

  if p_status = 'failed' and v_run_type = 'paid' and v_order_id is not null then
    update public.studio_entitlements
    set remaining_uses = remaining_uses + 1
    where order_id = v_order_id;
  end if;

  update public.studio_runs
  set status = p_status,
      completed_at = now()
  where id = p_run_id;

  return true;
end;
$$;

create or replace function studio_private.studio_usage(p_user_id uuid)
returns jsonb
language sql
security definer
set search_path = pg_catalog, public, studio_private
as $$
  select jsonb_build_object(
    'trial_count',
      (select count(*) from public.studio_runs
       where user_id = p_user_id
         and run_type = 'trial'
         and status in ('reserved','completed')),
    'trials_remaining',
      greatest(
        0,
        3 - (select count(*) from public.studio_runs
             where user_id = p_user_id
               and run_type = 'trial'
               and status in ('reserved','completed'))
      ),
    'paid_credits',
      coalesce((select sum(remaining_uses) from public.studio_entitlements
                where user_id = p_user_id), 0)
  );
$$;

grant execute on function studio_private.reserve_run(uuid, text) to service_role;
grant execute on function studio_private.finish_run(uuid, uuid, text) to service_role;
grant execute on function studio_private.studio_usage(uuid) to service_role;
