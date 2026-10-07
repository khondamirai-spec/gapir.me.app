-- A third plan: Cheksiz — 199 000 so'm a month, and no weekly word cap.
--
-- Recovered verbatim from the live project's migration history on 2026-10-07: this was
-- applied on 2026-08-30 (as version 20260830184259, named "20260830120000_unlimited_plan")
-- but the file never reached this repository. The version in the filename is the one the
-- database recorded, so `supabase db push` sees it as already applied and does not re-run it.
--
-- What it changes:
--   * plan_limits.weekly_word_limit may be NULL, meaning "no weekly cap". The per-minute burst
--     cap and max_clip_ms still apply — an unlimited plan is still one leaked account away
--     from draining the Gemini keys everyone else depends on.
--   * payme_orders records which plan an order buys (`plan`, defaulting to 'pro' for orders
--     made by builds that knew of no other) and what the user was on before (`prev_plan`), so a
--     refund can put back the plan as well as the expiry.
--   * effective_plan() returns whichever paid plan is in force instead of assuming 'pro'.
--   * reserve_dictation() skips the weekly check when the limit is NULL.
--   * account_snapshot() adds `prices`, a { plan: tiyin } map of everything on sale.
--     `price_tiyin` (Pro's price alone) stays for builds that predate the map.

alter table public.plan_limits alter column weekly_word_limit drop not null;

comment on column public.plan_limits.weekly_word_limit is
  'Transcribed words allowed per calendar week (Monday 00:00 Asia/Tashkent). NULL means no '
  'weekly cap; per_minute_limit and max_clip_ms still apply.';

insert into public.plan_limits (plan, per_minute_limit, max_clip_ms, price_tiyin, weekly_word_limit)
values ('unlimited', 20, 120000, 19900000, null)   -- 199 000 UZS/month
on conflict (plan) do update
  set price_tiyin = excluded.price_tiyin,
      weekly_word_limit = excluded.weekly_word_limit;

alter table public.payme_orders
  add column if not exists plan text not null default 'pro' references public.plan_limits(plan),
  add column if not exists prev_plan text;

create or replace function public.effective_plan(p_user uuid)
returns text
language sql
stable
security definer set search_path = public
as $$
  select case
           when p.plan <> 'free' and (p.plan_expires_at is null or p.plan_expires_at > now())
             then p.plan
           else 'free'
         end
  from public.profiles p
  where p.id = p_user;
$$;

create or replace function public.reserve_dictation(p_user uuid, p_model text default '')
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_plan text;
  v_word_limit int;
  v_burst int;
  v_max_clip int;
  v_used int;
  v_recent int;
  v_event bigint;
  v_week_start timestamptz;
begin
  v_plan := public.effective_plan(p_user);
  if v_plan is null then
    return jsonb_build_object('allowed', false, 'reason', 'no_profile');
  end if;

  select weekly_word_limit, per_minute_limit, max_clip_ms
    into v_word_limit, v_burst, v_max_clip
    from public.plan_limits where plan = v_plan;

  v_week_start := date_trunc('week', now() at time zone 'Asia/Tashkent') at time zone 'Asia/Tashkent';

  select coalesce(sum(words), 0) into v_used
    from public.usage_events
   where user_id = p_user
     and created_at >= v_week_start;

  select count(*) into v_recent
    from public.usage_events
   where user_id = p_user and created_at >= now() - interval '1 minute';

  if v_recent >= v_burst then
    return jsonb_build_object(
      'allowed', false, 'reason', 'burst',
      'plan', v_plan, 'used', v_used, 'limit', v_word_limit,
      'resets_at', v_week_start + interval '1 week'
    );
  end if;

  if v_word_limit is not null and v_used >= v_word_limit then
    return jsonb_build_object(
      'allowed', false, 'reason', 'weekly',
      'plan', v_plan, 'used', v_used, 'limit', v_word_limit,
      'resets_at', v_week_start + interval '1 week'
    );
  end if;

  insert into public.usage_events (user_id, model)
  values (p_user, p_model)
  returning id into v_event;

  return jsonb_build_object(
    'allowed', true,
    'plan', v_plan,
    'used', v_used,
    'limit', v_word_limit,
    'resets_at', v_week_start + interval '1 week',
    'max_clip_ms', v_max_clip,
    'event_id', v_event
  );
end;
$$;

create or replace function public.account_snapshot()
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_plan text;
  v_word_limit int;
  v_used int;
  v_expires timestamptz;
  v_week_start timestamptz;
  v_prices jsonb;
begin
  v_week_start := date_trunc('week', now() at time zone 'Asia/Tashkent') at time zone 'Asia/Tashkent';

  select coalesce(jsonb_object_agg(plan, price_tiyin), '{}'::jsonb) into v_prices
    from public.plan_limits where price_tiyin > 0;

  if v_user is null then
    return jsonb_build_object(
      'plan', 'free', 'used', 0, 'limit', 0, 'price_tiyin', 0, 'prices', v_prices,
      'resets_at', v_week_start + interval '1 week'
    );
  end if;

  v_plan := public.effective_plan(v_user);
  if v_plan is null then
    return jsonb_build_object(
      'plan', 'free', 'used', 0, 'limit', 0, 'price_tiyin', 0, 'prices', v_prices,
      'resets_at', v_week_start + interval '1 week'
    );
  end if;

  select weekly_word_limit into v_word_limit
    from public.plan_limits where plan = v_plan;

  select coalesce(sum(words), 0) into v_used
    from public.usage_events
   where user_id = v_user
     and created_at >= v_week_start;

  select plan_expires_at into v_expires from public.profiles where id = v_user;

  return jsonb_build_object(
    'plan', v_plan,
    'used', v_used,
    'limit', v_word_limit,
    'expires_at', v_expires,
    'resets_at', v_week_start + interval '1 week',
    'price_tiyin', (select price_tiyin from public.plan_limits where plan = 'pro'),
    'prices', v_prices
  );
end;
$$;

create or replace function public.fulfil_payme_order(p_order bigint)
returns timestamptz
language plpgsql
security definer set search_path = public
as $$
declare
  v_user uuid;
  v_months int;
  v_plan text;
  v_prev timestamptz;
  v_prev_plan text;
  v_new timestamptz;
begin
  select user_id, months, plan into v_user, v_months, v_plan
    from public.payme_orders where id = p_order;
  if v_user is null then return null; end if;

  select plan_expires_at, plan into v_prev, v_prev_plan
    from public.profiles where id = v_user;
  v_new := greatest(now(), coalesce(v_prev, now())) + (v_months || ' months')::interval;

  update public.profiles
     set plan = v_plan, plan_expires_at = v_new, updated_at = now()
   where id = v_user;

  update public.payme_orders
     set state = 'paid', paid_at = now(),
         prev_expires_at = v_prev, granted_expires_at = v_new, prev_plan = v_prev_plan
   where id = p_order;

  return v_new;
end;
$$;

create or replace function public.refund_payme_order(p_order bigint)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_user uuid;
  v_prev timestamptz;
  v_prev_plan text;
  v_granted timestamptz;
  v_current timestamptz;
begin
  select user_id, prev_expires_at, granted_expires_at, prev_plan
    into v_user, v_prev, v_granted, v_prev_plan
    from public.payme_orders where id = p_order;
  if v_user is null then return; end if;

  update public.payme_orders set state = 'refunded' where id = p_order;

  select plan_expires_at into v_current from public.profiles where id = v_user;

  if v_granted is not null and v_current is not distinct from v_granted then
    update public.profiles
       set plan_expires_at = v_prev,
           plan = case
                    when v_prev is null or v_prev <= now() then 'free'
                    else coalesce(v_prev_plan, 'pro')
                  end,
           updated_at = now()
     where id = v_user;
  else
    raise warning 'refund of order % left the expiry alone: it no longer matches what was granted', p_order;
  end if;
end;
$$;

revoke execute on function public.reserve_dictation(uuid, text) from public, anon, authenticated;
revoke execute on function public.fulfil_payme_order(bigint) from public, anon, authenticated;
revoke execute on function public.refund_payme_order(bigint) from public, anon, authenticated;
revoke execute on function public.account_snapshot() from public, anon;
grant execute on function public.account_snapshot() to authenticated;
