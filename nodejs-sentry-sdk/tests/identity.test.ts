import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSession,
  getAnonymousId,
  getIdentityAttributes,
  getRegistrableCookieDomain,
  getSessionId,
  hasEstablishedAnonymousId,
  seedAnonymousId,
  startSession,
  startSessionFromToken,
  upgradeAnonymousId,
  visibleForTesting,
} from "../src/identity";

const THIRTY_MIN = 30 * 60 * 1000;

/**
 * Minimal cookie-jar fake implementing the `document.cookie` read/write
 * contract the module relies on: writes are `name=value; Max-Age=..; ...`
 * strings (Max-Age=0 deletes), reads return `name=value; name2=value2`.
 */
const installDom = (hostname = "app.kubit.ai", protocol = "https:") => {
  const jar = new Map<string, string>();
  const doc = {
    get cookie(): string {
      return Array.from(jar.entries())
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
    },
    set cookie(raw: string) {
      const [pair, ...attrs] = raw.split(";").map((s) => s.trim());
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const maxAge = attrs.find((a) => a.startsWith("Max-Age="));
      if (maxAge && Number(maxAge.slice("Max-Age=".length)) <= 0) {
        jar.delete(name);
        return;
      }
      jar.set(name, value);
    },
  };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", { location: { hostname, protocol } });
  return { jar, doc };
};

