import { describe, expect, it } from "vitest";
import { createRollingSession, type SessionStorageLike } from "../src/session";

const THIRTY_MIN = 30 * 60 * 1000;

/** In-memory storage stub implementing the Web Storage subset. */
const memoryStorage = (): SessionStorageLike => {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
};

/** A controllable clock + a deterministic, sequential id generator. */
const harness = (startMs = 1_000_000) => {
  let t = startMs;
  let counter = 0;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    generateId: () => `gen-${(counter += 1)}`,
  };
};

describe("createRollingSession — rolling cap", () => {
  it("keeps one id within the window, regardless of how often it's read", () => {
    const { now, generateId } = harness();
    const session = createRollingSession({ now, generateId, storage: null });

    const first = session();
    expect(first).toBe("gen-1");
    expect(session()).toBe("gen-1");
    expect(session()).toBe("gen-1");
  });

  it("mints a fresh id once the 30-min window elapses (hard cap, not inactivity)", () => {
    const h = harness();
    const session = createRollingSession({ now: h.now, generateId: h.generateId, storage: null });

    expect(session()).toBe("gen-1");
    h.advance(THIRTY_MIN - 1);
    expect(session()).toBe("gen-1"); // still inside the window
    h.advance(1); // now exactly at the cap
    expect(session()).toBe("gen-2");
  });

  it("honors a custom window", () => {
    const h = harness();
    const session = createRollingSession({
      now: h.now,
      generateId: h.generateId,
      storage: null,
      windowMs: 1000,
    });

    expect(session()).toBe("gen-1");
    h.advance(1000);
    expect(session()).toBe("gen-2");
  });
});

describe("createRollingSession — seeded first window", () => {
  it("uses initialId (string) for the first session, then generated ids after", () => {
    const h = harness();
    const session = createRollingSession({
      now: h.now,
      generateId: h.generateId,
      storage: null,
      initialId: "hashed-token",
    });

    expect(session()).toBe("hashed-token"); // first window = seed
    h.advance(THIRTY_MIN);
    expect(session()).toBe("gen-1"); // later windows = generated, NOT the seed
    h.advance(THIRTY_MIN);
    expect(session()).toBe("gen-2");
  });

  it("evaluates a function initialId (Vega's hash(token) layer)", () => {
    const h = harness();
    let token = "abc";
    const session = createRollingSession({
      now: h.now,
      generateId: h.generateId,
      storage: null,
      initialId: () => `hash:${token}`,
    });

    token = "xyz"; // mutated before first read — lazy evaluation captures this
    expect(session()).toBe("hash:xyz");
  });

  it("falls back to a generated id when the seed resolves empty", () => {
    const h = harness();
    const session = createRollingSession({
      now: h.now,
      generateId: h.generateId,
      storage: null,
      initialId: () => "",
    });

    expect(session()).toBe("gen-1");
  });
});

describe("createRollingSession — persistence", () => {
  it("continues an in-window session across instances sharing storage (page reload)", () => {
    const h = harness();
    const storage = memoryStorage();

    const a = createRollingSession({ now: h.now, generateId: h.generateId, storage, initialId: "seed" });
    expect(a()).toBe("seed");

    // New instance (fresh page) reading the same storage continues the session.
    const b = createRollingSession({ now: h.now, generateId: h.generateId, storage });
    expect(b()).toBe("seed");

    // ...and rolls once the window passes — no re-seed (a session already existed).
    h.advance(THIRTY_MIN);
    expect(b()).toBe("gen-1");
  });

  it("treats malformed stored JSON as no session", () => {
    const h = harness();
    const storage: SessionStorageLike = {
      getItem: () => "{not-json",
      setItem: () => undefined,
    };
    const session = createRollingSession({
      now: h.now,
      generateId: h.generateId,
      storage,
      initialId: "seed",
    });

    expect(session()).toBe("seed");
  });
});

describe("createRollingSession — defaults", () => {
  it("returns a stable, non-empty id with zero options", () => {
    const h = harness();
    const session = createRollingSession({ now: h.now });

    const id = session();
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
    expect(session()).toBe(id); // stable within the window
  });
});
