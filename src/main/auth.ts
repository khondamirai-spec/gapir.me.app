import { join } from 'node:path';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { app, safeStorage, shell } from 'electron';
import WebSocket from 'ws';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { WebSocketLikeConstructor } from '@supabase/realtime-js';
import type { AccountState, AuthUser, PlanSnapshot } from '@shared/types';
import {
  AUTH_REDIRECT,
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
  isConfigured
} from './supabase-config';

/**
 * Google sign-in, and the session it produces.
 *
 * A leaf module: it knows nothing about dictation, the overlay or the tray, and nothing knows
 * about it except src/main/state.ts (which needs a token) and src/main/index.ts (which wires
 * the IPC and the deep link). That is the same rule every other module in src/main follows —
 * state.ts is the only coordinator.
 *
 * ## Why the browser, and not a BrowserWindow
 *
 * Google refuses OAuth in an embedded webview, and it is right to: a window the app controls
 * can read what the user types into it, so a consent screen shown there proves nothing. The
 * flow is therefore: open the system browser, let the user sign in somewhere we cannot touch,
 * and get the result back through a `gapirme://` deep link.
 *
 * PKCE rather than the implicit flow, because the answer comes back as `?code=` in the query
 * string. The implicit flow returns `#access_token=` in the fragment, and a fragment is
 * exactly the part of a URL that things along the way are entitled to drop.
 */

/** The session file. Not settings.json, and that distinction is the point — see below. */
const SESSION_FILE = 'auth.json';

function sessionPath(): string {
  return join(app.getPath('userData'), SESSION_FILE);
}

/**
 * Supabase's session store, on disk, encrypted.
 *
 * **A refresh token is a credential, and settings.json is documented as plaintext** (see the
 * header of src/main/config.ts, and `dropLegacyKeys()` which exists precisely because
 * credentials were once written there). So this goes in its own file, through Electron's
 * safeStorage — DPAPI on Windows, which ties the ciphertext to the user account.
 *
 * The plaintext fallback is deliberate rather than lazy: safeStorage can be unavailable, and
 * refusing to sign in at all would be a worse answer than signing in with a warning. It is
 * loud in the log so that a support conversation can find it.
 *
 * supabase-js also keeps the PKCE code verifier here between opening the browser and the
 * callback arriving, which is why the store is a key-value map rather than one session blob.
 */
function readStore(): Record<string, string> {
  const path = sessionPath();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path);
    const text = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8');
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch (err) {
    // A store we can't read is a session we can't use; the user signs in again. Deleting it
    // beats throwing on every startup — most often this is a machine where DPAPI keys changed.
    console.warn('[auth] session store unreadable, discarding:', err instanceof Error ? err.message : err);
    try {
      unlinkSync(path);
    } catch {
      /* nothing more to do */
    }
    return {};
  }
}

function writeStore(store: Record<string, string>): void {
  const text = JSON.stringify(store);
  try {
    if (safeStorage.isEncryptionAvailable()) {
      writeFileSync(sessionPath(), safeStorage.encryptString(text));
    } else {
      console.warn('[auth] safeStorage unavailable — the session will be stored in plain text');
      writeFileSync(sessionPath(), text, 'utf8');
    }
  } catch (err) {
    // Losing the session costs a re-login, not a dictation. Never let it break the app.
    console.error('[auth] could not write the session store:', err instanceof Error ? err.message : err);
  }
}

const fileStorage = {
  getItem(key: string): string | null {
    return readStore()[key] ?? null;
  },
  setItem(key: string, value: string): void {
    const store = readStore();
    store[key] = value;
    writeStore(store);
  },
  removeItem(key: string): void {
    const store = readStore();
    delete store[key];
    writeStore(store);
  }
};

let client: SupabaseClient | null = null;

/**
 * Created lazily because `app.getPath('userData')` is only meaningful once Electron is ready,
 * and this module is imported at the top of the bootstrap.
 */
