/**
 * Cookie-backed visitor identity for Kubit web surfaces.
 *
 * Owns the two identity primitives every Kubit-instrumented web app shares:
 *
 *   - `user.anonymous_id` — persistent ~365d cookie, minted ONCE and reused
 *     for the cookie's lifetime so the anonymous→registered funnel resolves
 *     to a single identity. Optionally upgradeable to a device fingerprint
 *     via `seedAnonymousId` (only while the id is fresh — an established
 *     identity is never re-fingerprinted).
 *   - `session.id` — 30-minute HARD-CLOCK session (measured from when the
 *     session STARTED, not an inactivity timeout), stored as a cookie holding
 *     JSON `{ id, start }`. Sessions begin only on explicit `startSession*`
 *     calls (an auth event); a plain read NEVER seeds one. Once the window
 *     elapses, the next read mints a fresh random id.
 *
 * Both cookies are scoped to the registrable `.kubit.ai` domain on any
 * `*.kubit.ai` host, so the SAME identity is visible to every sibling
 * subdomain (marketing site, app, docs) and across tabs. On any other host
 * (localhost, previews, third-party deployments) they fall back to host-only
 * cookies.
 *
 * `getIdentityAttributes()` returns the canonical flat attribute names
 * (`session.id`, `user.anonymous_id`) — the SDK owns this naming so every
 * emitter (web SDK today, mobile SDKs later) lands on the same keys.
 *
 * Consumers that attach the ids to their own transport (e.g. request headers)
 * read them via `getSessionId()` / `getAnonymousId()`.
 *
 * All functions are safe in non-browser contexts (SSR, Node tests without a
 * DOM): they degrade to `''` / no-ops instead of throwing. An analytics id
 * must never break the flow it rides on.
 */

// Cookie names are a wire contract with already-deployed Kubit surfaces —
// do not rename.
const SESSION_ID_COOKIE = "kubit_session_id";
const ANONYMOUS_ID_COOKIE = "kubit_anonymous_id";

const ONE_YEAR_S = 365 * 24 * 60 * 60;

/** Hard cap per session, measured from `start`. */
const SESSION_WINDOW_MS = 30 * 60 * 1000;

/**
 * `crypto.randomUUID` exists ONLY in secure contexts (https + localhost); on
 * plain-http hosts it is undefined and a bare call would throw. Fall back to
 * a non-crypto id — acceptable for a correlation-only identifier.
 */
const safeUuid = (): string => {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to the non-crypto id
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

/**
 * Derive the registrable cookie domain from the deployment host: `.kubit.ai`
 * for every `*.kubit.ai` host (shared with sibling subdomains), `''`
 * (host-only cookie) for anything else.
 */
export const getRegistrableCookieDomain = (hostname: string): string =>
  hostname === "kubit.ai" || hostname.endsWith(".kubit.ai") ? ".kubit.ai" : "";

const hasDom = (): boolean =>
  typeof document !== "undefined" && typeof window !== "undefined";

const setCookie = (name: string, value: string, maxAgeS: number = ONE_YEAR_S): void => {
  if (!hasDom()) {
    return;
  }
  try {
    const domain = getRegistrableCookieDomain(window.location.hostname);
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie =
      `${name}=${encodeURIComponent(value)}; Max-Age=${maxAgeS}; Path=/` +
      (domain ? `; Domain=${domain}` : "") +
      `; SameSite=Lax${secure}`;
  } catch {
    // cookie write blocked (sandboxed context) — identity degrades gracefully
  }
};

const getCookie = (name: string): string => {
  if (!hasDom()) {
    return "";
  }
  try {
    // Split-scan rather than a RegExp built from `name` — an unescaped name
    // containing metacharacters would match the wrong cookie or throw. The
    // trailing `=` guards against prefix collisions.
    const target = `${name}=`;
    for (const pair of document.cookie.split(";")) {
      const trimmed = pair.trimStart();
      if (trimmed.startsWith(target)) {
        return decodeURIComponent(trimmed.slice(target.length));
      }
    }
  } catch {
    // unreadable cookie jar — treat as absent
  }
  return "";
};

const deleteCookie = (name: string): void => {
  // Re-issue with Max-Age=0 and the same Domain so the browser drops it.
  setCookie(name, "", 0);
};

// ---------------------------------------------------------------------------
// anonymous id — mint-once-reuse
// ---------------------------------------------------------------------------

// Tracks an anonymous id minted during THIS page load, so the async
// fingerprint bootstrap can distinguish "fresh id we just created" (safe to
// upgrade in place) from "identity the visitor arrived with" (never touched).
// Synchronous callers (boot requests, first spans) can't wait for an async
// fingerprint, so the first mint is always a UUID; the fingerprint then
// upgrades it before it has aged past this page load.
let mintedThisLoadId: string | null = null;

/**
 * The visitor's anonymous id. Mints (and persists) a UUID on first call;
 * every later call returns the stored value unchanged — including across
 * login/logout, so account switching never changes the device identity.
 * Returns `''` only when cookies are unavailable entirely.
 */
export const getAnonymousId = (): string => {
  try {
    const existing = getCookie(ANONYMOUS_ID_COOKIE);
    if (existing) {
      return existing;
    }
    if (!hasDom()) {
      return "";
    }
    const id = safeUuid();
    setCookie(ANONYMOUS_ID_COOKIE, id);
    mintedThisLoadId = id;
    return id;
  } catch {
    return "";
  }
};

/**
 * True when the anonymous-id cookie exists AND was NOT minted during this
 * page load — i.e. the visitor arrived with an established identity that a
 * fingerprint bootstrap must never touch. Lets callers skip the fingerprint
 * download entirely for returning visitors.
 */
export const hasEstablishedAnonymousId = (): boolean => {
  try {
    const existing = getCookie(ANONYMOUS_ID_COOKIE);
    return existing !== "" && existing !== mintedThisLoadId;
  } catch {
    return false;
  }
};

/**
 * Upgrade the anonymous id to a device-derived id (e.g. a FingerprintJS
 * visitorId) — but ONLY while the current cookie is absent or was minted
 * during this page load. A pre-existing cookie is a strict no-op: an
 * established identity is never re-fingerprinted. Returns whether the id was
 * actually replaced, so callers can re-publish any mirrors (tags, headers).
 */
export const upgradeAnonymousId = (visitorId: string): boolean => {
  try {
    if (!visitorId || !hasDom()) {
      return false;
    }
    const existing = getCookie(ANONYMOUS_ID_COOKIE);
    if (existing && existing !== mintedThisLoadId) {
      return false;
    }
    setCookie(ANONYMOUS_ID_COOKIE, visitorId);
    mintedThisLoadId = null;
    return true;
  } catch {
    return false;
  }
};

/**
 * Async anonymous-id seeding bootstrap. For first-time visitors, resolves a
 * device id from `provider` (e.g. a lazy FingerprintJS load) and upgrades the
 * cookie; for returning visitors it returns immediately WITHOUT calling the
 * provider, so an expensive fingerprint library is never even downloaded.
 * Resolves to whether the id was replaced. Never rejects.
 */
export const seedAnonymousId = async (
  provider: () => Promise<string>,
): Promise<boolean> => {
  try {
    if (hasEstablishedAnonymousId()) {
      return false;
    }
    const visitorId = await provider();
    return upgradeAnonymousId(visitorId);
  } catch {
    // provider failed — identity stays on the minted UUID
    return false;
  }
};

// ---------------------------------------------------------------------------
// session id — explicit start, 30-min hard-clock roll, read-never-seeds
// ---------------------------------------------------------------------------

interface StoredSession {
  id: string;
  start: number;
}

const readStoredSession = (): StoredSession | null => {
  const raw = getCookie(SESSION_ID_COOKIE);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.id === "string" &&
      typeof parsed.start === "number"
    ) {
      return { id: parsed.id, start: parsed.start };
    }
  } catch {
    // malformed JSON — treat as no session
  }
  return null;
};

