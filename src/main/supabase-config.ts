/**
 * Where the backend is, and the key used to reach it.
 *
 * **These two values are public by design, and committing them is correct.** That is worth
 * stating plainly, because this repo spent its whole life so far treating an embedded key as
 * a liability (see the note at the top of src/main/keys.ts). The Supabase `anon` key is a
 * different kind of thing: it identifies the project, not a user, and grants exactly what the
 * row-level-security policies in supabase/migrations/0001_init.sql allow — which is "read
 * your own rows". Extracting it from an installer buys an attacker nothing.
 *
 * The `service_role` key is the opposite and must never appear in this repo, in an installer,
 * or in a renderer. It lives in Supabase's own secret store and is read only by Edge
 * Functions.
 *
 * The environment overrides exist so a developer can point a dev build at a staging project
 * without editing a tracked file. A packaged build has no environment to read, so what ships
 * is always the constants below.
 */

/** Filled in from the live project (Phase 1 of docs/supabase-setup.md is done). */
const DEFAULT_URL = 'https://saqiwlwpazoctfswpabz.supabase.co';
const DEFAULT_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNhcWl3bHdwYXpvY3Rmc3dwYWJ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY4MTYwMTMsImV4cCI6MjEwMjM5MjAxM30.3kdKhsWnCnhWrZDPSd-RtAwSvBhW0fU2CWLEJ_Vcj8k';

export const SUPABASE_URL = (process.env.SUPABASE_URL || DEFAULT_URL).replace(/\/+$/, '');
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || DEFAULT_ANON_KEY;

/**
 * The custom scheme the sign-in comes back on.
 *
 * Google never sees it: Google redirects to Supabase's own https callback, Supabase
 * redirects to the web page below, and that page hands the code to this app through the
 * scheme. The installer registers the handler (see `protocols` in electron-builder.yml);
 * `completeSignIn()` accepts URLs on this scheme and no other.
 */
export const AUTH_PROTOCOL = 'gapirme';

/** What the browser opens to reach us. */
export const APP_CALLBACK = `${AUTH_PROTOCOL}://auth-callback`;

/**
 * Where Supabase sends the browser when the consent is done.
 *
 * A page on our own site rather than the `gapirme://` link directly, and the extra hop is
 * the difference between a sign-in that *looks* finished and one that leaves the user
 * staring at a blank tab with a permission dialog over it. The page says "you are signed
 * in, you can close this", and carries a button that opens the app — which matters, because
 * a browser treats a deliberate click on a custom scheme far more kindly than a navigation
 * fired from a script. Its source is in the website repo, at src/app/auth/callback.
 *
 * **This address must be in the project's redirect allowlist** (Authentication → URL
 * Configuration → Redirect URLs, and `additional_redirect_urls` in supabase/config.toml).
 * If it is not, Supabase quietly falls back to the project's `site_url` — which is
 * `gapirme://auth-callback`, so sign-in still completes, just without the page. That is a
 * soft failure by luck rather than by design; list the URL.
 *
 * www, not the apex: gapir.me answers with a 308 to www.gapir.me, and a redirect chain is
 * one more thing that can drop a query string.
 */
export const AUTH_REDIRECT =
  process.env.WHISPER_UZ_AUTH_REDIRECT || 'https://www.gapir.me/auth/callback';

export const TRANSCRIBE_URL = `${SUPABASE_URL}/functions/v1/transcribe`;

/** False when the app was built without a backend — every account path shows this rather than
 *  failing with a confusing network error. */
export function isConfigured(): boolean {
  return SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0;
}
