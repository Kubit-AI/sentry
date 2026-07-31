/**
 * Client-context attributes for behavior analytics — browser, OS, locale,
 * timezone, and (optionally) geo — as FLAT DOTTED KEYS.
 *
 * The SDK owns this naming so every emitter (this web SDK, mobile SDKs later)
 * lands on the same attribute keys: OpenTelemetry semantic-convention names
 * where they exist (`browser.name`, `browser.version`, `browser.mobile`,
 * `browser.language`, `os.name`, `os.version`, `geo.country.iso_code`,
 * `geo.region.iso_code`, `geo.locality.name`) and the `kubit.` prefix only
 * for keys with no semconv equivalent (`kubit.timezone`).
 *
 * `getClientContextAttributes()` is computed ONCE per page load (memoized) —
 * it is intended to be read on hot paths (per event flush), so it stays sync
 * and cheap. Geo resolves asynchronously via `initGeoContext()` and merges
 * into the same memo, so flushes after resolution carry the geo keys.
 *
 * Everything degrades to key-omission: unknown browser, missing API, failed
 * geo fetch — the key is simply absent, never an empty string.
 */

interface UABrand {
  brand: string;
  version: string;
}

interface UserAgentDataLike {
  brands?: UABrand[];
  mobile?: boolean;
  platform?: string;
}

interface ParsedUserAgent {
  browserName?: string;
  browserVersion?: string;
  osName?: string;
  osVersion?: string;
  mobile: boolean;
}

/**
 * Minimal ordered-regex UA parser — four browsers and five OS families cover
 * the fleet; anything else simply omits the keys. Browser order matters:
 * Edge UAs carry Chrome+Safari tokens (`Edg/` checked first), Chrome UAs
 * carry a Safari token (Chrome before Safari). OS order: iOS/Android are
 * checked before the generic Mac/Linux tokens their UAs also contain.
 */
const parseUserAgent = (ua: string): ParsedUserAgent => {
  const parsed: ParsedUserAgent = {
    mobile: /Mobi|Android|iPhone|iPad/.test(ua),
  };

  const edge = /Edg\/([\d.]+)/.exec(ua);
  const firefox = /Firefox\/([\d.]+)/.exec(ua);
  const chrome = /Chrome\/([\d.]+)/.exec(ua);
  const safari = /Version\/([\d.]+).*Safari\//.exec(ua);
  if (edge) {
    parsed.browserName = "Edge";
    parsed.browserVersion = edge[1];
  } else if (firefox) {
    parsed.browserName = "Firefox";
    parsed.browserVersion = firefox[1];
  } else if (chrome) {
    parsed.browserName = "Chrome";
    parsed.browserVersion = chrome[1];
  } else if (safari) {
    parsed.browserName = "Safari";
    parsed.browserVersion = safari[1];
  }

  const windows = /Windows NT ([\d.]+)/.exec(ua);
  const ios = /(?:iPhone OS|CPU OS) ([\d_]+)/.exec(ua);
  const android = /Android ([\d.]+)/.exec(ua);
  const mac = /Mac OS X ([\d_.]+)/.exec(ua);
  if (windows) {
    parsed.osName = "Windows";
    parsed.osVersion = windows[1];
  } else if (ios) {
    parsed.osName = "iOS";
    parsed.osVersion = ios[1].replace(/_/g, ".");
  } else if (android) {
    parsed.osName = "Android";
    parsed.osVersion = android[1];
  } else if (mac) {
    parsed.osName = "macOS";
    parsed.osVersion = mac[1].replace(/_/g, ".");
  } else if (/Linux/.test(ua)) {
    parsed.osName = "Linux";
  }

  return parsed;
};

// userAgentData brand names are marketing strings; map them onto the same
// vocabulary the UA-string parser emits so downstream queries see ONE name
// per browser regardless of which source supplied it.
const mapBrandName = (brand: string): string => {
  if (brand === "Google Chrome") {
    return "Chrome";
  }
  if (brand === "Microsoft Edge") {
    return "Edge";
  }
  return brand;
};

let memo: Record<string, string | boolean> | null = null;

// Geo attributes resolved asynchronously by initGeoContext — empty until (and
// unless) the geo fetch succeeds.
let geoAttrs: Record<string, string> = {};

const getNavigator = (): (Navigator & { userAgentData?: UserAgentDataLike }) | null =>
  typeof navigator !== "undefined" ? navigator : null;

/**
 * Flat dotted client-context attributes: `browser.name`, `browser.version`,
 * `browser.mobile` (boolean), `os.name`, `os.version`, `browser.language`,
 * `kubit.timezone`, plus `geo.*` once `initGeoContext` has resolved.
 * Unknown/missing values OMIT the key rather than emitting `''`. Prefers
 * `navigator.userAgentData` (brands + mobile) when present, falling back to
 * UA-string parsing; os.version always comes from the UA string (the
 * low-entropy userAgentData surface does not expose it).
 */
