-- The daily quota now resets at midnight in Tashkent, not midnight UTC.
--
-- 0001 counted "today's" dictations with `created_at >= date_trunc('day', now())`, which is
-- a UTC day. Every user-facing string — the Help pane, the 402 message — says the limit
-- "har kuni yarim tunda yangilanadi" (resets at midnight), and for the audience this app is
-- built for, midnight means midnight in Tashkent. UTC+5 put the actual reset at 05:00 local:
-- a support thread titled "limit didn't reset at midnight" waiting to happen.
--
-- The expression is written the long way round on purpose:
--
--   date_trunc('day', now() at time zone 'Asia/Tashkent') at time zone 'Asia/Tashkent'
--
-- The inner `at time zone` converts now() to a local wall-clock timestamp so date_trunc
-- finds the *local* midnight; the outer one converts that midnight back to timestamptz so
-- the comparison against `created_at` is between like types. Dropping the outer conversion
-- would compare timestamptz to timestamp and silently reinterpret local midnight as UTC —
-- off by exactly the five hours this migration exists to remove.
--
-- Both functions that count the day change together, or the pill and the Hisob pane would
-- disagree about how many dictations are left. Everything else is restated verbatim from
-- 0001 (CREATE OR REPLACE needs the whole body). Uzbekistan has no DST, so the boundary is
-- stable year round.

create or replace function public.reserve_dictation(p_user uuid, p_model text default '')
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_plan text;
  v_daily int;
  v_burst int;
  v_max_clip int;
  v_used int;
  v_recent int;
  v_event bigint;
begin
  v_plan := public.effective_plan(p_user);
  if v_plan is null then
    -- No profile row. The auth trigger should have made one, so this is a user who existed
    -- before this migration ran, or a deleted profile.
    return jsonb_build_object('allowed', false, 'reason', 'no_profile');
  end if;

  select daily_limit, per_minute_limit, max_clip_ms
    into v_daily, v_burst, v_max_clip
    from public.plan_limits where plan = v_plan;

  select count(*) into v_used
    from public.usage_events
   where user_id = p_user
     and created_at >= date_trunc('day', now() at time zone 'Asia/Tashkent') at time zone 'Asia/Tashkent';

  select count(*) into v_recent
    from public.usage_events
   where user_id = p_user and created_at >= now() - interval '1 minute';

  if v_recent >= v_burst then
    return jsonb_build_object(
      'allowed', false, 'reason', 'burst',
      'plan', v_plan, 'used', v_used, 'limit', v_daily
    );
  end if;

  if v_used >= v_daily then
    return jsonb_build_object(
      'allowed', false, 'reason', 'daily',
      'plan', v_plan, 'used', v_used, 'limit', v_daily
    );
  end if;

  insert into public.usage_events (user_id, model)
  values (p_user, p_model)
  returning id into v_event;

  return jsonb_build_object(
    'allowed', true,
    'plan', v_plan,
    'used', v_used + 1,
    'limit', v_daily,
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
  v_daily int;
  v_price bigint;
  v_used int;
  v_expires timestamptz;
begin
  if v_user is null then
    return jsonb_build_object('plan', 'free', 'used', 0, 'limit', 0, 'price_tiyin', 0);
  end if;

  v_plan := public.effective_plan(v_user);
  if v_plan is null then
    return jsonb_build_object('plan', 'free', 'used', 0, 'limit', 0, 'price_tiyin', 0);
  end if;

  select daily_limit, price_tiyin into v_daily, v_price
    from public.plan_limits where plan = v_plan;

  select count(*) into v_used
    from public.usage_events
   where user_id = v_user
     and created_at >= date_trunc('day', now() at time zone 'Asia/Tashkent') at time zone 'Asia/Tashkent';

  select plan_expires_at into v_expires from public.profiles where id = v_user;

  return jsonb_build_object(
    'plan', v_plan,
    'used', v_used,
    'limit', v_daily,
    'expires_at', v_expires,
    'price_tiyin', (select price_tiyin from public.plan_limits where plan = 'pro')
  );
end;
$$;

-- CREATE OR REPLACE preserves existing grants and revokes, but restate the intent from 0001
-- anyway — a future reader of this file alone should see the same rule: nothing is callable
-- by the app except account_snapshot().
revoke execute on function public.reserve_dictation(uuid, text) from public, anon, authenticated;
revoke execute on function public.account_snapshot() from public, anon;
grant execute on function public.account_snapshot() to authenticated;
