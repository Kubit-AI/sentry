import { describe, expect, it } from "vitest";
import type { Client, Event } from "@sentry/core";
import {
  createKubitSentryHooks,
  kubitSentryIntegration,
} from "../src/integration";

describe("kubitSentryIntegration", () => {
  it("registers on the client afterSendEvent hook in setup()", () => {
    const handlers: Record<string, (event: Event) => void> = {};
    const client = {
      on: (hook: string, cb: (event: Event) => void) => {
        handlers[hook] = cb;
        return () => {};
      },
    } as unknown as Client;

    const integration = kubitSentryIntegration({ apiKey: "" });
    expect(integration.name).toBe("KubitSentry");
    integration.setup?.(client);
    expect(typeof handlers.afterSendEvent).toBe("function");

    // Without an apiKey the tee is a no-op — must never throw into Sentry.
    expect(() =>
      handlers.afterSendEvent({ event_id: "a".repeat(32), timestamp: 1 }),
    ).not.toThrow();
  });
});

describe("createKubitSentryHooks", () => {
  it("returns events untouched", () => {
    const { beforeSend, beforeSendTransaction } = createKubitSentryHooks({
      apiKey: "",
    });
    const error: Event = { event_id: "b".repeat(32), timestamp: 1 };
    const txn: Event = { type: "transaction", timestamp: 2 };
    expect(beforeSend(error)).toBe(error);
    expect(beforeSendTransaction(txn)).toBe(txn);
  });
});