function supabase(): SupabaseClient {
  if (client) return client;
  client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      // `?code=` in the query string rather than `#access_token=` in the fragment. See above.
      flowType: 'pkce',
      persistSession: true,
      // supabase-js keeps the access token fresh on a timer of its own, which is what makes
      // the token usable at hotkey-press time without a round trip first.
      autoRefreshToken: true,
      // There is no URL to detect a session in — this is a Node process, and reaching for
      // window.location is how supabase-js crashes outside a browser.
      detectSessionInUrl: false,
      storage: fileStorage,
      storageKey: 'gapir-me-session'
    },
    // This app never opens a realtime channel, but supabase-js constructs its RealtimeClient
    // regardless, and that constructor probes for a WebSocket implementation. Electron 33
    // embeds Node 20, which has no native WebSocket, so the probe leaves an unhandled
    // rejection ("native WebSocket not found") in main.log on every launch — noise in the one
    // file a remote user can send us. Hand it `ws`, already a dependency for the Gemini Live
    // socket, and the probe never runs. The cast bridges a typing mismatch only — ws's
    // constructor declares an internal-use `new (address: null)` overload the interface
    // doesn't; at runtime the two are compatible.
    realtime: { transport: WebSocket as unknown as WebSocketLikeConstructor }
  });
  return client;
}

// ------------------------------------------------------------------ state

let state: AccountState = { user: null, plan: null, error: '' };
const listeners = new Set<(state: AccountState) => void>();

export function accountState(): AccountState {
  return state;
}

/** Subscribe to sign-in, sign-out and plan changes. Returns an unsubscribe function. */
export function onAccountChanged(cb: (state: AccountState) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function emit(patch: Partial<AccountState>): void {
  state = { ...state, ...patch };
  for (const cb of listeners) cb(state);
}

function toUser(raw: {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
}): AuthUser {
  const meta = raw.user_metadata ?? {};
  const name = typeof meta.full_name === 'string' ? meta.full_name
    : typeof meta.name === 'string' ? meta.name
    : '';
  // The profile picture URL Google also sends is deliberately dropped rather than carried and
  // ignored: the app window's CSP is `default-src 'self'`, so it could never be drawn without
  // widening the policy — and the Hisob pane shows initials instead. See .acc-avatar.
  return { id: raw.id, email: raw.email ?? '', name };
}

// ------------------------------------------------------------------ plan

/**
 * Ask the server what this user is entitled to.
 *
 * `account_snapshot()` takes no arguments on purpose — it reads `auth.uid()` from the JWT, so
 * there is no user id for a modified client to substitute. See the note on it in
 * supabase/migrations/0001_init.sql.
 */
export async function refreshPlan(): Promise<PlanSnapshot | null> {
  if (!state.user) return null;
  try {
    const { data, error } = await supabase().rpc('account_snapshot');
    if (error) throw new Error(error.message);
    const raw = (data ?? {}) as Record<string, unknown>;
    const plan: PlanSnapshot = {
      plan: raw.plan === 'pro' ? 'pro' : 'free',
      used: Number(raw.used ?? 0),
      limit: Number(raw.limit ?? 0),
      expiresAt: typeof raw.expires_at === 'string' ? raw.expires_at : null,
      priceTiyin: Number(raw.price_tiyin ?? 0)
    };
    emit({ plan, error: '' });
    return plan;
  } catch (err) {
    console.warn('[auth] could not read the plan:', err instanceof Error ? err.message : err);
    // Deliberately not an error state: a plan we couldn't fetch must not look like a plan the
    // user doesn't have. The dictation path asks the server anyway, which is authoritative.
    return state.plan;
  }
}

/**
 * Told by the dictation path what the server just said, so the Hisob pane counts up as you
 * speak instead of only when the window is opened.
 */
export function notePlanUsage(plan: 'free' | 'pro', used: number, limit: number): void {
  if (!state.plan) {
    emit({ plan: { plan, used, limit, expiresAt: null, priceTiyin: 0 } });
    return;
  }
  emit({ plan: { ...state.plan, plan, used, limit } });
}

// ------------------------------------------------------------------ session

/** Restore a session from disk, if there is one. Called once at startup. */
export async function initAuth(): Promise<void> {
  if (!isConfigured()) {
    console.warn('[auth] no Supabase project configured — see src/main/supabase-config.ts');
    return;
  }

  supabase().auth.onAuthStateChange((event, session) => {
    if (session?.user) {
      emit({ user: toUser(session.user), error: '' });
      // A token refresh doesn't change the plan, so only fetch on a real sign-in.
      if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') void refreshPlan();
    } else {
      emit({ user: null, plan: null });
    }
  });

  try {
    const { data } = await supabase().auth.getSession();
    if (data.session?.user) {
      console.log('[auth] restored a session for', data.session.user.email);
    }
  } catch (err) {
    console.warn('[auth] could not restore a session:', err instanceof Error ? err.message : err);
  }
}

/**
 * The access token for the current session, refreshing it if it is close to expiry.
 *
 * `getSession()` rather than a cached field: supabase-js refreshes on a timer, and reading
 * through it is what makes the token that reaches the Edge Function the current one. Returns
 * '' when signed out, which the caller must treat as "do not dictate" rather than "try
 * anyway" — an unauthenticated request would be rejected after uploading the whole clip.
 */
export async function accessToken(): Promise<string> {
  if (!isConfigured()) return '';
  try {
    const { data, error } = await supabase().auth.getSession();
    if (error) throw new Error(error.message);
    return data.session?.access_token ?? '';
  } catch (err) {
    console.warn('[auth] could not get an access token:', err instanceof Error ? err.message : err);
    return '';
  }
}

/**
 * Force a refresh and hand back the new token.
 *
 * The proxy adapter calls this once on a 401 — a session can expire between the hotkey going
 * down and the upload finishing, and making the user say it all again for that would be a
 * poor trade for one extra round trip.
 */
export async function refreshToken(): Promise<string> {
  try {
    const { data, error } = await supabase().auth.refreshSession();
    if (error) throw new Error(error.message);
    return data.session?.access_token ?? '';
  } catch (err) {
    console.warn('[auth] refresh failed:', err instanceof Error ? err.message : err);
    return '';
  }
}

export function isSignedIn(): boolean {
  return state.user !== null;
}

// ------------------------------------------------------------------ sign in

/**
 * Start the sign-in.
 *
 * Resolves when the browser has been opened, **not** when the user is signed in — the result
 * arrives later through `completeSignIn()`. Anything waiting on this to mean "signed in" will
 * wait forever, which is why IPC.authSignIn is documented the same way.
 */
export async function signIn(): Promise<{ ok: boolean; error?: string }> {
  if (!isConfigured()) {
    return { ok: false, error: 'Ilova serverga ulanmagan — ilovani yangilang' };
  }
  try {
    const { data, error } = await supabase().auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: AUTH_REDIRECT,
        // We open the browser ourselves. Without this supabase-js tries to navigate a
        // `window` that does not exist in the main process.
        skipBrowserRedirect: true
      }
    });
    if (error) throw new Error(error.message);
    if (!data.url) throw new Error('no authorization url');

    await shell.openExternal(data.url);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[auth] sign-in could not start:', message);
    emit({ error: 'Kirishni boshlab bo‘lmadi — internetni tekshiring' });
    return { ok: false, error: message };
  }
}

