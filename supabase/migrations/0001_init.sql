-- gapir me — identity, quota and billing.
--
-- The app used to ship its Gemini keys inside the installer (src/main/keys.ts), which meant
-- anyone who downloaded it held the key everyone dictated on. This schema is the other half
-- of moving that key to the server: the Edge Functions hold it, and these tables decide who
-- is allowed to spend it and how much.
--
-- Everything here is written on the assumption that **the client is hostile**. The app talks
-- to Postgres only through the `anon` key, which is public and protected by the RLS policies
-- at the bottom; every decision that costs money is made by a `security definer` function
-- called from an Edge Function with the service-role key. A user can read their own plan.
-- They cannot write it.

-- ---------------------------------------------------------------- plan limits

-- A table rather than constants in the Edge Function, so raising the free tier or changing
-- the price is one UPDATE rather than a redeploy of anything.
create table public.plan_limits (
  plan text primary key,
  -- Dictations per calendar day (UTC). Pro is capped too: an unlimited plan is one leaked
  -- account away from draining the Gemini key everyone else depends on.
  daily_limit int not null,
  -- A burst cap on top of the daily one. A human dictating cannot exceed this; a script can.
  per_minute_limit int not null,
  -- Longest single clip, in milliseconds. Edge Function request bodies are far smaller than
  -- Gemini's own 20 MB inline limit, so the proxy path is the tighter constraint.
  max_clip_ms int not null,
  -- Monthly price in tiyin (1 UZS = 100 tiyin). Zero means the plan is not sold.
  price_tiyin bigint not null default 0
);

insert into public.plan_limits (plan, daily_limit, per_minute_limit, max_clip_ms, price_tiyin) values
  ('free', 30,   6,  120000, 0),
  ('pro',  1000, 20, 120000, 5000000);   -- 50 000 UZS/month

-- ------------------------------------------------------------------ profiles

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  avatar_url text,
  plan text not null default 'free' references public.plan_limits(plan),
  -- Null on the free plan. On 'pro' this is what actually decides access — see
  -- effective_plan() below, which is why nothing may read `plan` on its own.
  plan_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A profile row must exist before the user's first dictation, and the only moment we are
-- guaranteed to hear about a new user is Supabase Auth inserting them. Doing this from the
-- app instead would leave a signed-in user with no row if the app closed at the wrong second.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data->>'full_name',
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- -------------------------------------------------------------- usage events

-- One row per dictation. Also the audit trail for "the user says they were charged a slot
-- and got nothing" — a row with chars = 0 that was never finalized is exactly that story.
create table public.usage_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  audio_ms int not null default 0,
  chars int not null default 0,
  model text not null default '',
  -- False until the transcript comes back. A reserved-but-never-finalized row is a failed
  -- dictation that has already been refunded by deleting it; if one survives, something
  -- crashed between the reserve and the finalize.
  finalized boolean not null default false
);

create index usage_events_user_time on public.usage_events (user_id, created_at desc);

-- -------------------------------------------------------------- effective plan

-- The plan a user is actually on *right now*.
--
-- Never read `profiles.plan` directly: an expired subscription still has 'pro' in that
-- column, and the row is only rewritten when someone next pays. Expiry is a question about
-- the clock, so it has to be asked at read time.
create or replace function public.effective_plan(p_user uuid)
returns text
language sql
stable
security definer set search_path = public
as $$
  select case
           when p.plan = 'pro' and (p.plan_expires_at is null or p.plan_expires_at > now())
             then 'pro'
           else 'free'
         end
  from public.profiles p
  where p.id = p_user;
$$;

-- ------------------------------------------------------------------ quota

-- Claim one dictation slot, atomically.
--
-- Returns jsonb rather than a record on purpose: plpgsql resolves OUT parameter names against
-- column names in the same scope, and a function returning (plan, used, ...) over tables that
-- also have those columns is a well-known way to get "column reference is ambiguous" at the
-- worst possible moment.
--
-- The row is inserted *before* Gemini is called, so two dictations racing cannot both squeeze
-- past the limit. The caller must either finalize it (transcript arrived) or refund it
-- (anything else) — see finalize_dictation / refund_dictation.
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
   where user_id = p_user and created_at >= date_trunc('day', now());

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

-- The transcript came back: write down what it actually cost.
create or replace function public.finalize_dictation(p_event bigint, p_audio_ms int, p_chars int)
returns void
language sql
security definer set search_path = public
as $$
  update public.usage_events
     set audio_ms = p_audio_ms, chars = p_chars, finalized = true
   where id = p_event;
$$;

