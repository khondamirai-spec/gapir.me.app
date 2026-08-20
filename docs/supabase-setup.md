# Backend setup — Supabase, Google sign-in, Payme

Everything in this file is done **once**, in dashboards, with your own accounts. The code is
already written; this is the part only you can do.

Work through it in order. Each phase leaves the app in a working state, so you can stop at the
end of any of them.

> **Where the app stands now (August 2026):** Phases 1–5 are done — `src/main/supabase-config.ts`
> carries the real project URL and anon key, the migrations are applied, all three Edge
> Functions are deployed, so `isConfigured()` is true and every build routes dictation through
> the server — and the old bundled key pool is deleted (Phase 5), so no Gemini key exists
> anywhere in the installer.

---

## Phase 1 — The Supabase project

### 1.1 Create it

1. [supabase.com/dashboard](https://supabase.com/dashboard) → **New project**.
2. **Region: `eu-central-1` (Frankfurt).** Pick carefully — the region cannot be changed
   later, and every dictation makes a round trip to it. Frankfurt is the closest option to
   Uzbekistan that Supabase offers; a US region adds roughly 150 ms to every single dictation.
3. Save the database password somewhere safe.

### 1.2 Collect the three values

**Settings → API**:

| Value | Where it goes | Secret? |
| --- | --- | --- |
| Project URL | `src/main/supabase-config.ts` | No — commit it |
| `anon` public key | `src/main/supabase-config.ts` | No — commit it |
| `service_role` key | Nowhere. Supabase already has it | **Yes.** Never in this repo |

The first two are public by design: the `anon` key identifies the project, and what it can
reach is decided entirely by the row-level-security policies in
`supabase/migrations/0001_init.sql`. This is genuinely different from the old
`resources/gemini-keys.json`, and committing it is correct.

### 1.3 Apply the schema

```bash
npm i -g supabase                 # or: scoop install supabase
supabase login
supabase link --project-ref <your-project-ref>
supabase db push
```

Check it landed: **Table editor** should show `profiles`, `usage_events`, `plan_limits`,
`payme_orders` and `payme_transactions`.

### 1.4 Fill in the app's constants

Edit [src/main/supabase-config.ts](../src/main/supabase-config.ts):

```ts
const DEFAULT_URL = 'https://xxxxxxxxxxxx.supabase.co';
const DEFAULT_ANON_KEY = 'eyJhbGci...';
```

---

## Phase 2 — Google sign-in

### 2.1 Google Cloud Console

1. [console.cloud.google.com](https://console.cloud.google.com) → new project (or an existing one).
2. **APIs & Services → OAuth consent screen**: External, fill in the app name, your support
   email, and a logo if you like. Add the `email` and `profile` scopes — nothing more; the app
   needs no access to anything in the user's Google account.
3. **Credentials → Create credentials → OAuth client ID → Web application.**
4. Under **Authorized redirect URIs** add exactly:
   ```
   https://<your-project-ref>.supabase.co/auth/v1/callback
   ```
   Note this is Supabase's URL, **not** `gapirme://`. Google never sees the custom scheme — it
   redirects to Supabase, and Supabase forwards to the app.
5. Copy the **Client ID** and **Client secret**.

### 2.2 Supabase

1. **Authentication → Providers → Google**: enable, paste the client id and secret, save.
2. **Authentication → URL Configuration → Redirect URLs**: add all three
   ```
   gapirme://auth-callback
   https://www.gapir.me/auth/callback
   https://gapir.me/auth/callback
   ```
   Without these Supabase refuses the forward and the user is left staring at a browser tab
   that goes nowhere. It is the single most common reason sign-in "does nothing".

   The https pages are where the browser now lands: the app asks for
   `https://www.gapir.me/auth/callback` (see `AUTH_REDIRECT` in
   [src/main/supabase-config.ts](../src/main/supabase-config.ts)), that page says "you are
   signed in, you can close this window" and hands the code to the app through the
   `gapirme://` scheme. The scheme stays listed because it is also the project's `site_url`,
   and because builds released before this change still ask for it directly.

   If the https address is missing from the list, Supabase falls back to `site_url` and
   sign-in still completes — without the page. That makes a missing entry easy to overlook:
   the flow works, it is just uglier than it should be.

### 2.3 While the app is unpublished

Google shows an "unverified app" warning until the consent screen is verified. Add yourself
under **Test users** to skip it while developing. Verification takes days to weeks and is
worth starting before you plan to launch.

---

## Phase 3 — The Gemini key

This is the whole point of the exercise: the key stops shipping to users and lives here.

```bash
supabase secrets set GEMINI_API_KEYS="key1,key2,key3"
supabase functions deploy transcribe
```

Several free-tier keys rather than one, for the same reason the app used to ship several: the
free tier caps requests per key per day, and `supabase/functions/transcribe/index.ts` rotates
to the next key when one comes back spent. `GEMINI_API_KEY` (singular) is also accepted.

Optionally pin the model — it otherwise matches `DEFAULT_GEMINI_MODEL`:

```bash
supabase secrets set GEMINI_MODEL="gemini-3.1-flash-lite"
```

### Check it works

```bash
npm run dev
```

Sign in from the **Hisob** pane, then hold Ctrl+Shift and speak. The log line should read
`route=proxy`:

```
[state] route=proxy gemini/gemini-3.1-flash-lite key=none audio=2.4s rtt=1180ms chars=31 :: "..."
```

If it reads `route=direct`, you have `GEMINI_API_KEY` in your `.env` — which is correct for
development and means you are not testing the proxy. Comment it out to exercise the real path.

### Adjusting the limits

They are rows, not constants, so this needs no deploy:

```sql
update plan_limits set daily_limit = 50 where plan = 'free';
```

Shipped defaults: free 30/day, pro 1000/day, 6 and 20 per minute, 2-minute clip cap.

---

## Phase 4 — Payme

**This phase has a hard prerequisite you cannot code around: a signed contract with Payme and
a cassa activated for production by your Payme manager.** Passing the sandbox and being
switched live are separate steps, and only the manager can do the second one.

### 4.1 Cabinet

1. Get access to [merchant.payme.uz](https://merchant.payme.uz) from your manager.
2. **Добавить кассу** (add a cashbox) → type: web.
3. **Endpoint URL**:
   ```
   https://<your-project-ref>.supabase.co/functions/v1/payme
   ```
4. **Account requisite**: name it exactly `order_id`. This string appears in
   `supabase/functions/payme/index.ts` as `ACCOUNT_FIELD` and in the checkout link as
   `ac.order_id`; a mismatch fails every payment at validation with a cause that is invisible
   from the code.
5. Collect the **cassa ID** (24 hex characters) and both keys — the **test key** and the
   **production key**.

### 4.2 Deploy

```bash
supabase secrets set PAYME_MERCHANT_ID="<24-hex cassa id>"
supabase secrets set PAYME_TEST_KEY="<test key>"
supabase secrets set PAYME_CHECKOUT_URL="https://test.paycom.uz"

supabase functions deploy payme
supabase functions deploy checkout
```

`PAYME_KEY` (the production key) is added at go-live. The endpoint accepts **any** configured
key, which is what makes going live an environment change rather than a code change.

Set the price — in **tiyin**, so'm × 100:

```sql
update plan_limits set price_tiyin = 5000000 where plan = 'pro';   -- 50 000 so'm
```

### 4.3 Sandbox

Go to [test.paycom.uz](https://test.paycom.uz), select your cassa, and run the test suite.
Do not take a real payment until every test is green.

If tests go red, check these first:

| Symptom | Cause |
| --- | --- |
| Everything red with `-32504` | `PAYME_TEST_KEY` not set, wrong, or the function not redeployed since setting it |
| `PerformTransaction` red with `-31003` after an earlier green run | A leftover state-1 transaction from a previous run. Reset the test data in the sandbox |
| `CreateTransaction` red with `-31008` | Same leftover-active-transaction cause |
| Wrong-amount test failing unexpectedly | Tiyin confusion — check `price_tiyin` really is so'm × 100 |
| Sandbox cannot reach the endpoint | Endpoint URL wrong in the cabinet, or `payme` not deployed |

Ask your manager whether `ChangePassword` is required for your cassa — it often is not, and
supporting it means moving the key out of environment variables and into the database. The six
implemented methods are what a standard scope asks for.

### 4.4 Go live

```bash
supabase secrets set PAYME_KEY="<production key>"
supabase secrets set PAYME_CHECKOUT_URL="https://checkout.paycom.uz"
supabase functions deploy payme
supabase functions deploy checkout
supabase secrets unset PAYME_TEST_KEY
```

Then ask your manager to activate the cassa for production. Until they do, the checkout page
shows «Поставщик не найден или заблокирован» — which is not a bug in anything above.

Finally, make one real payment with a real card and confirm `profiles.plan` flips to `pro`.

---

## Phase 5 — Retire the bundled keys ✅ (done, August 2026)

Only once Phase 3 has been proven in a **packaged** build, because until then the key pool is
what keeps older installs dictating.

1. Delete `src/main/keys.ts`, `src/main/keys.test.ts` and `scripts/write-keys.mjs`.
2. Remove the `gemini-keys.json` entry from `extraResources` in `electron-builder.yml`.
3. Remove the `write-keys` step and the `GEMINI_KEYS` secret from
   `.github/workflows/release.yml` — and delete the secret from the repository settings.
4. In `src/main/state.ts`, delete the `'pool'` branch of `resolveRoute()` and the pool
   rotation in `batchTranscribe()`.
5. In `src/main/config.ts`, shrink `resolveGeminiKey()` to the `.env` branch.
6. Rewrite the parts of `CLAUDE.md` and `README.md` that describe the key pool.

After this, **no Gemini key exists anywhere in the installer** — which is what makes the paid
plan real rather than advisory.

---

## Secrets, in one table

| Name | Where | Secret |
| --- | --- | --- |
| Supabase project URL | `src/main/supabase-config.ts` | No |
| Supabase `anon` key | `src/main/supabase-config.ts` | No |
| Supabase `service_role` key | Supabase only — never set it yourself | **Yes** |
| `GEMINI_API_KEYS` | `supabase secrets` | **Yes** |
| `PAYME_MERCHANT_ID` | `supabase secrets` | No (appears in checkout links) |
| `PAYME_KEY` / `PAYME_TEST_KEY` | `supabase secrets` | **Yes** |
| `PAYME_CHECKOUT_URL` | `supabase secrets` | No |
| Google OAuth client id/secret | Supabase Auth dashboard | Secret half is **yes** |

Nothing marked secret belongs in this repository, in an installer, or in a chat message.

---

## Troubleshooting

**Sign-in opens the browser and nothing comes back.** `gapirme://auth-callback` is missing
from Supabase's redirect allowlist (§2.2), or the protocol handler was not registered — on a
packaged build that comes from `protocols:` in `electron-builder.yml`, and in dev from
`registerProtocol()` in `src/main/index.ts`. Check `logs\main.log` for
`could not register the gapirme:// handler`.

**Dictation says «Kirish kerak» even though the Hisob pane shows me signed in.** The session
restored but the token did not. Sign out and back in; if it recurs, look for
`safeStorage unavailable` in the log — on a machine where DPAPI is unavailable the session
file is rewritten in plaintext and may have been discarded.

**Dictation says «Bugungi bepul limit tugadi» immediately.** Check `usage_events` for that
user. Rows with `finalized = false` are reservations that were never settled — they should be
deleted by the refund path, and a pile of them means the function crashed between reserving
and answering.

**Everything worked and now every dictation 401s.** The `anon` key was rotated, or the
project was paused (free-tier Supabase projects pause after a week of inactivity).
