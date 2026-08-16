# gapir.me — Design Guide (design.md)

**gapir.me** is Uzbek voice-to-text for the desktop. Press a global hotkey anywhere, speak Uzbek, and the text lands where your cursor is. The brand is warm, human, hand-made — not a tech tool. It behaves like a person, not an API.

> **Scope: this guide governs the gapir.me website and marketing surfaces.** The shipped app
> follows the same palette and type system but diverges from three rules below, deliberately —
> do not "fix" these in the app on the strength of this document:
>
> - **The pill's thinking state is a 12-spoke stepped spinner**, not the wave — a deliberate
>   Wispr-reference choice, documented in `src/renderer/overlay/index.html`. §8's "never a
>   spinner" applies to the website.
> - **App copy and the transcription prompt use the ASCII apostrophe** (`o'zbek`), not U+02BB —
>   the prompt in `gemini-common.ts` standardises on ASCII so a user's history stays
>   searchable, and the app's strings match it. §3's U+02BB rule applies to the website.
> - **Caveat (handwriting) is not bundled in the app** — the app ships Figtree, EB Garamond
>   and Geist Mono only (`src/renderer/fonts/fonts.css`). Caveat asides are a website device.

---

## 1. Brand principles

1. **Two colors, zero effects.** Deep burgundy ink on warm cream. No third color, no gradients, no glow, no glassmorphism.
2. **Light-first.** Cream owns ~90% of every screen. Ink is the accent: type, hairlines, icon strokes, the logo, and **at most one filled block per screen**.
3. **One continuous line.** The logo is a line-drawn mouth whose teeth read as a wave. Everything follows: outline-only icons at one weight, line-drawn illustration, rounded corners everywhere.
4. **The "hand" lives in the illustration layer**, not the type. UI type is clean and geometric; handwriting (Caveat) appears at most once per screen as a small aside.
5. **Calm, competent, local.** Aesop's restraint with a Tashkent voice. Never sells "AI"; it describes what happens.

---

## 2. Color

Only two brand colors. Everything else is a mix of them.

| Token | Value | Role |
|---|---|---|
| `--gapir-cream` / `--base` | `#FFEEE0` | Base — page, surfaces, cards (~90% of every screen) |
| `--gapir-ink` / `--accent` | `#590222` | Accent — type, strokes, icons, one solid CTA |

Contrast: 12.74:1 — AAA at any size.

**Ink ramp** (mixes of the two): `--ink-900 #3A0116` · `--ink-800 #590222` · `--ink-600 #72253E` · `--ink-400 #8B495B` · `--ink-300 #A46C78` · `--ink-200 #BD9094` · `--line #EBD2C9` · `--surface #F7E2D6`.

**Functional color** (meaning only, desaturated): `--live #C3123F` (recording) · `--success #3F6B4F` · `--error #A8321E`.

**Rules:**
- Never two ink-filled blocks on one view. Never an ink page background in light mode.
- No third brand color, ever.
- The only tonal shift allowed is a `--surface` band fenced by hairlines.

**Dark mode is required** (`[data-theme="dark"]`) — the app floats over dark IDEs at midnight. Brand color inverts to cream; burgundy survives only as the near-black background `--night #1E060E` (`--cream:#1E060E`, `--surface:#2A0A14`, `--line:#3A1620`, text ramp flips to cream).

---

## 3. Typography

| Token | Family | Use |
|---|---|---|
| `--font-display` | EB Garamond 500 (600 for small in-row labels) | Hero, page titles, numbers (lining + tabular) — an old-style serif, `size-adjust: 110%` in fonts.css compensates its small x-height |
| `--font-ui` | Figtree 300–900 (variable) | Everything else — the website's body face. Onest stays behind it in the stack for Cyrillic only; Figtree has no Cyrillic glyphs |
| `--font-mono` | Geist Mono | Sparse technical accents — file paths, the hotkey. Never body text |

**Scale (size / line-height):**
display 56/1.05 · h1 36/1.15 · h2 26/1.25 · h3 19/1.35 · body 16/1.6 · small 14/1.5 · micro 12/1.4 (UPPERCASE, +0.08em tracking) · **transcript 18/1.75** — the most generous line-height in the system, because the transcript *is* the product.

Prose measure caps at `--measure-prose: 680px`.

**Casing:** sentence case everywhere. Only the 12px micro label is uppercase (`HOTKEY`, `TIL`).

**Uzbek coverage test** every string must pass: `Oʻzbek tilida gapiring — gʻalati, qiziq, ҳақиқий`. The apostrophe is **U+02BB (ʻ)** — never `'` or `’`.

---

## 4. Spacing & layout

8px base scale: `4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96` (`--s-1`…`--s-9`).

Whitespace is the luxury signal — default to more padding than feels necessary. Cards 24px in; sections 48–96px apart.

**App layout:** 52px title bar (hairline bottom) · 212px sidebar (hairline right) · scrolling content · the dictation overlay is the only fixed/floating layer, bottom-centred.
**Web layout:** sticky hairline header · 1080px max content · 680px max prose · single column below ~900px. Nothing else fixed or sticky.

---

## 5. Shape, borders, elevation