const writeSession = (id: string): string => {
  setCookie(SESSION_ID_COOKIE, JSON.stringify({ id, start: Date.now() }));
  return id;
};

/**
 * Start (or replace) the session with the given id — call on auth events
 * (login, token refresh). Omitting `id` mints a random one. Returns the id.
 */
export const startSession = (id?: string): string => {
  try {
    if (!hasDom()) {
      return "";
    }
    return writeSession(id && id.length > 0 ? id : safeUuid());
  } catch {
    return "";
  }
};

/**
 * One-way SHA-256 hex digest. The input is never stored — only the digest.
 * Falls back to a random id when `crypto.subtle` is unavailable (plain-http
 * contexts) or the digest fails; never throws.
 */
const sha256Hex = async (input: string): Promise<string> => {
  try {
    if (typeof crypto === "undefined" || !crypto.subtle) {
      return safeUuid();
    }
    const bytes = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return safeUuid();
  }
};

/**
 * Start (or replace) the session with the SHA-256 hex of an auth token, so
 * the opening session of an authenticated visit is tied to a known identity
 * WITHOUT ever storing the raw token. An empty token starts a random session
 * (never a constant hash of `''`). Never rejects — resolves to `''` when no
 * session could be written.
 */
export const startSessionFromToken = async (accessToken: string): Promise<string> => {
  try {
    const id = accessToken ? await sha256Hex(accessToken) : safeUuid();
    return startSession(id);
  } catch {
    return "";
  }
};

/**
 * Read the current session id. SYNCHRONOUS — safe to call on hot paths
 * (event pipelines, request interceptors). Within the 30-minute window it
 * returns the stored id; once the window has elapsed it mints a fresh RANDOM
 * id in place (the hard-clock roll). Returns `''` when no session exists —
 * a read never seeds a session; only `startSession*` does.
 */
export const getSessionId = (): string => {
  try {
    const stored = readStoredSession();
    if (stored === null) {
      return "";
    }
    if (Date.now() - stored.start < SESSION_WINDOW_MS) {
      return stored.id;
    }
    return writeSession(safeUuid());
  } catch {
    return "";
  }
};

/** Drop the session (call on logout). */
export const clearSession = (): void => {
  try {
    deleteCookie(SESSION_ID_COOKIE);
  } catch {
    // cookie delete blocked — nothing to clean up
  }
};

// ---------------------------------------------------------------------------
// canonical attribute names
// ---------------------------------------------------------------------------

/**
 * The identity attributes under their canonical flat names — `session.id`
 * and `user.anonymous_id`. Only present values are included (no empty
 * strings), so the result can be spread directly onto span/event attributes.
 */
export const getIdentityAttributes = (): Record<string, string> => {
  const attributes: Record<string, string> = {};
  const sessionId = getSessionId();
  if (sessionId) {
    attributes["session.id"] = sessionId;
  }
  const anonymousId = getAnonymousId();
  if (anonymousId) {
    attributes["user.anonymous_id"] = anonymousId;
  }
  return attributes;
};

/** Test-only surface: reset the per-page-load mint tracking. */
export const visibleForTesting = {
  SESSION_ID_COOKIE,
  ANONYMOUS_ID_COOKIE,
  resetMintedThisLoad: (): void => {
    mintedThisLoadId = null;
  },
};
