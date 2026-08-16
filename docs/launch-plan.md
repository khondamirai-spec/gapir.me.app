# Launch plan — from this repo to a paid, downloadable product

This is the full path from where the code stands today to "anyone opens the website,
downloads the app, signs in, pays, and dictates". It covers three kinds of work, and it
matters which kind each task is:

- **Coding** — you (or Claude) can do it any evening.
- **Dashboard work** — done once, in your own accounts, already scripted step-by-step in
  [supabase-setup.md](supabase-setup.md).
- **Waiting on other people** — Payme's manager, Google's verification team, Apple.
  These have the longest and least controllable timelines, so they are started *first*
  and the coding happens while they grind.

**Headline estimate: first real payment in ~2–4 weeks; almost all of that is waiting on
Payme, not building.** The code for the backend, quota, checkout and the Merchant API
endpoint is already written and tested.

---

## Where things stand today

| Piece | Status |
| --- | --- |
| App (Windows): dictation, overlay, history, settings | ✅ Done, shipping |
| Website ([docs/index.html](index.html)) with permanent download link | ✅ Done — needs Pages switched on |
| Release pipeline (tag → build → GitHub Release → auto-update) | ✅ Done |
| Supabase backend code (transcribe / checkout / payme functions, schema) | ✅ Written & unit-tested |
| Supabase project created and configured | ✅ Done (Aug 2026) — migrations applied, all three functions deployed, real URL + anon key committed in `supabase-config.ts` |
| Google sign-in configured | ⬜ Phase 2 of supabase-setup.md — verify by signing in from the Hisob pane and seeing `route=proxy` |
| Payme contract, cabinet, sandbox, go-live | ⬜ Phase 4 — **the long pole** |
| Bundled key pool retired | ⬜ Phase 5 — only after the proxy is proven |
| Windows code signing | ⬜ Optional polish |
| macOS / Linux builds | ⬜ Requires porting work first (see Track E) |

---

## Track A — Backend live (Supabase Phases 1–3)

**Effort: one focused day. Nobody external involved. Do this first — everything else
tests against it.**

| Step | What | Time |
| --- | --- | --- |
| A1 | Create the Supabase project (**Frankfurt** — region is permanent), `supabase db push` | 1–2 h |
| A2 | Fill `src/main/supabase-config.ts` with the project URL + anon key, commit | 15 min |
| A3 | Google Cloud OAuth client, enable Google provider in Supabase, add `gapirme://auth-callback` to redirect URLs | 1–2 h |
| A4 | `supabase secrets set GEMINI_API_KEYS=...`, deploy `transcribe`, verify `route=proxy` in the `[state]` log | 1 h |
| A5 | Add yourself as an OAuth **test user**, and **submit the consent screen for Google verification now** — it takes days to weeks and runs unattended (Track D) | 30 min |

Exit criterion: `npm run dev` with no `GEMINI_API_KEY` in `.env`, sign in from the Hisob
pane, dictate, and the log reads `route=proxy`.

---

## Track B — Payme: registration, sandbox, go-live (Phase 4)

**Elapsed time: 2–4 weeks. Your own effort inside it: ~2 days. Start the paperwork the
same week as Track A — the waiting overlaps with everything else.**

### B1. Legal prerequisite (before Payme will talk to you)

Payme signs contracts with registered businesses, not private individuals. If you don't
have one yet, register as **yakka tartibdagi tadbirkor (YaTT / ИП)** — doable online via
my.gov.uz, typically **1 business day**, with a bank account for the business following
in **1–3 days**. An OOO (MChJ) also works but takes longer and isn't needed to start.

### B2. Contract and cabinet access — *the long pole*

