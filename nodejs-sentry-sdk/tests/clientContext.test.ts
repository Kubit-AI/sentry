import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getClientContextAttributes,
  initGeoContext,
  visibleForTesting,
} from "../src/clientContext";

const { parseUserAgent } = visibleForTesting;

// Real-world UA fixtures.
const CHROME_WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const EDGE_WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.87";
const SAFARI_MACOS_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const FIREFOX_LINUX_UA =
  "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0";
const CHROME_ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const SAFARI_IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 " +
  "Safari/604.1";

const stubNavigator = (fields: Record<string, unknown>): void => {
  vi.stubGlobal("navigator", fields);
};

beforeEach(() => {
  visibleForTesting.resetMemo();
  visibleForTesting.resetGeo();
});

afterEach(() => {
  vi.unstubAllGlobals();
  visibleForTesting.resetMemo();
  visibleForTesting.resetGeo();
});

describe("parseUserAgent", () => {
  it("parses Chrome on Windows", () => {
    expect(parseUserAgent(CHROME_WINDOWS_UA)).toEqual({
      browserName: "Chrome",
      browserVersion: "126.0.0.0",
      osName: "Windows",
      osVersion: "10.0",
      mobile: false,
    });
  });

  it("detects Edge BEFORE Chrome (Edg/ token wins)", () => {
    const parsed = parseUserAgent(EDGE_WINDOWS_UA);
    expect(parsed.browserName).toBe("Edge");
    expect(parsed.browserVersion).toBe("126.0.2592.87");
  });

  it("parses Safari on macOS with underscores->dots os version", () => {
    expect(parseUserAgent(SAFARI_MACOS_UA)).toEqual({
      browserName: "Safari",
      browserVersion: "17.5",
      osName: "macOS",
      osVersion: "10.15.7",
      mobile: false,
    });
  });

  it("parses Firefox on Linux (bare Linux — os version omitted)", () => {
    const parsed = parseUserAgent(FIREFOX_LINUX_UA);
    expect(parsed.browserName).toBe("Firefox");
    expect(parsed.osName).toBe("Linux");
    expect(parsed.osVersion).toBeUndefined();
  });

  it("parses Chrome on Android as mobile", () => {
    expect(parseUserAgent(CHROME_ANDROID_UA).mobile).toBe(true);
    expect(parseUserAgent(CHROME_ANDROID_UA).osName).toBe("Android");
  });

  it("parses Safari on iOS as mobile with underscores->dots version", () => {
    const parsed = parseUserAgent(SAFARI_IOS_UA);
    expect(parsed.osName).toBe("iOS");
    expect(parsed.osVersion).toBe("16.6");
    expect(parsed.mobile).toBe(true);
  });

  it("returns only mobile:false for an unknown UA", () => {
    expect(parseUserAgent("weird-bot/1.0")).toEqual({ mobile: false });
  });
});

describe("getClientContextAttributes", () => {
  it("returns flat dotted keys from the UA-string fallback", () => {
    stubNavigator({ userAgent: CHROME_WINDOWS_UA, language: "en-US" });
    const attrs = getClientContextAttributes();
    expect(attrs["browser.name"]).toBe("Chrome");
    expect(attrs["browser.version"]).toBe("126.0.0.0");
    expect(attrs["browser.mobile"]).toBe(false);
    expect(attrs["os.name"]).toBe("Windows");
    expect(attrs["os.version"]).toBe("10.0");
    expect(attrs["browser.language"]).toBe("en-US");
    expect(attrs["kubit.timezone"]).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  });

  it("prefers the browser's own brand over the shared Chromium engine token (shuffled order)", () => {
    stubNavigator({
      userAgent: CHROME_WINDOWS_UA,
      userAgentData: {
        // Chromium listed BEFORE Google Chrome — the shuffled order that
        // would previously report "Chromium" for a Chrome user.
        brands: [
          { brand: "Not/A)Brand", version: "8" },
          { brand: "Chromium", version: "148" },
          { brand: "Google Chrome", version: "148" },
        ],
        mobile: false,
      },
    });
    const attrs = getClientContextAttributes();
    expect(attrs["browser.name"]).toBe("Chrome");
    expect(attrs["browser.version"]).toBe("148");
  });

  it("falls back to Chromium when it is the only real brand (bare Chromium build)", () => {
    stubNavigator({
      userAgent: CHROME_WINDOWS_UA,
      userAgentData: {
        brands: [
          { brand: "Not/A)Brand", version: "8" },
          { brand: "Chromium", version: "148" },
        ],
        mobile: false,
      },
    });
    expect(getClientContextAttributes()["browser.name"]).toBe("Chromium");
  });

  it("prefers userAgentData brands (GREASE filtered, marketing names mapped)", () => {
    stubNavigator({
      userAgent: CHROME_WINDOWS_UA,
      userAgentData: {
        brands: [
          { brand: "Not/A)Brand", version: "8" },
          { brand: "Google Chrome", version: "126" },
        ],
        mobile: true,
      },
    });
    const attrs = getClientContextAttributes();
    expect(attrs["browser.name"]).toBe("Chrome");
    expect(attrs["browser.version"]).toBe("126");
    expect(attrs["browser.mobile"]).toBe(true);
    // os.version is NOT exposed by low-entropy userAgentData — UA string wins.
    expect(attrs["os.version"]).toBe("10.0");
  });

  it("is memoized — same object, environment changes after first call ignored", () => {
    stubNavigator({ userAgent: CHROME_WINDOWS_UA, language: "en-US" });
    const first = getClientContextAttributes();
    stubNavigator({ userAgent: SAFARI_MACOS_UA, language: "fr-FR" });
    const second = getClientContextAttributes();
    expect(second).toBe(first);
    expect(second["browser.name"]).toBe("Chrome");
  });

  it("omits unknown keys rather than emitting empty strings", () => {
    stubNavigator({ userAgent: "weird-bot/1.0" });
    const attrs = getClientContextAttributes();
    expect(attrs).not.toHaveProperty("browser.name");
    expect(attrs).not.toHaveProperty("os.name");
    expect(attrs["browser.mobile"]).toBe(false);
  });

  it("degrades to timezone-only without a navigator (SSR)", () => {
    const attrs = getClientContextAttributes();
    expect(attrs).not.toHaveProperty("browser.name");
    expect(typeof attrs["kubit.timezone"]).toBe("string");
  });
});

