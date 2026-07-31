import { afterEach, describe, expect, it, vi } from "vitest";
import { postOtlp } from "../src/exporter";
import type { OtlpExportRequest } from "../src/types";

const config = { endpoint: "https://otel.kubit.ai/v1/traces", apiKey: "rg.v1.test" };

/** Tiny payload used where body size is irrelevant. */
const payload: OtlpExportRequest = { resourceSpans: [] };

/** A payload whose serialized body pads out to roughly `chars` characters. */
const payloadOfChars = (chars: number, fill = "a"): OtlpExportRequest =>
  ({
    resourceSpans: [
      {
        resource: { attributes: [{ key: "pad", value: { stringValue: fill.repeat(chars) } }] },
        scopeSpans: [],
      },
    ],
  }) as unknown as OtlpExportRequest;

const jsonResponse = (status: number, body?: unknown): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

/** Stub fetch, run postOtlp, and hand back the captured RequestInit. */
const captureFetch = (response: Response | Error) => {
  const fetchMock = vi.fn(
    (): Promise<Response> =>
      response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("postOtlp — request shape", () => {
  it("POSTs JSON to the configured endpoint with the x-api-key header", async () => {
    const fetchMock = captureFetch(jsonResponse(200));

    const result = await postOtlp(payload, config);

    expect(result).toEqual({ ok: true, status: 200 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(config.endpoint);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      "x-api-key": "rg.v1.test",
    });
    expect(init.body).toBe(JSON.stringify(payload));
  });

  it("attaches a timeout signal when AbortSignal.timeout is available", async () => {
    const fetchMock = captureFetch(jsonResponse(200));

    await postOtlp(payload, config);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("postOtlp — keepalive gating (browser only, byte-capped)", () => {
  it("never sets keepalive outside a browser (no document)", async () => {
    const fetchMock = captureFetch(jsonResponse(200));

    await postOtlp(payload, config);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.keepalive).toBeUndefined();
  });

  it("sets keepalive in a browser for small bodies", async () => {
    vi.stubGlobal("document", {});
    const fetchMock = captureFetch(jsonResponse(200));

    await postOtlp(payload, config);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.keepalive).toBe(true);
  });

  it("skips keepalive when the body exceeds the cap in BYTES despite a small char count", async () => {
    vi.stubGlobal("document", {});
    const fetchMock = captureFetch(jsonResponse(200));

    // 25k chars of a 3-byte-per-char glyph -> ~75KB of UTF-8, over the 60KB
    // cap while the char count stays far under it. A char-based threshold
    // would wrongly set keepalive here and the browser would reject the fetch.
    await postOtlp(payloadOfChars(25_000, "あ"), config);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.keepalive).toBeUndefined();
  });

  it("skips keepalive for large ASCII bodies too", async () => {
    vi.stubGlobal("document", {});
    const fetchMock = captureFetch(jsonResponse(200));

    await postOtlp(payloadOfChars(70_000), config);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.keepalive).toBeUndefined();
  });
});

describe("postOtlp — response handling", () => {
  it("treats a 200 with a non-JSON body as full success", async () => {
    captureFetch(new Response("OK", { status: 200 }));

    expect(await postOtlp(payload, config)).toEqual({ ok: true, status: 200 });
  });

  it("surfaces partial_success (numeric rejected_spans)", async () => {
    captureFetch(
      jsonResponse(200, {
        partial_success: { rejected_spans: 3, error_message: "queue full" },
      }),
    );

    expect(await postOtlp(payload, config)).toEqual({
      ok: true,
      status: 200,
      rejectedSpans: 3,
      message: "queue full",
    });
  });

  it("tolerates proto3-JSON string-encoded rejected_spans", async () => {
    captureFetch(jsonResponse(200, { partial_success: { rejected_spans: "2" } }));

    expect(await postOtlp(payload, config)).toMatchObject({
      ok: true,
      rejectedSpans: 2,
    });
  });

  it("ignores a zero-count partial_success", async () => {
    captureFetch(jsonResponse(200, { partial_success: { rejected_spans: 0 } }));

    expect(await postOtlp(payload, config)).toEqual({ ok: true, status: 200 });
  });

  it("returns the body text as the failure message on 4xx", async () => {
    captureFetch(new Response("bad key", { status: 401 }));

    expect(await postOtlp(payload, config)).toEqual({
      ok: false,
      status: 401,
      message: "bad key",
    });
  });

  it("truncates long failure bodies to 200 chars", async () => {
    captureFetch(new Response("x".repeat(500), { status: 400 }));

    const result = await postOtlp(payload, config);
    expect(result.ok).toBe(false);
    expect(result.message).toBe(`${"x".repeat(200)}…`);
  });

  it("falls back to a status-only message when the failure body is empty", async () => {
    captureFetch(new Response(null, { status: 503 }));

    expect(await postOtlp(payload, config)).toEqual({
      ok: false,
      status: 503,
      message: "HTTP 503",
    });
  });

  it("resolves (never rejects) on network failure, with status 0", async () => {
    captureFetch(new TypeError("Failed to fetch"));

    expect(await postOtlp(payload, config)).toEqual({
      ok: false,
      status: 0,
      message: "Failed to fetch",
    });
  });
});