- **Radii:** `--r-sm 8` · `--r-md 14` (inputs) · `--r-lg 24` (cards, panels) · `--r-pill 999` (buttons, toggles, chips). Nothing is sharp — the logo has no corners.
- **Separation is a 1px `--line` hairline.** That's the device; not shadows.
- **One shadow exists:** `--shadow-float: 0 8px 32px rgba(89,2,34,0.08)` — reserved for a genuinely floating panel (the dictation overlay). Never on cards, never on hover, never stacked.
- **Transparency/blur exactly once:** the overlay scrim `rgba(89,2,34,0.10)` + `blur(2px)`.
- **Backgrounds:** flat `--cream`. No photography, gradients, patterns, grain, or noise.

**Cards:** `--surface` fill · 1px `--line` · 24px radius · 24px padding · no shadow. Interactive cards darken the hairline to `--ink-400` on hover; nothing lifts or scales.

---

## 6. Components

- **Button** — pill shape. `primary`: `--surface` fill, 1.5px ink border, ink text. `solid`: heavy ink fill, **at most once per screen** (the single most important action). Plus `secondary` / `ghost`.
- **IconButton** — circular, icon-only, derived from Button variants.
- **Input** — 14px radius, hairline border.
- **Card** — as above.
- **Waveform / WaveformDivider / RecordingIndicator** — the signature element (see §8).
- **Logo / Icon / MarginNote** — brand layer.

**States (color only — no motion, no opacity):**
- Hover: primary → `--line` fill; solid → `--ink-900`; secondary/ghost → `--surface` fill; links underline.
- Press: same deepest ink — no shrink, no scale, no translate.
- Focus: 2px `--gapir-ink` ring at 2px offset — never removed.
- Disabled: `--line` fill with `--ink-300` text (or hairline outline). Opacity is never used to signal state.

---

## 7. Iconography

- **Lucide, outline only.** 1.75px stroke at 24px, rounded caps and joins, no fills. No filled icon set may be mixed in.
- Emphasis = change the **color**, never the fill.
- Sizes: 16 (inline) · 18 (button labels) · 20 (icon buttons) · 24 (feature/marketing). Default color `--icon-default` (`--ink-600`); disabled `--ink-200`.
- **Emoji: never.** Unicode only as quiet furniture: `·` separators, `↓ ← →` beside a Caveat note, `▌` typing caret, `⌘ ⇧` hotkeys.
- **The logo is not an icon** — use at ≥40px height, on cream or `--surface` only.

---

## 8. Signature element — the waveform

One continuous line of vertical risers joined by **fully rounded turns** at varying heights — a square wave with every corner rounded to the full radius each column allows. Uniform stroke, rounded caps. Never filled bars, never a plain sine, never hard 90° corners.

Reused as a system: live recording meter · progress fill · section divider · flat-line empty state that springs to life on interaction. **Loading is always the wave animating** — never a spinner, never three dots.

---

## 9. Motion

- 180–240ms, `cubic-bezier(0.32, 0.72, 0, 1)`. No bounce, no spring overshoot, no long fades.
- **One orchestrated moment:** on transcription, text types in word by word at natural speech pace. Everything else holds still.
- `prefers-reduced-motion`: waveform freezes to static amplitude, typing becomes instant.

---

## 10. Voice & copy

- **Uzbek Latin first.** Product copy is authored in Uzbek, then translated — never the reverse.
- **Second person** to the user (*gapiring, bosing*); the product describes itself in third person, plainly (*"gapir.me yozib beradi"*) — never "we", never "I".
- **Verbs, not nouns:** `Yozib olish`, not `Yozib olish jarayonini boshlash`.
- **Consistency rule:** whatever the button says, the result says the same word. `Yozib olish` → `Yozib olinmoqda` → `Yozuv`. Never synonyms.
- **Errors:** problem + fix, one sentence, no apology, no exclamation mark. `Ruxsat berilmagan — tizim sozlamalarida mikrofonni yoqing.`
- **Empty states** invite action and are the one place the voice softens: `Hali yozuv yoʻq` + short instruction + at most one Caveat aside (`shu yerga gapiring ↓`).
- **Numbers** concrete and small: `18 soniya · 42 soʻz`. Middot separators, lining tabular numerals in EB Garamond.

---

## 11. Illustration & imagery

- Single-continuous-line drawings at the logo's stroke weight, ink on cream. Subjects from the product's world: a mouth, an ear, a hand holding a phone, a keyboard, a person at a desk.
- Never 3D, never isometric stock, never gradient mesh. Rule of thumb: if it could appear on any SaaS landing page, delete it.
- No photography in the system. If ever introduced: warm, low-contrast, slightly desaturated, duotoned toward the ink. Cool/blue/clinical imagery is off-brand.

---

## 12. Do / Don't

**Do**
- Cream base, ink accent, one solid block max per screen
- Hairlines for separation, whitespace for hierarchy
- Sentence case, Uzbek-first copy, U+02BB apostrophe
- Waveform for loading, progress, dividers
- Pill buttons, 24px card radius, focus ring always visible

**Don't**
- Third color, gradients, shadows on cards, glassmorphism
- Emoji, spinners, three-dot loaders
- Script/handwriting UI fonts, Inter, uppercase headings
- Scale/translate on hover or press; opacity for disabled
- The mark as a favicon-crop or inside buttons
