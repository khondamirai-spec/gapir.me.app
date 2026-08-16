-- Two things the database linter is right about, neither of which changes what anyone is
-- allowed to do. Both were introduced by 0001_init.sql; this file is the correction, kept
-- separate so the original reads as it was written.

-- ------------------------------------------------- auth.uid() per row -> once
--
-- `auth.uid()` inside a policy is re-evaluated **for every row scanned**, because Postgres
-- treats it as a volatile-ish function reference rather than a constant. Wrapping it as
-- `(select auth.uid())` turns it into an InitPlan: evaluated once, then compared against each
-- row like any other parameter.
--
-- The semantics are identical — the subquery has no correlation to the outer row — so this is
-- purely how the planner is allowed to treat it. It matters here because `usage_events` grows
-- by one row per dictation forever, and "read your own usage" is the Statistika pane's query:
-- the cost of getting this wrong scales with how much someone has used the app, which is
-- exactly the wrong way round.
--
-- Policies cannot be altered in place without restating their expressions, so each is dropped
-- and recreated with the same rule.

drop policy "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select using ((select auth.uid()) = id);

-- Still deliberately narrow: a user may correct their display name and nothing else. The two
-- subqueries re-read the caller's own row so that `plan` and `plan_expires_at` must come back
-- unchanged — without that column guard this is an "upgrade myself to pro" button.
drop policy "update own profile name" on public.profiles;
create policy "update own profile name" on public.profiles
  for update using ((select auth.uid()) = id)
  with check (
    (select auth.uid()) = id
    and plan = (select p.plan from public.profiles p where p.id = (select auth.uid()))
    and plan_expires_at is not distinct from
        (select p.plan_expires_at from public.profiles p where p.id = (select auth.uid()))
  );

drop policy "read own usage" on public.usage_events;
create policy "read own usage" on public.usage_events
  for select using ((select auth.uid()) = user_id);

drop policy "read own orders" on public.payme_orders;
create policy "read own orders" on public.payme_orders
  for select using ((select auth.uid()) = user_id);

-- --------------------------------------------------------- the last stray grant
--
-- 0001_init.sql revoked EXECUTE on every security-definer function it created except this one,
-- which was missed because it is a trigger function and reads as plumbing rather than as API.
-- PostgREST exposes it at /rest/v1/rpc/handle_new_user all the same, and it runs as its owner.
--
-- Calling it directly errors ("trigger functions can only be called as triggers"), so this is
-- tidying rather than a breach — but the rule in 0001 was "nothing is callable by the app
-- except account_snapshot()", and an exception nobody decided on is worth closing.
--
-- Safe for the trigger itself: Postgres checks EXECUTE on a trigger function when the trigger
-- is *created*, not each time it fires. `on_auth_user_created` keeps working, which the
-- accompanying verification run confirms rather than assumes.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
