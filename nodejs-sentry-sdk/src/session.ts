/**
 * Session id management for behavior analytics.
 *
 * `createRollingSession` returns a provider — call it once per teed event to get
 * the current session id. A session keeps its id for a fixed window (default 30
 * min) measured from when it STARTED, regardless of activity: a hard clock cap,
 * not an inactivity timeout. When the window elapses the next call mints a fresh
 * id.
 *
 * The first session of a fresh visitor can be SEEDED via `initialId` (a string
 * or a lazy function) — e.g. a hashed access token — so the opening session is
 * tied to a known identity; every later window uses `generateId`. This is the
 * "one more layer" some apps want on top of the plain rolling default:
 *
 *     // Simple: plain 30-min rolling, random ids
 *     createRollingSession()
 *
 *     // Seeded: first window = a hashed identity, then roll to generated ids
 *     createRollingSession({ initialId: () => hashAccessToken(token) })
 *
 * Persisted to `localStorage` by default so the id survives page navigations;
 * pass `storage: null` for in-memory only (Node, or privacy-sensitive contexts).
 */

/** Minimal storage contract — a subset of the Web Storage API. */
export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface RollingSessionOptions {
  /** Hard cap per session, in ms. Default 1_800_000 (30 min). */
  windowMs?: number;
  /** Persistence key. Default "kubit-session". */
  storageKey?: string;
  /**
   * Id for the FIRST session of a fresh visitor (no persisted session yet). A
   * string, or a function evaluated once when that session starts. Every later
   * window uses `generateId` instead.
   */
  initialId?: string | (() => string);
  /** Id generator for every window after the first. Default: `crypto.randomUUID`. */
  generateId?: () => string;
  /**
   * Storage backend. Defaults to `localStorage` when available, else in-memory.
   * Pass `null` to force in-memory (no cross-reload persistence).
   */
  storage?: SessionStorageLike | null;
  /** Clock source — injectable for tests. Default `Date.now`. */
  now?: () => number;
}

/** Returns the current session id. Call once per event. */
export type SessionIdProvider = () => string;

interface StoredSession {
  id: string;
  start: number;
}

const DEFAULT_WINDOW_MS = 30 * 60 * 1000;
const DEFAULT_STORAGE_KEY = "kubit-session";

/** `localStorage` when present (browser); null in Node or sandboxed contexts. */
const getDefaultStorage = (): SessionStorageLike | null => {
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage;
    }
  } catch {
    // accessing localStorage can throw in sandboxed iframes
  }
  return null;
};

const defaultGenerateId = (): string => {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to the non-crypto id
  }
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

const resolveSeed = (seed: string | (() => string)): string => {
  try {
    const value = typeof seed === "function" ? seed() : seed;
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
};

const isLive = (
  saved: StoredSession | null,
  now: number,
  windowMs: number,
): saved is StoredSession =>
  saved !== null && saved.id.length > 0 && now - saved.start < windowMs;

export const createRollingSession = (
  options: RollingSessionOptions = {},
): SessionIdProvider => {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
  const generateId = options.generateId ?? defaultGenerateId;
  const now = options.now ?? (() => Date.now());
  const storage =
    options.storage === undefined ? getDefaultStorage() : options.storage;

  // In-memory mirror — authoritative within a page, backed by `storage` across
  // reloads / navigations.
  let memory: StoredSession | null = null;

  const read = (): StoredSession | null => {
    if (memory) {
      return memory;
    }
    if (!storage) {
      return null;
    }
    try {
      const raw = storage.getItem(storageKey);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed.id === "string" &&
        typeof parsed.start === "number"
      ) {
        return { id: parsed.id, start: parsed.start };
      }
    } catch {
      // unreadable / malformed — treat as no session
    }
    return null;
  };

  const write = (session: StoredSession): void => {
    memory = session;
    if (!storage) {
      return;
    }
    try {
      storage.setItem(storageKey, JSON.stringify(session));
    } catch {
      // storage full / unavailable — `memory` still holds the session
    }
  };

  return (): string => {
    const t = now();
    const saved = read();
    if (isLive(saved, t, windowMs)) {
      memory = saved;
      return saved.id;
    }
    // Mint a new session. A fresh visitor (no prior session at all) may be
    // seeded with `initialId`; every later window uses `generateId`.
    const seeded =
      saved === null && options.initialId !== undefined
        ? resolveSeed(options.initialId)
        : "";
    const id = seeded.length > 0 ? seeded : generateId();
    write({ id, start: t });
    return id;
  };
};
