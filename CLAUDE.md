# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Electron tray app for Windows: hold **Ctrl+Shift**, speak Uzbek, release, and the
transcript is pasted into whatever app has focus. Clicking the overlay pill does the same
hands-free — click to start, click again (or Esc) to stop. Speech goes to **Google Gemini**, not to a
local Whisper model. Gemini is the only provider; the Aisha adapters are gone. The surviving
mentions of Aisha and of the user-key era — the `dropLegacyKeys()` list in
[config.ts](src/main/config.ts) — are deliberate and must stay: `conf` preserves unknown
keys, so without them encrypted credentials for services this app no longer contacts sit in
`settings.json` forever.

**There is no Gemini key in the app.** Users sign in with Google through Supabase Auth, and
every dictation uploads its audio to a Supabase Edge Function which checks the user's plan and
daily quota and then calls Gemini with a key held as a **server secret**. That is what makes
the paid plan real rather than advisory — a key handed to the client is a key the client can
keep. See [docs/supabase-setup.md](docs/supabase-setup.md) for the one-time dashboard work,
and the "Accounts, quota and money" section below for how it fits together.

**There is still no API-key setting and no model setting**, by decision rather than by
omission: everyone dictates on the server's key pool and on `DEFAULT_GEMINI_MODEL`. Both are
ours to change, not the user's to change in a text box, and `Settings` in
[types.ts](src/shared/types.ts) carries neither field. `GEMINI_API_KEY` /
`WHISPER_UZ_GEMINI_MODEL` in a developer's `.env` bypass the server entirely so that working
on the app never spends real users' quota; a packaged build has no environment to read.

**The bundled key pool is gone** (Phase 5 of the setup doc, done): the app used to ship
free-tier Gemini keys inside the installer (`src/main/keys.ts`, `resources/gemini-keys.json`,
`scripts/write-keys.mjs`, the `GEMINI_KEYS` CI secret), because before there was a backend it
had nothing else to dictate on. A key inside an installer is extractable by anyone who
downloads it, so once the proxy was live the pool was a hole in the paywall — an installed
copy now dictates through the proxy or not at all, which is what makes the paid plan real.
Don't reintroduce a client-side key for any reason.

There is no main window in the usual sense. The app lives in the tray plus a floating
always-on-top pill; the `BrowserWindow` in [src/main/index.ts](src/main/index.ts) is a place
you *visit* — to read history, check a statistic, or change a setting.

## Commands

```bash
npm run dev          # electron-vite dev via scripts/dev.mjs (see below)
npm run dev:mock     # same, with a fake transcriber — no API key, nothing billed
npm run dev -- --log-frames   # dump Gemini Live frames + unparseable batch responses
npm test             # vitest run
npm run typecheck    # tsc --noEmit
npm run build        # typecheck + electron-vite build
npm start            # electron-vite preview — run the built output, no dev server
npm run dist         # fetches ffmpeg (predist) then builds release/gapir-me-Setup.exe
npm run release      # same, but --publish always (CI uses this; see Release below)
npm run spike        # replay sample.pcm through Gemini and print the transcript
npm run spike -- --model a,b   # same audio through several models, side by side
npm run spike -- --models      # list the models the key can reach
npm run spike -- --raw         # print the unparsed response body
npm run spike -- --lang ru     # transcribe as Russian instead of Uzbek
```

The spike is a standalone Node script, not part of the app: it reads `GEMINI_API_KEY` from
`.env` itself and needs a recording you make first —
`ffmpeg -f dshow -i audio="<device>" -ar 16000 -ac 1 -f s16le -t 6 sample.pcm`. Its default
model is kept in step with `DEFAULT_GEMINI_MODEL` by hand, so a plain run answers "would
today's build have got this right?".

Single test file / single test:

```bash
npx vitest run src/main/audio.test.ts
npx vitest run -t "pairs each friendly label with its ASCII alternative name"
npx vitest            # watch mode
```

The backend has its own toolchain, and it is **not** wired into `npm run build` — deploying it
is a separate act from releasing the app (see Release):

```bash
supabase db push                      # apply supabase/migrations
supabase functions deploy transcribe  # ...and checkout, and payme
supabase functions serve              # run them locally against a local Postgres
supabase secrets set GEMINI_API_KEYS="k1,k2"
```

**Always launch dev through `npm run dev`, never `npx electron-vite dev` directly.**
[scripts/dev.mjs](scripts/dev.mjs) exists to strip `ELECTRON_RUN_AS_NODE`, which VS Code's
integrated terminal inherits from the extension host — with it set, Electron boots as plain
Node and the app dies with "Cannot read properties of undefined (reading 'app')". The
launcher also loads `.env` into the child (the main process has no `import.meta.env`, so
`resolveGeminiKey()` reads `process.env.GEMINI_API_KEY` or `GOOGLE_API_KEY` — Google's own
SDKs read both and people already have one or the other) and maps `--mock` / `--log-frames`
onto `WHISPER_UZ_MOCK_STT` / `WHISPER_UZ_LOG_FRAMES`.