-- The dictation failed. Give the slot back.
--
-- A user whose transcription errored must not lose a slot for it — they got nothing, and on
-- the free tier every slot is visible to them. This is why the reserve is a real row that can
-- be deleted rather than a counter that can only go up.
create or replace function public.refund_dictation(p_event bigint)
returns void
language sql
security definer set search_path = public
as $$
  delete from public.usage_events where id = p_event and finalized = false;
$$;

-- What the Hisob pane shows. One round trip for plan, usage and price.
--
-- **Takes no argument, deliberately.** Every other function here is called by an Edge Function
-- holding the service-role key, but this one is called by the app itself with the anon key.
-- A `p_user uuid` parameter on a security-definer function reachable by any signed-in user is
-- an invitation to pass somebody else's id and read their account — so the subject is
-- auth.uid(), which the caller cannot choose.
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
   where user_id = v_user and created_at >= date_trunc('day', now());

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

-- ------------------------------------------------------------------ payments
--
-- Payme (paycom.uz) works the opposite way round from most payment APIs: **we never call
-- Payme — Payme calls us.** The app sends the customer to a hosted checkout page, and while
-- they are on it, Payme's servers POST JSON-RPC to an endpoint of ours
-- (supabase/functions/payme/index.ts). Access is granted there, on PerformTransaction, and
-- never because the customer "came back" to the app.
--
-- Two tables, because the unit Payme transacts against is an **order**, not a user. An order
-- fixes the amount before anyone is sent to a payment page, which is what lets the callback
-- verify that the amount Payme reports is the amount we asked for (error -31001). Keying this
-- on the user instead would leave nothing to compare against, and the amount would have to be
-- taken on trust from whatever hit the checkout URL.

