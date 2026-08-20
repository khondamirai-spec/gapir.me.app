-- The quota is words per week now, not dictations per day.
--
-- ## Why words
--
-- A dictation was never a unit of anything. "Ha" and a two-minute paragraph both spent one
-- slot, so the plan measured how often someone pressed a key rather than how much they got
-- out of it — and the two are not related. It also priced the tool backwards: the careful
-- user who dictates one long paragraph paid the same as the one who fires off thirty
-- fragments, while the second costs us thirty round trips and thirty prompts.
--
-- Words are what the user actually receives, they are the number the Statistika pane has
-- always shown, and "1000 so'z" is a quantity a person can picture. "30 diktovka" is not.
--
-- ## Why a week
--
-- A daily cap has to be set for the worst day someone will have, so it is either too small
-- to trust or too large to mean anything. Writing happens in bursts — nothing on Tuesday,
-- four thousand words on Thursday — and a week is the smallest window that survives one.
-- It is also the window a user can plan around, which a day is not.
--
-- ## Why the check is "are you already over", not "would this put you over"
--
-- The cost of a dictation is not knowable until after the model answers: you cannot price a
-- sentence before it has been spoken. So the rule is the only honest one available — if you
-- have words left, you get the whole of this dictation, and the overshoot is bounded by
-- plan_limits.max_clip_ms (two minutes, ~300 words at a fast speaking rate). Refusing to
-- start because the *next* clip might not fit would mean refusing a five-word correction to
-- somebody with 900 words spent, which is absurd; truncating the transcript to fit would be
-- worse still, because the user said those words out loud and would never get them back.
--
-- ## The week boundary
--
--   date_trunc('week', now() at time zone 'Asia/Tashkent') at time zone 'Asia/Tashkent'
--
-- Same shape, and same reason, as the day boundary in
-- 20260816084215_tashkent_day_boundary.sql: the inner conversion makes date_trunc find the
-- *local* midnight, and the outer one turns that back into a timestamptz so the
-- comparison against created_at is between like types. date_trunc('week') is ISO — weeks
-- start on Monday, which is the week Uzbekistan keeps. Uzbekistan has no DST, so the
-- boundary is stable year round.

-- ------------------------------------------------------------------ limits

alter table public.plan_limits
  add column if not exists weekly_word_limit int not null default 0;

comment on column public.plan_limits.weekly_word_limit is
  'Transcribed words allowed per calendar week (Monday 00:00 Asia/Tashkent). Pro is capped '
  'too: an unlimited plan is one leaked account away from draining the Gemini keys everyone '
  'else depends on.';

update public.plan_limits set weekly_word_limit = 1000 where plan = 'free';
update public.plan_limits set weekly_word_limit = 6000 where plan = 'pro';

-- Nothing counts dictations any more. Dropped rather than left in place, so that a reader of
-- plan_limits cannot mistake a stale number for a rule that is still enforced — the two
-- functions below are replaced in this same migration and are its only consumers.
alter table public.plan_limits drop column if exists daily_limit;

-- ------------------------------------------------------------- usage events

-- What the dictation actually cost, in the unit the plan is now denominated in.
--
-- `chars` stays: it is the audit trail for "I was charged and got nothing", and it is the
-- most we have any business keeping about what somebody said out loud. `words` is the same
-- text measured the way the plan measures it, written by the same rule the app's Statistika
-- pane uses — see supabase/functions/_shared/text.ts and src/shared/text.ts, which are held
-- byte-identical by src/main/word-count-drift.test.ts.
alter table public.usage_events
  add column if not exists words int not null default 0;

-- Summing a week of one user's rows is now the hot read on this table. The existing
-- (user_id, created_at desc) index already serves it; this one lets the sum come out of the
-- index alone rather than visiting every row.
create index if not exists usage_events_user_week
  on public.usage_events (user_id, created_at) include (words);