Those env vars are a **dev convenience only**: a packaged build on someone else's machine
sees none of them, so what ships always dictates through the proxy on `DEFAULT_GEMINI_MODEL`. The
same goes for `WHISPER_UZ_GEMINI_MODEL` and `WHISPER_UZ_GEMINI_REALTIME`, which exist so a
model or the Live socket can be tried without touching a settings screen that no longer has
either control.

Dev needs **Node 22+** and **ffmpeg on PATH** (`winget install ffmpeg`); the bundled copy is
only fetched for packaged builds.

**Quit any running copy before `npm run dev`, and check that you did.** The single-instance
lock does not care that the second copy is a newer build: it quits, and the *running* one
answers by opening its app window (see `second-instance` in [index.ts](src/main/index.ts)).
So a window appears, nothing about it has changed, and the obvious conclusion — "my edit did
nothing" — is wrong. `Get-Process electron | Stop-Process -Force` first; an installed build
counts too, and shares the lock. This is the same mechanism sign-in rides on, so it cannot be
relaxed for convenience.

**To see a main-process change you must restart; to see a renderer change you usually
mustn't.** Vite hot-reloads the three renderer pages in place — which is its own trap, below.

On startup `@supabase/supabase-js` prints *"Node.js 20 and below are deprecated"* even on a
Node 22 machine. It is reading **Electron's embedded Node**, which is 20.18 in Electron 33 —
not the one that ran `npm`. Don't spend time chasing it as a local misconfiguration; it is a
fact about the runtime we ship, and it is the thing that will force an Electron upgrade
(37+ ships Node 22).

**As of `@supabase/realtime-js` 2.112, that deprecation has teeth.** `createClient` builds a
`RealtimeClient` eagerly, which throws *"Node.js detected but native WebSocket not found"* on
Node 20 — so `supabase()` in [auth.ts](src/main/auth.ts) throws on its first call, `client` is
never memoised, and every later call throws too. `initAuth` is launched with `void`, so the
app boots normally and the failure surfaces only as an `UnhandledPromiseRejectionWarning` at
startup and **no `[auth]` line at all** in the log. That absence is the tell: no session is
restored, sign-in cannot complete, and every dictation on a configured build says
*"Kirish kerak"*. It is not dev-only — a packaged build runs the same embedded Node. The
dependency is a caret range, so a machine that installed before 2.112 will not reproduce it.
CI ([.github/workflows/ci.yml](.github/workflows/ci.yml))
runs on `windows-latest` — the native deps ship platform-specific binaries and the modules
under test import them.

## Architecture

Three electron-vite targets, built from [electron.vite.config.ts](electron.vite.config.ts):
`main`, `preload`, and three renderer HTML entries (`overlay`, `dock-guides`, `app`).
`@shared` aliases `src/shared`.

**[src/main/state.ts](src/main/state.ts) is the only module that coordinates the others.**
Everything else in `src/main/` is a leaf with no knowledge of its siblings — `audio.ts`
doesn't know STT exists, `hotkey.ts` doesn't know about the overlay. Preserve that: new
cross-cutting behaviour belongs in the state machine, not wired between leaves.

The leaves, so you can find a behaviour without opening all of them:

| file | role |
| --- | --- |
| `index.ts` | bootstrap: single-instance lock, tray, the app `BrowserWindow`, every `ipcMain` handler |
| `audio.ts` | ffmpeg dshow capture, device enumeration, `rms`, `pcmToWav` |
| `hotkey.ts` | the uiohook listener that emits `start` / `stop` / `cancel` |
| `inject.ts` | clipboard save → paste → restore-on-a-timer |
| `overlay.ts` | the pill window, its bounds, `applyVisibility()`, and the drag magnet |
| `dock-guides.ts` | the landing slots drawn while the pill is dragged — owned by `overlay.ts`, not a peer |
| `history.ts` | the capped history log and its change listener |
| `config.ts` | the settings store, plus `geminiModel()`, `geminiRealtimeEnabled()` and `resolveGeminiKey()` — the three things that are decided for the user rather than by them |
| `auth.ts` | the Supabase session: Google PKCE sign-in, the encrypted session store, `accessToken()`, the plan snapshot |
| `billing.ts` | asks the server for a Payme checkout URL and opens it |
| `supabase-config.ts` | project URL, anon key, the `gapirme://` scheme — all public by design |
| `mic-test.ts` | the Settings level meter |
| `updater.ts` | electron-updater, surfaced as `IPC.updateStatus` |
| `logger.ts` | tees `console.*` into `userData\logs\main.log` — a packaged app has no console |

