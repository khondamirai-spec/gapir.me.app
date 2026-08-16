-- The actual cause of the 42P17 that 0003 tried and failed to fix.
--
-- 0002 rewrote every `auth.uid()` as `(select auth.uid())`. 0003 then reverted the
-- `update own profile name` policy, on the theory that its WITH CHECK subquery over
-- `public.profiles` was what re-entered. It was not enough, and the reason is worth writing
-- down because it is invisible from either policy read on its own:
--
--   * `update own profile name` has a WITH CHECK that SELECTs from `public.profiles`.
--   * That inner SELECT is itself subject to the `read own profile` SELECT policy.
--   * So the two policies compose, and the recursion belongs to the *pair*, not to either one.
--
-- With both written as bare `auth.uid()` — which is how 0001_init.sql shipped — Postgres plans
-- the self-reference without re-entering, and the guard returns a clean refusal. Once
-- `read own profile` became an InitPlan, the composed plan re-entered and every UPDATE on
-- profiles died with 42P17, including the legitimate rename the policy exists to permit.
--
-- 0003 was therefore correct but incomplete; this restores the other half. `profiles` holds
-- one row per user and is always reached by primary key, so the initplan warning was never
-- worth much here. The two policies that keep the optimisation are `read own usage` and
-- `read own orders`, which scan tables that grow without bound and which no policy reads back
-- into.

drop policy "read own profile" on public.profiles;

-- Verbatim from 0001_init.sql.
create policy "read own profile" on public.profiles
  for select using (auth.uid() = id);
