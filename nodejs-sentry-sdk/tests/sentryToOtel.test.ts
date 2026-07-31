import { describe, expect, it } from "vitest";
import {
  sentryEventToOtlp,
  sentryErrorToOtlp,
  sentryTransactionToOtlp,
} from "../src/sentryToOtel";
import type { KubitSentryConfig } from "../src/config";
import type { Event, TransactionEvent } from "@sentry/core";

const config: KubitSentryConfig = {
  apiKey: "rg.v1.test",
  endpoint: "https://otel.kubit.ai/v1/traces",
  serviceName: "test-app",
  serviceVersion: "1.2.3",
  debug: false,
};

const firstSpan = (req: ReturnType<typeof sentryEventToOtlp>) =>
  req.resourceSpans[0].scopeSpans[0].spans[0];

const resourceAttrs = (req: ReturnType<typeof sentryEventToOtlp>) =>
  Object.fromEntries(
    req.resourceSpans[0].resource.attributes.map((a) => [a.key, a.value]),
  );

describe("Transactions", () => {
  it("maps the trace context to a root span and threads config service attrs", () => {
    const event = {
      type: "transaction",
      transaction: "GET /home",
      start_timestamp: 1,
      timestamp: 2,
      release: "ignored-because-config-wins",
      contexts: {
        trace: { trace_id: "a".repeat(32), span_id: "b".repeat(16), op: "navigation", status: "ok" },
      },
      spans: [],
    } as unknown as TransactionEvent;

    const out = sentryTransactionToOtlp(event, config);
    const span = firstSpan(out);
    expect(span.traceId).toBe("a".repeat(32));
    expect(span.name).toBe("GET /home");
    expect(span.startTimeUnixNano).toBe("1000000000");
    expect(span.status.code).toBe(1); // OK
    const attrs = resourceAttrs(out);
    expect(attrs["service.name"]).toEqual({ stringValue: "test-app" });
    expect(attrs["service.version"]).toEqual({ stringValue: "1.2.3" });
  });

  it("stamps session.id + user.id onto every span — and ONLY the id, never name/email (PII)", () => {
    const event = {
      type: "transaction",
      transaction: "t",
      start_timestamp: 1,
      timestamp: 2,
      user: { id: 42, username: "alice", email: "alice@example.com" },
      contexts: {
        trace: { trace_id: "a".repeat(32), span_id: "b".repeat(16) },
      },
      spans: [
        {
          trace_id: "a".repeat(32),
          span_id: "c".repeat(16),
          description: "child",
          start_timestamp: 1,
          timestamp: 2,
        },
      ],
    } as unknown as TransactionEvent;

    const out = sentryTransactionToOtlp(event, config, "sess-xyz");
    const spanAttrs = (i: number) =>
      Object.fromEntries(
        out.resourceSpans[0].scopeSpans[0].spans[i].attributes.map((a) => [
          a.key,
          a.value,
        ]),
      );
    for (const i of [0, 1]) {
      // user id coerced to string; present on root AND child spans
      expect(spanAttrs(i)["user.id"]).toEqual({ stringValue: "42" });
      expect(spanAttrs(i)["session.id"]).toEqual({ stringValue: "sess-xyz" });
      // name/email are PII — user details are looked up backend-side by id,
      // so they must never be exported even when Sentry.setUser set them.
      expect(spanAttrs(i)["user.name"]).toBeUndefined();
      expect(spanAttrs(i)["user.email"]).toBeUndefined();
    }
  });

  it("encodes object / array-of-object attributes as kvlistValue (not JSON strings)", () => {
    const event = {
      type: "transaction",
      transaction: "order completed",
      start_timestamp: 1,
      timestamp: 2,
      contexts: {
        trace: {
          trace_id: "a".repeat(32),
          span_id: "b".repeat(16),
          data: {
            product_items: [
              { productId: 1, productName: "Urban Runner Pro", inStock: true },
            ],
          },
        },
      },
      spans: [],
    } as unknown as TransactionEvent;

    const out = sentryTransactionToOtlp(event, config);
    const attrs = Object.fromEntries(
      firstSpan(out).attributes.map((a) => [a.key, a.value]),
    );
    // A JS array maps to arrayValue; each object element maps to kvlistValue
    // (recursively), with scalars typed per OTLP — no JSON-string blobs.
    expect(attrs["product_items"]).toEqual({
      arrayValue: {
        values: [
          {
            kvlistValue: {
              values: [
                { key: "productId", value: { intValue: "1" } },
                {
                  key: "productName",
                  value: { stringValue: "Urban Runner Pro" },
                },
                { key: "inStock", value: { boolValue: true } },
              ],
            },
          },
        ],
      },
    });
  });
});

describe("Timestamps", () => {
  it("converts seconds-floats to exact integer nanoseconds (no float quantization)", () => {
    const event = {
      type: "transaction",
      transaction: "t",
      start_timestamp: 1750000000.5,
      timestamp: 1750000000.625,
      contexts: {
        trace: { trace_id: "a".repeat(32), span_id: "b".repeat(16) },
      },
      spans: [],
    } as unknown as TransactionEvent;

    const span = firstSpan(sentryTransactionToOtlp(event, config));
    expect(span.startTimeUnixNano).toBe("1750000000500000000");
    expect(span.endTimeUnixNano).toBe("1750000000625000000");
  });
});

describe("Errors", () => {
  it("emits an ERROR span with an exception span event, anchored on event_id", () => {
    const event: Event = {
      event_id: "f".repeat(32),
      timestamp: 5,
      level: "error",
      exception: {
        values: [
          {
            type: "TypeError",
            value: "x is not a function",
            stacktrace: { frames: [{ function: "boom", filename: "app.ts", lineno: 10, colno: 3 }] },
            mechanism: { handled: false, type: "generic" },
          },
        ],
      },
    };

    const out = sentryErrorToOtlp(event, config);
    const span = firstSpan(out);
    expect(span.traceId).toBe("f".repeat(32));
    expect(span.spanId).toBe("f".repeat(16));
    expect(span.status.code).toBe(2); // ERROR
    expect(span.name).toBe("TypeError");
    expect(span.events?.[0].name).toBe("exception");
    const evAttrs = Object.fromEntries(
      (span.events?.[0].attributes ?? []).map((a) => [a.key, a.value]),
    );
    expect(evAttrs["exception.type"]).toEqual({ stringValue: "TypeError" });
    expect(evAttrs["exception.escaped"]).toEqual({ boolValue: true });
  });

  it("joins an active trace as a child span without reusing the live span id", () => {
    const event: Event = {
      event_id: "d".repeat(32),
      timestamp: 5,
      contexts: {
        trace: {
          trace_id: "a".repeat(32),
          span_id: "b".repeat(16),
          parent_span_id: "c".repeat(16),
        },
      },
      exception: { values: [{ type: "Error", value: "boom" }] },
    };

    const span = firstSpan(sentryErrorToOtlp(event, config));
    expect(span.traceId).toBe("a".repeat(32));
    // span id derives from event_id; trace.span_id becomes the parent so the
    // error span can't collide with the live span the transaction also ships.
    expect(span.spanId).toBe("d".repeat(16));
    expect(span.parentSpanId).toBe("b".repeat(16));
  });
});

describe("Dispatcher", () => {
  it("routes by event.type", () => {
    const err: Event = { event_id: "c".repeat(32), timestamp: 1 };
    expect(firstSpan(sentryEventToOtlp(err, config)).status.code).toBe(2);
  });
});