1. Apply to Payme Business (payme.uz/business or through a manager contact) with your
   business details and a description of the product ("desktop application, online
   subscription service").
2. Sign the contract; the manager creates your account on **merchant.payme.uz** tied to
   your registration phone number.

**Elapsed: typically 1–2 weeks, occasionally longer.** This is bureaucracy, not
engineering — chase the manager politely and keep building meanwhile. Ready-to-send
message templates (uz/ru) are in the payme integration notes; the key ask is: cabinet
access, confirmation the account field is `order_id`, and confirmation of your Endpoint
URL.

### B3. Cabinet setup — half a day once you have access

In merchant.payme.uz (UI is Russian):

1. «Кассы» → «Добавить кассу» → type **«Прием электронных платёжей с биллингом»**
   (WITH billing — the only type that has an Endpoint URL and a TEST_KEY).
2. Endpoint URL: `https://<project-ref>.supabase.co/functions/v1/payme`
   (the `/functions/v1/payme` suffix matters — a wrong path fails every test).
3. «Реквизиты платёжа» → add requisite named exactly **`order_id`** (validation:
   digits). A mismatch with `ACCOUNT_FIELD` in the code fails every payment invisibly.
4. From the 🔑 icon on the cassa card, collect: **cassa ID** (24 hex), **TEST_KEY**,
   and note where the production **KEY** lives (don't deploy it yet).
5. `supabase secrets set` the merchant ID + test key, `PAYME_CHECKOUT_URL=https://test.paycom.uz`,
   deploy `payme` and `checkout`, set `price_tiyin` (so'm × 100!) in `plan_limits`.

### B4. Sandbox — 1–2 days including re-runs

At **test.paycom.uz**, run the suite top to bottom (invalid-data block first, then the
six payment methods). Before starting: seed one fake test order in `payme_orders` and
verify a raw unauthenticated POST to the endpoint returns HTTP 200 with `-32504`.
The classic trap: a leftover state-1 transaction from a previous run makes later runs go
red for reasons that look like code bugs — reset the test rows between full runs.
The failure table in [supabase-setup.md §4.3](supabase-setup.md) covers every red result
we know about. **Delete the fake order and test transactions when done.**

### B5. Go-live — a few days, mostly waiting again

1. Message the manager: sandbox all green, please activate the cassa. **Activation is
   the manager's action** — until it happens the checkout page says «Поставщик не найден
   или заблокирован» no matter how green the sandbox is. Allow 1–5 business days.
2. Env flip (no code change): set `PAYME_KEY`, switch `PAYME_CHECKOUT_URL` to
   `https://checkout.paycom.uz`, redeploy, unset `PAYME_TEST_KEY`.
3. **Smoke test with real money**: pay for Pro yourself with a real card, confirm
   `profiles.plan` flips to `pro` and the Hisob pane shows it after a refresh.
4. Refund that payment from the cabinet and confirm the `-2` path behaves.

Exit criterion: a stranger with a card can go from «Pro olish» to a working Pro plan
with no human involved.

---

## Track C — Website and Windows distribution

**Effort: an afternoon now; signing later. No external waiting except domain DNS.**

| Step | What | Time |
| --- | --- | --- |
| C1 | Repo → Settings → Pages → deploy from `main` / `docs`. Site live at `https://<user>.github.io/<repo>/` | 15 min |
| C2 | Custom domain: buy `gapir.me`, add a `CNAME` file to `docs/`, point DNS at Pages, enforce HTTPS | 1 h + DNS propagation |
| C3 | OS detection on the download button: Windows → the existing `.exe` permanent link; macOS/Linux → «Tez orada» + the Windows link as secondary. Keeps the page honest today and ready for Track E without a redesign | 1–2 h |
| C4 | *(after Track A/B)* Update the page copy: pricing, «Google bilan kirish», free-plan limits | 1 h |
| C5 | **Code signing** (optional, later): Azure Trusted Signing ≈ $10/month kills the SmartScreen warning. Needs the same business registration as Track B. Until then users click «More info → Run anyway» | 0.5 day setup |

---

## Track D — Google OAuth verification (background)

Submitted in step A5; runs unattended. Until Google approves, sign-in shows an
"unverified app" warning to everyone except listed test users. Scope is only
`email` + `profile`, so this is the cheap kind of review — **typically several days to
~2 weeks**. Nothing blocks on it except the polish of a warning-free consent screen;
you can launch to early users before it clears.

---

## Track E — macOS (later, on demand)

**Effort: 2–4 weeks of real porting work + $99/year + access to a Mac. Do not start
until Windows revenue or user demand justifies it.**

The blocker is code, not packaging — four modules are Windows-only:

| File | Port |
| --- | --- |
| `audio.ts` | ffmpeg `dshow` → `avfoundation`; new device enumeration parsing |
| `hotkey.ts` | uiohook works on mac but needs the Accessibility permission flow; the CapsLock send/restore trick must be rethought |
| `inject.ts` | Ctrl+V → Cmd+V; clipboard timing revalidated |
| `overlay.ts` | panel-level window flags for the always-on-top non-focusable pill |

Then packaging: `mac:` target in `electron-builder.yml` (dmg, `arch: [arm64, x64]`,
fixed `artifactName` so the permanent-link trick keeps working), microphone usage
description in entitlements, **Apple Developer Program ($99/yr) + notarization** —
non-negotiable on macOS; unsigned apps don't open and auto-update doesn't work at all.
CI becomes a matrix (`windows-latest` + `macos-latest`); electron-builder publishes
`latest-mac.yml` alongside `latest.yml` and electron-updater handles the rest.
The existing `protocols:` block covers `gapirme://` sign-in on mac unchanged.

**Linux:** cheap to build (AppImage), expensive to support — Wayland blocks global
keyboard hooks and synthetic paste, which is this app's entire mechanism. X11-only,
tiny market share locally. Skip until someone specifically asks.

---

## Phase 5 — Retire the bundled key pool

Once the proxy is proven **in a packaged build** (not just dev), execute Phase 5 of
[supabase-setup.md](supabase-setup.md): delete `keys.ts`, `write-keys.mjs`, the
`GEMINI_KEYS` CI secret and the `'pool'` route. Half a day. Until this ships, every
installer contains extractable free-tier keys and the paywall is advisory. Do it
*before* Track E — it removes the per-build key machinery you'd otherwise replicate in
every CI matrix job.

---

## The calendar, if you start Monday

```
Week 1   Track A (backend live, 1 day) ──┐
         Track B1–B2 paperwork filed     │  Track D (Google review)
         Track C1–C3 website live        │  runs in the background
Week 2   ── waiting on Payme contract ── │  meanwhile: test proxy in a
         B3 cabinet setup when access    │  packaged build, polish app
         arrives → B4 sandbox            │
Week 3   B5 go-live request → activation waiting → real-money smoke test
         🎉 first real payment possible around here
Week 4   Phase 5 (retire key pool) + release; C5 signing when cert arrives
Later    Track E (macOS) when demand justifies $99/yr + a Mac
```

## Costs

| Item | Cost | When |
| --- | --- | --- |
| GitHub Pages hosting + Releases bandwidth | free | now |
| `gapir.me` domain | ~$20–30/yr | Track C |
| Supabase | free tier to start; $25/mo Pro when the free project's limits or auto-pause bite | Track A |
| YaTT registration + bank account | small state fees | Track B1 |
| Payme | no setup fee; per-transaction commission per your contract | Track B |
| Windows signing (Azure Trusted Signing) | ≈ $10/mo | Track C5, optional |
| Apple Developer Program | $99/yr | Track E only |

## The three rules that keep this safe (from CLAUDE.md — do not trade them away for speed)

1. The Gemini key lives only on the server; the client sends audio, never a prompt.
2. Quota and plan-granting live in Postgres `security definer` functions; nothing in
   the app can grant a plan — only Payme's `PerformTransaction` call does.
3. Payme keys live only in `supabase secrets` — never in git, the installer, or a chat.