beforeEach(() => {
  visibleForTesting.resetMintedThisLoad();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("getRegistrableCookieDomain", () => {
  it("returns .kubit.ai for kubit.ai and any subdomain, '' otherwise", () => {
    expect(getRegistrableCookieDomain("kubit.ai")).toBe(".kubit.ai");
    expect(getRegistrableCookieDomain("app.kubit.ai")).toBe(".kubit.ai");
    expect(getRegistrableCookieDomain("deep.sub.kubit.ai")).toBe(".kubit.ai");
    expect(getRegistrableCookieDomain("localhost")).toBe("");
    expect(getRegistrableCookieDomain("evilkubit.ai")).toBe("");
  });
});

describe("anonymous id", () => {
  it("mints once and reuses on every later read", () => {
    installDom();
    const first = getAnonymousId();
    expect(first).not.toBe("");
    expect(getAnonymousId()).toBe(first);
    expect(getAnonymousId()).toBe(first);
  });

  it("reuses an id the visitor arrived with (never re-mints)", () => {
    const { jar } = installDom();
    jar.set(visibleForTesting.ANONYMOUS_ID_COOKIE, "arrived-with");
    expect(getAnonymousId()).toBe("arrived-with");
  });

  it("returns '' without a DOM (SSR/Node) instead of throwing", () => {
    expect(getAnonymousId()).toBe("");
  });

  it("hasEstablishedAnonymousId: false for absent, false for minted-this-load, true for arrived-with", () => {
    const { jar } = installDom();
    expect(hasEstablishedAnonymousId()).toBe(false);
    getAnonymousId();
    expect(hasEstablishedAnonymousId()).toBe(false);
    // Simulate a NEW page load holding the same cookie.
    visibleForTesting.resetMintedThisLoad();
    expect(hasEstablishedAnonymousId()).toBe(true);
    jar.clear();
    expect(hasEstablishedAnonymousId()).toBe(false);
  });

  it("upgradeAnonymousId replaces a minted-this-load id and reports true", () => {
    installDom();
    const minted = getAnonymousId();
    expect(upgradeAnonymousId("fp-visitor-id")).toBe(true);
    expect(getAnonymousId()).toBe("fp-visitor-id");
    expect(getAnonymousId()).not.toBe(minted);
  });

  it("upgradeAnonymousId is a strict no-op on an established identity", () => {
    const { jar } = installDom();
    jar.set(visibleForTesting.ANONYMOUS_ID_COOKIE, "arrived-with");
    expect(upgradeAnonymousId("fp-visitor-id")).toBe(false);
    expect(getAnonymousId()).toBe("arrived-with");
  });

  it("upgradeAnonymousId rejects an empty visitor id", () => {
    installDom();
    getAnonymousId();
    expect(upgradeAnonymousId("")).toBe(false);
  });

  it("seedAnonymousId skips the provider entirely for returning visitors", async () => {
    const { jar } = installDom();
    jar.set(visibleForTesting.ANONYMOUS_ID_COOKIE, "arrived-with");
    const provider = vi.fn().mockResolvedValue("fp-visitor-id");
    expect(await seedAnonymousId(provider)).toBe(false);
    expect(provider).not.toHaveBeenCalled();
  });

  it("seedAnonymousId upgrades a fresh visitor and never rejects on provider failure", async () => {
    installDom();
    getAnonymousId();
    expect(await seedAnonymousId(async () => "fp-visitor-id")).toBe(true);
    expect(getAnonymousId()).toBe("fp-visitor-id");

    // Provider failure: swallowed, id keeps its current value.
    visibleForTesting.resetMintedThisLoad();
    await expect(
      seedAnonymousId(() => Promise.reject(new Error("fp blocked"))),
    ).resolves.toBe(false);
  });
});

describe("session id", () => {
  it("a read NEVER seeds a session — '' until an explicit start", () => {
    installDom();
    expect(getSessionId()).toBe("");
    expect(getSessionId()).toBe("");
  });

  it("startSession writes the given id; getSessionId returns it within the window", () => {
    installDom();
    vi.useFakeTimers();
    expect(startSession("seed-id")).toBe("seed-id");
    expect(getSessionId()).toBe("seed-id");
    vi.advanceTimersByTime(THIRTY_MIN - 1);
    expect(getSessionId()).toBe("seed-id");
  });

  it("rolls to a fresh RANDOM id once the hard 30-min window elapses", () => {
    installDom();
    vi.useFakeTimers();
    startSession("seed-id");
    vi.advanceTimersByTime(THIRTY_MIN);
    const rolled = getSessionId();
    expect(rolled).not.toBe("");
    expect(rolled).not.toBe("seed-id");
    // The roll rewrites `start`, so the successor is stable for its window.
    vi.advanceTimersByTime(THIRTY_MIN - 1);
    expect(getSessionId()).toBe(rolled);
  });

  it("startSession with no id mints a random one", () => {
    installDom();
    const id = startSession();
    expect(id).not.toBe("");
    expect(getSessionId()).toBe(id);
  });

  it("startSessionFromToken stores only the SHA-256 hex of the token, never the raw value", async () => {
    const { jar } = installDom();
    const token = "raw-jwt-value";
    const id = await startSessionFromToken(token);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(getSessionId()).toBe(id);
    expect(jar.get(visibleForTesting.SESSION_ID_COOKIE)).not.toContain(token);
  });

  it("startSessionFromToken with an empty token starts a random session (never a constant hash)", async () => {
    installDom();
    const id = await startSessionFromToken("");
    expect(id).not.toBe("");
    expect(id).not.toMatch(/^[0-9a-f]{64}$/);
  });

  it("clearSession drops the session; the next read is ''", () => {
    installDom();
    startSession("seed-id");
    clearSession();
    expect(getSessionId()).toBe("");
  });

  it("a malformed session cookie reads as no session", () => {
    const { jar } = installDom();
    jar.set(visibleForTesting.SESSION_ID_COOKIE, "not-json");
    expect(getSessionId()).toBe("");
    jar.set(
      visibleForTesting.SESSION_ID_COOKIE,
      encodeURIComponent(JSON.stringify({ id: 42, start: "x" })),
    );
    expect(getSessionId()).toBe("");
  });

  it("returns '' without a DOM instead of throwing", () => {
    expect(getSessionId()).toBe("");
    expect(startSession("x")).toBe("");
  });
});

describe("getIdentityAttributes", () => {
  it("returns only present values under the canonical attribute names", () => {
    installDom();
    // No session yet — only the anonymous id (minted by the read).
    const preAuth = getIdentityAttributes();
    expect(preAuth["user.anonymous_id"]).not.toBe("");
    expect(preAuth).not.toHaveProperty("session.id");

    startSession("seed-id");
    const postAuth = getIdentityAttributes();
    expect(postAuth["session.id"]).toBe("seed-id");
    expect(postAuth["user.anonymous_id"]).toBe(preAuth["user.anonymous_id"]);
  });

  it("returns an empty record without a DOM", () => {
    expect(getIdentityAttributes()).toEqual({});
  });
});

describe("cookie scoping", () => {
  it("writes Domain=.kubit.ai on kubit.ai hosts and Secure on https", () => {
    const writes: string[] = [];
    const jar = new Map<string, string>();
    vi.stubGlobal("document", {
      get cookie() {
        return Array.from(jar.entries())
          .map(([name, value]) => `${name}=${value}`)
          .join("; ");
      },
      set cookie(raw: string) {
        writes.push(raw);
        const [pair] = raw.split(";");
        const eq = pair.indexOf("=");
        jar.set(pair.slice(0, eq), pair.slice(eq + 1));
      },
    });
    vi.stubGlobal("window", {
      location: { hostname: "app.kubit.ai", protocol: "https:" },
    });
    getAnonymousId();
    expect(writes[0]).toContain("Domain=.kubit.ai");
    expect(writes[0]).toContain("Secure");
    expect(writes[0]).toContain("SameSite=Lax");
  });

  it("omits Domain (host-only) and Secure on plain-http localhost", () => {
    const writes: string[] = [];
    vi.stubGlobal("document", {
      get cookie() {
        return "";
      },
      set cookie(raw: string) {
        writes.push(raw);
      },
    });
    vi.stubGlobal("window", {
      location: { hostname: "localhost", protocol: "http:" },
    });
    getAnonymousId();
    expect(writes[0]).not.toContain("Domain=");
    expect(writes[0]).not.toContain("Secure");
  });
});