create table public.payme_orders (
  -- This number is `ac.order_id` in the checkout link and in every callback.
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  months int not null default 1,
  -- Tiyin (so'm x 100), computed server-side exactly once, when the order is created.
  amount_tiyin bigint not null,
  state text not null default 'pending'
    check (state in ('pending', 'paid', 'cancelled', 'refunded')),
  -- What fulfilment changed, so that a refund can put it back rather than guess. Without
  -- these, revoking a refunded month means subtracting a month from whatever the expiry
  -- happens to be now — which is wrong for anyone who bought again in between.
  prev_expires_at timestamptz,
  granted_expires_at timestamptz,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create index payme_orders_user on public.payme_orders (user_id, created_at desc);
-- Finding the reusable pending order on a repeat tap of "upgrade".
create index payme_orders_pending on public.payme_orders (user_id) where (state = 'pending');

-- Column names follow Payme's own vocabulary rather than ours, because every one of them is
-- echoed straight back in a JSON-RPC reply and a rename here becomes a bug there. Times are
-- Payme's epoch-**milliseconds** integers for the same reason.
create table public.payme_transactions (
  id bigint generated always as identity primary key,  -- returned as result.transaction
  -- Payme's own id. Unique because Payme *retries* CreateTransaction, and a duplicate row
  -- here is a customer charged twice — the constraint is the idempotency, not a nicety.
  paycom_id text not null unique,
  paycom_time bigint not null,                          -- params.time; GetStatement filters on it
  order_id bigint not null references public.payme_orders(id),
  amount_tiyin bigint not null,
  -- 1 created · 2 performed (paid) · -1 cancelled before payment · -2 refunded after payment.
  state int not null default 1,
  create_time bigint not null,
  perform_time bigint not null default 0,
  cancel_time bigint not null default 0,
  reason int                                            -- Payme cancel reason (4 = timeout)
);

create index payme_transactions_time on public.payme_transactions (paycom_time);

-- The one-time-account rule, enforced by the database rather than by a read-then-write in the
-- Edge Function: at most one *active* transaction per order. Two CreateTransaction calls
-- racing each other cannot both win, and the loser gets a clean -31008.
create unique index uq_payme_tx_active_order
  on public.payme_transactions (order_id) where (state = 1);

-- Money moved: mark the order paid and extend the subscription.
--
-- `greatest(now(), plan_expires_at)` rather than `now()` so that paying early stacks onto the
-- time already bought instead of throwing it away.
--
-- Returns the granted expiry so the caller can log it; the values are also stored on the order
-- so a later refund knows exactly what to undo.
create or replace function public.fulfil_payme_order(p_order bigint)
returns timestamptz
language plpgsql
security definer set search_path = public
as $$
declare
  v_user uuid;
  v_months int;
  v_prev timestamptz;
  v_new timestamptz;
begin
  select user_id, months into v_user, v_months
    from public.payme_orders where id = p_order;
  if v_user is null then return null; end if;

  select plan_expires_at into v_prev from public.profiles where id = v_user;
  v_new := greatest(now(), coalesce(v_prev, now())) + (v_months || ' months')::interval;

  update public.profiles
     set plan = 'pro', plan_expires_at = v_new, updated_at = now()
   where id = v_user;

  update public.payme_orders
     set state = 'paid', paid_at = now(),
         prev_expires_at = v_prev, granted_expires_at = v_new
   where id = p_order;

  return v_new;
end;
$$;

-- A refund takes the time back, so a reversed payment cannot leave someone on Pro for free.
--
-- Only when the expiry is still the one we granted. If the user bought again afterwards, the
-- current expiry belongs to that later purchase and subtracting from it would silently steal
-- time they paid for — better to leave it and let a human sort out the overlap.
create or replace function public.refund_payme_order(p_order bigint)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_user uuid;
  v_prev timestamptz;
  v_granted timestamptz;
  v_current timestamptz;
begin
  select user_id, prev_expires_at, granted_expires_at
    into v_user, v_prev, v_granted
    from public.payme_orders where id = p_order;
  if v_user is null then return; end if;

  update public.payme_orders set state = 'refunded' where id = p_order;

  select plan_expires_at into v_current from public.profiles where id = v_user;

  if v_granted is not null and v_current is not distinct from v_granted then
    update public.profiles
       set plan_expires_at = v_prev,
           plan = case when v_prev is null or v_prev <= now() then 'free' else 'pro' end,
           updated_at = now()
     where id = v_user;
  else
    raise warning 'refund of order % left the expiry alone: it no longer matches what was granted', p_order;
  end if;
end;
$$;

-- ----------------------------------------------------------------------- RLS
--
-- The app holds only the anon key, so these policies are the whole of what a compromised or
-- modified client can reach. Read your own row; write nothing. Every mutation that matters
-- goes through the security-definer functions above, called by an Edge Function holding the
-- service-role key — which bypasses RLS entirely, and is why the quota cannot be faked.

alter table public.profiles enable row level security;
alter table public.usage_events enable row level security;
alter table public.payme_orders enable row level security;
alter table public.payme_transactions enable row level security;
alter table public.plan_limits enable row level security;

create policy "read own profile" on public.profiles
  for select using (auth.uid() = id);

-- Deliberately narrow: a user may correct their display name, nothing else. Without the
-- column guard this is an "upgrade myself to pro" button.
create policy "update own profile name" on public.profiles
  for update using (auth.uid() = id)
  with check (
    auth.uid() = id
    and plan = (select p.plan from public.profiles p where p.id = auth.uid())
    and plan_expires_at is not distinct from
        (select p.plan_expires_at from public.profiles p where p.id = auth.uid())
  );

create policy "read own usage" on public.usage_events
  for select using (auth.uid() = user_id);

create policy "read own orders" on public.payme_orders
  for select using (auth.uid() = user_id);

-- No policy on payme_transactions at all, which means no signed-in user can read a row of it.
-- Deliberate: it holds Payme's transaction ids and is written only by the callback endpoint
-- running as service_role. Nothing in the app needs it, and "the user can see their own
-- payment history" is served by payme_orders above.

-- Limits are not secret — the app shows them — and letting the client read them keeps the
-- pricing in the Hisob pane honest without a second source of truth.
create policy "anyone may read limits" on public.plan_limits
  for select using (true);

-- -------------------------------------------------------------------- grants
--
-- **Postgres grants EXECUTE on new functions to PUBLIC by default**, and every function above
-- is `security definer` — which means that without the revokes below, any signed-in user
-- could call apply_payment() and give themselves a year of Pro, or refund_dictation() in a
-- loop to dictate for free. The RLS policies would not stop them: a security-definer function
-- runs as its owner and bypasses them by design.
--
-- So: nothing is callable by the app except account_snapshot(), which reads auth.uid() and
-- cannot be pointed at anyone else. Everything else is reachable only with the service-role
-- key, from an Edge Function.

revoke execute on function public.effective_plan(uuid) from public, anon, authenticated;
revoke execute on function public.reserve_dictation(uuid, text) from public, anon, authenticated;
revoke execute on function public.finalize_dictation(bigint, int, int) from public, anon, authenticated;
revoke execute on function public.refund_dictation(bigint) from public, anon, authenticated;
revoke execute on function public.fulfil_payme_order(bigint) from public, anon, authenticated;
revoke execute on function public.refund_payme_order(bigint) from public, anon, authenticated;
revoke execute on function public.account_snapshot() from public, anon;

grant execute on function public.account_snapshot() to authenticated;
