/**
 * Unit tests for `@kubit-ai/otel/mask` helpers.
 *
 * The helpers operate on the OTel `ReadableSpan` / `TimedEvent` shapes —
 * `attributes` is a mutable record and `events` is a mutable array on the
 * concrete `Span` class. Tests build minimal duck-typed objects that match
 * those shapes; cross-version assertions live in the integration tests in
 * `processor.test.ts` which use the real `BasicTracerProvider`.
 */

import { describe, expect, it } from "vitest";
import type { ReadableSpan, TimedEvent } from "@opentelemetry/sdk-trace-base";

import { deleteAttr, maskEvents, setAttr } from "../src/mask";

function fakeSpan(
  attributes?: Record<string, unknown>,
  events?: TimedEvent[],
): ReadableSpan {
  return {
    name: "op",
    attributes: attributes ?? {},
    events: events ?? [],
  } as unknown as ReadableSpan;
}

function fakeEvent(name: string, attributes?: Record<string, unknown>): TimedEvent {
  return {
    name,
    time: [0, 0],
    attributes: attributes,
  } as unknown as TimedEvent;
}

describe("setAttr", () => {
  it("adds an attribute to a span with no initial attrs", () => {
    const span = { name: "op", events: [] } as unknown as ReadableSpan;
    setAttr(span, "gen_ai.prompt", "hi");
    expect((span.attributes as Record<string, unknown>)["gen_ai.prompt"]).toBe("hi");
  });

  it("overwrites an existing span attribute", () => {
    const span = fakeSpan({ "gen_ai.prompt": "secret" });
    setAttr(span, "gen_ai.prompt", "[REDACTED]");
    expect((span.attributes as Record<string, unknown>)["gen_ai.prompt"]).toBe(
      "[REDACTED]",
    );
  });

  it("writes to an event's attributes", () => {
    const event = fakeEvent("e1", { keep: true });
    setAttr(event, "added", "x");
    expect(event.attributes).toMatchObject({ keep: true, added: "x" });
  });

  it("writes to an event with no initial attributes", () => {
    const event = fakeEvent("e1", undefined);
    setAttr(event, "k", "v");
    expect((event.attributes as Record<string, unknown>)["k"]).toBe("v");
  });

  it("accepts non-string OTel attribute values", () => {
    const span = fakeSpan();
    setAttr(span, "i", 42);
    setAttr(span, "f", 3.14);
    setAttr(span, "b", false);
    setAttr(span, "seq", ["a", "b"]);
    const attrs = span.attributes as Record<string, unknown>;
    expect(attrs).toMatchObject({ i: 42, f: 3.14, b: false, seq: ["a", "b"] });
  });
});

describe("deleteAttr", () => {
  it("removes a present key from a span", () => {
    const span = fakeSpan({ "gen_ai.prompt": "secret", keep: 1 });
    deleteAttr(span, "gen_ai.prompt");
    expect(span.attributes).toMatchObject({ keep: 1 });
    expect((span.attributes as Record<string, unknown>)["gen_ai.prompt"]).toBeUndefined();
  });

  it("is a no-op for absent keys", () => {
    const span = fakeSpan({ keep: 1 });
    deleteAttr(span, "missing");
    expect(span.attributes).toEqual({ keep: 1 });
  });

  it("is a no-op when attributes is undefined", () => {
    const span = { name: "op", events: [] } as unknown as ReadableSpan;
    expect(() => deleteAttr(span, "anything")).not.toThrow();
  });

  it("removes from an event", () => {
    const event = fakeEvent("e", { a: 1, b: 2 });
    deleteAttr(event, "a");
    expect(event.attributes).toEqual({ b: 2 });
  });
});

