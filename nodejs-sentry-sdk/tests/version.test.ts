import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SDK_VERSION } from "../src/version";
import { sentryTransactionToOtlp } from "../src/sentryToOtel";
import type { TransactionEvent } from "@sentry/core";

describe("SDK_VERSION", () => {
  it("matches package.json — the browser-safe constant must not drift from the release version", () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "..", "package.json"), "utf8"),
    ) as { version: string };
    expect(SDK_VERSION).toBe(pkg.version);
  });

  it("is stamped onto the OTLP instrumentation scope", () => {
    const event = {
      type: "transaction",
      transaction: "t",
      start_timestamp: 1,
      timestamp: 2,
      contexts: {
        trace: { trace_id: "a".repeat(32), span_id: "b".repeat(16) },
      },
      spans: [],
    } as unknown as TransactionEvent;

    const out = sentryTransactionToOtlp(event, {
      apiKey: "rg.v1.test",
      endpoint: "https://otel.kubit.ai/v1/traces",
      debug: false,
    });
    expect(out.resourceSpans[0].scopeSpans[0].scope).toEqual({
      name: "kubit.sentry",
      version: SDK_VERSION,
    });
  });
});