-- ------------------------------------------------------------------ quota

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
    -- No profile row. The auth trigger should have made one, so this is a user who existed
    -- before that trigger, or a deleted profile.
    return jsonb_build_object('allowed', false, 'reason', 'no_profile');
  end if;

  select weekly_word_limit, per_minute_limit, max_clip_ms
    into v_word_limit, v_burst, v_max_clip
    from public.plan_limits where plan = v_plan;

  v_week_start := date_trunc('week', now() at time zone 'Asia/Tashkent') at time zone 'Asia/Tashkent';

  -- coalesce because sum() over no rows is null, and null >= anything is null — which would
  -- fall through the check below and let a brand-new user past on a technicality rather than
  -- on purpose. It works out the same here, but only by accident, and accidents in a quota
  -- check are how a paywall becomes advisory.
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

  if v_used >= v_word_limit then
    return jsonb_build_object(
      'allowed', false, 'reason', 'weekly',
      'plan', v_plan, 'used', v_used, 'limit', v_word_limit,
      'resets_at', v_week_start + interval '1 week'
    );
  end if;

  -- The row goes in before Gemini is called, so two dictations racing cannot both slip past
  -- the limit. It carries no words yet — nobody knows how many there will be — which is
  -- exactly why the caller must either finalize it or refund it.
  insert into public.usage_events (user_id, model)
  values (p_user, p_model)
  returning id into v_event;

  return jsonb_build_object(
    'allowed', true,
    'plan', v_plan,
    -- Words spent *before* this dictation. The old daily counter returned the
    -- post-reservation count because reserving was itself the spend; here the spend is not
    -- known until finalize_dictation, and reporting a number the user has not spent yet
    -- would make the Hisob pane jump forward and then back on every silent clip.
    'used', v_used,
    'limit', v_word_limit,
    'resets_at', v_week_start + interval '1 week',
    'max_clip_ms', v_max_clip,
    'event_id', v_event
  );
end;
$$;

-- The transcript came back: write down what it actually cost.
--
-- The 3-argument version is dropped rather than overloaded. `create or replace` with an added
-- `p_words int default 0` would leave *both* signatures in place and make every existing
-- 3-argument call ambiguous — an error, at the worst possible moment, in the one code path
-- that settles up after money has been spent. Dropping first and giving the new parameter a
-- default keeps the currently deployed Edge Function working until it is redeployed.
drop function if exists public.finalize_dictation(bigint, int, int);

create or replace function public.finalize_dictation(
  p_event bigint,
  p_audio_ms int,
  p_chars int,
  p_words int default 0
)
returns void
language sql
security definer set search_path = public
as $$
  update public.usage_events
     set audio_ms = p_audio_ms, chars = p_chars, words = greatest(0, p_words), finalized = true
   where id = p_event;
$$;

-- What the Hisob pane shows. One round trip for plan, usage, price and when it all resets.
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
begin
  v_week_start := date_trunc('week', now() at time zone 'Asia/Tashkent') at time zone 'Asia/Tashkent';

  if v_user is null then
    return jsonb_build_object(
      'plan', 'free', 'used', 0, 'limit', 0, 'price_tiyin', 0,
      'resets_at', v_week_start + interval '1 week'
    );
  end if;

  v_plan := public.effective_plan(v_user);
  if v_plan is null then
    return jsonb_build_object(
      'plan', 'free', 'used', 0, 'limit', 0, 'price_tiyin', 0,
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
    'price_tiyin', (select price_tiyin from public.plan_limits where plan = 'pro')
  );
end;
$$;

-- Postgres grants EXECUTE to PUBLIC by default, and `create or replace` on an existing
-- function keeps its grants — but `drop` + `create` on finalize_dictation above did not, and
-- that one moves money's worth of quota. Restate the whole rule rather than patching the one
-- function, so this file alone says what is reachable: nothing but account_snapshot().
revoke execute on function public.reserve_dictation(uuid, text) from public, anon, authenticated;
revoke execute on function public.finalize_dictation(bigint, int, int, int) from public, anon, authenticated;
revoke execute on function public.account_snapshot() from public, anon;
grant execute on function public.account_snapshot() to authenticated;