describe("maskEvents", () => {
  it("keeps all events when fn returns each event back", () => {
    const span = fakeSpan(undefined, [fakeEvent("a"), fakeEvent("b")]);
    maskEvents(span, (e) => e);
    expect(span.events.map((e) => e.name)).toEqual(["a", "b"]);
  });

  it("drops events for which fn returns null", () => {
    const span = fakeSpan(undefined, [
      fakeEvent("keep"),
      fakeEvent("drop"),
      fakeEvent("keep2"),
    ]);
    maskEvents(span, (e) => (e.name === "drop" ? null : e));
    expect(span.events.map((e) => e.name)).toEqual(["keep", "keep2"]);
  });

  it("drops events for which fn returns undefined", () => {
    const span = fakeSpan(undefined, [fakeEvent("a"), fakeEvent("b")]);
    maskEvents(span, (e) => (e.name === "a" ? undefined : e));
    expect(span.events.map((e) => e.name)).toEqual(["b"]);
  });

  it("preserves order across drops", () => {
    const span = fakeSpan(undefined, [
      fakeEvent("a"),
      fakeEvent("b"),
      fakeEvent("c"),
      fakeEvent("d"),
    ]);
    maskEvents(span, (e) => (e.name === "a" || e.name === "c" ? null : e));
    expect(span.events.map((e) => e.name)).toEqual(["b", "d"]);
  });

  it("can drop all events", () => {
    const span = fakeSpan(undefined, [fakeEvent("a"), fakeEvent("b")]);
    maskEvents(span, () => null);
    expect(span.events).toEqual([]);
  });

  it("is a no-op when there are no events", () => {
    const span = fakeSpan(undefined, []);
    maskEvents(span, (e) => e);
    expect(span.events).toEqual([]);
  });

  it("allows the callback to mutate event attributes via setAttr/deleteAttr", () => {
    const span = fakeSpan(undefined, [
      fakeEvent("e", { secret: "abc", keep: 1 }),
    ]);
    maskEvents(span, (event) => {
      deleteAttr(event, "secret");
      setAttr(event, "redacted", true);
      return event;
    });
    const out = span.events[0]!;
    expect(out.attributes).toMatchObject({ keep: 1, redacted: true });
    expect((out.attributes as Record<string, unknown>)["secret"]).toBeUndefined();
  });

  it("can substitute an event with a brand-new one", () => {
    const span = fakeSpan(undefined, [fakeEvent("orig")]);
    const replacement = fakeEvent("replaced");
    maskEvents(span, () => replacement);
    expect(span.events.map((e) => e.name)).toEqual(["replaced"]);
  });

  it("propagates callback exceptions to the caller (fail-closed at the outer mask)", () => {
    const span = fakeSpan(undefined, [fakeEvent("a"), fakeEvent("b")]);
    expect(() =>
      maskEvents(span, () => {
        throw new Error("kaboom");
      }),
    ).toThrow("kaboom");
  });
});

describe("helper composition — realistic mask shapes", () => {
  it("credit-card-style redaction over span attributes", () => {
    const span = fakeSpan({
      "gen_ai.prompt": "card 4111-1111-1111-1111",
      "gen_ai.model": "gpt-4",
    });
    const cc = /\b(?:\d[ -]*?){13,19}\b/g;
    const prompt =
      (span.attributes as Record<string, string>)["gen_ai.prompt"] ?? "";
    setAttr(span, "gen_ai.prompt", prompt.replace(cc, "[REDACTED CC]"));
    expect(
      (span.attributes as Record<string, string>)["gen_ai.prompt"],
    ).not.toContain("4111");
    expect(
      (span.attributes as Record<string, string>)["gen_ai.prompt"],
    ).toContain("[REDACTED CC]");
  });

  it("drops gen_ai.user.message events while keeping assistant.message", () => {
    const span = fakeSpan(undefined, [
      fakeEvent("gen_ai.user.message", { content: "ssn 111-22-3333" }),
      fakeEvent("gen_ai.assistant.message", { content: "ok" }),
    ]);
    maskEvents(span, (e) => (e.name === "gen_ai.user.message" ? null : e));
    expect(span.events.map((e) => e.name)).toEqual([
      "gen_ai.assistant.message",
    ]);
  });
});