export const getClientContextAttributes = (): Record<string, string | boolean> => {
  if (memo) {
    return memo;
  }
  const attrs: Record<string, string | boolean> = {};
  try {
    const nav = getNavigator();
    if (nav) {
      const parsed = parseUserAgent(nav.userAgent ?? "");
      const uaData = nav.userAgentData;
      // GREASE entries ("Not/A)Brand" etc.) are intentional garbage. Among
      // the real brands, prefer one that is NOT "Chromium": every
      // Chromium-based browser ships the engine token "Chromium" ALONGSIDE
      // its own brand (Google Chrome, Microsoft Edge, Opera, ...), and the
      // list order is deliberately shuffled per browser version — picking
      // the first real brand would split the same Chrome fleet between
      // "Chromium" and "Chrome" buckets across versions. Fall back to
      // "Chromium" only when it is the sole real brand (a bare Chromium
      // build genuinely is that browser).
      const realBrands = (uaData?.brands ?? []).filter(
        (candidate) => candidate.brand !== "" && !candidate.brand.includes("Not"),
      );
      const brand =
        realBrands.find((candidate) => candidate.brand !== "Chromium") ??
        realBrands[0];
      const browserName = brand ? mapBrandName(brand.brand) : parsed.browserName;
      const browserVersion = brand ? brand.version : parsed.browserVersion;
      if (browserName) {
        attrs["browser.name"] = browserName;
      }
      if (browserVersion) {
        attrs["browser.version"] = browserVersion;
      }
      attrs["browser.mobile"] =
        typeof uaData?.mobile === "boolean" ? uaData.mobile : parsed.mobile;
      if (parsed.osName) {
        attrs["os.name"] = parsed.osName;
      }
      if (parsed.osVersion) {
        attrs["os.version"] = parsed.osVersion;
      }
      if (nav.language) {
        attrs["browser.language"] = nav.language;
      }
    }
    try {
      // resolvedOptions can throw in exotic environments — omit the key then.
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (timezone) {
        attrs["kubit.timezone"] = timezone;
      }
    } catch {
      // key omitted
    }
  } catch {
    // whatever failed, ship what we have — keys degrade to omission
  }
  // Geo may have resolved before the first call — fold whatever is already
  // known into the fresh memo.
  Object.assign(attrs, geoAttrs);
  memo = attrs;
  return memo;
};

const GEO_FETCH_TIMEOUT_MS = 5000;

// The same-origin `/country` default only exists on Kubit-hosted surfaces,
// and the route sends no CORS headers — a cross-origin fetch from any other
// host is guaranteed to fail. Skip the doomed request instead of firing it.
const defaultGeoEndpoint = (): string => {
  if (typeof window === "undefined") {
    return "";
  }
  const hostname = window.location.hostname;
  if (hostname !== "kubit.ai" && !hostname.endsWith(".kubit.ai")) {
    return "";
  }
  return `${window.location.origin}/country`;
};

export interface GeoContextOptions {
  /**
   * Absolute or same-origin URL of a GeoIP endpoint returning JSON
   * `{ country, region, city, ... }`. Default: same-origin `/country` — but
   * ONLY on `*.kubit.ai` hosts, where that nginx route exists. On any other
   * host the default is skipped entirely (the Kubit `/country` route sends no
   * CORS headers, so a cross-origin browser fetch cannot succeed): non-Kubit
   * consumers either pass their own CORS-reachable endpoint here, or simply
   * omit geo client-side — the Kubit ingest can derive it server-side from
   * the OTLP request's source IP.
   */
  endpoint?: string;
  /** Abort the geo fetch after this many ms. Default 5000. */
  timeoutMs?: number;
  /**
   * Called once with the resolved geo attributes — for consumers that mirror
   * them onto an additional surface (e.g. Sentry error tags).
   */
  onGeoResolved?: (attrs: Record<string, string>) => void;
}

/**
 * Resolve geo attributes from a GeoIP endpoint, once per page load. Emits the
 * OTel semconv keys `geo.country.iso_code` ("US"), `geo.region.iso_code`
 * (ISO 3166-2, composed `${country}-${region}`) and `geo.locality.name`
 * (city). The response's `ip` and display-name fields are NEVER attached.
 * Fire-and-forget: events flushed before the fetch resolves omit geo; later
 * flushes pick it up because the resolved values merge into the (mutated)
 * client-context memo.
 */
export const initGeoContext = (options: GeoContextOptions = {}): void => {
  void (async () => {
    try {
      if (typeof fetch !== "function") {
        return;
      }
      const endpoint = options.endpoint ?? defaultGeoEndpoint();
      if (!endpoint) {
        return;
      }
      const timeoutMs = options.timeoutMs ?? GEO_FETCH_TIMEOUT_MS;
      const signal =
        typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
          ? AbortSignal.timeout(timeoutMs)
          : undefined;
      const response = await fetch(endpoint, { signal });
      if (!response.ok) {
        return;
      }
      const payload = await response.json();
      if (!payload || typeof payload !== "object") {
        return;
      }
      const { country, region, city } = payload;
      const attrs: Record<string, string> = {};
      if (typeof country === "string" && country !== "") {
        attrs["geo.country.iso_code"] = country;
        if (typeof region === "string" && region !== "") {
          attrs["geo.region.iso_code"] = `${country}-${region}`;
        }
      }
      if (typeof city === "string" && city !== "") {
        attrs["geo.locality.name"] = city;
      }
      if (Object.keys(attrs).length === 0) {
        return;
      }
      geoAttrs = attrs;
      if (memo) {
        Object.assign(memo, attrs);
      }
      options.onGeoResolved?.(attrs);
    } catch {
      // endpoint absent (non-Kubit host / local dev), network failure, or
      // timeout — geo keys stay omitted, no console noise
    }
  })();
};

/** Test-only surface: the raw parser and per-page-load state resets. */
export const visibleForTesting = {
  parseUserAgent,
  resetMemo: (): void => {
    memo = null;
  },
  resetGeo: (): void => {
    geoAttrs = {};
  },
};