describe("initGeoContext", () => {
  // Real /country response shape from the Kubit nginx GeoIP endpoint.
  const GEO_RESPONSE = {
    ip: "73.170.216.185",
    country: "US",
    country_name: "United States",
    region: "CA",
    region_name: "California",
    city: "Fremont",
  };

  const stubFetch = (payload: unknown, ok = true) => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok,
      json: async () => payload,
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  const flushGeo = async (): Promise<void> => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  };

  it("fetches the endpoint and merges OTel geo semconv keys into an already-built memo", async () => {
    stubNavigator({ userAgent: CHROME_WINDOWS_UA });
    const fetchMock = stubFetch(GEO_RESPONSE);
    const attrs = getClientContextAttributes();
    expect(attrs).not.toHaveProperty("geo.country.iso_code");
    initGeoContext({ endpoint: "https://geo.example.com/country" });
    await flushGeo();
    expect(fetchMock.mock.calls[0][0]).toBe("https://geo.example.com/country");
    expect(attrs["geo.country.iso_code"]).toBe("US");
    expect(attrs["geo.region.iso_code"]).toBe("US-CA");
    expect(attrs["geo.locality.name"]).toBe("Fremont");
  });

  it("defaults the endpoint to same-origin /country on kubit.ai hosts", async () => {
    vi.stubGlobal("window", {
      location: {
        origin: "https://app.kubit.ai",
        hostname: "app.kubit.ai",
      },
    });
    const fetchMock = stubFetch(GEO_RESPONSE);
    initGeoContext();
    await flushGeo();
    expect(fetchMock.mock.calls[0][0]).toBe("https://app.kubit.ai/country");
  });

  it("SKIPS the default on non-Kubit hosts (the /country route sends no CORS headers)", async () => {
    vi.stubGlobal("window", {
      location: {
        origin: "https://shop.example-customer.com",
        hostname: "shop.example-customer.com",
      },
    });
    const fetchMock = stubFetch(GEO_RESPONSE);
    initGeoContext();
    await flushGeo();
    expect(fetchMock).not.toHaveBeenCalled();
    // An EXPLICIT endpoint is still honored on any host.
    initGeoContext({ endpoint: "https://geo.example-customer.com/lookup" });
    await flushGeo();
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://geo.example-customer.com/lookup",
    );
  });

  it("NEVER attaches the ip or display-name fields", async () => {
    stubFetch(GEO_RESPONSE);
    initGeoContext({ endpoint: "https://x.kubit.ai/country" });
    await flushGeo();
    const json = JSON.stringify(getClientContextAttributes());
    expect(json).not.toContain("73.170.216.185");
    expect(json).not.toContain("United States");
    expect(json).not.toContain("California");
  });

  it("invokes onGeoResolved with exactly the attached attributes", async () => {
    stubFetch(GEO_RESPONSE);
    const onGeoResolved = vi.fn();
    initGeoContext({ endpoint: "https://x.kubit.ai/country", onGeoResolved });
    await flushGeo();
    expect(onGeoResolved).toHaveBeenCalledWith({
      "geo.country.iso_code": "US",
      "geo.region.iso_code": "US-CA",
      "geo.locality.name": "Fremont",
    });
  });

  it("omits geo.region.iso_code when region is missing", async () => {
    stubFetch({ country: "US", city: "Fremont" });
    initGeoContext({ endpoint: "https://x.kubit.ai/country" });
    await flushGeo();
    const attrs = getClientContextAttributes();
    expect(attrs["geo.country.iso_code"]).toBe("US");
    expect(attrs).not.toHaveProperty("geo.region.iso_code");
    expect(attrs["geo.locality.name"]).toBe("Fremont");
  });

  it("is silent on non-ok responses, rejects, malformed payloads, and empty values", async () => {
    const onGeoResolved = vi.fn();

    stubFetch(GEO_RESPONSE, false);
    initGeoContext({ endpoint: "https://x.kubit.ai/country", onGeoResolved });
    await flushGeo();
    expect(getClientContextAttributes()).not.toHaveProperty("geo.country.iso_code");

    visibleForTesting.resetMemo();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(() =>
      initGeoContext({ endpoint: "https://x.kubit.ai/country", onGeoResolved }),
    ).not.toThrow();
    await flushGeo();

    visibleForTesting.resetMemo();
    stubFetch("not-an-object");
    initGeoContext({ endpoint: "https://x.kubit.ai/country", onGeoResolved });
    await flushGeo();

    visibleForTesting.resetMemo();
    stubFetch({ country: "", region: "", city: "" });
    initGeoContext({ endpoint: "https://x.kubit.ai/country", onGeoResolved });
    await flushGeo();

    expect(getClientContextAttributes()).not.toHaveProperty("geo.country.iso_code");
    expect(onGeoResolved).not.toHaveBeenCalled();
  });

  it("does nothing without an endpoint and without a window (Node)", async () => {
    const fetchMock = stubFetch(GEO_RESPONSE);
    initGeoContext();
    await flushGeo();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