/**
 * Finish the sign-in from the deep link the browser sent us.
 *
 * Called with the raw `gapirme://auth-callback?code=…` URL. Returns false for anything that
 * isn't a callback we recognise, so the caller can pass it every argv entry without filtering.
 */
export async function completeSignIn(rawUrl: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'gapirme:') return false;

  // Supabase reports a refused consent as ?error=access_denied rather than an absent code.
  const denied = url.searchParams.get('error');
  if (denied) {
    console.warn('[auth] sign-in was refused:', denied, url.searchParams.get('error_description') ?? '');
    emit({ error: denied === 'access_denied' ? '' : 'Kirish bekor qilindi' });
    return true;
  }

  const code = url.searchParams.get('code');
  if (!code) return false;

  try {
    const { data, error } = await supabase().auth.exchangeCodeForSession(code);
    if (error) throw new Error(error.message);
    if (!data.session?.user) throw new Error('no session returned');
    console.log('[auth] signed in as', data.session.user.email);
    emit({ user: toUser(data.session.user), error: '' });
    await refreshPlan();
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[auth] could not exchange the code:', message);
    emit({ error: 'Kirish yakunlanmadi — qaytadan urinib ko‘ring' });
    return true;
  }
}

export async function signOut(): Promise<void> {
  try {
    await supabase().auth.signOut();
  } catch (err) {
    console.warn('[auth] sign-out call failed:', err instanceof Error ? err.message : err);
  }
  // Clear locally regardless: a sign-out that fails on the network must still sign the person
  // out of their own machine, which is the half they asked for.
  try {
    if (existsSync(sessionPath())) unlinkSync(sessionPath());
  } catch (err) {
    console.warn('[auth] could not delete the session file:', err instanceof Error ? err.message : err);
  }
  emit({ user: null, plan: null, error: '' });
}

export const _internals = { readStore, writeStore, toUser };
