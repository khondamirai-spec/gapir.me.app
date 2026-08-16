-- Undo one quarter of 0002: the `update own profile name` policy must keep calling
-- `auth.uid()` directly.
--
-- 0002 wrapped every `auth.uid()` in `(select auth.uid())` to satisfy the linter's
-- auth_rls_initplan warning. That is right for the three SELECT policies and wrong for this
-- one, which is the only policy whose WITH CHECK reads `public.profiles` from inside a policy
-- *on* `public.profiles`. With the bare call Postgres plans that self-reference without
-- applying the policy again; behind an InitPlan it re-enters and the whole statement dies with
--
--   42P17: infinite recursion detected in policy for relation "profiles"
--
-- — and not only for the attack this guard exists to stop. A user legitimately correcting
-- their own display name got the same 500, which is the worse half of the bug: the policy
-- stopped being a guard and became a wall.
--
-- Nothing is lost by reverting. The initplan warning is about `auth.uid()` being re-evaluated
-- per scanned row, which is a cost that grows with the number of rows a policy examines; this
-- one qualifies a single UPDATE matched by primary key, so "once per row" is once. The
-- warning is aimed at `read own usage`, where rows accumulate one per dictation forever, and
-- that policy keeps the fix.

drop policy "update own profile name" on public.profiles;

-- Verbatim from 0001_init.sql. Still deliberately narrow: a user may correct their display
-- name, nothing else. Without the column guard this is an "upgrade myself to pro" button.
create policy "update own profile name" on public.profiles
  for update using (auth.uid() = id)
  with check (
    auth.uid() = id
    and plan = (select p.plan from public.profiles p where p.id = auth.uid())
    and plan_expires_at is not distinct from
        (select p.plan_expires_at from public.profiles p where p.id = auth.uid())
  );