`mic-test.ts` is the one leaf with a rule you can't see from its own file: **only one ffmpeg
process can hold a DirectShow device at a time**, so a dictation has to win. `state.ts` calls
`stopMicTest()` before opening the microphone, and the dependency points that way (state →
mic-test) on purpose — never the reverse.

`dock-guides.ts` is the one place a leaf imports another, and it is not an exception to the
rule so much as a window that belongs to `overlay.ts`: the slots exist only inside a drag,
and the drag loop is the only thing that knows which one the magnet has. Routing a highlight
that changes 120 times a second through the state machine would buy nothing.

**Never move the overlay window with `setPosition`.** On a fractionally scaled display —
125% is the Windows default on most laptops — it makes the window *grow* by about a pixel
per call, because Electron rounds the DIP→physical conversion and then re-derives the size
from the rounded rect, feeding each call's error into the next. A drag makes over a hundred
calls a second, so the window inflates from 360×150 to larger than the screen in seconds,
and since the pill is anchored to the window's bottom edge it slides downward out of the
user's hand and then off the display entirely. `moveTo()` restates `WIDTH`/`HEIGHT` on every
move for exactly this reason.

The dictation flow:

```
hotkey 'start' ─▶ ensureVisible() + startRecording() + resolveRoute()
                  (+ open the Live socket, only if WHISPER_UZ_GEMINI_REALTIME=1)
hotkey 'stop'  ─▶ TRANSCRIBING ─▶ addHistory() ─▶ INJECTING ─▶ DONE
hotkey 'cancel' (Esc) ─▶ back to IDLE, nothing pasted
```

`resolveRoute()` decides where the transcript will come from, once, at hotkey-press time —
`proxy` (every installed copy), `direct` (a developer's `.env` key), `mock`, or `none`.
**`route=` is the first field to read in the `[state]` log line**, because with a server in
the path the prior question to "which model ran?" is whether the request went through the
server at all.

`AppState` (`IDLE | RECORDING | TRANSCRIBING | INJECTING | DONE | ERROR`) lives in
[src/shared/types.ts](src/shared/types.ts) alongside `Settings`, `StyleSettings`,
`HistoryEntry`, `AppSection` and the `IPC` channel-name map. That file must stay
dependency-free — it is imported by main, preload and both renderers.
[src/shared/text.ts](src/shared/text.ts) is the same deal for word counting — today only the
Statistika pane counts words (main's `[state]` line logs `chars=`), but the counting rule is
product policy and lives in shared so any future counter agrees with the pane.

Load-bearing details of the flow:

- Every PCM chunk is retained in `Dictation.pcm` so the **batch adapter can re-transcribe
  the same audio** if the Live socket dies. Realtime first (when enabled), batch on any
  recoverable failure or an empty result; the mock has no fallback.
- **History is written before the paste is attempted**, deliberately. A paste that lands in
  the wrong window is exactly when the user needs to fetch the text by hand.
- `IDLE` does *not* mean "overlay hidden". Whether the window is on screen is decided by
  `applyVisibility()` in [overlay.ts](src/main/overlay.ts), from `lastState` and the
  `showIdlePill` setting.
- `DONE` and `ERROR` are transient display states, not dead ends — a new hotkey press cancels
  the timer and records immediately.
- `currentState()` is a method rather than a field read on purpose: `this.state` is mutated
  inside `set()`, which TS control-flow analysis can't see, so a direct field read after an
  `await` narrows to a stale type.

### Accounts, quota and money

The backend lives in `supabase/` and is three Edge Functions over five tables. It is deployed
separately from the app — a schema or function change ships with `supabase db push` /
`supabase functions deploy`, not with a release.

| function | verify_jwt | role |
| --- | --- | --- |
| `transcribe` | yes | the dictation proxy: check quota → reserve → call Gemini → finalise or refund |
| `checkout` | yes | create/reuse a `payme_orders` row and return a checkout URL |
| `payme` | **no** | the Payme Merchant API endpoint Payme itself calls |

Four properties hold this together, and each is load-bearing:

**The prompt is built on the server, never sent by the client.** The app posts
`{ audio, language, style }` — validated field by field in `readBody()`. If it posted prompt
text, any signed-in user could point our Gemini key at a task of their own choosing. This is
the single most important security property of the design.

**Quota is enforced by Postgres, not by the app.** `reserve_dictation()` is `security definer`
and callable only with the service-role key; the app's `anon` key reaches nothing but
`account_snapshot()`, which reads `auth.uid()` and so cannot be pointed at anyone else.
**Postgres grants `EXECUTE` to `PUBLIC` by default**, so the `revoke` block at the bottom of
the migration is not tidiness — without it a signed-in user could call `fulfil_payme_order()`
and give themselves a year of Pro, and RLS would not stop them.

**A failed dictation costs nothing.** The usage row is inserted *before* Gemini is called (so
two dictations racing cannot both slip past the limit) and deleted again on any failure,
including a silent clip. A `finalized = false` row that survives is a crash, and worth
investigating as one.

**Nothing in the app can grant a plan.** The subscription is granted in `PerformTransaction`,
when Payme calls us — not when the browser comes back. That is why the UI says "come back and
refresh" after opening a checkout rather than "you are now Pro": the app genuinely does not
know yet.

### Payme

`supabase/functions/payme/index.ts` implements the six Merchant API methods. Payme calls us;
we never call Payme. The rules that decide whether money moves are extracted into
`_shared/payme-rules.ts` and tested in [payme-rules.test.ts](src/main/payme-rules.test.ts) —
strict account-id parsing, the 12-hour boundary, tiyin-vs-so'm, constant-time key comparison.

Four things about that file are counter-intuitive enough to be worth knowing before editing
it, and each is a way the sandbox at test.paycom.uz fails an integration:

- **Always HTTP 200.** Errors are a JSON body. A 4xx, or a crashed 500, reads to Payme as
  -32400 and fails a test that was otherwise passing.
- **Retries must return the identical saved result**, to the millisecond. Every state change
  is a compare-and-swap and every "already in that state" branch returns stored values.
- **`CheckPerformTransaction` must not fail because an active transaction exists.** It is a
  pre-check; the one-active-transaction rule belongs to `CreateTransaction` and is enforced by
  a partial unique index.
- **`PerformTransaction` answers success even if granting the plan throws.** Payme has been
  told the money moved; a fulfilment bug must not become a payment-protocol error. It logs
  `PAID BUT NOT FULFILLED` for a human instead.

`ACCOUNT_FIELD` (`order_id`) must match the requisite configured in the merchant cabinet
exactly, or every payment fails validation with a cause invisible from the code.

### The key pool (removed)

Before there was a server, the app shipped free-tier Gemini keys inside the installer and
rotated through them as each hit its daily cap. Phase 5 of the setup doc removed all of it —
`src/main/keys.ts` and its test, `resources/gemini-keys.json`, `scripts/write-keys.mjs`, the
`GEMINI_KEYS` CI secret and the `pool` route — because a key inside an installer is
extractable by anyone who downloads it, which once the proxy was live made the pool a paywall
bypass. The same per-key rotation and cooldown logic now lives inside the `transcribe` Edge
Function, over keys nobody can extract.

### STT adapters

[src/main/stt/types.ts](src/main/stt/types.ts) defines `SttAdapter` / `SttSession`
(`pushAudio` → `end(): Promise<string>` / `cancel()`). Implementations:

| file | role |
| --- | --- |
| `proxy-batch.ts` | posts the WAV to our Edge Function with the user's JWT — **the path every installed copy takes**, and the one with no API key in the process |
| `gemini-batch.ts` | `generateContent` with inline WAV, called directly — the dev `.env` and pre-Supabase path |
| `gemini-live.ts` | Live API WebSocket — the streaming experiment, **off by default**, and unavailable on the proxy route (it needs a key in hand) |
| `gemini-common.ts` | prompt building and response parsing, shared by the two direct adapters |
| `mock.ts` | fake transcriber for `npm run dev:mock` |

`gemini-common.ts` is **deliberately duplicated** into
`supabase/functions/_shared/gemini.ts`, because the two run in different runtimes and bridging
them would be more machinery than the ~200 lines it saves. That copy is kept honest by
[prompt-drift.test.ts](src/main/stt/prompt-drift.test.ts), which asserts both builders produce
byte-identical prompts across every language × tone × switch — change a rule in one file and
it fails. It is also the only thing typechecking the edge module at all, since `supabase/` is
outside tsconfig's `include`.

`SttError` carries a `code` (`quota` / `auth` / `model`) when the answer changes what the
caller should do; that is what drives key rotation.

**Gemini is a language model, not an ASR service, and that difference is load-bearing.**
The prompt in [gemini-common.ts](src/main/stt/gemini-common.ts) is product code: without
each of its rules the model answers the speech instead of transcribing it, translates Uzbek
to English, tidies grammar, or fences its output. The Uslub pane is compiled into that
prompt — `transcriptionPrompt({ language, style })` — so a change there changes what every
dictation returns. `sanitizeTranscript` cleans up what
survives, and the `<no-speech>` sentinel exists so a silent clip comes back as `''` rather
than as an apology that would get pasted into the user's document. `parseGeminiResponse`
skips `thought` parts — pasting a thinking model's reasoning would be the worst bug this app
could have. Batch requests also suppress thinking (transcription needs no reasoning, and it
costs latency) and set `BLOCK_NONE` on all four safety categories (the user already said the
words out loud; we are only typing them).

Neither of those blocks is accepted by every model, and that is why `SHAPES` in
[gemini-batch.ts](src/main/stt/gemini-batch.ts) is a **four-entry walk rather than a single
retry**: `thinkingLevel: 'low'` works across the 3.x line, `thinkingBudget: 0` is rejected by
3.5-flash-lite and 3.6-flash, `thinkingLevel: 'none'` is rejected everywhere, and some
accounts may not set `BLOCK_NONE` at all. A rejection arrives as a bare
`400 Request contains an invalid argument` naming no argument, so this cannot be driven by
reading the error — it has to be tried. The winning index is memoised per model id in
`shapeByModel`, because discovering it once per run is fine and once per utterance is a
latency bug. `isFatalBadRequest` short-circuits the walk for 400s that no reshaping will fix
(bad key, missing model, audio too large).

Gemini model ids churn faster than this app ships, and the model used to be a free-text
setting for exactly that reason. It isn't any more: a text box that can 404 at hotkey-press
time is a support burden handed to the one person who can't fix it, and every install
transcribing on the same known-good model is worth more than the flexibility. Changing it is
a one-line change to `DEFAULT_GEMINI_MODEL` in [types.ts](src/shared/types.ts) plus a
release; `WHISPER_UZ_GEMINI_MODEL` and `npm run spike -- --model` are how you find out what
to put there. The Live API model is `WHISPER_UZ_GEMINI_LIVE_MODEL` — note its default is a
whole generation behind the batch default, because the Live API and `generateContent` do not
carry the same model ids.

### Renderers and IPC

Context isolation on, node integration off. [src/preload/index.ts](src/preload/index.ts) is
the entire main↔renderer surface, exposed as `window.api`. Every `on*` subscriber returns an
unsubscribe function because the app window swaps panes without reloading. Channel names come
from the `IPC` const, never string literals.

**A renderer holds no state main cannot re-establish, and main re-establishes it on every
`did-finish-load` — `on`, never `once`.** A page loads more than once: Vite reloads the
overlay whenever its HTML or CSS is touched, and a crashed renderer is reloaded in the field.
A page that comes back without being re-told everything draws *defaults*, which is a
particularly nasty class of bug because the defaults look deliberate — the pill reappears in
the bottom dock, unhovered, with the level meter of a dictation that is not happening,
while main's own state says otherwise and nothing in the log is wrong. The overlay's handler
in [overlay.ts](src/main/overlay.ts) re-pushes status, dock and hover for exactly this
reason; anything new that main pushes belongs in it. Its partner is the markup: a renderer's
first frame is drawn before any IPC arrives, so the HTML has to *be* the resting state
rather than assume a message will fix it.

The renderers are **plain TypeScript and hand-written CSS** — no framework, no component
library. [app.ts](src/renderer/app/app.ts) draws all five panes, the settings modal and the
first-run welcome; keep it that way rather than reaching for React.

**Settings is a modal, not a pane.** `show('settings')` opens `#settingsModal` over whatever
was on screen and returns; every other section swaps the `.view` underneath. The modal has
its own sub-nav (`.modal-nav-item[data-pane]` → `.modal-pane`), and **every control in it
saves on `change`** — there is no Save button, which is only safe because nothing in there is
half-typed state any more. The version and the update check live in its bottom-left corner.

**The logo is the logo.** Every surface that shows the mark — sidebar, welcome screen,
overlay pill, tray, app icon, installer, download page — draws
[LOGO.png](LOGO.png) itself, rescaled by [scripts/make-icons.mjs](scripts/make-icons.mjs)
into `src/renderer/assets/logo.png` (trimmed, for the renderers), `resources/icon.png`,
`resources/tray.png` and `docs/logo.png`. An earlier version of that script traced the mark
by hand as bezier paths and the renderers inlined *those* — legible at 16px, and not the
brand's mark. If a copy looks cramped, make it bigger; do not redraw it. The pill paints it
with `-webkit-mask-image` rather than as an `<img>`, because the artwork is burgundy and the
pill is near-black: masking keeps the shape and lets the colour follow the state.

The two brand typefaces are **bundled**, not fetched:
[src/renderer/fonts/fonts.css](src/renderer/fonts/fonts.css) is imported from each renderer
entry so Vite emits the `.woff2` files and rewrites their URLs. `assetsInlineLimit: 0` in
[electron.vite.config.ts](electron.vite.config.ts) is load-bearing for that — the default
4 KB threshold inlines the smallest subset as a `data:` URI, which `default-src 'self'`
then blocks in the packaged build but not in dev.

Three IPC rules main enforces and that must survive edits to
[index.ts](src/main/index.ts): `openExternal` rejects anything that isn't `https://`; the
window-control handlers act on `BrowserWindow.fromWebContents(event.sender)` rather than a
module-level window; and **no credential crosses the bridge**. That third rule retired with
the API-key field and came straight back with the session — `IPC.authGet` returns a name, an
email and two counters, and the access token stays in main. `IPC.billingCheckout` takes no
arguments for the same reason: a renderer that could name the user or the price could name
someone else's account or a cheaper one.

Sign-in is the one flow that does not resolve where it starts. `IPC.authSignIn` resolves once
the system browser has been opened; the signed-in state arrives later on `IPC.authChanged`,
via the `gapirme://` deep link. Anything that awaits the invoke and then reads the account
will read the signed-out one.

The app window is **frameless** — the title bar is drawn in the renderer, dragging comes from
`-webkit-app-region: drag`, and minimise/maximise/close go over IPC. `IPC.windowState` exists
because a window can be maximised by ways we never hear about (Win+Up, Aero Snap) and the
glyph has to stay truthful.

## When a dictation produces nothing

The failure everyone hits is "I held the keys, I spoke, no text appeared". The flow has four
places to lose the transcript, and they are distinguishable in about a minute if you look in
this order.

**The `[state]` log line is the ground truth.** Every completed dictation prints the route,
the model, which key it used (`key=env` / `key=none`), audio length, round-trip time and the
transcript from [state.ts](src/main/state.ts). It exists so that "which model actually ran?"
is a fact you read rather than one you infer.

On an installed copy there is no console to read it in, so [logger.ts](src/main/logger.ts)
tees `console.log`/`warn`/`error` into `logs\main.log` under userData — which is what the
tray's *Loglar papkasi* item opens. That file is the whole of what you get back from a user
whose dictation produced nothing, so treat it as the interface it is: anything worth
diagnosing a remote failure with has to go through `console.*` to end up there.

**Runtime state lives in `%APPDATA%\whisper-uz\`** — `settings.json` (all plaintext; there
is no credential in it), `auth.json` (the Supabase session, **encrypted** with `safeStorage`
— a refresh token is a credential, which is exactly why it is not in `settings.json`),
`history.json`, and `logs\main.log`. Note the folder is named after `package.json`'s `name`,
**in packaged builds too**: `productName` lives only in `electron-builder.yml`, which Electron
never reads at runtime, so a packaged build and `npm run dev` share the same folder — and the
same single-instance lock, which is why an installed copy must be quit before running dev.
Read `settings.json` before trusting any
claim about what the app is configured to do, including the user's. `conf` re-reads from disk
on each `get`, so editing that file takes effect on the next hotkey press with no restart —
handy for bisecting a bad setting, and a reason not to assume a running app is still using
the values it started with. An empty `history.json` means **no dictation has ever
succeeded**, which narrows the search a lot.

**"Kirish kerak" is not a bug.** On a configured build a signed-out user cannot dictate, by
design. If the Hisob pane shows someone signed in and the hotkey still says this, the session
restored but the token did not — look for `safeStorage unavailable` in `main.log`.

**Two different messages mean "out of quota" and they are not the same failure.** `plan` (a
402 from our server) is the *user's* daily allowance running out, and the answer is an offer
to upgrade. `quota` (a 429) is a key of *ours* being spent, which the user can do nothing
about. `SttErrorCode` keeps them apart on purpose; collapsing them would show an upgrade
button for our outage.

**Free-tier quota exhaustion is a routine operating condition, not an edge case.** Gemini's
free tier caps *daily requests per model per key* — `gemini-3.6-flash` allows 20 — and once
spent, every dictation on that key fails identically with a 429. That is what the 429
handling in [gemini-batch.ts](src/main/stt/gemini-batch.ts) is for, and why it distinguishes
a burst limit from a daily cap via `isFreeTierQuotaExhausted`: both arrive as a 429 carrying
a `retryDelay`, but the daily one's delay is fiction — Google says "retry in 52s" for an
allowance that resets tomorrow. Waits above `MAX_RETRY_WAIT_MS` (6s) are refused rather than
slept through, because the user is standing there with a hotkey in their hand. On the proxy
route the same rotation runs server-side across the `GEMINI_API_KEYS` pool; when every server
key is spent, that is our outage to fix (`supabase secrets set GEMINI_API_KEYS=...`), not the
user's.

**Silent capture looks exactly like a broken transcriber.** `defaultDeviceId()` is literally
`cachedDevices[0]` — DirectShow has no "default device" concept — so on a machine whose first
enumerated input is a virtual cable or a disconnected headset, the app records real PCM of
pure silence, the provider dutifully returns nothing, and the pill says
`Hech narsa eshitilmadi`. Before debugging any STT code, measure what was captured: RMS a few
seconds of the device ffmpeg would pick, and check the peak is well above the −45 dBFS that
means "room noise only".

## Invariants worth knowing before you change things

The README's **"Things that look wrong but aren't"** section documents the decisions that
look like mistakes to anyone tidying up — read it before simplifying any of:

- ffmpeg subprocess capture instead of `getUserMedia` ([audio.ts](src/main/audio.ts))
- the hotkey cancelling the gesture when any third key goes down — Ctrl+Shift is the prefix
  of half the shortcuts in Windows ([hotkey.ts](src/main/hotkey.ts))
- not using Electron's `globalShortcut`
- `showInactive()` + `focusable: false` + a window that never resizes to fit a bigger pill
  ([overlay.ts](src/main/overlay.ts)) — it does *move*, though: holding the pill drags the
  window (main chases the cursor; the renderer only reports the button), and it snaps to a
  dock — left edge, bottom centre, right edge — persisted as the `overlayDock` setting,
  together with the height it was dropped at (`overlayDockY`, a fraction of the work area).
  A side dock is an *edge*, not a point: pinning it to the vertical middle meant every drop
  up an edge slid back to the centre of the screen, so the magnet has no vertical target
  there at all.
  The dock is also the *only* thing that changes the window's size: 360×150 at the bottom,
  360×`SIDE_HEIGHT` at a side, because a side-docked pill is rotated a quarter turn to run
  along the edge and its tooltip then needs the height. The pill floats *inside* that
  window rather than filling it: `PAD_BOTTOM` / `PAD_SIDE` are the room its drop shadow
  needs, and a side-docked pill reuses both by being rotated about its own bottom edge. All of them are
  duplicated into the `#hit` rules in the overlay's CSS, which is the price of main
  hit-testing a window Chromium never tells it about
- the pill's anchor being `position: absolute` + `left`/`bottom`/`transform` rather than
  flex alignment — the dock is applied as the window glides to it, and `justify-content`
  cannot be transitioned
- the magnet leaning the pill at a dock by at most `MAX_ASSIST_PX` instead of a fraction of
  the distance — a fraction scales with how far away the slot is, which is backwards, and
  it tore the pill out of the hand carrying it. The pill therefore never reaches the slot
  mid-drag; `endDrag` glides it there
- `#pill.error` alone dropping the side docks' rotation — a sideways three-line sentence is
  not readable, and it is why a side-docked window keeps the full 360 width
- main hit-testing the cursor on an interval to drive the pill's hover, rather than letting
  the overlay receive mouse events — Electron's `forward: true` delivers nothing here
- gating the whole bootstrap on the single-instance lock, not just calling `app.quit()` —
  which is also **how sign-in works**: a `gapirme://` link launches a second copy whose argv
  carries the callback URL, and `second-instance` forwards it. The lock and the deep link are
  one mechanism; breaking either breaks sign-in on packaged builds only
- passing ffmpeg the `@device_cm_{...}` alternative name, never the localised friendly name
- the `SHAPES` walk in [gemini-batch.ts](src/main/stt/gemini-batch.ts)
- **the Statistika chart being SVG rather than divs** — as DOM elements the bars would not
  keep the height they were given (flex item, absolutely positioned, px, %, `!important` —
  all resolved to the full chart height), so empty days drew full-height slabs. Don't
  "simplify" it back into divs without checking an empty day.

Two more, from [inject.ts](src/main/inject.ts): never focus a window of ours during the paste
flow, and restore the clipboard on a timer (`RESTORE_DELAY_MS`) rather than synchronously —
a synchronous restore races the paste and the user gets their old clipboard.

Device enumeration shells out to ffmpeg and takes 1–2s, so it is cached
(`refreshDevices()` at startup and when Settings opens) and resolved synchronously on the
hotkey path.

## Conventions

- **All user-facing strings are Uzbek** — error messages, tray menu, every label in the app
  window. Console logs and comments are English. Match this when adding UI or error text.
- Because of that, **the `AppSection` ids and the pane names in the UI are different words**,
  and a user reporting a bug will use the second set: `insights` is *Statistika*,
  `dictation` is *Diktovka*, `style` is *Uslub*, `scratchpad` is *Qaydlar*, `settings` is
  *Sozlamalar* (the modal, whose own four sections are *Umumiy*, *Tizim*, *Tarix* and
  *Maxfiylik*), `account` is *Hisob*, `help` is *Yordam*. The `NAV` / `NAV_BOTTOM` tables in
  [app.ts](src/renderer/app/app.ts) are the authority. *Lug'at* and *Shablonlar* were removed
  along with the settings behind them — an older bug report may still name them.
- The window is warm paper (`--paper`, `--card`, `--ink*`, `--accent`) with a single easing
  token (`--ease`) and a `prefers-reduced-motion` block that switches all of it off. Reuse
  the tokens; don't introduce a second palette or a second easing curve. Type is the brand's
  faces through `--font-ui` (Figtree, with Onest behind it as the Cyrillic fallback Figtree
  lacks), `--font-display` (EB Garamond, headings and figures) and `--font-mono` (Geist
  Mono, sparse technical accents); see [design-style.md](design-style.md).
- Anything a user typed is rendered with `textContent`, never `innerHTML`. Transcripts are
  arbitrary text and this window draws hundreds of them.
- Comments here explain *why*, at length, where a decision is non-obvious or was arrived at
  the hard way. Match that density; don't strip these comments while refactoring.
- Modules export an `_internals` object where tests need at private constants.
- Windows-only today. macOS needs platform branches in exactly four files —
  `audio.ts`, `hotkey.ts`, `inject.ts`, `overlay.ts` (see the README's "Not built yet").

## Testing

Vitest, `environment: node`, only `src/**/*.test.ts`. There is no Electron runtime in tests:
[vitest.config.ts](vitest.config.ts) aliases the whole `electron` module to
[test/electron-stub.ts](test/electron-stub.ts), and `electron-store` is `vi.mock`ed per test
file with an in-memory class. Consequently **only pure helpers are unit-tested** —
`parseDeviceList`, `friendlyFfmpegError`, `rms`, `pcmToWav`, the overlay's dock geometry
(`bottomCenterBounds` / `dockBounds` / `dockForPosition` / `magnetTarget`), the Gemini
prompt/parse/sanitize trio, `countWords`/`wordsPerMinute`, and
history ordering/cap.

The overlay tests are worth a note of their own, because they are the only place the *feel*
of a gesture is pinned down: `magnetTarget` is asserted to move the pill by no more than
`MAX_ASSIST_PX` at any distance, and to leave the vertical axis of a side dock strictly
alone. Both encode complaints ("it flew out of my hand", "it snaps back to the middle of the
screen") that are otherwise only reproducible by dragging a window with a mouse.

Two test files live in `src/` but cover code in `supabase/`, which is the only way to test
that code at all — Deno functions cannot be driven from vitest, but the *decisions* inside
them are pure and are extracted for exactly this purpose:
[prompt-drift.test.ts](src/main/stt/prompt-drift.test.ts) (the duplicated Gemini prompt) and
[payme-rules.test.ts](src/main/payme-rules.test.ts) (account parsing, the 12-hour boundary,
tiyin-vs-so'm, constant-time key comparison). Follow that pattern rather than leaving
payment logic untested because it happens to live in a Deno file. The endpoint as a whole is
verified by the Payme sandbox, which is not optional. Anything touching a real window, hook or device is verified by running
the app (`npm run dev:mock` covers the whole loop offline).

When adding logic that deserves a test, extract it as a pure exported function rather than
trying to stand up Electron.

## Release

`npm version patch && git push --follow-tags` →
[release.yml](.github/workflows/release.yml) builds and publishes, including the `latest.yml`
that `electron-updater` reads. `verifyUpdateCodeSignature: false` in
[electron-builder.yml](electron-builder.yml) is required while builds are unsigned; integrity
rests on the SHA-512 in `latest.yml` over TLS. `npmRebuild: false` is also required — both
native deps ship prebuilt N-API binaries, and rebuilding demands Visual Studio to produce
binaries that were already correct.

Before cutting a release, check that
[src/main/supabase-config.ts](src/main/supabase-config.ts) holds a real project URL and anon
key. Those two are **public by design** and belong in git — RLS is what protects the data, and
the anon key grants nothing but "read your own rows". Ship them empty and `isConfigured()` is
false, nobody can sign in or pay, and every dictation fails — there is no client-side
fallback any more.

`protocols:` in [electron-builder.yml](electron-builder.yml) is what registers the
`gapirme://` scheme with the installer. Without it sign-in works perfectly in dev — where
`registerProtocol()` claims the scheme at runtime — and silently does nothing on a packaged
build, which is the worst possible place for that gap.

**The backend is deployed separately from the app.** A change under `supabase/` reaches users
through `supabase db push` / `supabase functions deploy`, not through a release; a released
build talks to whatever is deployed. That decoupling is mostly a gift — the model, the price
and the daily limits all change without a release — but it means a breaking change to the
Edge Function's request shape strands every installed copy until they update.

The `repository` field in `package.json` is what electron-builder and electron-updater infer
owner and repo from, so it has to match the repo the releases actually live in.
